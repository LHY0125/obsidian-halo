import i18next from "i18next";
import { PluginSettingTab, Setting } from "obsidian";
import type HaloPlugin from "./main";
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
  replaceImageLinks: boolean;
  imageUploadCache: Record<string, Record<string, ImageUploadCacheEntry>>;
}

export const DEFAULT_SETTINGS: HaloSetting = {
  settingsVersion: CURRENT_SETTINGS_VERSION,
  sites: [],
  publishByDefault: false,
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
}
