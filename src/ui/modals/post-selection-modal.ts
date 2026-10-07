import i18next from "i18next";
import { Modal, Notice, Setting } from "obsidian";
import {
  type FetchAllPagesResult,
  LIST_PAGE_SIZE,
  MAX_PAGES_DEFAULT,
  type PagedResult,
  fetchAllPages,
} from "../../core/pagination";
import { renderErrorMessage } from "../../i18n/error-message";
import type { HaloPluginContext } from "../../plugin-context";
import type { McpPostItem } from "../../service/post-mapping";
import { type HaloSite, mcpEndpointOf } from "../../settings";
import { McpClient } from "../../transport/mcp-client";

/**
 * `LIST_PAGE_SIZE` 已移到 `pagination.ts` —— 四个调用点（分类 / 标签 / 拉取列表 / 附件列表）
 * 必须共用同一个值。这里按**原路径重导出**，既有的
 * `import { LIST_PAGE_SIZE } from "./post-selection-modal"` 不会断。
 */
export { LIST_PAGE_SIZE };

/**
 * 选择器需要的最小字段集。
 *
 * **刻意不是 `Pick<McpPostItem, …>`**：`McpPostItem` 的字段全是可选的（服务层对缺失字段有回落），
 * 而选择器需要的是「一定拿得到东西」的形状 —— 否则 `setName()` 与 `pullPost()` 都得处理 undefined。
 * 规范化由 `toSelectablePosts` 一次做完。
 */
export interface SelectablePost {
  /** `metadata.name` —— 拉取时唯一的标识。schema 未把它列为必需，缺失的项已在映射时剔除。 */
  name: string;
  /** 列表里显示的标题。缺 `title` 时回落成 `name`，否则会出现一行空白。 */
  title: string;
  /** 列表里的副标题，单纯给用户辨认用，可以为空串。 */
  slug: string;
}

/**
 * 拉取可选择的文章列表。
 *
 * 走 MCP 的 `halo_list_posts`（**读路径 → `callToolJson`**），并**翻页取全**。
 * 此前这里直连 REST `uc.api.content.halo.run/v1alpha1/posts` 并用 **PAT** 鉴权，
 * 是整条链路上最后一个还在用 REST 的读取点；切掉之后 PAT 只在「> 7 MiB 图片回退上传」这一条路上还有用。
 *
 * 不传 `published`：与迁移前的 REST 查询一致 —— 草稿与已发布都要列出来给用户选。
 * `recycled` 也不必显式传，schema 的默认值就是 `false`（等价于迁移前那句 `labelSelector=…deleted=false`）。
 *
 * ⚠️ **本函数有副作用：它自己弹 Notice**，两处，都是刻意的 ——
 * 1. **翻页触顶**（`fetchAllPages` 的 `maxPages`）时提示列表**确实**不完整；
 * 2. 加载失败时提示**具体原因**，并返回空数组（**不抛**）。
 *
 * 提示放在这里而不是 modal 里，是为了让这两条都能被测到：modal 的渲染没有测试脚手架，
 * 而本阶段明确不新建一套 UI mock 基建。「吞掉异常并返回空」也与
 * `HaloService.readPostOrNotify` 同款 —— 命令入口不该把异常放给 Obsidian，
 * 它只会记进控制台，用户什么都看不到。
 *
 * ⚠️ **判据收窄了，这是本次改动的要点**：此前是「`hasNext` 为真就提示」，而翻页之后
 * `hasNext` 为真只意味着「还有下一页」，是翻页过程里**正常的中间状态** ——
 * 拿它当提示条件，会在列表**已经完整**时谎报不完整（提示必须是「列表真的不完整」的函数）。
 * 现在唯一的触发条件是触顶。
 */
