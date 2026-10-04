import i18next from "i18next";
import { PluginSettingTab, Setting } from "obsidian";
// 从 "glob" 而不是 "site-routing" 取这两个符号：glob.ts 是零项目内依赖的叶子，
// 而 site-routing.ts 反过来 import 本文件。从那边取会重新造出 settings ⇄ site-routing 的 import 环。
import { type SiteRoutingRule, matchGlob, normalizeRulePattern } from "./glob";
import type HaloPlugin from "./main";
import { openSiteRoutingModal } from "./site-routing-modal";
import { HaloSitesModal } from "./sites-modal";

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
  constructor(private readonly plugin: HaloPlugin) {
    super(plugin.app, plugin);
  }

  display() {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName(i18next.t("settings.site.name"))
      .setDesc(i18next.t("settings.site.description"))
      .addButton((button) =>
        button.setButtonText(i18next.t("settings.site.actions.open")).onClick(() => {
          new HaloSitesModal(this.plugin).open();
        }),
      );

    new Setting(containerEl)
      .setName(i18next.t("settings.publishByDefault.name"))
      .setDesc(i18next.t("settings.publishByDefault.description"))
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.publishByDefault).onChange((value) => {
          this.plugin.settings.publishByDefault = value;
          this.plugin.saveSettings();
        });
      });

    // 紧挨着 `publishByDefault`：两者都是「发布这一次要怎么做」的开关，放在一起才不会被
    // 当成两件无关的事。注意它们的语义**完全不同**（一个是"发还是存草稿"、一个是"要不要
    // 先看一眼"），所以是两个键 —— 见 `HaloSetting.skipPreviewOnPublish` 的说明。
    new Setting(containerEl)
      .setName(i18next.t("settings.skipPreviewOnPublish.name"))
      .setDesc(i18next.t("settings.skipPreviewOnPublish.description"))
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.skipPreviewOnPublish).onChange((value) => {
          this.plugin.settings.skipPreviewOnPublish = value;
          this.plugin.saveSettings();
        });
      });

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
            this.display();
          }
        }),
      );
      setting.addExtraButton((button) =>
        button.setIcon("lucide-trash").onClick(() => {
          rules.splice(index, 1);
          this.plugin.saveSettings();
          this.display();
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
          this.display();
        }
      }),
    );

    new Setting(containerEl)
      .setName(i18next.t("settings.replaceImageLinks.name"))
      .setDesc(i18next.t("settings.replaceImageLinks.description"))
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.replaceImageLinks).onChange((value) => {
          this.plugin.settings.replaceImageLinks = value;
          this.plugin.saveSettings();
        });
      });
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
    this.display();
  }
}
