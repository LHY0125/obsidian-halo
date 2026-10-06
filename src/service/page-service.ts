import type { Content, SinglePage } from "@halo-dev/api-client";
import i18next from "i18next";
import { Notice, type TFile } from "obsidian";
import { randomUUID } from "src/utils/id";
import { CONTENT_TOOLSETS } from "../content-kind";
import { renderErrorMessage } from "../i18n/error-message";
import {
  type FetchAllPagesResult,
  LIST_PAGE_SIZE,
  MAX_PAGES_DEFAULT,
  type PagedResult,
  fetchAllPages,
} from "../pagination";
import { isSameSiteUrl } from "../settings";
import { McpError } from "../transport/errors";
import { HaloServiceBase, type PublishResult } from "./index";
import {
  type HaloPageFrontmatter,
  type McpGetSinglePageResult,
  type McpSinglePageItem,
  applyPageFrontmatter,
  applyPageToFrontmatter,
  toPageCreateArgs,
  toPageUpdateArgs,
  toSinglePage,
} from "./page-mapping";
import { toContent } from "./post-mapping";

/**
 * 读一个页面失败、又拿不到具体原因（**非 `McpError`**，例如网络层直接抛）时的兜底文案键。
 *
 * **与文章的 `service.error_post_not_found` 刻意分开**：命令名是「拉取独立页面」，
 * 而这两句话会把用户引向两个完全不同的自查方向 —— 网络抖动时显示「文章不存在」，
 * 用户会去站点后台的**文章列表**逐条核对（认为那篇被删了），而实际只需重试。
 *
 * 各自持有一个常量、而不是共用一个 `readFailureMessage(error, key)`：两条路径的兜底文案
 * 本来就是两种内容类型各自的话，共用一个入参只会让「这个 key 属于谁」变成读调用点才知道的事。
 */
const PAGE_NOT_FOUND_KEY = "service.error_page_not_found";

/**
 * 独立页面的编排：推送 / 拉取 / 发布状态 / 回收 / 恢复。
 *
 * **重试、正文切分、失败文案与 `HaloService` 共用 `HaloServiceBase`**，而不是各写一份 ——
 * `withPublishRetry` 的 3 次 500ms 退避是 1-A 花了整轮才调对的，复制一份必然在某次改动后分叉，
 * 而分叉的表现是「文章会重试、页面不会」，本地完全看不出来。
 *
 * 与文章路径的**实质差异只有三处**：
 * ① 工具名换一套（`CONTENT_TOOLSETS.page`）；
 * ② 入参只有 8 / 7 个键（页面没有分类 / 标签 / 置顶 / 排序 / 定时 / 模板 / 摘要）；
 * ③ 前言只认 `halo.site` / `halo.name` / `halo.publish` 三个 halo 键。
 *
 * ⚠️ **回写笔记用的是页面自己那一对函数**（`applyPageFrontmatter` / `applyPageToFrontmatter`），
 * 不是文章的那一对。理由见 `applyPageToFrontmatter()` 的文档：文章的前言契约是九键、
 * 页面只有三键，借文章那份来写会往每篇页面笔记里塞进 5 个 `undefined`。
 *
 * 页面**没有规划 / 预览 / 图片上传**：它们通常是「关于」「友链」这类短文档，图片上传与预览对它的
 * 收益远小于复杂度 —— 真需要传图的页面，用户可以先用「Halo: 上传图片」那条命令。
 */
class PageService extends HaloServiceBase {
  private readonly tools = CONTENT_TOOLSETS.page;

  /**
   * 读一个页面。与 `HaloService.getPost` 同构，包括那条硬约束：`truncated` 为真**必须抛错**。
   *
   * 抛而不是「就用这一份」：截断的正文写回本地就是**静默损坏用户的笔记**，
   * 而用户没有任何线索能发现少了半篇。
   */
  public async getPage(name: string): Promise<{ page: SinglePage; content: Content }> {
    const result = await this.client.callToolJson<McpGetSinglePageResult>(this.tools.get, {
      name,
      version: "HEAD",
      format: "RAW",
    });

    if (result.truncated) {
      throw new McpError("unknown", { tool: this.tools.get }, `content truncated: ${name}`);
    }

    // `toContent` 与文章路径共用：页面的 `content` 负载与文章**同形**
    //（`snapshotName` / `rawType` / `raw`），各写一份只是再留一个会漂移的地方。
    return { page: toSinglePage(result.item), content: toContent(result.content) };
  }

