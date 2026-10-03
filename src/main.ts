import i18next from "i18next";
import { Notice, Plugin, moment } from "obsidian";
import { resources } from "./i18n";
import { addHaloIcon } from "./icons";
import { describeSelfCheckFailure, runSelfCheck } from "./mcp-self-check";
import { openPostSelectionModal } from "./post-selection-model";
import HaloService from "./service";
import {
  type HaloSetting,
  HaloSettingTab,
  type HaloSite,
  isSameSiteUrl,
  mcpEndpointOf,
  migrateSettings,
  normalizeSite,
} from "./settings";
import { SettingsMigrationModal } from "./settings-migration-modal";
import { openSiteSelectionModal } from "./site-selection-modal";

export default class HaloPlugin extends Plugin {
  settings: HaloSetting;

  async onload() {
    console.log("loading obsidian-halo plugin");

    await i18next.init({
      lng: moment.locale(),
      fallbackLng: "en",
      resources,
      returnNull: false,
    });

    await this.loadSettings();

    addHaloIcon();

    this.addRibbonIcon("halo-logo", i18next.t("ribbon_icon.publish"), async (evt: MouseEvent) => {
      await this.publishCommand();
    });

    this.addCommand({
      id: "publish",
      name: i18next.t("command.publish.name"),
      callback: async () => {
        await this.publishCommand();
      },
    });

    this.addCommand({
      id: "publish-with-defaults",
      name: i18next.t("command.publish_with_defaults.name"),
      callback: async () => {
        const site = this.settings.sites.find((site) => site.default);

        if (!site) {
          new Notice(i18next.t("command.publish_with_defaults.error_no_default_site"));
          return;
        }

        if (!this.canPublishToSite(site)) {
          return;
        }

        const service = new HaloService(this.app, this.settings, site);
        const uploadResult = await this.uploadImagesForPublish(service);

        if (!uploadResult.success) {
          return;
        }

        await service.publishPost({ markdown: uploadResult.markdown });
      },
    });

    this.addCommand({
      id: "upload-images",
      name: i18next.t("command.upload_images.name"),
      callback: async () => {
        await this.uploadImagesCommand();
      },
    });

    this.addCommand({
      id: "update-post",
      name: i18next.t("command.update_post.name"),
      editorCallback: async () => {
        const { activeEditor } = this.app.workspace;

        if (!activeEditor || !activeEditor.file) {
          return;
        }

        const matterData = this.app.metadataCache.getFileCache(activeEditor.file)?.frontmatter;

        if (!matterData?.halo?.site) {
          new Notice(i18next.t("command.update_post.error_not_published"));
          return;
        }

        const site = this.getSiteByUrl(matterData.halo.site);

        if (!site) {
          new Notice(i18next.t("command.update_post.error_no_matched_site"));
          return;
        }

        const service = new HaloService(this.app, this.settings, site);

        await service.updatePost();

        new Notice(i18next.t("command.update_post.success"));
      },
    });

    this.addCommand({
      id: "pull-post",
      name: i18next.t("command.pull_post.name"),
      callback: async () => {
        if (this.settings.sites.length === 0) {
          new Notice(i18next.t("command.pull_post.error_no_sites"));
          return;
        }

        let site: HaloSite = this.settings.sites[0];

        if (this.settings.sites.length > 1) {
          site = await openSiteSelectionModal(this);
        }

        const post = await openPostSelectionModal(this, site);

        const service = new HaloService(this.app, this.settings, site);
        // 选择器给的是扁平条目（MCP 的表示），不再是 REST 的 `post.post.metadata.name`
        await service.pullPost(post.name);
      },
    });

    this.addCommand({
      id: "mcp-self-check",
      name: i18next.t("command.mcp_self_check.name"),
      callback: async () => {
        const site = this.settings.sites.find((item) => item.default) ?? this.settings.sites[0];

        if (!site) {
          new Notice(i18next.t("command.mcp_self_check.error_no_sites"));
          return;
        }

        new Notice(i18next.t("command.mcp_self_check.notice_checking"));

        const report = await runSelfCheck(mcpEndpointOf(site), site.mcpToken);

        if (report.error) {
          // 与站点编辑弹窗共用同一个文案函数（含服务端原文），免得两处各拼一遍框架
          new Notice(describeSelfCheckFailure(report.error));
          return;
        }

        if (report.ok) {
          new Notice(
            i18next.t("command.mcp_self_check.notice_ok", {
              name: report.server?.name,
              version: report.server?.version,
              count: report.availableCount,
            }),
          );
          return;
        }

        new Notice(
          i18next.t("command.mcp_self_check.notice_missing", {
            count: report.missing.length,
            tools: report.missing.join(", "),
          }),
        );
      },
    });

    this.addSettingTab(new HaloSettingTab(this));
  }

