import i18next from "i18next";
import { PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
// 从 "glob" 而不是 "site-routing" 取这两个符号：glob.ts 是零项目内依赖的叶子，
// 而 site-routing.ts 反过来 import 本文件。从那边取会重新造出 settings ⇄ site-routing 的 import 环。
import { type SiteRoutingRule, matchGlob, normalizeRulePattern } from "./core/glob";
import type HaloPlugin from "./main";
import { openSiteRoutingModal } from "./ui/modals/site-routing-modal";
import { HaloSitesModal } from "./ui/modals/sites-modal";

export interface HaloSite {
  name: string;
  url: string;
  /** Halo 个人访问令牌（PAT）。仅用于 >7MiB 图片的 REST 回退上传，MCP 路径不使用 */
  token: string;
  /** MCP 访问密钥，以 hmcp_ 开头。与 token 是两种不同凭据，不可互换 */
  mcpToken: string;
  default: boolean;
}

export interface ImageUploadCacheEntry {
  filePath: string;
  linkType?: "markdown" | "wiki";
  size: number;
  mtime: number;
  permalink: string;
  updatedAt: number;
  wikiAlias?: string;
}

export const CURRENT_SETTINGS_VERSION = 1;

export interface HaloSetting {
  settingsVersion: number;
  sites: HaloSite[];
  publishByDefault: boolean;
  /**
   * 发布前是否跳过预览弹窗。默认 `false` = **显示预览**。
   *
   * 刻意不复用 `publishByDefault` 来承载这个语义：那个键名里有 "publish" 却管的是"发布还是草稿"，
   * 拿它同时表示"要不要弹窗"会让读者长期误读（spec §5.2 明确点名了这一点）。
   */
  skipPreviewOnPublish: boolean;
  /** 站点路由规则。**数组顺序就是优先级**（自上而下取首个命中），所以任何地方都不能重排 */
  siteRouting: SiteRoutingRule[];
  replaceImageLinks: boolean;
  imageUploadCache: Record<string, Record<string, ImageUploadCacheEntry>>;
}

export const DEFAULT_SETTINGS: HaloSetting = {
  settingsVersion: CURRENT_SETTINGS_VERSION,
  sites: [],
  publishByDefault: false,
  skipPreviewOnPublish: false,
  siteRouting: [],
  replaceImageLinks: true,
  imageUploadCache: {},
};

export function normalizeSiteUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** 站点 URL 与 MCP 端点的推导规则：<url 去尾斜杠>/mcp */
export function mcpEndpointOf(site: HaloSite): string {
  return `${normalizeSiteUrl(site.url)}/mcp`;
}

export function normalizeSite(site: HaloSite): HaloSite {
  return {
    ...site,
    url: normalizeSiteUrl(site.url),
    mcpToken: site.mcpToken ?? "",
  };
}

export interface MigrationNotice {
  key: "publishByDefault-true";
}

export interface MigrationResult {
  settings: HaloSetting;
  notices: MigrationNotice[];
}

/**
 * 规整规则表：丢掉模式为空的行、把模式写成库内路径的形态。
 *
 * **绝不重排、绝不去重、绝不丢掉指向未知站点的行** —— 数组顺序就是优先级，
 * 而指向未知站点的行是用户要去修的东西（`resolveSite` 会明确报出来），悄悄删掉它
 * 等于把「规则写错了」变成「规则不见了」。
 */
function normalizeRoutingRules(raw: unknown): SiteRoutingRule[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((rule): rule is SiteRoutingRule => typeof rule === "object" && rule !== null)
    .map((rule) => ({
      // 先摊开原对象、再用归一化后的值覆盖已知字段。`SiteRoutingRule` 今天恰好只有这两个字段，
      // 所以当前零损失；风险在将来 —— 谁给类型加了第三个字段却忘了改这个 mapper，
      // 那个字段会**每次加载都被剥掉、再被 saveData() 永久写掉**，用户视角是「我改的配置自己没了」。
      // 摊开之后这里对未知字段免疫。
      ...rule,
      pattern: normalizeRulePattern(String(rule.pattern ?? "")),
      site: String(rule.site ?? ""),
    }))
    .filter((rule) => rule.pattern !== "");
}

/**
 * 把任意来源的原始设置迁移到当前版本。
 *
 * 纯函数：不读磁盘、不弹窗、不写盘，便于测试。
 * 只产出 notices，绝不静默修改用户已有的值 —— 默认值变更对已装用户无效，
 * 静默覆盖用户配置是难以察觉的坏行为。
 */
export function migrateSettings(raw: unknown): MigrationResult {
  const source = (raw ?? {}) as Partial<HaloSetting> & { settingsVersion?: number };
  const merged = Object.assign({}, DEFAULT_SETTINGS, source);
  const notices: MigrationNotice[] = [];

  const fromVersion = typeof source.settingsVersion === "number" ? source.settingsVersion : 0;

  if (fromVersion < CURRENT_SETTINGS_VERSION && merged.publishByDefault === true) {
    notices.push({ key: "publishByDefault-true" });
  }

  return {
    settings: {
      ...merged,
      settingsVersion: CURRENT_SETTINGS_VERSION,
      sites: (merged.sites ?? []).map(normalizeSite),
      siteRouting: normalizeRoutingRules(merged.siteRouting),
      skipPreviewOnPublish: merged.skipPreviewOnPublish === true,
      imageUploadCache: { ...(merged.imageUploadCache ?? {}) },
    },
    notices,
  };
}

export function isSameSiteUrl(left: string, right: string): boolean {
  return normalizeSiteUrl(left) === normalizeSiteUrl(right);
}

export class HaloSettingTab extends PluginSettingTab {
  /**
   * ⚠️ 这里**必须**是真正的 `HaloPlugin`，不能用 `HaloPluginContext`。
   *
   * `PluginSettingTab` 的构造函数签名是 `(app: App, plugin: Plugin)` —— 它要的是 Obsidian 的
   * **基类** `Plugin`，而 `HaloPluginContext` 是刻意收窄的接口（只有 `app` / `settings` /
   * `saveSettings` 三个成员），不满足 `Plugin`。改成接口会直接报
   * 「Argument of type 'HaloPluginContext' is not assignable to parameter of type 'Plugin'」。
   *
   * 所以本文件保留对 `main.ts` 的类型依赖 —— 这是**类型系统的要求**，不是漏改。
   * 它也不破坏「切断反向依赖」这个目标：`main.ts` 要 `addSettingTab(new HaloSettingTab(this))`，
   * 两边都是 `import type`，运行时无环。真正解掉的是其余 11 个 UI 文件对 `main.ts` 的回指。
   */
  constructor(private readonly plugin: HaloPlugin) {
    super(plugin.app, plugin);
  }

  /**
   * 声明式设置定义 —— 让设置项出现在 Obsidian 1.13+ 的**设置搜索**里。
   *
   * 为什么必须实现它：不实现时审核器会报
   * 「This PluginSettingTab does not implement getSettingDefinitions(); its settings will not
   * appear in Obsidian's settings search」。而 `display()` 里手写的 `new Setting(...)` 对
   * 搜索索引是**不可见**的 —— 用户搜「图片链接」找不到这个开关。
   *
   * ⚠️ **只声明「简单项」**：四个开关/按钮。站点路由规则那张表**留在 `display()` 里**，
   * 因为它每行带三个图标按钮（上移/下移/编辑/删除）与实时命中数，声明式 API 表达不了
   * 这种「一行多个动作 + 每次渲染重算」的结构 —— 硬套只会写出比现在更难懂的代码。
   *
   * 两类混用是官方支持的：`getSettingDefinitions()` 提供可搜索的项，`display()` 里
   * 追加自定义 UI。**顺序上 `display()` 先执行**（父类渲染声明式项之后调用它），
   * 所以下面用 `containerEl.createEl("h3")` 自己画小标题，把两组分开。
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const t = (key: string) => i18next.t(`settings.${key}`);

    return [
      {
        type: "page",
        name: t("site.name"),
        desc: t("site.description"),
        items: [
          {
            name: t("site.name"),
            desc: t("site.description"),
            action: () => {
              new HaloSitesModal(this.plugin).open();
            },
          },
        ],
      },
      {
        type: "page",
        name: "Publishing",
        items: [
          {
            name: t("publishByDefault.name"),
            desc: t("publishByDefault.description"),
            control: { type: "toggle", key: "publishByDefault" },
          },
          // 紧挨着 `publishByDefault`：两者都是「发布这一次要怎么做」的开关，放在一起才不会被
          // 当成两件无关的事。注意它们的语义**完全不同**（一个是"发还是存草稿"、一个是"要不要
          // 先看一眼"），所以是两个键 —— 见 `HaloSetting.skipPreviewOnPublish` 的说明。
          {
            name: t("skipPreviewOnPublish.name"),
            desc: t("skipPreviewOnPublish.description"),
            control: { type: "toggle", key: "skipPreviewOnPublish" },
          },
          {
            name: t("replaceImageLinks.name"),
            desc: t("replaceImageLinks.description"),
            control: { type: "toggle", key: "replaceImageLinks" },
          },
        ],
      },
    ];
  }

  /**
   * 读一个声明式控件的当前值。基类默认从 `app.vault.getConfig` 读（那是给 Obsidian
   * 自己的设置页用的），插件必须覆盖成读自己的设置对象。
   */
  getControlValue(key: string): unknown {
    return (this.plugin.settings as unknown as Record<string, unknown>)[key];
  }

  /**
   * 写一个声明式控件的值并落盘。
   *
   * 返回 Promise 会让框架等它写完再重绘 —— 但本插件的设置是纯内存赋值 + `saveData()`，
   * 不 await 也不会出现「界面显示了新值、磁盘上还是旧的」的错位（`saveData` 失败时
   * 用户下次打开会看到回退，属于可接受的降级）。这里仍然返回 Promise 以如实反映
   * `saveSettings()` 的签名。
   */
  setControlValue(key: string, value: unknown): Promise<void> {
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    return this.plugin.saveSettings();
  }

  display() {
    const { containerEl } = this;

    containerEl.empty();

    // ⚠️ 站点、发布开关、替换图片链接这三组**不在这里渲染** —— 它们已经由
    // `getSettingDefinitions()` 声明式提供（那样才能进设置搜索）。这里再写一遍会让
    // 每一项**渲染两次**。本方法只负责声明式 API 表达不了的部分：路由规则那张表。

    new Setting(containerEl)
      .setName(i18next.t("settings.siteRouting.name"))
      .setDesc(i18next.t("settings.siteRouting.description"))
      .setHeading();

    const rules = this.plugin.settings.siteRouting;

    if (rules.length === 0) {
      containerEl.createEl("p", { text: i18next.t("settings.siteRouting.empty") });
    }

    // 一次遍历算出每行的命中数：vault 里的 markdown 文件清单是现成的，规则又只有几条，
    // 复杂度是 files × rules —— 当前规模（百余篇、个位数规则）下可以忽略。
    const markdownFiles = this.plugin.app.vault.getMarkdownFiles();

    rules.forEach((rule, index) => {
      const matchCount = markdownFiles.filter((file) => matchGlob(rule.pattern, file.path)).length;
      // 用 `||` 而不是 `??`：站点被找到但 `name` 是空串时，`""` **不是 nullish**，`??` 拦不住它，
      // 行标题会渲染成「博客/** → 」——箭头后面空白，而这一栏正是本面板存在的理由。
      // 空串在这里的语义是「用户只填了 URL、还没填名字」（新建站点的默认字面量就是 `name: ""`，
      // 且新增路径不校验 name），不是「这个站点有意义地没有名字」。
      // 与 site-routing-modal 里 `site.name || site.url` 保持同一形态。
      const siteName = this.plugin.settings.sites.find((site) => isSameSiteUrl(site.url, rule.site))?.name || rule.site;
      const setting = new Setting(containerEl)
        .setName(`${rule.pattern} → ${siteName}`)
        .setDesc(
          matchCount === 0
            ? i18next.t("settings.siteRouting.no_match")
            : i18next.t("settings.siteRouting.match_count", { count: matchCount }),
        );

      setting.addExtraButton((button) =>
        button
          .setIcon("lucide-arrow-up")
          .setDisabled(index === 0)
          .onClick(() => {
            this.moveRule(index, index - 1);
          }),
      );
      setting.addExtraButton((button) =>
        button
          .setIcon("lucide-arrow-down")
          .setDisabled(index === rules.length - 1)
          .onClick(() => {
            this.moveRule(index, index + 1);
          }),
      );
      setting.addExtraButton((button) =>
        button.setIcon("lucide-pencil").onClick(async () => {
          const updated = await openSiteRoutingModal(this.plugin, rule);

          if (updated) {
            rules[index] = updated;
            await this.plugin.saveSettings();
            this.update();
          }
        }),
      );
      setting.addExtraButton((button) =>
        button.setIcon("lucide-trash").onClick(() => {
          rules.splice(index, 1);
          void this.plugin.saveSettings();
          this.update();
        }),
      );
    });

    new Setting(containerEl).addButton((button) =>
      button.setButtonText(i18next.t("settings.siteRouting.actions.add")).onClick(async () => {
        const rule = await openSiteRoutingModal(this.plugin);

        if (rule) {
          // 追加到末尾：新规则默认优先级最低。要把它提到前面去，用行上的上移按钮 ——
          // 静默插到最前面会让既有用户下次发布时突然改了目标站点。
          rules.push(rule);
          await this.plugin.saveSettings();
          this.update();
        }
      }),
    );
  }

  /** 交换两条规则的顺序。**顺序就是优先级**，所以这是本设置面板里唯一改语义的操作 */
  private moveRule(from: number, to: number): void {
    const rules = this.plugin.settings.siteRouting;

    // `from` 与 `to` 一起校验。今天 `from` 必定合法（两个参数都来自同一次渲染的下标，
    // 上/下按钮又被 `setDisabled` 挡了边界），但一旦它越界，`splice` 返回空数组、`moved` 就是
    // `undefined`，而 `undefined` 会被当作一条规则插回数组并 `saveSettings()` 落盘 ——
    // 紧接着的 `display()` 才在 `rule.pattern` 上抛，那时坏数据已经在磁盘上了。
    if (from < 0 || from >= rules.length || to < 0 || to >= rules.length) {
      return;
    }

    const [moved] = rules.splice(from, 1);
    rules.splice(to, 0, moved);
    void this.plugin.saveSettings();
    this.update();
  }
}
