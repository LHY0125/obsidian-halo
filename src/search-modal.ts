import i18next from "i18next";
import { type App, Modal, Setting } from "obsidian";
import type HaloPlugin from "./main";
import type { SearchResult } from "./search-preview";
import { type HaloSite, normalizeSiteUrl } from "./settings";

/**
 * 摘要截断长度。
 *
 * 弹窗是「看一眼是不是已经写过」的地方，不是阅读器 —— 实测站点 2026-10-05 的 7 条结果
 * excerpt 全在 200 字符以上（最长的一条 328 字符、最短的 245），逐条铺开会把「一共几条」挤出屏幕。
 * 想看全文，点那一行的「打开」。
 */
const EXCERPT_MAX_LENGTH = 200;

/** 一行的渲染依据。理由见 `buildSearchRows()`。 */
export interface SearchRow {
  title: string;
  /** 已截断到 `EXCERPT_MAX_LENGTH` 的摘要 */
  excerpt: string;
  /** 决定类型 tooltip 用哪一档（`search_modal.type_POST` / `type_SINGLE_PAGE`） */
  type: "POST" | "SINGLE_PAGE";
  icon: string;
  /** 草稿标记：为 true 才画那个铅笔图标 */
  isDraft: boolean;
  /** 「打开」按钮的地址；**空串表示没有可打开的地址**，此时不画按钮 */
  openUrl: string;
}

/**
 * 搜索结果 → 弹窗要逐行渲染的数据。
 *
 * 抽成纯函数是因为**弹窗本身没有测试脚手架**：`tests/setup.ts` 把 `obsidian` 整体 mock 了，
 * 而那个 `Modal.open()` 不调 `onOpen()` —— 弹窗里那个 `for` 加两个 `if` 一行都跑不到。
 * 凡是能在弹窗外面算出来的都算出来，弹窗里就只剩 `createEl`。与 `publish-preview.ts` 的
 * `buildPublishPreview()` 是同一条约定。
 *
 * 但**文案本身不在这里**：这里给的是「该用哪个键」的判据（`type` / `isDraft` / `openUrl`），
 * `i18next.t()` 留在弹窗里 —— 同样与 `buildPublishPreview()` 一致，它回的是 `visible: "PUBLIC"`
 * 这类原值，而不是翻好的标签。
 */
export function buildSearchRows(siteUrl: string, results: SearchResult[]): SearchRow[] {
  const base = normalizeSiteUrl(siteUrl);

  return results.map((result) => ({
    title: result.title,
    excerpt: result.excerpt.slice(0, EXCERPT_MAX_LENGTH),
    type: result.type,
    // 文章与独立页面共用一个列表，两者**必须能分辨**：同名的一篇文章与一个页面
    // 在列表里长得一模一样，而用户点开的会是完全不同的东西。
    // 图标名带 `lucide-` 前缀，与 `settings.ts` / `sites-modal.ts` 里的既有用法一致。
    icon: result.type === "POST" ? "lucide-file-text" : "lucide-file",
    // `published` 已由 `toSearchResults()` 归一成布尔（`item.published === true`），
    // 所以这里取反是安全的，不会把 `undefined` 变成「草稿」。
    isDraft: !result.published,
    openUrl: permalinkUrl(base, result.permalink),
  }));
}

/**
 * 站点地址 + permalink → 绝对地址。
 *
 * 实测（2026-10-05 对站点调 `halo_search_content`）：permalink 形如
 * `/archives/halo-dark-mode-plugin2`、`/archives/6jSWyj8U`、单页则是 `/about`、`/Registration-Agreement`
 * —— **都以 `/` 开头**。即便这样也仍然归一化两边的斜杠：permalink 少一个前导 `/` 时，
 * 朴素的 `base + permalink` 会拼出 `https://blog.example.comarchives/x` 这种**看起来像成功、
 * 点开却是 404** 的地址，而这里没有任何东西能察觉它（按钮就在那儿，只是打不开）。
 *
 * 空 permalink 回落空串，好让调用方用一个判据（`if (row.openUrl)`）决定画不画按钮。
 */
function permalinkUrl(base: string, permalink: string): string {
  const path = permalink.replace(/^\/+/, "");

  return path === "" ? "" : `${base}/${path}`;
}

