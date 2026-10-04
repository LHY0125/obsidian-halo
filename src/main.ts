import i18next from "i18next";
import { Notice, Plugin, type TFile, moment } from "obsidian";
import { confirmBatchPlan, showBatchSummary } from "./batch-confirm-modal";
import { type BatchAction, collectBatchCandidates, planBatch, runBatch } from "./batch-publish";
import { initializeI18n } from "./i18n";
import { addHaloIcon } from "./icons";
import { describeSelfCheckFailure, runSelfCheck } from "./mcp-self-check";
import { openPostSelectionModal } from "./post-selection-model";
import { type PublishPreviewInput, buildPublishPreview } from "./publish-preview";
import { confirmPublishPreview } from "./publish-preview-modal";
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

    // 语言取 Obsidian 自己的 locale（`moment.locale()`，可能是 `zh-cn` 这种小写形态），
    // 回落 `en` 由 `initializeI18n` 负责。**不要在这里自己拼 options** ——
    // 全局的 `interpolation.escapeValue` 必须只有一份，理由见 `initializeI18n` 的注释。
    await initializeI18n(moment.locale());

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
        // （笔记的 halo.site 与目标站点不一致时报错）因此也只在这条路径上有用 ——
        // 它被收进了 `publishToDefaultSite`，与「默认站点在哪」的判断放在一起。
        const { activeEditor } = this.app.workspace;

        if (!activeEditor?.file) {
          return;
        }

        await this.publishToDefaultSite(activeEditor.file);
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

    // 三个批量命令共用 `runBatchCommand`，只在 action 上分档 —— 与 `publish` /
    // `publish-with-defaults` 分成两条公开命令是同一取舍：命令名要能一眼看出会做什么。
    this.addCommand({
      id: "batch-draft",
      name: i18next.t("command.batch_draft.name"),
      callback: async () => {
        await this.runBatchCommand("draft");
      },
    });

    this.addCommand({
      id: "batch-publish",
      name: i18next.t("command.batch_publish.name"),
      callback: async () => {
        await this.runBatchCommand("publish");
      },
    });

    this.addCommand({
      id: "batch-unpublish",
      name: i18next.t("command.batch_unpublish.name"),
      callback: async () => {
        await this.runBatchCommand("unpublish");
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

  /**
   * `publish` 命令与功能区图标的入口：取出活动文件，再走 `publishFile`。
   *
   * 取活动文件的守卫留在这里、**不**下沉进 `publishFile`：那个方法收的是**显式文件**，
   * 批量路径也要用它 —— 那边手上是一批文件，而活动编辑器只有一个。
   */
  private async publishCommand() {
    const { activeEditor } = this.app.workspace;

    if (!activeEditor || !activeEditor.file) {
      return;
    }

    await this.publishFile(activeEditor.file);
  }

  /**
   * 单篇发布的完整流程：解析站点 → 规划 → 预览 → 确认 → 上传图片 → 执行。
   *
   * 预览发生在**规划之后、任何写操作之前**。`uploadImages` 也会改笔记（把图片链接换成
   * 远程地址），所以它必须排在确认之后 —— 否则用户点了「取消」，笔记里的图片链接已经被换掉了：
   * 一次「什么都没发生」的取消，实际改动了整库笔记里的图片链接。
   */
  private async publishFile(file: TFile): Promise<void> {
    // 这一处的解析顺序是**行为变更**（刻意的）：改动前 `publishCommand` 在没有 `halo.site` 时
    // 一律弹窗选站点，**完全忽略设置里的默认站点与唯一站点**。现在的顺序由 `resolveSite` 决定：
    // frontmatter → **路由规则表** → 默认站点 → 单站点直取 → 弹窗。
    // 差别是实质性的：笔记一旦命中某条规则，目标就由规则决定，轮不到默认站点。
    // 最直观的差别：只配了一个站点的用户不再每次发布都看一眼只有一个选项的弹窗。
    const resolution = this.resolveSiteFor(file);

    if (resolution.kind === "resolved") {
      await this.publishToResolvedSite(file, resolution);
      return;
    }

    // 其余四档（no-sites / unknown-site / unknown-rule-site / needs-choice）的处置都在
    // `siteForResolution` 里：该报错的报错，该弹窗的弹窗。返回 undefined 就是「这次算了」。
    const site = await this.siteForResolution(resolution);

    if (!site) {
      return;
    }

    // 这一档是用户在弹窗里手选的，`resolveSite` 并不知道 —— 预览上要如实标成「你选的」，
    // 而不是套用「唯一站点」或「默认站点」的说法（那会让人以为自己的配置变了）。
    await this.publishToResolvedSite(file, { site, source: "picked" });
  }

  /**
   * `publish-with-defaults` 命令的入口：直接用设置里的默认站点，**不经过路由解析**。
   *
   * 与 `publishFile` 分成两条而不是加个开关：这条命令的语义就是「用默认站点」，
   * 让路由规则来改写目标会与命令名直接冲突。
   */
  private async publishToDefaultSite(file: TFile): Promise<void> {
    const site = this.settings.sites.find((item) => item.default);

    if (!site) {
      new Notice(i18next.t("command.publish_with_defaults.error_no_default_site"));
      return;
    }

    if (!this.canPublishToSite(site)) {
      return;
    }

    await this.publishToResolvedSite(file, { site, source: "default" });
  }

  /** 站点已经定下来之后的发布流程。签名刻意只接受「已解析」这一档，省掉调用方的判空 */
  private async publishToResolvedSite(
    file: TFile,
    resolved: { site: HaloSite; source: PublishPreviewInput["siteSource"]; pattern?: string },
  ): Promise<void> {
    const service = new HaloService(this.app, this.settings, resolved.site);
    const planned = await service.planPublish(file);

    if (!planned.ok) {
      // `planPublish` 自己不播报（详见它的说明：命令层要在预览之前显示原因），
      // 所以原因在这里显示出来。用户点了「发布」却什么都不发生、也不说为什么，
      // 是最难自查的一种失败。
      new Notice(planned.reason);
      return;
    }

    if (!this.settings.skipPreviewOnPublish) {
      const preview = buildPublishPreview({
        siteName: resolved.site.name || resolved.site.url,
        siteUrl: resolved.site.url,
        siteSource: resolved.source,
        sitePattern: resolved.pattern,
        title: planned.plan.post.spec.title,
        slug: planned.plan.post.spec.slug,
        raw: planned.plan.raw,
        // `Post` 来自 `@halo-dev/api-client`，而该包的类型在本项目解析不了（`moduleResolution: "node"`
        // 忽略 `exports`），`spec` 实际退化成 `any`。`buildPublishPreview` 只要一个只读的记录，
        // 所以这里显式断言一次，把「调用方知道类型是虚的」这件事写在代码里。
        spec: planned.plan.post.spec as unknown as Record<string, unknown>,
        newCategories: planned.plan.newCategories,
        newTags: planned.plan.newTags,
        images: planned.plan.images,
      });

      if (!(await confirmPublishPreview(this, preview))) {
        // 用户点了「取消」：此刻站点与本地都还是打开弹窗之前的样子（规划的零写入不变式），
        // 所以这里直接结束就是对「取消」最忠实的实现。
        return;
      }
    }

    const uploadResult = await this.uploadImagesForPublish(service, file);

    if (!uploadResult.success) {
      return;
    }

    // 单篇路径不传 quiet，`executePublish` 自己会弹成功便签，这里不重复播报。
    // 失败的原因也已经由它弹过 —— 拿返回值只是为了让「不弹便签」这件事有据可依。
    await service.executePublish(file, planned.plan, { markdown: uploadResult.markdown });
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
   * 三个批量命令共用的入口：取候选 → 聚合规划 → 一次确认 → 执行 → 汇总。
   *
   * 候选来源就是**vault 里当前所有 markdown 文件**，用户靠确认弹窗里的分组清单看到全貌。
   * 刻意不做「先选文件夹再选标签」的多选对话框：一次聚合确认（用户 2026-10-03 的裁定）
   * 的前提正是"清单里能看到全部候选"，先让用户筛一遍再让他看清单，等于把同一件事问两遍。
   *
   * 站点解析不出来（多站点无规则无默认 / 指向未配置的站点 / 站点已被删）的笔记
   * 一律进 `skipped` 并在弹窗里逐条列出原因 —— 批量路径**不弹站点选择弹窗**，
   * 一篇一弹会把"批量"变成 118 次点击。
   */
  private async runBatchCommand(action: BatchAction): Promise<void> {
    if (this.settings.sites.length === 0) {
      new Notice(i18next.t("batch.error_no_sites"));
      return;
    }

    const files = this.app.vault.getMarkdownFiles();
    const { candidates, skipped } = collectBatchCandidates(files, this.app, this.settings, action);

    if (candidates.length === 0) {
      // 这句提示与上一句是两种不同的处境（没配站点 / 配了但没有一篇能进批），
      // 所以两个键分开。合成一句「无法批量处理」会让用户不知道该去改站点还是改笔记。
      new Notice(i18next.t("batch.error_no_candidates"));
      return;
    }

    // 每个站点造一个 service：分类/标签的列举与图片概览都要用它，
    // 而 118 篇里同一站点的那些共用同一个客户端。
    // 缓存另一个作用是让**预览与执行共用同一批客户端** —— 两处各建一份不会出错，
    // 却会把「哪一篇属于哪个站点」这件事在两条路径上各算一遍。
    const services = new Map<string, HaloService>();
    const serviceFor = (site: HaloSite): HaloService => {
      let service = services.get(site.url);

      if (!service) {
        service = new HaloService(this.app, this.settings, site);
        services.set(site.url, service);
      }

      return service;
    };

    const plan = await planBatch(candidates, skipped, action, {
      listTaxonomy: async (site) => {
        const service = serviceFor(site);
        const [categories, tags] = await Promise.all([service.getCategories(), service.getTags()]);
        return { categories, tags };
      },
      summarizeImages: async (item) =>
        item.resolution.kind === "resolved"
          ? serviceFor(item.resolution.site).summarizeImages(item.file)
          : { pending: 0, cached: 0, overLimit: [] },
    });

    const selected = await confirmBatchPlan(this, plan);

    // `undefined` = 用户取消。到此为止，站点与本地都还没被动过
    //（预览与确认都发生在任何写操作之前，包括上传图片那一步）。
    if (!selected) {
      return;
    }

    showBatchSummary(this, await runBatch(plan, selected, serviceFor));

    // 执行过程中图片缓存被写进了 `settings.imageUploadCache`；不落盘的话下次还得重传一遍。
    // 放在汇总**之后**：落盘是几百毫秒级的 I/O，而用户此刻在等的是那份清单。
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
