import i18next from "i18next";
import { Modal, Notice, Setting } from "obsidian";
import { renderErrorMessage } from "./i18n/error-message";
import type HaloPlugin from "./main";
import { type RecycleKind, type RecycledItem, fetchActivePages, fetchRecycled, restoreRecycled } from "./recycle-model";
import PageService from "./service/page-service";
import { type HaloSite, mcpEndpointOf } from "./settings";
import { McpClient } from "./transport/mcp-client";

/**
 * 回收站的交互面：两个弹窗。
 *
 * | 弹窗 | 看什么 | 能做什么 |
 * |---|---|---|
 * | `RecycleBinModal` | **回收站里**的某一类内容 | 恢复 |
 * | `PageManagerModal` | 站点上**不在回收站**的独立页面 | 移入回收站 |
 *
 * **四个格子刻意只填了两个** —— 回收站里不放「移入回收站」，管理页面里不放「恢复」。
 * 两个弹窗的职责本来就不同：一个是「误删之后能捞回来」，另一个是页面生命周期管理。
 * 要是把两边的动作都塞进同一个弹窗，「回收站」这个入口就会同时有回收与恢复，
 * 而列表里**没有任何一列**能告诉用户这一行现在是活的还是已回收的 —— 点之前得先猜。
 *
 * 两个弹窗的取数出自 `recycle-model.ts` 里**同一个**私有实现（只差 `recycled` 那一档），
 * 所以「管理页面列出了回收站里的东西」这种对调在代码层面不成立。
 */
export class RecycleBinModal extends Modal {
  private readonly client: McpClient;
  private items: RecycledItem[] = [];
  private truncated = false;

  constructor(
    plugin: HaloPlugin,
    site: HaloSite,
    private readonly kind: RecycleKind,
  ) {
    super(plugin.app);
    this.client = new McpClient({ endpoint: mcpEndpointOf(site), token: site.mcpToken });
  }

  onOpen(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;

    contentEl.empty();
    contentEl.createEl("h2", { text: i18next.t(`recycle_modal.title_${this.kind}`) });

    try {
      const result = await fetchRecycled(this.client, this.kind);
      this.items = result.items;
      this.truncated = result.truncated;
    } catch (error) {
      // 取数失败**不抛**给 Obsidian（它只会把异常记进控制台，用户在界面上什么都看不到）。
      // 弹一条带服务端原文的提示，然后把列表当空的渲染 —— 与附件弹窗同一处置。
      new Notice(renderErrorMessage(error));
      this.items = [];
    }

    if (this.items.length === 0) {
      // 「回收站是空的」是一条**结论**，不是一片空白：用户把里面的东西都恢复完之后再打开，
      // 看到空白会以为插件坏了。
      contentEl.createEl("p", { text: i18next.t("recycle_modal.empty") });
    }

    if (this.truncated) {
      // 触顶时才提示 —— 静默截断是本阶段反复处理的那类问题（`fetchRecycled` 把
      // `truncated` 交给调用方，就是为了有人能说这句话）。
      contentEl.createEl("p", { text: i18next.t("recycle_modal.notice_truncated") });
    }

    for (const item of this.items) {
      new Setting(contentEl)
        .setName(item.title)
        .setDesc(item.permalink)
        .addButton((button) =>
          button.setButtonText(i18next.t("recycle_modal.button_restore")).onClick(() => {
            void this.restoreItem(item);
          }),
        );
    }

    new Setting(contentEl).addButton((button) =>
      button.setButtonText(i18next.t("common.button_close")).onClick(() => this.close()),
    );
  }