  /**
   * 列出全部页面（按 `hasNext` 翻页取全）。
   *
   * 翻页而不是只取一页：页面数量没有上限，静默少一截的表现是「选择器里找不到某个页面」，
   * 而用户会以为它不存在。
   *
   * ⚠️ **本函数的契约是「不抛」**：失败时自己弹提示并返回**空数组**，与
   * `post-selection-model.ts` 的 `fetchSelectablePosts` 逐字同款。而调用方（拉取选择器）
   * 的 `.then()` 后面**没有** catch —— 抛出去就是一条未捕获异常：Obsidian 只把它记进控制台，
   * 用户看到的是一个空列表加零条提示，分不清「站点上没有页面」与「请求失败了」。
   *
   * ⚠️ **但「取数函数契约一致」这句话早已不成立，别照着它写新代码。** 写这条注释时
   * 只有两个取数函数，现在**至少**有八个、分成两派：
   *
   * - **不抛**（失败时自己弹提示 + 返回空）：`fetchSelectablePosts` / 本函数 / `searchContent`。
   *   它们服务于**选择器或列表渲染** —— 调用方拿不到结果时只能渲染一个空列表，
   *   没有别的事可做，所以「弹提示 + 给空数组」是完整的处置。
   * - **抛**（各自由自己的弹窗兜 try/catch）：`fetchAttachments` / `fetchRecycled` /
   *   `fetchActivePages`。它们服务于**弹窗** —— 弹窗除了列表还有别的状态要维护
   *   （`truncated` 提示、重取），异常交给弹窗那一个 catch 处理比在取数层各自弹一遍更整齐，
   *   而弹窗**确实**裹了 catch（`attachment-modal.ts` / `recycle-modal.ts`）。
   *
   * ⚠️ **`HaloService.getCategories()` / `getTags()` 属于「抛」那一派，但不在上面那三个之列。**
   * 它们**不**吞异常（`fetchAllPages` 的失败会原样穿出去），也**不**返回空数组 —— 所以
   * 调用方必须自己裹 try/catch：`planBatch()` 的 `listTaxonomy` 就是这么做的（失败时回落成
   * 空快照，让整批不至于因为一次列举失败而不可用）。它们与上面三个「抛」的差别在**提示时机**：
   * 那两个只在**触顶**时弹一句 `notice_list_truncated`，**失败时不弹**（异常就是它们唯一的出口）。
   * 别把「自己弹提示」读成「失败也会弹」—— 失败路径上它们一个字都不说，全靠调用方。
   *
   * 两派并存是**刻意**的，不合并：合并成「都抛」要给上面前三个各配一个 catch，
   * 合并成「都不抛」会让下三个的失败在弹窗里退化成空列表，`truncated` 提示的语义也跟着变。
   * 代价是**每个调用方必须先看一眼这个函数抛不抛** —— 照着上面那句话写
   * `await fetchAttachments(client)` 而不裹 try/catch，异常会变成未捕获 rejection：
   * Obsidian 只记进控制台、界面毫无反应（用户点了「管理附件」，什么都没发生）。
   */
  public async getPages(): Promise<McpSinglePageItem[]> {
    let result: FetchAllPagesResult<McpSinglePageItem>;

    try {
      result = await fetchAllPages<McpSinglePageItem>(
        async (page, size) =>
          await this.client.callToolJson<PagedResult<McpSinglePageItem>>(this.tools.list, { page, size }),
        { pageSize: LIST_PAGE_SIZE },
      );
    } catch (error) {
      // 文案统一由 `renderErrorMessage` 出（与服务层其它读路径共用一份实现）：命中 McpError 就是
      // **可操作的处置指引**（核对密钥 / 为该密钥勾工具授权 / 检查端点与插件），并附上服务端原文。
      // 这条路径最怕退化成「反正都是连接失败」—— 那样用户只能瞎猜。
      new Notice(renderErrorMessage(error));
      return [];
    }

    if (result.truncated) {
      // 触顶（`fetchAllPages` 的 maxPages，默认 `MAX_PAGES_DEFAULT`）时**必须提示**，
      // 不能静默截断。`size` 与分类 / 标签两处同源，都是「页大小 × maxPages」——
      // 两个因子都取自 `pagination.ts` 的定义处，写死任何一个都会让这句**渲染给用户看的**
      // 提示与实际取到的条数对不上。
      new Notice(
        i18next.t("service.notice_list_truncated", {
          what: i18next.t("service.what_pages"),
          size: LIST_PAGE_SIZE * MAX_PAGES_DEFAULT,
        }),
      );
    }

    return result.items;
  }

