import type { Content, Post } from "@halo-dev/api-client";
import i18next from "i18next";
import { type App, Notice, type TFile } from "obsidian";
import { randomUUID } from "src/utils/id";
import { slugify } from "transliteration";
import { type HaloSetting, type HaloSite, isSameSiteUrl, mcpEndpointOf, normalizeSite } from "../settings";
import { McpError } from "../transport/errors";
import { McpClient } from "../transport/mcp-client";
import {
  type ImageUploadContext,
  type UploadImagesResult,
  restoreCachedLocalImageLinks,
  uploadImage,
  uploadImages,
} from "./image-upload";
import { type HaloPostFrontmatter, applyPostFrontmatter } from "./local-content";
import {
  type McpCategoryItem,
  type McpGetPostResult,
  type McpTagItem,
  generateResourceName,
  toContent,
  toPost,
} from "./post-mapping";

const PUBLISH_RETRY_COUNT = 3;
const PUBLISH_RETRY_DELAY_MS = 500;

class HaloService {
  private readonly site: HaloSite;
  private readonly app: App;
  private readonly settings: HaloSetting;
  /**
   * MCP 客户端。**可注入**——测试传 `createFakeClient()` 造的对象，生产代码不传、用真实的。
   * 可注入是本计划全部服务层测试的前提：`McpClient` 内部走 `requestUrl`，
   * 而测试要断言的是「调了哪个工具、传了什么参数」，不是「发了什么 HTTP 请求」。
   */
  private readonly client: McpClient;

  constructor(app: App, settings: HaloSetting, site: HaloSite, client?: McpClient) {
    this.app = app;
    this.settings = settings;
    this.site = normalizeSite(site);

    if (!this.settings.imageUploadCache) {
      this.settings.imageUploadCache = {};
    }

    this.client = client ?? new McpClient({ endpoint: mcpEndpointOf(this.site), token: this.site.mcpToken });
  }

  /** 图片上传模块的运行上下文。三个调用点共用，避免各写一遍字段拼装 */
  private imageUploadContext(): ImageUploadContext {
    return {
      app: this.app,
      client: this.client,
      settings: this.settings,
      site: this.site,
    };
  }

  /**
   * 读取一篇文章的元数据与可编辑正文。
   *
   * 与上游的差异（刻意的）：
   * - 上游要发两次请求（post 资源 + draft 快照），MCP 的 `halo_get_post` 一次返回两者；
   * - 上游把所有失败都吞成 `undefined`，导致网络故障被显示成「文章不存在」。现在失败即抛，
   *   由调用方决定文案。
   */
  public async getPost(name: string): Promise<{ post: Post; content: Content }> {
    const result = await this.client.callToolJson<McpGetPostResult>("halo_get_post", {
      name,
      version: "HEAD",
      format: "RAW",
    });

    if (result.truncated) {
      // 绝不能把截断的正文当完整文章写进本地文件 —— 那是静默损坏用户的笔记
      throw new McpError("unknown", { tool: "halo_get_post" }, `content truncated: ${name}`);
    }

    return { post: toPost(result.item), content: toContent(result.content) };
  }

  /**
   * 读一篇文章，失败时弹提示并返回 `undefined`。
   *
   * 存在的理由：`getPost()` 现在失败即抛，而 `updatePost` / `pullPost` 都不该把异常直接
   * 放给命令回调 —— Obsidian 只会把它记进控制台，用户什么都看不到。两处的处置完全一致，
   * 收在这里还能保证失败文案只有一处定义。
   */
  private async readPostOrNotify(name: string): Promise<{ post: Post; content: Content } | undefined> {
    try {
      return await this.getPost(name);
    } catch (error) {
      new Notice(this.readFailureMessage(error));
      return undefined;
    }
  }

