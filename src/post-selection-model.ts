import i18next from "i18next";
import { Modal, Notice, Setting } from "obsidian";
import type HaloPlugin from "./main";
import type { McpPostItem } from "./service/post-mapping";
import { type HaloSite, mcpEndpointOf } from "./settings";
import { McpClient } from "./transport/mcp-client";

/** 一页取多少篇。`size` 的 schema 上限就是 100（实测自 `halo_list_posts` 的 inputSchema）。 */
const LIST_PAGE_SIZE = 100;

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
 * `halo_list_posts` 的返回体。
 *
 * 只声明消费得上的 `items`：响应里还有 `page` / `size` / `total` / `totalPages` / `hasNext`
 * （schema 全部列为必需，实测确有），但本模块不读它们 —— 多声明就是一份要跟着服务端走的契约。
 * 将来要翻页时，需要读的正是 `hasNext` / `totalPages`。
 */
interface PostListResult {
  items?: McpPostItem[];
}

/**
 * 拉取可选择的文章列表。
 *
 * 走 MCP 的 `halo_list_posts`（**读路径 → `callToolJson`**）。此前这里直连 REST
 * `uc.api.content.halo.run/v1alpha1/posts` 并用 **PAT** 鉴权，是整条链路上最后一个还在用 REST 的读取点；
 * 切掉之后 PAT 只在「> 7 MiB 图片回退上传」这一条路上还有用。
 *
 * 不传 `published`：与迁移前的 REST 查询一致 —— 草稿与已发布都要列出来给用户选。
 * `recycled` 也不必显式传，schema 的默认值就是 `false`（等价于迁移前那句 `labelSelector=…deleted=false`）。
 *
 * ⚠️ **不翻页**：`size` 上限 100。站点现有文章数少于该值即一页取尽；一旦超过 100，
 * 这里会**漏掉后面的**。取舍与 `HaloService.getCategories()` 相同 ——
 * 已知的已知，写在注释里，而不是让它静默发生。
 */
export async function fetchSelectablePosts(client: McpClient): Promise<SelectablePost[]> {
  const result = await client.callToolJson<PostListResult>("halo_list_posts", {
    page: 1,
    size: LIST_PAGE_SIZE,
  });

  return toSelectablePosts(result.items ?? []);
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

export function openPostSelectionModal(plugin: HaloPlugin, site: HaloSite): Promise<SelectablePost> {
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
    private readonly plugin: HaloPlugin,
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

      fetchSelectablePosts(this.client)
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
        .catch(() => {
          new Notice(i18next.t("common.error_connection_failed"));
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