  public async setPagePublish(name: string, publish: boolean): Promise<void> {
    // 走 callToolVoid：本工具最可能回一句确认文案，用 callToolJson 会在**写成功之后**抛错
    await this.client.callToolVoid(this.tools.setPublish, { name, publish });
  }

  public async recyclePage(name: string): Promise<void> {
    await this.client.callToolVoid(this.tools.recycle, { name });
  }

  public async restorePage(name: string): Promise<void> {
    await this.client.callToolVoid(this.tools.restore, { name });
  }

  /**
   * 把一篇笔记推成独立页面（新建或更新）。
   *
   * @param options.publish 显式覆盖发布状态；不传则看前言的 `halo.publish`、再退到设置里的
   *   `publishByDefault`（与文章路径同一套三档）。
   */
  public async pushPage(file: TFile, options: { publish?: boolean } = {}): Promise<PublishResult> {
    const markdown = await this.app.vault.read(file);
    const matterData = this.app.metadataCache.getFileCache(file)?.frontmatter as HaloPageFrontmatter | undefined;

    // 防跨站误推：站点对不上就直接返回，**一个工具都不调**。与文章路径同一条判据 ——
    // 推错站的后果是不可恢复的，而报错只是让用户去改一行配置。
    if (matterData?.halo?.site && !isSameSiteUrl(matterData.halo.site, this.site.url)) {
      return { ok: false, reason: i18next.t("service.error_site_not_match") };
    }

    // 归一化掉显式空串：`halo.name: ""` 的语义是「还没推送过」，与文章路径同一条判据
    let remoteName = matterData?.halo?.name || undefined;

    /**
     * 本次**要求的**发布状态（没要求就是 `undefined`）。
     *
     * 必须在重试闭包**外**记录：闭包内算出的值会被下一次重试覆盖，而回写时要靠它把发布意图
     * 覆盖回前言 —— 详见下面回写那一段。
     */
    let intendedPublish: boolean | undefined;

    try {
      const basis = remoteName ? await this.readRemotePage(remoteName) : createEmptyPage();
      const raw = this.bodyOf(markdown, file);
      const page = applyPageFrontmatter(basis, {
        activeFile: file,
        matterData,
        // 新建分支才用文件名当标题 / 用标题拼音当 slug；更新分支缺的字段保留远端值
        useActiveFileDefaults: !remoteName,
      });

      // `page.metadata.name` 是本次操作对象 name 的**唯一来源** —— 下面的 `update`、
      // `setPagePublish` 与回写三处都读它。
      //
      // 更新分支必须在这里显式锚回**前言里那个**：`toSinglePage()` 在服务端不回 `name` 时填的是
      // 空串，而 `halo_update_single_page` 与 `halo_set_single_page_publish_state` 的 `required`
      // **都含 `name`** —— 空串会被服务端直接拒绝，用户只看到一句「推送失败」而无从自查。
      // 与 `HaloService.pullPost` 那条「写 halo.name 要用**入参** name」同源。
      if (remoteName) {
        page.metadata.name = remoteName;
      }

      await this.withPublishRetry(async (attempt) => {
        if (remoteName) {
          // 首次尝试沿用刚读到的那份（预览之前只读过一次远端）；**重试才重读** ——
          // 重试的动机正是上一次写入失败了，远端此刻可能已被别的客户端改过，
          // 拿旧对象原样重放会把这些改动盖掉。与 `HaloService.executePublish` 同一条理由。
          //
          // 注意这里**不再**包一层 `readRemotePage`：本次调用已经在 `withPublishRetry` 的闭包
          // 里了，再包一层会嵌套成 4 × 4 次尝试加累加退避。
          const target = attempt === 0 ? page : (await this.getPage(remoteName)).page;

          // 重读拿到的是**另一个**对象，name 也要锚到同一个来源上（理由见上面那段）
          target.metadata.name = page.metadata.name;

          await this.client.callToolVoid(this.tools.update, toPageUpdateArgs(target, raw));
        } else {
          // MCP 没有 `metadata.generateName` 的等价物，而 `halo_create_single_page` 的 required
          // 含 name —— 本地生成。`if` 而不是无条件赋值：重试时不能换一个新 name，
          // 否则会在站点上留下两个同名页面。
          if (!page.metadata.name) {
            page.metadata.name = randomUUID();
          }

          await this.client.callToolVoid(this.tools.create, toPageCreateArgs(page, raw));

          // 这行回填是重试的**自愈机制**，不能删：首次建页面成功后若发布状态那步瞬时失败，
          // 重试时 remoteName 已是真值 → 走「更新」分支，而不是再建一篇重复页面。
          remoteName = page.metadata.name;
        }

        // 发布状态的三档与文章路径**逐档对齐**：① 命令的显式覆盖；② 前言的 `halo.publish`；
        // ③ 设置里的 `publishByDefault`。
        //
        // ⚠️ 第三档在开关为**假**时**不发这次调用**，而不是发一次 `publish: false`。后者会把一篇
        // 已发布页面悄悄退回草稿（笔记里恰好没写 `halo.publish` 时），而本地看不出任何异常 ——
        // 用户看到的是「推送成功」。文章路径的处置正是「没写就谁都不改」（`executePublish`）。
        const requestedPublish =
          options.publish ?? matterData?.halo?.publish ?? (this.settings.publishByDefault ? true : undefined);

        if (requestedPublish !== undefined) {
          intendedPublish = requestedPublish;
          // 与上面那次 `update` 用**同一个** name 来源（`page.metadata.name`）——
          // 本工具的 `required` 同样含 `name`，各取各的就会在「服务端不回 name」时漏掉一处
          await this.setPagePublish(page.metadata.name, requestedPublish);
        }
      });

      const refreshed = await this.refreshPageAfterWrite(page);

      // 发布意图以**本地记录的**为准：回读失败时 `refreshed` 就是本地构造的 `page`，其
      // `spec.publish` 是**改发布状态之前**的值，直接沿用会把这个陈旧值写进前言 ——
      // **下一次**推送据此把已发布的页面静默退回草稿，而用户两次都看到「推送成功」。
      // 用展开而不是就地赋值：不改动服务端返回的对象。
      const finalPage =
        intendedPublish === undefined
          ? refreshed
          : { ...refreshed, spec: { ...refreshed.spec, publish: intendedPublish } };

      this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        applyPageToFrontmatter(frontmatter, finalPage, {
          siteUrl: this.site.url,
          // ⚠️ 用本地那个 name，不是 `finalPage.metadata.name`：回读可能拿到一个缺 `name` 的 item，
          // 写真空会让下次推送当新建 —— **再建一个重复页面**。理由同 `PostToFrontmatterOptions.name`。
          name: page.metadata.name,
        });
      });

