import i18next from "i18next";
import { Modal, Notice, Setting } from "obsidian";
import type HaloPlugin from "./main";
import { describeMcpError } from "./mcp-self-check";
import type { McpPostItem } from "./service/post-mapping";
import { type HaloSite, mcpEndpointOf } from "./settings";
import { McpError } from "./transport/errors";
import { McpClient } from "./transport/mcp-client";

/**
 * 一页取多少篇。`size` 的 schema 上限就是 100（实测自 `halo_list_posts` 的 inputSchema）。
 *
 * 导出是给测试用的：截断提示的文案里带的正是这个数，测试若写死 100 就与实际值脱钩。
 */
export const LIST_PAGE_SIZE = 100;

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
 * 只声明**消费得上**的字段：响应里还有 `page` / `size` / `total` / `totalPages`
 * （schema 全部列为必需，实测确有），但本模块不读它们 —— 多声明就是一份要跟着服务端走的契约。
 * 将来真要翻页时，需要读的是 `totalPages`。
 */
interface PostListResult {
  items?: McpPostItem[];
  /**
   * 还有下一页时为 true。schema 把它列为必需，实测确实返回。
   *
   * 读它**只为一个目的**：列表不完整时告诉用户。注释救不了用户 —— 他会看到一份不完整的列表
   * 而不知道它不完整，然后以为某篇文章不存在（与本阶段反复处理的「静默」是同一类问题）。
   */
  hasNext?: boolean;
}

/**
 * 列表加载失败时给用户看的文案。
 *
 * 抽成独立函数（而不是写在 `catch` 里）是为了能被直接断言：这条路径最容易退化成
 * 「反正都是连接失败」，而 `McpError` 自带的 key 本身就是**可操作的处置指引**
 * （核对密钥 / 给这个密钥勾工具授权 / 检查端点与插件），丢掉它用户只能瞎猜。
 *
 * `detail` 必须拼上：工具级失败（HTTP 200 + `isError`）的归类只能是泛化的 `unknown`，
 * 而服务端原文全在 `detail` 里 —— 不拼的话这类失败就只剩一句「MCP 请求失败」
 * （`transport/errors.ts` 的 `toolFailureError` 对这一点有同样的要求）。
 * 拼接用换行而非标点：`detail` 是服务端原文、未经本地化，标点却需要翻译。
 *
 * （这条规则与 `HaloService.withErrorDetail` 相同；那个是私有的，故此处是第二份实现。
 * 若要把两份合一，正确做法是把这个纯函数提到 `transport/errors.ts` 共用，
 * 而不是继续各写一份 —— 但那会动到已经过审的服务层，故本轮只在这里注明。）
 */
export function describeListFailure(error: unknown): string {
  const { key, params } = describeMcpError(error);
  const message = i18next.t(key, params);

  if (error instanceof McpError && error.detail) {
    return `${message}\n${error.detail}`;
  }

  return message;
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
 * ⚠️ **本函数有副作用：它自己弹 Notice**，两处，都是刻意的 ——
 * 1. 列表不完整（`hasNext`）时提示「还有文章没有列出来」；
 * 2. 加载失败时提示**具体原因**，并返回空数组（**不抛**）。
 *
 * 提示放在这里而不是 modal 里，是为了让这两条都能被测到：modal 的渲染没有测试脚手架，
 * 而本阶段明确不新建一套 UI mock 基建。「吞掉异常并返回空」也与
 * `HaloService.readPostOrNotify` 同款 —— 命令入口不该把异常放给 Obsidian，
 * 它只会记进控制台，用户什么都看不到。
 *
 * ⚠️ **仍不翻页**：`size` 上限 100，站点文章数超过它就会漏。区别在于这里**会提示**，
 * 而不是静默漏掉（`HaloService.getCategories()` 面临同一处境，但那处只有注释、没有提示）。
 */
export async function fetchSelectablePosts(client: McpClient): Promise<SelectablePost[]> {
  let result: PostListResult;

  try {
    result = await client.callToolJson<PostListResult>("halo_list_posts", {
      page: 1,
      size: LIST_PAGE_SIZE,
    });
  } catch (error) {
    new Notice(describeListFailure(error));
    return [];
  }

  if (result.hasNext) {
    new Notice(i18next.t("post_selection_modal.notice_truncated", { size: LIST_PAGE_SIZE }));
  }

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

      // 这里**没有 `.catch`**：`fetchSelectablePosts` 的契约就是「不抛」——
      // 失败时它自己弹提示并给空数组（见那里的说明）。再挂一个 catch 只会是死代码，
      // 而且会掩盖契约：读的人会以为失败是从这里兜的。
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