  public async publishPost(options: { markdown?: string } = {}): Promise<void> {
    const { activeEditor } = this.app.workspace;

    if (!activeEditor || !activeEditor.file) {
      return;
    }

    const activeFile = activeEditor.file;

    let params: Post = {
      apiVersion: "content.halo.run/v1alpha1",
      kind: "Post",
      metadata: {
        annotations: {},
        name: "",
      },
      spec: {
        allowComment: true,
        baseSnapshot: "",
        categories: [],
        cover: "",
        deleted: false,
        excerpt: {
          autoGenerate: true,
          raw: "",
        },
        headSnapshot: "",
        htmlMetas: [],
        owner: "",
        pinned: false,
        priority: 0,
        publish: false,
        publishTime: "",
        releaseSnapshot: "",
        slug: "",
        tags: [],
        template: "",
        title: "",
        visible: "PUBLIC",
      },
    };

    const md = options.markdown ?? (await this.app.vault.read(activeFile));
    const matterData = this.app.metadataCache.getFileCache(activeFile)?.frontmatter as HaloPostFrontmatter | undefined;
    const frontmatterPosition = this.app.metadataCache.getFileCache(activeFile)?.frontmatterPosition;

    const raw = frontmatterPosition ? md.slice(frontmatterPosition?.end.offset) : md;

    // check site url
    if (matterData?.halo?.site && !isSameSiteUrl(matterData.halo.site, this.site.url)) {
      new Notice(i18next.t("service.error_site_not_match"));
      return;
    }

    let categoryNames: string[] | undefined;
    if (matterData?.categories) {
      categoryNames = await this.getCategoryNames(matterData.categories);
    }

    let tagNames: string[] | undefined;
    if (matterData?.tags) {
      tagNames = await this.getTagNames(matterData.tags);
    }

    let remotePostName = matterData?.halo?.name;

    try {
      params = await this.withPublishRetry(async () => {
        // 两个分支刻意用 if/else 而不是 if + 提前 return：发布状态那步必须对**两条**分支都生效，
        // 提前 return 会让更新分支跳过它（上游就是这个形状，不是随手写的）。
        if (remotePostName) {
          const latestPost = (await this.getPost(remotePostName)).post;

          params = applyPostFrontmatter(latestPost, {
            activeFile,
            categoryNames,
            matterData,
            tagNames,
            useActiveFileDefaults: false,
          });

          // 上游原本分两步写（PUT post + PUT draft 快照），MCP 的 update_post 带 raw
          // 即同时更新元数据与可编辑内容，两次请求合成一次。
          //
          // 用 callToolVoid 而非 callToolJson，两条不假设都写在这一处：
          // ① 不假设返回体是 **Post 形状** —— MCP 的文章表示是扁平的，扁平无法直接当 Post 读；
          // ② 不假设返回体**可解析** —— 写工具都没有 outputSchema，回人读确认文案或空体都合理。
          // 违反任一条的后果都不是「取值取错」而是「服务端已写成功、本地却抛错」：
          // 抛错会触发整事务重试（新建分支会拿同一个 name 再建一次，被重名拒绝），
          // 用户看到「发布失败」而文章其实已经写好了。最新的 Post 由下面的 getPost() 取。
          await this.client.callToolVoid("halo_update_post", this.toUpdateArgs(params, raw));
        } else {
          if (!params.metadata.name) {
            params.metadata.name = randomUUID();
          }

          params = applyPostFrontmatter(params, {
            activeFile,
            categoryNames,
            matterData,
            tagNames,
            useActiveFileDefaults: true,
          });

          // 同上：既不消费返回体，也不假设它可解析。name 用的是本地生成的 randomUUID()。
          await this.client.callToolVoid("halo_create_post", this.toCreateArgs(params, raw));

          // 这行回填是重试的**自愈机制**，不能删：首次建文章成功后若发布状态那步瞬时失败，
          // 重试时 remotePostName 已是真值 → 走「更新」分支，而不是再建一篇重复文章。
          // 因此发布状态调用必须留在本闭包内 —— 移出去会同时丢掉这层自愈和它的重试覆盖。
          remotePostName = params.metadata.name;
        }

        // 发布状态独立于内容：上游用 changePostPublish，MCP 是 set_post_publish_state。
        // 优先级与上游一致——frontmatter 明确写了 `publish` 就听它的（显式 false 要主动退回草稿），
        // 只有没写时才看 publishByDefault。
        // biome-ignore lint/suspicious/noPrototypeBuiltins: 判据必须与上游逐位一致；推荐的 Object.hasOwn 是 ES2022，本项目 target 为 ES6
        if (matterData?.halo?.hasOwnProperty("publish")) {
          await this.changePostPublish(params.metadata.name, Boolean(matterData.halo.publish));
        } else if (this.settings.publishByDefault) {
          await this.changePostPublish(params.metadata.name, true);
        }

        return params;
      });

      params = await this.refreshPostAfterWrite(params);
    } catch (error) {
      new Notice(this.publishFailureMessage(error));
      return;
    }

    const postCategories = await this.getCategoryDisplayNames(params.spec.categories);
    const postTags = await this.getTagDisplayNames(params.spec.tags);

    this.app.fileManager.processFrontMatter(activeFile, (frontmatter) => {
      frontmatter.title = params.spec.title;
      frontmatter.slug = params.spec.slug;
      frontmatter.cover = params.spec.cover;
      frontmatter.excerpt = params.spec.excerpt.autoGenerate ? undefined : params.spec.excerpt.raw;
      frontmatter.categories = postCategories;
      frontmatter.tags = postTags;
      frontmatter.halo = {
        site: this.site.url,
        name: params.metadata.name,
        publish: params.spec.publish,
      };
    });

    new Notice(i18next.t("service.notice_publish_success"));
  }