  /**
   * 恢复一条内容。
   *
   * **不做二次确认**：恢复不是破坏性动作（要再删，重新回收一次即可），代价远小于
   * 「点错一次还得再删一遍」。二次确认留给真正不可逆的操作 —— 附件删除。
   *
   * 抽成具名方法而不是内联进 `onClick`：`Setting.addButton` 在测试脚手架里**不记录回调**，
   * 内联的话凡是这个动作体里的东西（走读还是走写、工具名按 `kind` 分不分档）
   * 一行都跑不到，改错了全套测试照样全绿。
   */
  private async restoreItem(item: RecycledItem): Promise<void> {
    try {
      await restoreRecycled(this.client, item);
      new Notice(i18next.t("recycle_modal.notice_restored", { title: item.title }));
      // 重取一遍，而不是从 `this.items` 里就地删掉那一项：服务端才是权威 ——
      // 回收站可能在这期间被别人改过。与附件弹窗删除后的处置一致。
      await this.render();
    } catch (error) {
      new Notice(renderErrorMessage(error));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * 「管理独立页面」：列出站点上**不在回收站**的页面，逐行给出「回收」。
 *
 * **只管页面**：命令是 `manage-pages`，而文章的生命周期已经在「批量推草稿 / 发布 / 撤回」
 * 那三条命令里了 —— 把文章也列进来会让这个弹窗变成一个「什么都能删」的地方，
 * 而它上面的按钮是不可逆的（回收之后要恢复得去另一个弹窗）。
 *
 * 取数走 `recycle-model` 的 `fetchActivePages()`（`recycled: false`），**不在**这里自己拼
 * `callToolJson` + 翻页：两个弹窗共用一份取数，`recycled` 传错时两个弹窗的内容会正好对调，
 * 而那从界面上看不出来。
 *
 * ⚠️ **「回收」走 `PageService.recyclePage()`，不在这儿拼工具名。** 以后要给页面回收
 * 加重试、加日志、换工具名，都只改服务层那一处；在弹窗里拼等于又开一个入口，
 * 而那个入口会**静默掉队**（本地与线上都看不出异常）。这里与 `page-selection-model.ts`
 * 持有 `PageService` 是同一个取舍。
 *
 * 与之相对，**「恢复」走的是 `restoreRecycled()`** —— 它是**跨 kind** 的统一实现
 *（文章与页面共用一处，按 `item.kind` 选工具），而 `PageService` 只管页面，
 * 拿它做恢复反而要为文章另开一条路。两处的不对称是有意的，不是漏改。
 */
export class PageManagerModal extends Modal {
  private readonly client: McpClient;
  private readonly service: PageService;

  constructor(plugin: HaloPlugin, site: HaloSite) {
    super(plugin.app);
    this.client = new McpClient({ endpoint: mcpEndpointOf(site), token: site.mcpToken });
    // ⚠️ 把上面这个 client **注入**给 `PageService`，而不是让它自己再造一个：同一个站点、
    // 同一个弹窗里开两条连接没有理由 —— 两边的 endpoint/token 推导本来完全相同
    //（`normalizeSite` + `mcpEndpointOf`），多出来的那条只会是又一个「端点推导改了、
    // 这里悄悄掉队」的地方。`HaloServiceBase` 的第四个参数本来就是为注入留的
    //（服务层测试就是这么传假 client 的），所以这不需要动任何构造签名。
    this.service = new PageService(plugin.app, plugin.settings, site, this.client);
  }

  onOpen(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;
    let items: RecycledItem[] = [];
    let truncated = false;

    contentEl.empty();
    contentEl.createEl("h2", { text: i18next.t("page_manager_modal.title") });

    try {
      const result = await fetchActivePages(this.client);
      items = result.items;
      truncated = result.truncated;
    } catch (error) {
      // 与回收站弹窗同一处置：不把异常放给 Obsidian，弹提示后按空列表渲染。
      new Notice(renderErrorMessage(error));
    }

    if (items.length === 0) {
      contentEl.createEl("p", { text: i18next.t("page_manager_modal.empty") });
    }

    if (truncated) {
      // 页面列表的另一个出口 —— `PageService.getPages()`（拉取选择器那条路）触顶时会提示，
      // 这里少掉它，用户看到的会是一个「少了几个页面」的列表而没有任何线索。
      contentEl.createEl("p", { text: i18next.t("page_manager_modal.notice_truncated") });
    }

    for (const item of items) {
      new Setting(contentEl)
        .setName(item.title)
        .setDesc(item.permalink)
        .addButton((button) =>
          button.setButtonText(i18next.t("page_manager_modal.button_recycle")).onClick(() => {
            void this.recycleItem(item);
          }),
        );
    }

    new Setting(contentEl).addButton((button) =>
      button.setButtonText(i18next.t("common.button_close")).onClick(() => this.close()),
    );
  }

  /**
   * 把一条页面移入回收站。
   *
   * 抽成具名方法而不是内联进 `onClick`：`Setting.addButton` 在测试脚手架里不记录回调，
   * 内联的话「回收走的是服务层」这条本任务最关键的约束一行都跑不到 ——
   * 而它正是本任务刻意偏离计划草案的地方（草案直接把工具名拼在这儿）。
   */
  private async recycleItem(item: RecycledItem): Promise<void> {
    try {
      await this.service.recyclePage(item.name);
      new Notice(i18next.t("page_manager_modal.notice_recycled", { title: item.title }));
      // 重取一遍：回收之后这一行不该再出现在「管理页面」里（`fetchActivePages` 只看活的）。
      await this.render();
    } catch (error) {
      new Notice(renderErrorMessage(error));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
