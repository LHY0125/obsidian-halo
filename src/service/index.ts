import type { Content, Post } from "@halo-dev/api-client";
import i18next from "i18next";
import { type App, Notice, type TFile } from "obsidian";
import { slugify } from "transliteration";
import { type HaloPostFields, applyPostToFrontmatter, parseHaloPostFields } from "../core/frontmatter-map";
import { LIST_PAGE_SIZE, MAX_PAGES_DEFAULT, type PagedResult, fetchAllPages } from "../core/pagination";
import { renderErrorMessage, withErrorDetail } from "../i18n/error-message";
import { type HaloSetting, type HaloSite, isSameSiteUrl, mcpEndpointOf, normalizeSite } from "../settings";
import { McpError } from "../transport/errors";
import { McpClient } from "../transport/mcp-client";
import { randomUUID } from "../utils/id";
import {
  type ImageUploadContext,
  type LocalImageSummary,
  type UploadImagesResult,
  restoreCachedLocalImageLinks,
  summarizeLocalImages,
  uploadImage,
  uploadImages,
} from "./image-upload";
import { type HaloPostFrontmatter, applyPostFrontmatter } from "./local-content";
import {
  type McpCategoryItem,
  type McpGetPostResult,
  type McpTagItem,
  generateResourceName,
  pickNewTerms,
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

/**
 * 一次发布的**完整规划** —— `planPublish` 的产物，`executePublish` 的输入。
 *
 * 存在的理由是「预览」：用户要在**任何写操作之前**看到这次到底会发生什么。
 * 所以规划把「读远端 / 套 frontmatter / 算图片 / 算将新建的分类标签」全部做完，
 * 只把「写」留给执行。`planPublish` 不写任何东西，是这一整块能成立的前提。
 *
 * 顺序上有一条必须原样保留：预览发生在**上传图片之前**，而 `uploadImages` 会改写本地笔记
 * （把图片链接换成远程地址）。反过来先上传再预览的话，用户在预览里点「取消」时笔记已经被
 * 改过了 —— 一次「什么都没发生」的取消，实际改动了整库笔记里的图片链接。
 */
export interface PublishPlan {
  /** 走更新分支时的远端文章名；为空表示这次是新建 */
  remoteName?: string;
  /** `applyPostFrontmatter` 之后的最终 spec —— 预览与首次写入都用它 */
  post: Post;
  raw: string;
  markdown: string;
  /** frontmatter 里写着的分类/标签显示名（还没解析资源名） */
  desiredCategories?: string[];
  desiredTags?: string[];
  /** 站点上**还不存在**的那些显示名 —— 预览里的「将新建」就是它 */
  newCategories: string[];
  newTags: string[];
  images: LocalImageSummary;
  /** frontmatter 里的 publish: true/false/没写（`undefined`） */
  publishFromFrontmatter?: boolean;
  /**
   * frontmatter 的原始数据与已校验的 6 个字段。**重试时要把同一份「本地意愿」重新套到
   * 刚读回来的远端文章上**，所以随计划一起带上。
   *
   * 为什么不让 `executePublish` 自己去 `metadataCache` 重读一遍：发布要跑几秒（上传图片
   * 还更久），重试与规划之间用户可能正在编辑同一篇笔记 —— 重试套上去的必须是**用户在预览里
   * 确认过的那一份**，而不是那一刻磁盘上的那一份。
   */
  matterData?: HaloPostFrontmatter;
  /**
   * 上者的校验产物（`parseHaloPostFields()`）。走到这里必定合法 ——
   * 不合法时 `planPublish` 已经返回失败，不会产出 `PublishPlan`。
   */
  haloFields?: HaloPostFields;
}

/**
 * 新建分支的底稿：一份字段齐全的 `Post` 字面量。
 *
 * 提成函数是因为「底稿」这个概念现在有两个语义不同的来源（新建＝这个字面量、
 * 更新＝刚读回来的远端文章），而两处必须**逐字段同形** ——
 * 差一个字段就会让预览里给用户看的东西与实际写出去的东西对不上。
 */
function createEmptyPost(): Post {
  return {
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
}

/**
 * 文章与独立页面两条编排路径**逐字相同**的那几个成员。
 *
 * 收在这里的只有「搬过去不改一行语义」的东西：站点/客户端字段、发布事务重试、正文切分、
 * 便签播报、发布失败文案。抽取的收益是实打实的 —— `withPublishRetry` 的 3 次 500ms 退避是
 * 1-A 花了整轮才调对的，复制一份必然在某次改动后分叉，而分叉的表现是「文章会重试、页面不会」，
 * 本地完全看不出来。
 *
 * ⚠️ **回写笔记（`applyPostToFrontmatter` 那一步）刻意不收在这里**：文章的前言契约是 9 键、
 * 页面只有 3 键（`site` / `name` / `publish`）。合成一份之后，每推一次页面就会往笔记里写进
 * 5 个 `undefined`（`cover` / `halo.pinned` / `halo.priority` / `halo.publishTime` / `halo.template`）。
 * 两个子类各写各的回写，正是因为它们管的**不是同一件事**。
 */
export class HaloServiceBase {
  protected readonly site: HaloSite;
  protected readonly app: App;
  protected readonly settings: HaloSetting;
  /**
   * MCP 客户端。**可注入**——测试传 `createFakeClient()` 造的对象，生产代码不传、用真实的。
   * 可注入是本计划全部服务层测试的前提：`McpClient` 内部走 `requestUrl`，
   * 而测试要断言的是「调了哪个工具、传了什么参数」，不是「发了什么 HTTP 请求」。
   */
  protected readonly client: McpClient;

  constructor(app: App, settings: HaloSetting, site: HaloSite, client?: McpClient) {
    this.app = app;
    this.settings = settings;
    this.site = normalizeSite(site);
    this.client = client ?? new McpClient({ endpoint: mcpEndpointOf(this.site), token: this.site.mcpToken });
  }

  /**
   * 切出 frontmatter **之后**的正文。
   *
   * 抽出来是因为它有两处调用，且必须用**同一套**切法：规划阶段（读盘或调用方递进来的那份）
   * 与执行阶段（上传图片之后的那份）。切法一旦分叉，实际发出去的正文就会与预览里报的字符数
   * 对不上 —— 差的正是 frontmatter 那几十个字符，用户按预览估的长度就白估了。
   */
  protected bodyOf(markdown: string, file: TFile): string {
    const position = this.app.metadataCache.getFileCache(file)?.frontmatterPosition;

    return position ? markdown.slice(position.end.offset) : markdown;
  }

  /** 便签播报。`quiet` 为真时什么也不做 —— 返回值仍然带着原因，调用方自己去汇总 */
  protected report(reason: string, quiet?: boolean): void {
    if (!quiet) {
      new Notice(reason);
    }
  }

  /**
   * 发布失败的提示文案（写已经发出去、服务端拒绝了）。
   *
   * 这里刻意**不**走 `renderErrorMessage`：这条路上 `McpError.detail` 就是最有价值的线索
   * （工具级失败的全部说明都只在它里面），保留「发布失败」这个框架 + 服务端原文，
   * 比换成 `transport.error.*` 的泛化处置指引更贴近用户此刻的处境。改动它会破坏既有断言。
   * 所以只借 `withErrorDetail` 那一半（补 detail），key 由这里写死。
   */
  protected publishFailureMessage(error: unknown): string {
    return withErrorDetail(i18next.t("service.error_publish_failed"), error);
  }

  /**
   * 把一次发布事务包进重试。
   *
   * `operation` 拿得到**尝试序号**（首次为 0）。这不是为了方便计数，而是调用方真的需要它：
   * 更新分支的首次尝试必须沿用规划阶段读到的那份远端状态，重试才重新拉取 ——
   * 见 `executePublish`。把序号交给闭包，比在外面挂一个布尔量更难失去同步。
   */
  protected async withPublishRetry<T>(operation: (attempt: number) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation(attempt);
      } catch (error) {
        if (attempt >= PUBLISH_RETRY_COUNT) {
          throw error;
        }

        await this.sleep(PUBLISH_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  /**
   * 改写一篇笔记的 frontmatter，**把 Obsidian 的 `any` 收口在这一处**。
   *
   * ## 为什么需要它
   *
   * Obsidian 自己的类型定义是：
   *
   * ```ts
   * processFrontMatter(file: TFile, fn: (frontmatter: any) => void, ...): Promise<void>
   * ```
   *
   * 回调参数被声明成 `any`。直接把它传给 `applyPostToFrontmatter(frontmatter:
   * Record<string, unknown>, ...)` 会触发 `@typescript-eslint/no-unsafe-argument`
   * —— 而这是**上游类型定义的缺陷，不是我们的代码问题**：我们无法在不降低自身类型安全的
   * 前提下消除它（把 `applyPostToFrontmatter` 的入参改成 `any` 只是把问题往下游推）。
   *
   * 所以在这里断言一次，并**只在这里**。这样：
   *   · 审核告警消掉（5 处调用收敛成 1 处断言）；
   *   · 「本处依赖 Obsidian 的 `any`」这件事被显式写下来，而不是散在 5 个调用点；
   *   · 将来 Obsidian 修了这个签名，只需删掉这一个断言。
   *
   * 断言是**安全**的：`processFrontMatter` 的契约就是「给你一个可写的普通对象」，
   * 它由 YAML 解析器产出，原型链上只有 `Object.prototype`。
   */
  protected async writeFrontMatter(file: TFile, mutate: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      mutate(frontmatter as Record<string, unknown>);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      // 用 `window.setTimeout`，**不是**裸 `setTimeout`。
      //
      // 裸调用落在全局作用域的定时器上；Obsidian 的弹出窗口（popout window）有自己的
      // `window`，显式写 `window.` 才能落在**当前**窗口上。
      //
      // ⚠️ **不要改成 `globalThis` 或 `activeWindow`** —— 两条审核规则正好把这两个都堵死了：
      //   · `globalThis` → 「Avoid using 'globalThis'. Use 'window' or 'activeWindow'...」
      //   · `activeWindow` → 「Use 'window.setTimeout()' instead of 'activeWindow.setTimeout()'.
      //                       Timer functions should use 'window'.」
      // 两条规则约束的对象不同（前者禁 `globalThis`，后者要求**定时器**用 `window`），
      // 而 `window` 是唯一同时满足两者的写法。
      //
      // 测试环境（Node，没有 `window`）由 `tests/setup.ts` 的 obsidian mock 挂上
      // `globalThis.window` —— 在桩里补，而不是在生产代码里加兜底。
      window.setTimeout(resolve, ms);
    });
  }
}

class HaloService extends HaloServiceBase {
  constructor(app: App, settings: HaloSetting, site: HaloSite, client?: McpClient) {
    super(app, settings, site, client);

    // 图片上传的缓存容器。只有文章路径会用到（页面路径没有图片上传），故留在子类里初始化，
    // 而不拖进基类 —— 基类的成员应当是两条路径都真的需要的东西。
    if (!this.settings.imageUploadCache) {
      this.settings.imageUploadCache = {};
    }
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
   * 发布前的规划：读远端、套 frontmatter、算图片概览、算出「将新建」的分类标签。
   *
   * **不写任何东西**（不建分类、不改笔记、不碰站点）。这是预览能成立的前提 ——
   * 用户在弹窗里点「取消」时，站点与本地都必须与打开弹窗之前一模一样。
   *
   * 与 `getCategoryNames` 的分工：那个负责**建**，这个只负责**算出要建哪些**。
   * 分类/标签的列表在两处各取一次（`halo_list_categories` 是只读的，代价可接受），
   * 换来的是「规划」与「执行」各自独立可测。
   *
   * `options.markdown` 是调用方手上那份正文（发布链路里是**上传图片之后**的那份）。
   * 给了就用它、一次盘都不读：读盘拿到的是上传之前的旧内容，而预览要报的必须是即将发布的
   * 那一份。这条契约有既有测试钉着（"publishes the provided markdown instead of rereading
   * the local note"）—— 规划阶段若自己去读盘，那条断言立刻变红。
   *
   * 失败一律**不抛**、也**不弹便签**，只把原因从 `reason` 交出来：命令层要在预览之前显示
   * 原因（它还没拿到 `plan`），播报收在 `publishPost` 一处，两条路径才不会一个弹一个不弹。
   * 异常若穿出去，Obsidian 只会把它记进控制台 —— 用户点了「发布」，什么都没发生。
   */
  public async planPublish(
    file: TFile,
    options: { markdown?: string } = {},
  ): Promise<{ ok: true; plan: PublishPlan } | { ok: false; reason: string }> {
    const md = options.markdown ?? (await this.app.vault.read(file));
    const matterData = this.app.metadataCache.getFileCache(file)?.frontmatter as HaloPostFrontmatter | undefined;
    const raw = this.bodyOf(md, file);

    // check site url
    if (matterData?.halo?.site && !isSameSiteUrl(matterData.halo.site, this.site.url)) {
      return { ok: false, reason: i18next.t("service.error_site_not_match") };
    }

    // 6 个元数据字段的校验放在**最前面**，理由是它必须早于任何副作用：分类/标签的列举也要走
    // MCP，一旦走到那一步再报"字段写错了"，用户已经为一次注定失败的发布等了一个来回 ——
    // 而这条校验纯本地、零成本。
    const haloFields = parseHaloPostFields(matterData?.halo);

    if (!haloFields.ok) {
      return { ok: false, reason: i18next.t(haloFields.key, haloFields.params) };
    }

    const desiredCategories = matterData?.categories;
    const desiredTags = matterData?.tags;

    // 只列不建：预览要在**写之前**告诉用户"将新建这 3 个标签"，而 `getCategoryNames`
    // 会真的把它们建到站点上。用户点取消后站点上多出 3 个空标签，是这次改造最容易漏的一处。
    //
    // 「将新建」用 `pickNewTerms` 算 —— 它与创建时的判等是**同一套** `displayName` 精确匹配。
    // 两处判等一分叉就会出现「预览说将新建、执行时又不建」或反过来，而用户刚在预览里为它做过决定。
    //
    // 列举失败与执行阶段的创建失败是同一件事的两半（都是这个密钥调不动分类/标签工具），
    // 故共用一套文案（`resolutionFailureMessage`）与同一套处置（中止，一个写工具都不调）。
    let existingCategories: McpCategoryItem[] = [];
    let existingTags: McpTagItem[] = [];

    try {
      if (desiredCategories) {
        existingCategories = await this.getCategories();
      }

      if (desiredTags) {
        existingTags = await this.getTags();
      }
    } catch (error) {
      return { ok: false, reason: this.resolutionFailureMessage(error) };
    }

    // 归一化掉显式空串：`halo.name: ""` 在改动前走的就是**新建**分支（`if (remotePostName)` 的
    // 真值判断），所以这里收敛成 `undefined`，既保住那条判据，也让 `plan.remoteName` 对下游
    // 只有「有名字」与「没有」两档，不必再判一次空串。
    const remoteName = matterData?.halo?.name || undefined;
    const halo = matterData?.halo;
    // 判据必须与上游逐位一致：`halo` 来自 Obsidian 的 frontmatter 解析结果，是个普通对象字面量。
    //
    // 用 `"publish" in halo` 而不是在对象上调用原型方法判键：两者对本处的输入**语义相同**
    //（`halo` 由 YAML 解析器产出，原型链上只有 `Object.prototype`，没有继承来的 `publish`），
    // 但 `in` 是 ES6 原生语法，不触碰对象上的方法 —— 而原型方法是可以被数据遮蔽的：
    // 一篇笔记若写了 `halo: { <原型方法名>: ... }`，旧写法会直接抛 `is not a function`。
    // 标准库的 `Object.hasOwn` 更贴切，但它是 ES2022，本项目 `lib` 只到 ES7，tsc 会报 TS2550。
    const publishFromFrontmatter = halo && "publish" in halo ? Boolean(halo.publish) : undefined;

    let post: Post;

    try {
      // 更新分支以**远端**为底、新建分支以字段齐全的字面量为底，两种情况都套上 frontmatter。
      // 预览要看的正是这个结果：`applyPostFrontmatter` 是稀疏展开，没写进 frontmatter 的键保留
      // 底里的值 —— 所以「没写就跟随远端」这件事只有在**读过远端之后**才看得见。不读远端的话，
      // 预览会把一篇 INTERNAL、已置顶的远端文章的可见性报成 PUBLIC、置顶报成否。
      const basis = remoteName ? await this.readRemotePost(remoteName) : createEmptyPost();

      post = applyPostFrontmatter(basis, {
        activeFile: file,
        haloFields: haloFields.fields,
        matterData,
        useActiveFileDefaults: !remoteName,
      });
    } catch (error) {
      return { ok: false, reason: this.publishFailureMessage(error) };
    }

    return {
      ok: true,
      plan: {
        remoteName,
        post,
        raw,
        markdown: md,
        desiredCategories,
        desiredTags,
        newCategories: pickNewTerms(desiredCategories, existingCategories),
        newTags: pickNewTerms(desiredTags, existingTags),
        // 概览按 `md` 算，不按盘上的内容算 —— 与上面的「正文取自哪一份」同源
        images: await this.summarizeImages(file, md),
        publishFromFrontmatter,
        matterData,
        haloFields: haloFields.fields,
      },
    };
  }

  /**
   * 按规划执行：建分类标签 → 建/更新文章 → 设定发布状态 → 回读 → 回写笔记。
   *
   * 与 `planPublish` 的分工是本次改造的核心：规划**决定**一切、什么都不写；执行**只写**、
   * 不再自己重新决定一遍。所以执行阶段拿 `plan` 里的取值，而不是再读一遍笔记与远端 ——
   * 用户在预览里确认过的那一份才是权威的。
   *
   * `options.markdown` 是**上传图片之后**的正文（本地图片链接已被换成远程地址）。发布流程
   * 必须在它之后才执行，所以规划时算出的 `plan.markdown` 会过时；给了 `markdown` 就用它，
   * 没给才回落 `plan.markdown`。
   */
  public async executePublish(
    file: TFile,
    plan: PublishPlan,
    options: { markdown?: string; publishOverride?: boolean; quiet?: boolean } = {},
  ): Promise<PublishResult> {
    // `??` 而不是真值判断：空串是**显式值**（一篇被清空了正文的笔记），与「没给」不是一回事。
    // 两者都收敛到同一份正文，但走的分支不同 —— 空串再切一次 frontmatter 仍然得到空串。
    const md = options.markdown ?? plan.markdown;
    const raw = this.bodyOf(md, file);

    // 分类/标签在这里**真的建**（`getCategoryNames` / `getTagNames` 会往站点上写）。
    // 拆分的全部意义就是把这个副作用挡在预览之后 —— 用户点「取消」时站点上不能多出任何东西。
    //
    // 顺序与改动前一致：解析（建）发生在写文章之前，失败的正确处置是**中止本次发布**并把原因
    // 带给用户。此前异常会直接穿出 `publishPost`，Obsidian 只把它记进控制台 —— 用户看到
    // 「什么都没发生」，而站点上确实什么都没发生，他却无从知道为什么。
    //
    // （`getCategoryNames` 是逐个创建的：失败前已建好的那几个会留在站点上。这是本设计的既有
    // 副作用、与上游一致 —— 它不改变「此刻文章还没写」这个判断，故中止依然是对的语义。）
    let categoryNames: string[] | undefined;
    let tagNames: string[] | undefined;

    try {
      if (plan.desiredCategories) {
        categoryNames = await this.getCategoryNames(plan.desiredCategories);
      }

      if (plan.desiredTags) {
        tagNames = await this.getTagNames(plan.desiredTags);
      }
    } catch (error) {
      const reason = this.resolutionFailureMessage(error);
      this.report(reason, options.quiet);
      return { ok: false, reason };
    }

    let remotePostName = plan.remoteName;

    /**
     * 本次**要求的**发布状态（没要求就是 `undefined`）。
     *
     * 必须在重试闭包**外**记录：闭包内的 `params` 会被下一次重试覆盖，而回读失败时要把这个意图
     * 覆盖回 frontmatter —— 详见 `refreshPostAfterWrite` 的「职责边界」。
     */
    let intendedPublish: boolean | undefined;

    let params = plan.post;

    try {
      params = await this.withPublishRetry(async (attempt) => {
        // 两个分支刻意用 if/else 而不是 if + 提前 return：发布状态那步必须对**两条**分支都生效，
        // 提前 return 会让更新分支跳过它（上游就是这个形状，不是随手写的）。
        if (remotePostName) {
          // 首次尝试沿用规划阶段读到的那份（`plan.post` 就是它的产物）：那次读就发生在预览之前，
          // 再读一遍只是把同一件事做两遍 —— 而「第一次写入之前只读过一次远端」这条性质有既有
          // 测试钉着（`fetchesBeforeAttempt`）。
          // **重试才重读**：重试的动机正是上一次写入失败了，远端此刻可能已经被别的客户端改过，
          // 拿旧对象原样重放会把这些改动盖掉。这与改动前「重试前先重读远端」的性质一致。
          const basis = attempt === 0 ? plan.post : await this.readRemotePost(remotePostName);

          // 重新套一遍 frontmatter 是**幂等**的（同一份 `matterData` / `haloFields` 再展开一次得到
          // 同一结果），所以对 `plan.post` 再套一次不会改动预览里给用户看过的那几个取值。它真正
          // 要做的是把**此刻才解析出来的** `categoryNames` / `tagNames` 填进去 —— 分类标签的创建
          // 是写操作，只能发生在预览之后，规划阶段拿不到它们的资源名。
          params = applyPostFrontmatter(basis, {
            activeFile: file,
            categoryNames,
            haloFields: plan.haloFields,
            matterData: plan.matterData,
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
            activeFile: file,
            categoryNames,
            haloFields: plan.haloFields,
            matterData: plan.matterData,
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
        //
        // 第二级读的是**规划阶段**记下的 `plan.publishFromFrontmatter`（改动前在这里现场
        // 判断前言里有没有 `publish` 键）：规划与执行之间用户可能正在编辑笔记，
        // 而这次发布已经由预览确认过 —— 用的必须是确认过的那一份。
        if (options.publishOverride !== undefined) {
          intendedPublish = options.publishOverride;
          await this.changePostPublish(params.metadata.name, intendedPublish);
        } else if (plan.publishFromFrontmatter !== undefined) {
          intendedPublish = plan.publishFromFrontmatter;
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
    // 这两个字段（刻意不落回任何值 —— 理由在 `src/frontmatter-map.ts` 的 `applyPostToFrontmatter()`
    // 里那段「绝不落回任何值」，那里解释了为什么落回 `spec` 里的 metadata.name 会造出垃圾分类/标签）。
    const postCategories = await this.resolveDisplayNames(() => this.getCategoryDisplayNames(params.spec.categories));
    const postTags = await this.resolveDisplayNames(() => this.getTagDisplayNames(params.spec.tags));

    // ⚠️ **必须 await**：`processFrontMatter` 是异步的（它要读文件、解析 YAML、再写回），
    // 不 await 时下面那句「发布成功」会**早于** frontmatter 落盘弹出 —— 用户看到成功提示后
    // 立刻关掉窗口/切换笔记，回写就可能被丢弃，而站点上文章已经发了。
    // 下次发布时 `halo.name` 缺席 → 走新建分支 → 站点上多出一篇重复文章。
    await this.writeFrontMatter(file, (frontmatter) => {
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

  /**
   * 单篇发布的便捷入口：规划 + 执行。命令层刻意**不用**它 —— 命令层要拿到 `plan` 才能预览。
   *
   * `options.markdown` 一路透传给 `planPublish`：规划也必须按**即将发布的那一份**正文来做
   * （图片张数、正文字符数都在其中）。读盘拿到的是上传图片之前的旧内容，而调用方递进来的
   * 那一份才是权威的 —— 既有测试 `publishes the provided markdown instead of rereading
   * the local note` 钉的正是这一点。
   *
   * 规划失败在这里补一次播报：`planPublish` 自己**不弹**（命令层要在预览之前自己显示原因），
   * 所以两条调用路径的播报都收在这一处，不会一个弹一个不弹。
   */
  public async publishPost(
    file: TFile,
    options: { markdown?: string; publishOverride?: boolean; quiet?: boolean } = {},
  ): Promise<PublishResult> {
    const planned = await this.planPublish(file, options);

    if (!planned.ok) {
      this.report(planned.reason, options.quiet);
      return { ok: false, reason: planned.reason };
    }

    return this.executePublish(file, planned.plan, options);
  }

  /**
   * 读远端文章，**带发布级重试**。
   *
   * 规划阶段的这次读与执行阶段重试时的重读是同一件事：都要求「一次瞬时抖动不该毁掉一次发布」。
   * 改动前这个读本来就在 `withPublishRetry` 的闭包里；拆出规划阶段时若不给它同样的覆盖，
   * 一次网络抖动就会从「重试后成功」变成「直接报发布失败」—— 那是拆分引入的行为退化，
   * 而不是拆分的目的。
   */
  private async readRemotePost(name: string): Promise<Post> {
    return this.withPublishRetry(async () => (await this.getPost(name)).post);
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

  /**
   * 列出站点分类（扁平表示，见 `post-mapping.ts`）。
   *
   * **翻页取全**。此前写死 `size: 100`（schema 上限）且**没有任何提示** —— 站点上分类一旦
   * 超过 100，后面的会被静默漏掉，而「静默」正是本阶段反复处理的那一类问题：
   * 用户看不到某几个分类，会以为它们不存在，然后重新建一遍。
   *
   * 触顶（`fetchAllPages` 的 `maxPages`）时**必须提示**，不能静默截断。
   */
  public async getCategories(): Promise<McpCategoryItem[]> {
    const { items, truncated } = await fetchAllPages<McpCategoryItem>(
      async (page, size) =>
        await this.client.callToolJson<PagedResult<McpCategoryItem>>("halo_list_categories", { page, size }),
      { pageSize: LIST_PAGE_SIZE },
    );

    if (truncated) {
      new Notice(
        i18next.t("service.notice_list_truncated", {
          what: i18next.t("service.what_categories"),
          size: LIST_PAGE_SIZE * MAX_PAGES_DEFAULT,
        }),
      );
    }

    return items;
  }

  /** 列出站点标签。翻页与提示的处置同 `getCategories`。 */
  public async getTags(): Promise<McpTagItem[]> {
    const { items, truncated } = await fetchAllPages<McpTagItem>(
      async (page, size) => await this.client.callToolJson<PagedResult<McpTagItem>>("halo_list_tags", { page, size }),
      { pageSize: LIST_PAGE_SIZE },
    );

    if (truncated) {
      new Notice(
        i18next.t("service.notice_list_truncated", {
          what: i18next.t("service.what_tags"),
          size: LIST_PAGE_SIZE * MAX_PAGES_DEFAULT,
        }),
      );
    }

    return items;
  }

  public async updatePost(): Promise<void> {
    const { activeEditor } = this.app.workspace;

    if (!activeEditor || !activeEditor.file) {
      return;
    }

    const matterData = this.app.metadataCache.getFileCache(activeEditor.file)?.frontmatter as
      | HaloPostFrontmatter
      | undefined;

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

    // 必须 await：本函数返回后调用方会弹「更新成功」，早于落盘弹提示会让用户以为已经写完。
    await this.writeFrontMatter(activeEditor.file, (frontmatter) => {
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
    // `openFile` 也是异步的（要打开叶子、渲染编辑器）。这里**不 await** 是刻意的：
    // 用户要的是「笔记建出来了」，打开它只是顺手的便利 —— 等编辑器渲染完再回写 frontmatter
    // 反而让「拉取」这个动作多等一个渲染周期。`void` 显式声明「知道它是 promise，故意不等」，
    // 而不是漏写。
    void this.app.workspace.getLeaf().openFile(file);

    // 必须 await：frontmatter 落盘后本函数才返回，调用方不会在回写完成前就认为拉取结束。
    await this.writeFrontMatter(file, (frontmatter) => {
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
   * 只读的图片概览，供发布预览与批量确认使用（**不发出任何请求**）。
   *
   * 规划阶段也走这一条，而不是直接调模块函数：这条封装把「上传模块的运行上下文」留在类内部，
   * 否则 `planPublish` 就得自己拼一份 `imageUploadContext()` —— 那正是「为了省一行而把上传
   * 模块的依赖（app / settings / site / client）摊到每个调用方手上」的开始。
   *
   * `markdown` 缺席时才读盘。发布链路把它手上那份（**上传图片之后**的正文）递进来：
   * 同一次发布不必为算概览再读一遍盘，更不会拿上传之前的旧内容去统计张数 ——
   * 而预览要报的必须是即将发布的那一份。
   */
  public async summarizeImages(file: TFile, markdown?: string): Promise<LocalImageSummary> {
    return summarizeLocalImages(file, this.imageUploadContext(), markdown);
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