  /**
   * 写成功后再读一次，拿服务端归一化过的字段（slug、publishTime 等）。
   *
   * 这次读**必须自己吞掉失败**：它在 `publishPost` 的 catch 作用域里，一旦把异常放出去，
   * 「东西已经写进 Halo 了，只是回读时网络抖了一下」会被报成「发布失败」——
   * 用户重发一遍，而重发不会再建一篇（`remotePostName` 已回填）但会白跑一趟并收到错误提示。
   * 读失败就沿用本地构造的 params：少了服务端归一化，发布本身依然是成功的。
   */
  private async refreshPostAfterWrite(params: Post): Promise<Post> {
    try {
      return (await this.getPost(params.metadata.name)).post;
    } catch {
      return params;
    }
  }

  public async changePostPublish(name: string, publish: boolean): Promise<void> {
    // 同样走 callToolVoid：本工具最可能回的就是一句确认文案，用 callToolJson 会在写成功后抛错
    await this.client.callToolVoid("halo_set_post_publish_state", { name, publish });
  }

  /**
   * 把 Post 投影成 `halo_create_post` 的入参。
   *
   * 两条硬约束（实测自 tool schema）：
   * - `rawType` 必须显式传 `"markdown"` —— schema 默认值是 `"html"`，漏传会把 Markdown 当 HTML 存，
   *   站点渲染错乱而本地看不出任何异常；
   * - `publishTime` 空值传 `null`，**不能传空字符串**——schema 是 `["string","null"]` + `format: date-time`。
   *
   * 另外刻意不传 `content`：schema 说它默认取 `raw`，交给服务端渲染即可。
   * （客户端跑 `markdownIt.render()` 的结果本来也不是读者看到的 HTML，见 spec F1。）
   */
  private toCreateArgs(params: Post, raw: string): Record<string, unknown> {
    return {
      ...this.toUpdateArgs(params, raw),
      // 新建时默认推草稿；是否发布由随后的 set_post_publish_state 决定（与上游行为一致）
      publish: false,
    };
  }

  /** 把 Post 投影成 `halo_update_post` 的入参。注意该工具没有 `publish`。 */
  private toUpdateArgs(params: Post, raw: string): Record<string, unknown> {
    return {
      name: params.metadata.name,
      title: params.spec.title,
      slug: params.spec.slug || undefined,
      raw,
      rawType: "markdown",
      cover: params.spec.cover || null,
      excerpt: params.spec.excerpt.autoGenerate ? null : params.spec.excerpt.raw || null,
      autoGenerateExcerpt: params.spec.excerpt.autoGenerate,
      categories: params.spec.categories,
      tags: params.spec.tags,
      visible: params.spec.visible,
      pinned: params.spec.pinned,
      priority: params.spec.priority,
      publishTime: params.spec.publishTime || null,
      allowComment: params.spec.allowComment,
      template: params.spec.template || null,
    };
  }

  /**
   * 把 `McpError.detail` 接到提示语后面。
   *
   * 必须显示：工具级失败（HTTP 200 + `isError: true`）的全部线索都在那里，只弹一句泛泛的
   * 提示会让用户完全无从自查。
   *
   * 判据用**真值**而非 `??`——`detail` 合法地可以是空串（服务端失败了但没给原因），
   * `detail ?? fallback` 挡不住空串，只会留下一个孤零零的分隔符。
   *
   * 拼接用换行而非标点：detail 是服务端原文、未经本地化，标点却需要翻译。
   */
  private withErrorDetail(message: string, error: unknown): string {
    if (error instanceof McpError && error.detail) {
      return `${message}\n${error.detail}`;
    }

    return message;
  }

