import type { Content, Post } from "@halo-dev/api-client";
import i18next from "i18next";
import { type App, Notice, type TFile } from "obsidian";
import { randomUUID } from "src/utils/id";
import { slugify } from "transliteration";
import { applyPostToFrontmatter, parseHaloPostFields } from "../frontmatter-map";
import { renderErrorMessage, withErrorDetail } from "../i18n/error-message";
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

/**
 * 一次发布的结果。
 *
 * 引入它是因为**批量操作需要把每篇的结果汇总起来**：调用方必须能分辨
 * 「这篇成功了」与「这篇因为什么失败了」，而 `void` + 内部 `Notice` 做不到这件事
 * （118 篇会弹 118 条提示，用户看不过来，代码也拿不到结果）。
 *
 * 失败的 `reason` 是**已渲染好的用户文案** —— 与 `renderErrorMessage` 的分层一致：
 * 渲染发生在产出原因的那一处，调用方只负责决定「怎么告诉用户」（单篇弹提示、批量汇总）。
 */
export type PublishResult = { ok: true } | { ok: false; reason: string };

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

  /**
   * 发布（或更新）一篇笔记。
   *
   * `file` 是显式的，不再从 `activeEditor` 取：批量操作要发的是一批文件，
   * 而活动编辑器只有一个。单篇命令传 `activeEditor.file`，行为与改动前一致。
   *
   * `options.quiet` 只是**不做便签播报**，结果照常从返回值给出 —— 两条通道里
   * 返回值是权威那份，便签只是单篇路径的呈现方式。
   */
  public async publishPost(
    file: TFile,
    options: { markdown?: string; publishOverride?: boolean; quiet?: boolean } = {},
  ): Promise<PublishResult> {
    const activeFile = file;

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
      const reason = i18next.t("service.error_site_not_match");
      this.report(reason, options.quiet);
      return { ok: false, reason };
    }

    // 6 个元数据字段的校验放在**最前面**，理由是它必须早于任何副作用：
    // 分类/标签解析会真的在站点上建分类（`getCategoryNames`），一旦走到那一步再报"字段写错了"，
    // 站点上已经留下了新建的标签，而文章没发出去 —— 用户看到的是"发布失败"和一堆新标签。
    const haloFields = parseHaloPostFields(matterData?.halo);

    if (!haloFields.ok) {
      const reason = i18next.t(haloFields.key, haloFields.params);
      this.report(reason, options.quiet);
      return { ok: false, reason };
    }

    // 分类/标签的解析发生在**写入之前**：此刻站点上还什么都没有，所以失败的正确处置是
    // **中止本次发布**并把原因带给用户。此前异常会直接穿出 `publishPost`，Obsidian 只把它记进
    // 控制台 —— 用户看到「什么都没发生」，而站点上确实什么都没发生，他却无从知道为什么。
    //
    // （`getCategoryNames` 是逐个创建的：失败前已建好的那几个会留在站点上。这是本设计的既有
    // 副作用、与上游一致 —— 它不改变「此刻文章还没写」这个判断，故中止依然是对的语义。）
    let categoryNames: string[] | undefined;
    let tagNames: string[] | undefined;

    try {
      if (matterData?.categories) {
        categoryNames = await this.getCategoryNames(matterData.categories);
      }

      if (matterData?.tags) {
        tagNames = await this.getTagNames(matterData.tags);
      }
    } catch (error) {
      const reason = this.resolutionFailureMessage(error);
      this.report(reason, options.quiet);
      return { ok: false, reason };
    }

    let remotePostName = matterData?.halo?.name;

    /**
     * 本次**要求的**发布状态（没要求就是 `undefined`）。
     *
     * 必须在重试闭包**外**记录：闭包内的 `params` 会被下一次重试覆盖，而回读失败时要把这个意图
     * 覆盖回 frontmatter —— 详见 `refreshPostAfterWrite` 的「职责边界」。
     */
    let intendedPublish: boolean | undefined;

    try {
      params = await this.withPublishRetry(async () => {
        // 两个分支刻意用 if/else 而不是 if + 提前 return：发布状态那步必须对**两条**分支都生效，
        // 提前 return 会让更新分支跳过它（上游就是这个形状，不是随手写的）。
        if (remotePostName) {
          const latestPost = (await this.getPost(remotePostName)).post;

          params = applyPostFrontmatter(latestPost, {
            activeFile,
            categoryNames,
            haloFields: haloFields.fields,
            matterData,
            tagNames,
            useActiveFileDefaults: false,
          });

          // 上游原本分两步写（PUT post + PUT draft 快照），MCP 的 update_post 带 raw
          // 即同时更新元数据与可编辑内容，两次请求合成一次。
          //
          // 用 callToolVoid 而非 callToolJson，两条不假设都写在这一处：
          // ① 不假设返回体是 **Post 形状** —— MCP 的文章表示是扁平的，扁平无法直接当 Post 读；
          // ② 不假设返回体**可解析** —— 写路径不**需要**响应负载（写与读解耦），因此也不依赖
          //    它的形状：回人读确认文案或空体都合理。
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
            haloFields: haloFields.fields,
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
        // 优先级：命令的显式覆盖 > frontmatter 的 `publish` > 设置里的 publishByDefault。
        //
        // 覆盖存在的原因是批量命令：用户点了「批量撤回」，意图是这批全部退回草稿，
        // 不该被某一篇笔记里写着的 `publish: true` 拦下来 —— 那样他会看到「撤回完成」
        // 而这些笔记仍然在线。单篇命令**不传** override，所以那一条路径的行为完全不变。
        // 后两级与上游一致 —— frontmatter 明确写了 `publish` 就听它的（显式 false 要主动退回草稿），
        // 只有没写时才看 publishByDefault。
        if (options.publishOverride !== undefined) {
          intendedPublish = options.publishOverride;
          await this.changePostPublish(params.metadata.name, intendedPublish);
          // biome-ignore lint/suspicious/noPrototypeBuiltins: 判据必须与上游逐位一致；推荐的 Object.hasOwn 是 ES2022，本项目 target 为 ES6
        } else if (matterData?.halo?.hasOwnProperty("publish")) {
          intendedPublish = Boolean(matterData.halo.publish);
          await this.changePostPublish(params.metadata.name, intendedPublish);
        } else if (this.settings.publishByDefault) {
          intendedPublish = true;
          await this.changePostPublish(params.metadata.name, true);
        }

        return params;
      });

      const refreshed = await this.refreshPostAfterWrite(params);

      // 服务端归一化过的字段（slug / publishTime 等）照用，但**发布意图以本地记录的为准**：
      // 回读失败时 `refreshed` 就是本地构造的 `params`，其 `spec.publish` 是**陈旧的** ——
      // 新建分支恒为字面量的 `false`，更新分支是「改发布状态之前」的服务端值。直接沿用会把这个
      // 陈旧值写进 frontmatter，**下一次**发布据此把已发布的文章静默退回草稿（详见上面 `intendedPublish`）。
      // 用展开而不是就地赋值：不改动服务端返回的对象。
      params =
        intendedPublish === undefined
          ? refreshed
          : { ...refreshed, spec: { ...refreshed.spec, publish: intendedPublish } };
    } catch (error) {
      const reason = this.publishFailureMessage(error);
      this.report(reason, options.quiet);
      return { ok: false, reason };
    }

    // 显示名解析是**写成功之后**的收尾读，和 `refreshPostAfterWrite` 同一类：必须自己吞掉失败。
    // 让异常逃出去的话，用户什么都看不到（Obsidian 只把未捕获异常记进控制台）、frontmatter
    // 也不会回写 —— 而文章其实已经写进 Halo 了。失败时返回 `undefined`，下面的回写据此**跳过**
    // 这两个字段（刻意不落回任何值，理由见那里）。
    const postCategories = await this.resolveDisplayNames(() => this.getCategoryDisplayNames(params.spec.categories));
    const postTags = await this.resolveDisplayNames(() => this.getTagDisplayNames(params.spec.tags));

    this.app.fileManager.processFrontMatter(activeFile, (frontmatter) => {
      applyPostToFrontmatter(frontmatter, params, {
        siteUrl: this.site.url,
        name: params.metadata.name,
        categoryNames: postCategories,
        tagNames: postTags,
      });
    });

    // 成功便签只在单篇路径上弹。批量路径由调用方汇总成一条 —— 118 条「发布成功」
    // 会把真正需要被看见的失败淹掉。
    if (!options.quiet) {
      new Notice(i18next.t("service.notice_publish_success"));
    }

    return { ok: true };
  }

  /** 便签播报。`quiet` 为真时什么也不做 —— 返回值仍然带着原因，调用方自己去汇总 */
  private report(reason: string, quiet?: boolean): void {
    if (!quiet) {
      new Notice(reason);
    }
  }

  /**
   * 写成功后再读一次，拿服务端归一化过的字段（slug、publishTime 等）。
   *
   * 这次读**必须自己吞掉失败**：它在 `publishPost` 的 catch 作用域里，一旦把异常放出去，
   * 「东西已经写进 Halo 了，只是回读时网络抖了一下」会被报成「发布失败」——
   * 用户重发一遍，而重发不会再建一篇（`remotePostName` 已回填）但会白跑一趟并收到错误提示。
   * 读失败就沿用本地构造的 params：少了服务端归一化，发布本身依然是成功的。
   *
   * **职责边界（写清以免又被依赖错）**：它只负责**服务端归一化**（slug、publishTime 这类服务端才算得准的字段），
   * **不承担「发布意图的回传」**。回读失败时它返回的 `params.spec.publish` 是**陈旧**的 ——
   * 新建分支恒为字面量的 `false`，更新分支是「改发布状态之前」的服务端值。调用方必须用自己记录的
   * `intendedPublish` 覆盖它，否则这个陈旧值会被写进 frontmatter，让**下一次**发布把已发布的文章
   * 静默退回草稿，而用户两次都看到「发布成功」。
   */
  private async refreshPostAfterWrite(params: Post): Promise<Post> {
    try {
      return (await this.getPost(params.metadata.name)).post;
    } catch {
      return params;
    }
  }

  /**
   * 解析显示名，**失败时返回 `undefined`**。
   *
   * 与 `refreshPostAfterWrite` 同属**写成功之后**的收尾读，因此必须自己吞掉失败 ——
   * 这两处一旦把异常放出去，用户看到的是「什么都没发生」，而文章已经在 Halo 上了。
   *
   * 失败时刻意**不提供回落值**，而是把「解析不出来」这件事原样交给调用方：调用方据此跳过
   * 该字段的回写。返回一个下游不认识的值（`params.spec` 里的 metadata.name）比不写更糟 ——
   * 消费方按 displayName 匹配，写入 name 会在下次发布时造出垃圾分类/标签，见 `publishPost`。
   *
   * 注意 `undefined` 与 `[]` 是两回事：前者是「解析不出来」，后者是「确实一个都没有」。
   */
  private async resolveDisplayNames(read: () => Promise<string[] | undefined>): Promise<string[] | undefined> {
    try {
      return await read();
    } catch {
      return undefined;
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
   * 发布失败的提示文案（写已经发出去、服务端拒绝了）。
   *
   * 这里刻意**不**走 `renderErrorMessage`：这条路上 `McpError.detail` 就是最有价值的线索
   * （工具级失败的全部说明都只在它里面），保留「发布失败」这个框架 + 服务端原文，
   * 比换成 `transport.error.*` 的泛化处置指引更贴近用户此刻的处境。改动它会破坏既有断言。
   * 所以只借 `withErrorDetail` 那一半（补 detail），key 由这里写死。
   */
  private publishFailureMessage(error: unknown): string {
    return withErrorDetail(i18next.t("service.error_publish_failed"), error);
  }

  /**
   * 读取失败的提示文案。
   *
   * 非 `McpError` 的意外错误才回落到「文章不存在」—— 那正是这句话本来就对应的情形；
   * 命中 `McpError` 时用它的 key 还原出**具体**原因（密钥过期 / 端点配错 / 网络不通
   * 各说各的，而不是一律「文章不存在」，那样用户照着怎么查都不对）。
   *
   * 这层还原原先在本类里手写了一份，现已收敛到 `renderErrorMessage`（与拉取弹窗共用一份实现）。
   */
  private readFailureMessage(error: unknown): string {
    return renderErrorMessage(error, "service.error_post_not_found");
  }

  /**
   * 发布**前**解析分类/标签失败的提示文案。
   *
   * 与 `publishFailureMessage` 的区别是刻意的：那条路上写已经发出去了，`detail` 是主线索；
   * 这条路上失败几乎都来自 `halo_list_categories` / `halo_create_category` 这类工具调用，
   * 而 `McpError` 的 key 本身就是**可操作的处置指引**（该去后台给这个密钥勾工具授权，
   * 还是该查网络 / 端点）—— 换成泛泛的「发布失败，请重试」等于把唯一的线索扔掉。
   */
  private resolutionFailureMessage(error: unknown): string {
    return renderErrorMessage(error, "service.error_publish_failed");
  }

  /**
   * 分类/标签显示名解析失败的提示文案（`updatePost` / `pullPost` 用）。
   *
   * 两段拼起来是刻意的：第一段说清**这次操作变成了什么样**（这两个字段没动、其余照常写入），
   * 第二段（`McpError` 时）说清**为什么**。只给其中一段，用户都得再猜一半 ——
   * 而「哪两个字段没同步」与「下一步该去后台勾工具授权还是查网络」正是他要的两件事。
   */
  private taxonomyFailureMessage(error: unknown): string {
    const outcome = i18next.t("service.notice_taxonomy_not_resolved");

    if (error instanceof McpError) {
      return `${outcome}\n${withErrorDetail(i18next.t(error.key, error.params), error)}`;
    }

    return outcome;
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

    // 显示名解析失败**不能**让整次更新炸掉：异常穿出去的话用户什么都看不到，而笔记一个字都没改。
    // 处置与 `publishPost` 的收尾读一致 —— 解析不出来就**跳过**这两个字段（保持笔记原值）、
    // 其余照常回写。区别在这处要**弹一次提示**：更新文档的**主目的**就是把远端状态同步进笔记，
    // 这两个字段没同步上属于主目的未完全达成，不能默默咽掉（发布那处主目的已完成，故不弹）。
    //
    // 两个字段**各自** try，而不是合用一个 —— 合用时失败语义是错的：若分类取到了、标签抛了，
    // `postCategories` 已经赋值并会被写进 frontmatter，可提示语说的却是「取不到的字段保持原样」，
    // 与事实不符（可复现路径：同一个密钥被勾了列举分类、没勾列举标签）。分开之后，被跳过的字段
    // 恰好等于真正失败的那些，提示语也就对得上了。`pullPost` 那处同构。
    //
    // 提示**只弹一次**：两处失败通常同因（都是这个密钥的授权问题），弹两遍同样的文案只会让用户
    // 以为出了两个问题。故只留第一个错误作为原因。
    let postCategories: string[] | undefined;
    let postTags: string[] | undefined;
    let taxonomyError: unknown;

    try {
      postCategories = await this.getCategoryDisplayNames(post.post.spec.categories);
    } catch (error) {
      taxonomyError = error;
    }

    try {
      postTags = await this.getTagDisplayNames(post.post.spec.tags);
    } catch (error) {
      taxonomyError = taxonomyError ?? error;
    }

    if (taxonomyError) {
      new Notice(this.taxonomyFailureMessage(taxonomyError));
    }

    const raw = this.settings.replaceImageLinks
      ? `${post.content.raw}`
      : restoreCachedLocalImageLinks(`${post.content.raw}`, this.imageUploadContext());

    await this.app.vault.modify(activeEditor.file, raw);

    this.app.fileManager.processFrontMatter(activeEditor.file, (frontmatter) => {
      applyPostToFrontmatter(frontmatter, post.post, {
        siteUrl: this.site.url,
        name: post.post.metadata.name,
        categoryNames: postCategories,
        tagNames: postTags,
      });
    });
  }

  public async pullPost(name: string): Promise<void> {
    // 失败时 readPostOrNotify 已经弹过提示（含失败原因）
    const post = await this.readPostOrNotify(name);

    if (!post) {
      return;
    }

    // 与 `updatePost` 同款处置。这里多一层考虑：**笔记照样要建出来** —— 分类名解析失败不该让
    // 整次拉取白做，正文才是用户要的东西；而且若失败是持久的（比如这个密钥没被勾选列举类工具），
    // 改成中止会让「拉取文章」永久不可用，比少两个字段严重得多。
    //
    // 新笔记没有「原值」可保留，跳过赋值的观测结果就是「这两个键不存在」。这不会误伤远端：
    // 发布时 `if (matterData?.categories)` 不成立，更新分支的 `spec.categories` 会保留服务端
    // 已有的分类，而不是把它们清空。
    //
    // 两个字段各自 try、提示只弹一次 —— 理由与 `updatePost` 那处完全相同（见那里的说明）。
    let postCategories: string[] | undefined;
    let postTags: string[] | undefined;
    let taxonomyError: unknown;

    try {
      postCategories = await this.getCategoryDisplayNames(post.post.spec.categories);
    } catch (error) {
      taxonomyError = error;
    }

    try {
      postTags = await this.getTagDisplayNames(post.post.spec.tags);
    } catch (error) {
      taxonomyError = taxonomyError ?? error;
    }

    if (taxonomyError) {
      new Notice(this.taxonomyFailureMessage(taxonomyError));
    }

    const file = await this.app.vault.create(`${post.post.spec.title}.md`, `${post.content.raw}`);
    this.app.workspace.getLeaf().openFile(file);

    this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      applyPostToFrontmatter(frontmatter, post.post, {
        siteUrl: this.site.url,
        // ⚠️ 是**入参** name，不是 post.post.metadata.name —— 理由见 PostToFrontmatterOptions.name
        name,
        categoryNames: postCategories,
        tagNames: postTags,
      });
    });
  }

  /**
   * 上传一篇笔记里的图片，必要时回写 markdown。
   *
   * 目标文件有**两种给法，都支持**：
   * - 写在 options 里（`{ file }`）—— **批量路径（Task 10）用的就是这种**；
   * - 作为第二个位置参数 —— 单篇命令用这种。
   *
   * 两者同时给出时 **options 里的那个优先**。顺序不能反过来：批量只传 options、不给第二个
   * 位置参数，若让位置参数优先，那个 `undefined` 会**盖掉** `options.file` → 静默回落到
   * 活动编辑器 → 每一篇的图片都传到当前打开的那篇上，正是本计划要消灭的「静默错文件」。
   *
   * ⚠️ 另一个入口 `publishPost(file, options?)` 是 file 在前 —— 两处顺序刻意不一致，
   * 别顺手「统一」，改了就静默改掉调用点。
   *
   * 实现在 `./image-upload`——这里只负责拼出运行上下文。
   */
  public async uploadImages(
    options: { silent?: boolean; replaceMarkdown?: boolean; file?: TFile } = {},
    file?: TFile,
  ): Promise<UploadImagesResult> {
    return uploadImages({ ...options, file: options.file ?? file }, this.imageUploadContext());
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

      // `halo_create_category` 的 `outputSchema.required` 只有 `["hideFromList"]` —— `name` 是
      // **可选**的，服务端不回它是契约允许的。但绝不能把这一项静默丢掉：文章会少一个分类，
      // 尾部的回写还会用 `getCategoryDisplayNames()` 把 frontmatter 里的分类名一并抹掉，
      // 用户看到的却是「发布成功」。也不编一个 name（那会指向一个不存在的资源），
      // 如实告诉用户哪一项没应用上。
      if (created?.name) {
        names.push(created.name);
      } else {
        new Notice(i18next.t("service.error_term_not_applied", { name: displayName }));
      }
    }

    return names;
  }

  /**
   * 把分类的 `metadata.name` 数组还原成显示名数组。
   *
   * **`undefined` 是独立的一档，不是「空结果」**：入参缺席（笔记或远端本就没有 categories）
   * 时返回 `undefined`，含义是「无从解析」；`[]` 才表示「确实一个都没有」。两者绝不可互换 ——
   * `publishPost` / `updatePost` / `pullPost` 都用真值判断决定要不要回写 frontmatter，
   * 一旦这里对缺席入参改成返回 `[]`，那道守卫就恒真，会把笔记里现有的分类**静默清空**。
   *
   * 所以签名如实标成 `string[] | undefined`：此前写的是 `Promise<string[]>`，真值却可能是
   * `undefined`（末尾那个 `as string[]` 断言恰好把它盖住了），接口与实现不一致 ——
   * 谁照着签名「修正」成返回 `[]`，就会踩上面那个坑，而 tsc 与测试都不会因此变红。
   */
  public async getCategoryDisplayNames(names?: string[]): Promise<string[] | undefined> {
    if (!names) {
      return undefined;
    }

    const categories = await this.getCategories();

    return names
      .map((name) => categories.find((item) => item.name === name)?.displayName)
      .filter((displayName): displayName is string => Boolean(displayName));
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

      // 同 `getCategoryNames`：服务端不回 `name` 时如实提示，既不静默丢掉也不编造
      if (created?.name) {
        names.push(created.name);
      } else {
        new Notice(i18next.t("service.error_term_not_applied", { name: displayName }));
      }
    }

    return names;
  }

  /** 与 `getCategoryDisplayNames` 同构，包含 `undefined` 与 `[]` 的那条区分（理由见那里）。 */
  public async getTagDisplayNames(names?: string[]): Promise<string[] | undefined> {
    if (!names) {
      return undefined;
    }

    const tags = await this.getTags();

    return names
      .map((name) => tags.find((item) => item.name === name)?.displayName)
      .filter((displayName): displayName is string => Boolean(displayName));
  }
}

export default HaloService;