export async function fetchSelectablePosts(client: McpClient): Promise<SelectablePost[]> {
  let result: FetchAllPagesResult<McpPostItem>;

  try {
    result = await fetchAllPages<McpPostItem>(
      async (page, size) => await client.callToolJson<PagedResult<McpPostItem>>("halo_list_posts", { page, size }),
      { pageSize: LIST_PAGE_SIZE },
    );
  } catch (error) {
    // 文案统一由 `renderErrorMessage` 出（与服务层共用一份实现）：命中 McpError 就是
    // **可操作的处置指引**（核对密钥 / 为该密钥勾工具授权 / 检查端点与插件），并附上服务端原文。
    // 这条路径最怕退化成「反正都是连接失败」—— 那样用户只能瞎猜。
    new Notice(renderErrorMessage(error));
    return [];
  }

  if (result.truncated) {
    // 只有触顶才提示 —— 那时列表确实不完整。
    // 条数 = `LIST_PAGE_SIZE × MAX_PAGES_DEFAULT`，两个因子都取自 `pagination.ts` 的定义处：
    // 在这里写死 `× 20` 的话，改默认值会改到取数、改不到这句**渲染给用户看**的提示。
    new Notice(i18next.t("post_selection_modal.notice_truncated", { size: LIST_PAGE_SIZE * MAX_PAGES_DEFAULT }));
  }

  return toSelectablePosts(result.items);
}

/**
 * 扁平列表项 → 选择器条目。抽成纯函数，好让这层映射能被直接测到（无需 UI 脚手架）。
 *
 * 两处规范化都源自 schema 的事实：列表项的 `required` 只有
 * `["published", "publishRequested", "recycled", "categories", "tags"]` ——
 * **`name` / `title` / `slug` 都不在其中**，所以它们可能缺席。
 *
 * - **缺 `name` 的项直接剔除**：`name` 是 `pullPost` 的唯一入参，缺了它这个条目按下去必然失败；
 *   列一个按了就坏的按钮比不列更糟，也不该编一个空串去凑（同 `getCategoryNames` 不肯编造 name 的立场）。
 * - **缺 `title` 时回落成 `name`**：用 `||` 而非 `??` 是刻意的 —— 空串同样会让列表出现一行空白，
 *   显示场景要的是「非空」而不是「非 null」。
 */
export function toSelectablePosts(items: McpPostItem[]): SelectablePost[] {
  const posts: SelectablePost[] = [];

  for (const item of items) {
    if (!item.name) {
      continue;
    }

    posts.push({
      name: item.name,
      title: item.title || item.name,
      slug: item.slug ?? "",
    });
  }

  return posts;
}

export function openPostSelectionModal(plugin: HaloPluginContext, site: HaloSite): Promise<SelectablePost> {
  return new Promise<SelectablePost>((resolve) => {
    const modal = new PostSelectionModal(plugin, site, (post) => {
      resolve(post);
    });
    modal.open();
  });
}

class PostSelectionModal extends Modal {
  /**
   * 与 `HaloService` 同一套构造方式（同一个 `mcpEndpointOf` + `mcpToken`）。
   *
   * 这里**不做注入**：本 modal 是命令入口，没有测试会去替换它的 client ——
   * 取数与映射已抽成 `fetchSelectablePosts(client)` / `toSelectablePosts()`，测那一层即可，
   * 为此新造一套 UI mock 基建不划算。
   */
  private readonly client: McpClient;

  constructor(
    private readonly plugin: HaloPluginContext,
    private readonly site: HaloSite,
    private readonly onSelect: (post: SelectablePost) => void,
  ) {
    super(plugin.app);
    this.client = new McpClient({ endpoint: mcpEndpointOf(site), token: site.mcpToken });
  }

  onOpen() {
    const { contentEl } = this;

    const renderPostList = (): void => {
      contentEl.empty();

      contentEl.createEl("h2", {
        text: i18next.t("post_selection_modal.title"),
      });

      // 这里**没有 `.catch`**：`fetchSelectablePosts` 的契约就是「不抛」——
      // 失败时它自己弹提示并给空数组（见那里的说明）。再挂一个 catch 只会是死代码，
      // 而且会掩盖契约：读的人会以为失败是从这里兜的。
      //
      // `void` 是给 lint 的显式声明：这条链**故意**不被 await（`onOpen` 是同步的，UI 要先画出来，
      // 列表异步填进去），而它又确实带 `.finally` 收尾 —— 不是漏写。
      void fetchSelectablePosts(this.client)
        .then((posts) => {
          for (const post of posts) {
            const setting = new Setting(contentEl).setName(post.title).setDesc(post.slug);

            setting.addButton((button) =>
              button.setButtonText(i18next.t("post_selection_modal.button_pull")).onClick(() => {
                this.onSelect(post);
                this.close();
              }),
            );
          }
        })
        .finally(() => {
          new Setting(contentEl).addButton((button) =>
            button.setButtonText(i18next.t("common.button_close")).onClick(() => this.close()),
          );
        });
    };

    renderPostList();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
