import i18next from "i18next";
import { Modal, Setting } from "obsidian";
import type HaloPlugin from "./main";
import type { McpSinglePageItem } from "./service/page-mapping";
import PageService from "./service/page-service";
import type { HaloSite } from "./settings";

/**
 * 选择器需要的最小字段集。理由同 `post-selection-model.ts` 的 `SelectablePost`：
 * **刻意不是 `Pick<McpSinglePageItem, …>`** —— 那个类型的字段全是可选的（服务层对缺失字段有回落），
 * 而选择器要的是「一定拿得到东西」的形状，否则 `setName()` 与 `pullPage()` 都得处理 undefined。
 * 规范化由 `toSelectablePages` 一次做完。
 */
export interface SelectablePage {
  /** `metadata.name` —— 拉取时唯一的标识。schema 未把它列为必需，缺失的项已在映射时剔除。 */
  name: string;
  /** 列表里显示的标题。缺 `title` 时回落成 `name`，否则会出现一行空白。 */
  title: string;
  /** 列表里的副标题，单纯给用户辨认用，可以为空串。 */
  slug: string;
}

/**
 * 扁平列表项 → 选择器条目。抽成纯函数，好让这层映射能被直接测到（无需 UI 脚手架）。
 *
 * 三条规范化都源自 schema 的事实：`halo_list_single_pages` 的 item `required` 只有
 * `["published", "publishRequested", "recycled"]` —— **`name` / `title` / `slug` 都不在其中**。
 *
 * 与 `toSelectablePosts` 逐字同构，**但刻意不复用同一个函数**：两个函数的入参类型不同
 * （`McpPostItem` vs `McpSinglePageItem`），强行合一会让签名退化成 `{ name?: string }` 这类
 * 结构类型，从而失去「文章项与页面项的字段集不同」这条信息 —— 而那条信息正是
 * `page-mapping.ts` 花了一整段注释立下的规矩（页面比文章少 9 个字段，多一个就会被
 * `additionalProperties: false` 拒绝）。
 *
 * 三处规范化的理由逐条同 `toSelectablePosts`：缺 `name` 直接剔除（那是 `pullPage` 的唯一入参，
 * 列一个按了就坏的按钮比不列更糟）；缺 `title` 用 `||` 而非 `??` 回落（空串同样是一行空白，
 * 显示场景要的是「非空」而不是「非 null」）；缺 `slug` 回落空串（它只是副标题，不是标识）。
 */
export function toSelectablePages(items: McpSinglePageItem[]): SelectablePage[] {
  const pages: SelectablePage[] = [];

  for (const item of items) {
    if (!item.name) {
      continue;
    }

    pages.push({
      name: item.name,
      title: item.title || item.name,
      slug: item.slug ?? "",
    });
  }

  return pages;
}

export function openPageSelectionModal(plugin: HaloPlugin, site: HaloSite): Promise<SelectablePage> {
  return new Promise<SelectablePage>((resolve) => {
    new PageSelectionModal(plugin, site, resolve).open();
  });
}

class PageSelectionModal extends Modal {
  /**
   * 取数走 `PageService.getPages()` 而**不是**在这里自己造一个 `McpClient` ——
   * 与文章那条选择器的唯一结构差异。理由：页面列表要翻页，而翻页与「触顶提示」
   * 都已经在服务层里了；在这里重造 client 就是把那段逻辑抄第二遍，
   * 抄漏的那次表现是「选择器里少了一部分页面」，而用户会以为它们不存在。
   */
  private readonly service: PageService;

  constructor(
    private readonly plugin: HaloPlugin,
    private readonly site: HaloSite,
    private readonly onSelect: (page: SelectablePage) => void,
  ) {
    super(plugin.app);
    this.service = new PageService(plugin.app, plugin.settings, site);
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: i18next.t("page_selection_modal.title") });

    // 这里**没有 `.catch`**：`getPages` 的契约就是「不抛」—— 失败时它自己弹提示并给空数组
    //（与 `fetchSelectablePosts` 同款，见那里的说明）。再挂一个 catch 只会是死代码，
    // 而且会掩盖契约：读的人会以为失败是从这里兜的。
    this.service
      .getPages()
      .then((items) => {
        for (const page of toSelectablePages(items)) {
          new Setting(contentEl)
            .setName(page.title)
            .setDesc(page.slug)
            .addButton((button) =>
              button.setButtonText(i18next.t("page_selection_modal.button_pull")).onClick(() => {
                this.onSelect(page);
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
  }

  onClose() {
    this.contentEl.empty();
  }
}