/**
 * 把输入框里的文字归一成查询词；空则 `undefined`。
 *
 * 空串**不是**合法查询：`halo_search_content` 的入参 schema 是 `minLength: 1`，
 * 实测传空串会被服务端拒掉（2026-10-05）：
 *
 * ```
 * Tool (halo_search_content) input validation failed:
 * Validation failed: JSON schema validation errors: [/query: must be at least 1 characters long]
 * ```
 *
 * 归一成 `undefined` 让命令入口能用一个判据同时挡住两种输入：「用户取消」与「用户什么都没输」
 * —— 两者对用户是同一件事（我没想查），不该一个静默返回、另一个弹一条报错。
 */
export function normalizeQuery(value: string): string | undefined {
  const trimmed = value.trim();

  return trimmed === "" ? undefined : trimmed;
}

/**
 * 查重结果列表。
 *
 * 用弹窗而不是 `Notice`：结果最多几十条（`searchContent` 传的是 `limit: 50`），
 * 而 `Notice` 几秒就消失且不可复制 —— 用户此刻要的是「逐条看、逐条点开」，
 * 那是 Notice 做不到的。
 */
export class SearchResultsModal extends Modal {
  constructor(
    plugin: HaloPlugin,
    private readonly site: HaloSite,
    private readonly query: string,
    private readonly results: SearchResult[],
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: i18next.t("search_modal.title", { query: this.query }) });

    if (this.results.length === 0) {
      // 「什么都没找到」是一条**结论**，不是一片空白 —— 用户跑完查重却看到空弹窗，
      // 会怀疑是插件坏了，而不是「站点上确实没有这篇」。
      contentEl.createEl("p", { text: i18next.t("search_modal.empty") });
    }

    for (const row of buildSearchRows(this.site.url, this.results)) {
      const setting = new Setting(contentEl).setName(row.title).setDesc(row.excerpt);

      // 类型图标与草稿图标都是**只有图标、没有文字**的按钮，tooltip 因此是必需的：
      // 去掉它，这两个图标对用户就是哑的，只能靠猜。
      setting.addExtraButton((button) =>
        button.setIcon(row.icon).setTooltip(i18next.t(`search_modal.type_${row.type}`)),
      );

      if (row.isDraft) {
        setting.addExtraButton((button) =>
          button.setIcon("lucide-pencil").setTooltip(i18next.t("search_modal.badge_draft")),
        );
      }

      if (row.openUrl) {
        setting.addButton((button) =>
          button.setButtonText(i18next.t("search_modal.button_open")).onClick(() => {
            // 用系统浏览器打开站点上的那一篇。**不**在 Obsidian 内部打开 ——
            // 查重的目的是「看看是不是已经写过」，而站点上那份才是权威的已发布版本。
            window.open(row.openUrl, "_blank");
          }),
        );
      }
    }

    new Setting(contentEl).addButton((button) =>
      button.setButtonText(i18next.t("common.button_close")).onClick(() => this.close()),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * 问一个关键词。取消时返回 `undefined`（**不是空串** —— 空串会被服务端以
 * `minLength: 1` 拒绝，理由见 `normalizeQuery()`）。
 */
export function promptForQuery(app: App, defaultValue: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    new QueryPromptModal(app, defaultValue, resolve).open();
  });
}

class QueryPromptModal extends Modal {
  private value: string;

  constructor(
    app: App,
    defaultValue: string,
    private readonly onDecide: (query: string | undefined) => void,
  ) {
    super(app);
    this.value = defaultValue;
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: i18next.t("search_modal.prompt_title") });

    new Setting(contentEl).setName(i18next.t("search_modal.prompt_label")).addText((text) =>
      text.setValue(this.value).onChange((value) => {
        // 这里存**原值**，归一（去空白、空串 → undefined）留给 `normalizeQuery()`：
        // 那是判据所在，抽出去才能被单独测到。
        this.value = value;
      }),
    );

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(i18next.t("common.button_cancel")).onClick(() => {
          this.onDecide(undefined);
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText(i18next.t("search_modal.button_search"))
          .setCta()
          .onClick(() => {
            this.onDecide(normalizeQuery(this.value));
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