      new Notice(i18next.t("service.notice_push_page_success"));
      return { ok: true };
    } catch (error) {
      const reason = this.publishFailureMessage(error);
      this.report(reason);
      return { ok: false, reason };
    }
  }

  /**
   * 读远端页面，**带发布级重试**。
   *
   * 与 `HaloService.readRemotePost` 同构、同一理由：`pushPage` 的这次基准读与执行阶段重试时的
   * 重读是同一件事，都要求「一次瞬时抖动不该毁掉一次推送」。不给它同样的覆盖，一次网络抖动就会从
   * 「重试后成功」变成「直接报推送失败」—— 那是新路径引入的行为退化，而不是设计。
   *
   * ⚠️ **只在 `pushPage` 的基准读那一处用它**。闭包里那次重读**不要**换成它 ——
   * 那次已经在 `withPublishRetry` 里了，再包一层会嵌套成 4 × 4 次尝试加累加退避。
   */
  private async readRemotePage(name: string): Promise<SinglePage> {
    return this.withPublishRetry(async () => (await this.getPage(name)).page);
  }

  /**
   * 推成功后再读一次，拿服务端归一化过的字段（slug 等）。
   *
   * 这次读**必须自己吞掉失败**，理由与 `HaloService.refreshPostAfterWrite` 逐字相同：
   * 「东西已经写进 Halo 了，只是回读时网络抖了一下」不该被报成「推送失败」——
   * 用户重推一遍，白跑一趟还收到错误提示。读失败就沿用本地构造的 page。
   */
  private async refreshPageAfterWrite(page: SinglePage): Promise<SinglePage> {
    try {
      return (await this.getPage(page.metadata.name)).page;
    } catch {
      return page;
    }
  }

  /**
   * 读取失败的提示文案。
   *
   * 与 `HaloService.readFailureMessage()` **同构，但兜底键不同** —— 两条路各有一份是
   * **刻意**的：它们是两种内容类型各自的文案（文章说「文章不存在」、页面说「页面不存在」），
   * 而共用一个方法就得把 key 当入参传进来，那还不如各自持有一个常量（见 `PAGE_NOT_FOUND_KEY`）。
   * 命中 `McpError` 时两边完全一样：用它的 key 还原出**具体**原因（密钥过期 / 端点配错 /
   * 网络不通各说各的），兜底键只在**非 `McpError`**（网络层直接抛）时才生效。
   */
  private readFailureMessage(error: unknown): string {
    return renderErrorMessage(error, PAGE_NOT_FOUND_KEY);
  }

  /** 拉一个页面到本地，建一篇新笔记。 */
  public async pullPage(name: string): Promise<void> {
    let result: { page: SinglePage; content: Content };

    try {
      result = await this.getPage(name);
    } catch (error) {
      // 与「拉取文章」共用同一份错误还原（`renderErrorMessage`），只有兜底键不同 —— 这里是
      // **页面**那一份（`service.error_page_not_found`，理由见那个常量）。
      new Notice(this.readFailureMessage(error));
      return;
    }

    const file = await this.app.vault.create(`${result.page.spec.title}.md`, `${result.content.raw}`);
    this.app.workspace.getLeaf().openFile(file);

    this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      applyPageToFrontmatter(frontmatter, result.page, {
        siteUrl: this.site.url,
        // ⚠️ 是**入参** name，不是 `result.page.metadata.name` —— 理由同 `pushPage` 的回写
        name,
      });
    });
  }
}

/**
 * 新建页面的底稿。
 *
 * 字段集**只含页面真有的那些** —— 多一个就会被 `additionalProperties: false` 拒绝，
 * 或者被 `toPageUpdateArgs` 原样发出去。**不能复用 `HaloService` 的 `createEmptyPost()`**：
 * 那个字面量的 20 个 spec 字段里有一半页面没有（`cover` / `categories` / `tags` / `pinned` /
 * `priority` / `publishTime` / `template` / `htmlMetas` / 三个 snapshot 名）。
 *
 * `excerpt.autoGenerate` 取 `true`，与 `toSinglePage()` 一致 —— 这样 `applyPageToFrontmatter()`
 * 的摘要判据在两条分支上给出同一个结论（本地不钉摘要），不会「新建时说钉、更新时说不钉」。
 */
function createEmptyPage(): SinglePage {
  return {
    apiVersion: "content.halo.run/v1alpha1",
    kind: "SinglePage",
    metadata: { annotations: {}, name: "" },
    spec: {
      title: "",
      slug: "",
      visible: "PUBLIC",
      publish: false,
      excerpt: { autoGenerate: true, raw: "" },
    },
  } as SinglePage;
}

export default PageService;