  /** 发布失败的提示文案 */
  private publishFailureMessage(error: unknown): string {
    return this.withErrorDetail(i18next.t("service.error_publish_failed"), error);
  }

  /**
   * 读取失败的提示文案。
   *
   * 与上游的差异（刻意的）：上游把 `getPost()` 的所有失败都吞成 `undefined`，于是密钥过期、
   * MCP 端点配错、网络不通全都被显示成「文章不存在」，用户照着这句话怎么查都查不对。
   * 现在 `getPost()` 失败即抛，这里用 `McpError` 自带的 `key` + `params` 还原出**具体**原因
   * （`transport.error.*` 本就是面向用户的文案）。
   *
   * 非 `McpError` 的意外错误才回落到「文章不存在」—— 那正是这句话本来就对应的情形。
   */
  private readFailureMessage(error: unknown): string {
    if (error instanceof McpError) {
      return this.withErrorDetail(i18next.t(error.key, error.params), error);
    }

    return i18next.t("service.error_post_not_found");
  }

  private async withPublishRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let retryCount = 0; ; retryCount++) {
      try {
        return await operation();
      } catch (error) {
        if (retryCount >= PUBLISH_RETRY_COUNT) {
          throw error;
        }

        await this.sleep(PUBLISH_RETRY_DELAY_MS * (retryCount + 1));
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * 列出站点分类（扁平表示，见 `post-mapping.ts`）。
   *
   * `size: 100` 既是 schema 的上限（`maximum: 100`），也是**刻意写死的**：
   * 站上现有 8 个分类，一页足够。但一旦分类数超过 100，这里会**静默漏掉后面的**——
   * 返回体里的 `hasNext` / `totalPages` 那时必须用起来改成分页。
   */
  public async getCategories(): Promise<McpCategoryItem[]> {
    const result = await this.client.callToolJson<{ items?: McpCategoryItem[] }>("halo_list_categories", {
      size: 100,
    });

    return result.items ?? [];
  }

  /** 列出站点标签。`size` 的取舍同 `getCategories`。 */
  public async getTags(): Promise<McpTagItem[]> {
    const result = await this.client.callToolJson<{ items?: McpTagItem[] }>("halo_list_tags", { size: 100 });

    return result.items ?? [];
  }

  public async updatePost(): Promise<void> {
    const { activeEditor } = this.app.workspace;

    if (!activeEditor || !activeEditor.file) {
      return;
    }

    const matterData = this.app.metadataCache.getFileCache(activeEditor.file)?.frontmatter;

    if (!matterData?.halo?.name) {
      new Notice(i18next.t("service.error_not_published"));
      return;
    }

    // 失败时 readPostOrNotify 已经弹过提示（含失败原因）
    const post = await this.readPostOrNotify(matterData.halo.name);

    if (!post) {
      return;
    }

    const postCategories = await this.getCategoryDisplayNames(post.post.spec.categories);
    const postTags = await this.getTagDisplayNames(post.post.spec.tags);

    const raw = this.settings.replaceImageLinks
      ? `${post.content.raw}`
      : restoreCachedLocalImageLinks(`${post.content.raw}`, this.imageUploadContext());

    await this.app.vault.modify(activeEditor.file, raw);

    this.app.fileManager.processFrontMatter(activeEditor.file, (frontmatter) => {
      frontmatter.title = post.post.spec.title;
      frontmatter.slug = post.post.spec.slug;
      frontmatter.cover = post.post.spec.cover;
      frontmatter.excerpt = post.post.spec.excerpt.autoGenerate ? undefined : post.post.spec.excerpt.raw;
      frontmatter.categories = postCategories;
      frontmatter.tags = postTags;
      frontmatter.halo = {
        site: this.site.url,
        name: post.post.metadata.name,
        publish: post.post.spec.publish,
      };
    });
  }

  public async pullPost(name: string): Promise<void> {
    // 失败时 readPostOrNotify 已经弹过提示（含失败原因）
    const post = await this.readPostOrNotify(name);

    if (!post) {
      return;
    }

    const postCategories = await this.getCategoryDisplayNames(post.post.spec.categories);
    const postTags = await this.getTagDisplayNames(post.post.spec.tags);

    const file = await this.app.vault.create(`${post.post.spec.title}.md`, `${post.content.raw}`);
    this.app.workspace.getLeaf().openFile(file);

    this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.title = post.post.spec.title;
      frontmatter.slug = post.post.spec.slug;
      frontmatter.cover = post.post.spec.cover;
      frontmatter.excerpt = post.post.spec.excerpt.autoGenerate ? undefined : post.post.spec.excerpt.raw;
      frontmatter.categories = postCategories;
      frontmatter.tags = postTags;
      frontmatter.halo = {
        site: this.site.url,
        name: name,
        publish: post.post.spec.publish,
      };
    });
  }

  /**
   * 上传当前笔记里的图片，必要时回写 markdown。
   *
   * 实现在 `./image-upload`——这里只负责拼出运行上下文。
   */
  public async uploadImages(
    options: { silent?: boolean; replaceMarkdown?: boolean } = {},
  ): Promise<UploadImagesResult> {
    return uploadImages(options, this.imageUploadContext());
  }

  /**
   * 上传单张图片并返回 permalink。
   *
   * 实现在 `./image-upload`——这里只负责拼出运行上下文。
   */
  public async uploadImage(file: TFile): Promise<string> {
    return uploadImage(file, this.imageUploadContext());
  }

  /**
   * 把显示名数组解析成 `metadata.name` 数组，缺失的**自动创建**。
   *
   * 与上游的差异（刻意的）：
   * - 上游用 `metadata.generateName` 让服务端造 name，MCP 没有等价物 → 本地生成（`generateResourceName`）；
   * - 上游并行创建（`Promise.all`），改成**顺序创建**：创建是有副作用的写操作，
   *   顺序化让失败定位更清楚，也不会把同一批里的撞名藏进并发里；
   * - 上游把结果重排成「已存在的在前、新建的在后」，那会丢掉与入参的顺序对应关系。这里**保持入参顺序**。
   *
   * 显示名已存在的那一项不会重复创建 —— 判等用 `displayName` 精确匹配（与上游一致）。
   * 新建项的 `priority` 接在现有分类之后（`all.length + index`），只影响主题侧的排序。
   */
  public async getCategoryNames(displayNames: string[]): Promise<string[]> {
    const all = await this.getCategories();
    const names: string[] = [];

    for (const [index, displayName] of displayNames.entries()) {
      const existing = all.find((item) => item.displayName === displayName);

      if (existing) {
        names.push(existing.name);
        continue;
      }

      const created = await this.client.callToolJson<{ name?: string }>("halo_create_category", {
        name: generateResourceName("category"),
        displayName,
        slug: slugify(displayName, { trim: true }),
        priority: all.length + index,
      });

      // 服务端没回 name 时这一项只能丢掉：让整批发布失败比少一个分类更糟
      if (created?.name) {
        names.push(created.name);
      }
    }

    return names;
  }

  public async getCategoryDisplayNames(names?: string[]): Promise<string[]> {
    const categories = await this.getCategories();
    return names
      ?.map((name) => {
        const found = categories.find((item) => item.name === name);
        return found ? found.displayName : undefined;
      })
      .filter(Boolean) as string[];
  }

  /** 与 `getCategoryNames` 同构；差异只有两处：走 `halo_create_tag`、不带 `priority`。 */
  public async getTagNames(displayNames: string[]): Promise<string[]> {
    const all = await this.getTags();
    const names: string[] = [];

    for (const displayName of displayNames) {
      const existing = all.find((item) => item.displayName === displayName);

      if (existing) {
        names.push(existing.name);
        continue;
      }

      const created = await this.client.callToolJson<{ name?: string }>("halo_create_tag", {
        name: generateResourceName("tag"),
        displayName,
        slug: slugify(displayName, { trim: true }),
      });

      if (created?.name) {
        names.push(created.name);
      }
    }

    return names;
  }

  public async getTagDisplayNames(names?: string[]): Promise<string[]> {
    const tags = await this.getTags();
    return names
      ?.map((name) => {
        const found = tags.find((item) => item.name === name);
        return found ? found.displayName : undefined;
      })
      .filter(Boolean) as string[];
  }
}

export default HaloService;
