import i18next from "i18next";
import { Notice, Plugin, type TFile, moment } from "obsidian";
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
import { type SiteResolution, resolveSite } from "./site-routing";
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
        // 这条命令**刻意不经过 `resolveSite`**：它的语义就是「用默认站点」，
        // 让路由规则来改写目标会与命令名直接冲突。`canPublishToSite` 那道守卫
        // （笔记的 halo.site 与目标站点不一致时报错）因此也只在这条路径上有用。
        const site = this.settings.sites.find((site) => site.default);

        if (!site) {
          new Notice(i18next.t("command.publish_with_defaults.error_no_default_site"));
          return;
        }

        if (!this.canPublishToSite(site)) {
          return;
        }

        // `canPublishToSite` 已经确认过有活动文件；这里再取一次是为了把**文件本身**拿在手上 ——
        // `publishPost` / `uploadImages` 现在都收显式文件，不再各自去读活动编辑器。
        const { activeEditor } = this.app.workspace;

        if (!activeEditor?.file) {
          return;
        }

        const service = new HaloService(this.app, this.settings, site);
        const uploadResult = await this.uploadImagesForPublish(service, activeEditor.file);

        if (!uploadResult.success) {
          return;
        }

        await service.publishPost(activeEditor.file, { markdown: uploadResult.markdown });
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

    // 这一处是**行为变更**（刻意的）：改动前 `publishCommand` 在没有 `halo.site` 时
    // 一律弹窗选站点，**完全忽略设置里的默认站点与唯一站点**；而 `CLAUDE.md` 一直写着
    // 的优先级是「frontmatter → 默认站点 → 单站点直取 → 弹窗」。改动后两端一致。
    // 注意 `resolveSite` 的实际顺序比那句**多一层**：frontmatter → **路由规则表** → 默认站点
    // → 单站点直取 → 弹窗（规则表是 Task 5 新加的，`CLAUDE.md` 那句还没跟上）。
    // 差别是实质性的：笔记一旦命中某条规则，目标就由规则决定，轮不到默认站点。
    // 最直观的差别：只配了一个站点的用户不再每次发布都看一眼只有一个选项的弹窗。
    const resolution = this.resolveSiteFor(activeEditor.file);
    const site = await this.siteForResolution(resolution);

    if (!site) {
      return;
    }

    const service = new HaloService(this.app, this.settings, site);
    const uploadResult = await this.uploadImagesForPublish(service, activeEditor.file);

    if (!uploadResult.success) {
      return;
    }

    await service.publishPost(activeEditor.file, { markdown: uploadResult.markdown });
  }

  private async uploadImagesCommand() {
    const { activeEditor } = this.app.workspace;

    // 守卫与 `getSiteForActiveFile()` 内部那道重复 —— 但这里需要把**文件本身**拿在手上
    //（`uploadImages` 现在收显式文件），所以先取一份，再让它去解析站点。
    if (!activeEditor || !activeEditor.file) {
      return;
    }

    const file = activeEditor.file;
    const site = await this.getSiteForActiveFile();

    if (!site) {
      return;
    }

    const service = new HaloService(this.app, this.settings, site);
    await service.uploadImages({}, file);
    await this.saveSettings();
  }

  /**
   * 决定一篇笔记的目标站点。**同步、不弹窗、不报错** —— 只做判断，
   * 用户可见的处置交给 `siteForResolution`。分开的理由是批量操作：它需要拿到
   * 「为什么这篇没有站点」这个**结果**去汇总，而不是让一次弹窗打断整批。
   */
  private resolveSiteFor(file: TFile): SiteResolution {
    const matterData = this.app.metadataCache.getFileCache(file)?.frontmatter;

    // `matterData?.halo?.site` 缺席时给的是 `undefined`，`resolveSite` 把**只有** `undefined` / `null`
    // 当「没写」而继续往下走规则表与默认站点。**绝不能在这里补 `?? ""`**：显式空串在
    // `resolveSite` 里是「写了」的值，会直接报 `unknown-site` —— 那等于把所有没写 `halo.site`
    // 的笔记全变成错误。（`site:` 裸写时 YAML 解析成 `null`，仍按缺席处理，这条路径是对的。）
    return resolveSite(this.settings.sites, this.settings.siteRouting ?? [], file.path, matterData?.halo?.site);
  }

  /**
   * 把解析结果变成可用的站点：需要用户选的弹窗、需要报错的报错，都收在这里。
   * 返回 `undefined` 表示「这次操作不要继续」（用户取消，或已经弹过提示）。
   */
  private async siteForResolution(resolution: SiteResolution): Promise<HaloSite | undefined> {
    switch (resolution.kind) {
      case "resolved":
        return resolution.site;
      case "no-sites":
        new Notice(i18next.t("command.publish.error_no_sites"));
        return undefined;
      case "unknown-site":
        // 与既有文案一致：笔记的 halo.site 指向一个没配过的站点
        new Notice(i18next.t("command.publish.error_no_matched_site"));
        return undefined;
      case "unknown-rule-site":
        // `escapeValue: false` 与 `mcp-self-check.ts` 同一处置，且这里更是**必须**：
        // i18next 默认会把插值做 HTML 转义，而它的转义表**连 `/` 也转**。
        // 这条文案的两个插值恰好都含 `/`（URL 的 `//`、glob 模式的目录分隔符），开着转义时
        // 用户看到的是 `https:&#x2F;&#x2F;blog.example.com` 与 `博客&#x2F;**` —— 而 Notice
        // 按纯文本显示、不解析 HTML，所以那不是「能看懂的实体」，就是一串乱码。
        new Notice(
          i18next.t("service.error_unknown_rule_site", {
            pattern: resolution.pattern,
            url: resolution.url,
            interpolation: { escapeValue: false },
          }),
        );
        return undefined;
      case "needs-choice":
        return openSiteSelectionModal(this);
      // 穷尽性安全网。返回类型含 `undefined`，且 `tsconfig.json` **没开** `noImplicitReturns`，
      // 所以少写一个 case 时 TypeScript 会**默默**接受「什么也不做就返回 undefined」——
      // 表现为操作中止却不弹任何提示，正是本计划要消灭的「说不清是哪一种失败」。
      // 这个子句今天恒不可达，但它把「忘了处理新的 kind」从**运行期静默**变成**编译期报错**：
      // 联合一旦加第六种，`resolution` 就不再是 `never`，`const unhandled: never` 会编译失败。
      default: {
        const unhandled: never = resolution;
        return unhandled;
      }
    }
  }

  private async getSiteForActiveFile(): Promise<HaloSite | undefined> {
    const { activeEditor } = this.app.workspace;

    if (!activeEditor || !activeEditor.file) {
      return undefined;
    }

    // 与发布走**同一个**解析入口。两处各解析一遍是错的：图片会传到 A 站、文章发到 B 站，
    // 两个操作都报成功，而文章里的图片链接指向另一个域名。
    return this.siteForResolution(this.resolveSiteFor(activeEditor.file));
  }

  private async uploadImagesForPublish(
    service: HaloService,
    file: TFile,
  ): Promise<{ success: boolean; markdown?: string }> {
    const uploadResult = await service.uploadImages({ silent: true }, file);
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