  onunload() {}

  async loadSettings() {
    const { settings, notices } = migrateSettings(await this.loadData());
    this.settings = settings;

    if (notices.length > 0) {
      // 弹窗依赖布局，推迟到布局就绪后再开：onload 期间 workspace 尚未就绪，
      // 此时打开 Modal 不符合 Obsidian 惯例。onLayoutReady 在布局已就绪时会立即执行回调。
      this.app.workspace.onLayoutReady(() => {
        new SettingsMigrationModal(this.app, notices[0], (switchToDraft) => {
          if (switchToDraft) {
            this.settings.publishByDefault = false;
          }
          // 必须放在 if 之外：migrateSettings() 盖上的 settingsVersion 只有经 saveData()
          // 才会落到 data.json。若只在「切草稿」这一支落盘，选「保持不变」的用户下次启动时
          // fromVersion 仍是 0，提示会一次次重复弹出 —— 等于告诉用户他的回答没生效。
          // 注意这里刻意不等 await：onDecide 是同步回调，落盘是浮空 Promise，不阻塞弹窗关闭。
          void this.saveSettings();
        }).open();
      });
    }
  }

  async saveSettings() {
    this.settings.sites = this.settings.sites.map(normalizeSite);
    await this.saveData(this.settings);
  }

  private async publishCommand() {
    const { activeEditor } = this.app.workspace;

    if (!activeEditor || !activeEditor.file) {
      return;
    }

    const matterData = this.app.metadataCache.getFileCache(activeEditor.file)?.frontmatter;

    if (matterData?.halo?.site) {
      const site = this.getSiteByUrl(matterData.halo.site);

      if (!site) {
        new Notice(i18next.t("command.publish.error_no_matched_site"));
        return;
      }

      const service = new HaloService(this.app, this.settings, site);
      const uploadResult = await this.uploadImagesForPublish(service);

      if (!uploadResult.success) {
        return;
      }

      await service.publishPost({ markdown: uploadResult.markdown });
      return;
    }

    if (this.settings.sites.length === 0) {
      new Notice(i18next.t("command.publish.error_no_sites"));
      return;
    }

    const site = await openSiteSelectionModal(this);
    const service = new HaloService(this.app, this.settings, site);
    const uploadResult = await this.uploadImagesForPublish(service);

    if (!uploadResult.success) {
      return;
    }

    await service.publishPost({ markdown: uploadResult.markdown });
  }

  private async uploadImagesCommand() {
    const site = await this.getSiteForActiveFile();

    if (!site) {
      return;
    }

    const service = new HaloService(this.app, this.settings, site);
    await service.uploadImages();
    await this.saveSettings();
  }

  private async getSiteForActiveFile(): Promise<HaloSite | undefined> {
    const { activeEditor } = this.app.workspace;

    if (!activeEditor || !activeEditor.file) {
      return undefined;
    }

    const matterData = this.app.metadataCache.getFileCache(activeEditor.file)?.frontmatter;

    if (matterData?.halo?.site) {
      const site = this.getSiteByUrl(matterData.halo.site);

      if (!site) {
        new Notice(i18next.t("command.upload_images.error_no_matched_site"));
        return undefined;
      }

      return site;
    }

    if (this.settings.sites.length === 0) {
      new Notice(i18next.t("command.upload_images.error_no_sites"));
      return undefined;
    }

    if (this.settings.sites.length === 1) {
      return this.settings.sites[0];
    }

    return openSiteSelectionModal(this);
  }

  private async uploadImagesForPublish(service: HaloService): Promise<{ success: boolean; markdown?: string }> {
    const uploadResult = await service.uploadImages({ silent: true });
    await this.saveSettings();

    if (uploadResult.failedCount > 0) {
      new Notice(i18next.t("service.error_upload_images_failed_publish_aborted", { failed: uploadResult.failedCount }));
      return { success: false };
    }

    return {
      success: true,
      markdown: uploadResult.markdown,
    };
  }

  private canPublishToSite(site: HaloSite): boolean {
    const { activeEditor } = this.app.workspace;

    if (!activeEditor || !activeEditor.file) {
      return false;
    }

    const matterData = this.app.metadataCache.getFileCache(activeEditor.file)?.frontmatter;

    if (matterData?.halo?.site && !isSameSiteUrl(matterData.halo.site, site.url)) {
      new Notice(i18next.t("service.error_site_not_match"));
      return false;
    }

    return true;
  }

  private getSiteByUrl(url: string): HaloSite | undefined {
    return this.settings.sites.find((site) => isSameSiteUrl(site.url, url));
  }
}
