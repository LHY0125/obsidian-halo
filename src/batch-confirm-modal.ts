import i18next from "i18next";
import { type ButtonComponent, Modal, Setting } from "obsidian";
import type { BatchGroup, BatchPlan, BatchRunSummary } from "./batch-publish";
import { summarizeSelection } from "./batch-publish";
import type HaloPlugin from "./main";

/**
 * 一次聚合确认。**返回勾选的路径集合；取消返回 `undefined`**，调用方据此直接结束，不写任何东西。
 *
 * 为什么是「返回集合」而不是「返回 true/false」：清单里每一篇都带一个勾选框，默认全勾。
 * 「批量发布」这个按钮听起来就像"把该发的都发了"，而**全库有 118 篇笔记** ——
 * 一个不接受任何勾选、默认对全部文件生效的批量命令，用户点下去之后才会发现自己
 * 把阅读笔记和日记也一起发到了博客上。默认全勾让"什么都不选"仍然是最省事的路径，
 * 而勾选框让"我只想发这几篇"有一个表达的地方。
 *
 * 返回的是**路径**集合（`file.path`），执行阶段也按路径取文件 —— 两边必须同一把键。
 */
export function confirmBatchPlan(plugin: HaloPlugin, plan: BatchPlan): Promise<Set<string> | undefined> {
  return new Promise((resolve) => {
    new BatchConfirmModal(plugin, plan, resolve).open();
  });
}

/**
 * `export` 只为测试：勾选状态是这条命令的安全边界（默认全勾 / 取消交回 `undefined`），
 * 而 `tests/setup.ts` 的 `Modal.open()` 不调 `onOpen()`、`Button.onClick()` 也不记录回调，
 * 按钮与勾选框在测试里点不到。`tests/batch-confirm-modal.test.ts` 因此直接构造本类、
 * 调用下面三个决定方法 —— 与 `tests/main.test.ts` 调插件私有方法用的是同一套办法。
 * 生产代码只用 `confirmBatchPlan()`，不直接引用本类。
 *
 * 仍未覆盖的部分：逐条勾选框的 `onChange`、`renderSummary` 的重画、确认按钮的禁用态 ——
 * 那几处只有真实的 DOM 与 Obsidian 的 `Setting` 才验得到，本仓库不为 UI 建 mock 基建。
 */
export class BatchConfirmModal extends Modal {
  /** 当前勾选的路径。初始全勾 —— 见 `confirmBatchPlan` 的说明 */
  private readonly selected = new Set<string>();

  /** 汇总一块独立的容器：勾选变化时只重画它，不重画上面那 118 行 */
  private summaryEl?: HTMLElement;
  private confirmButton?: ButtonComponent;

  constructor(
    private readonly plugin: HaloPlugin,
    private readonly plan: BatchPlan,
    private readonly onDecide: (selected: Set<string> | undefined) => void,
  ) {
    super(plugin.app);

    for (const group of plan.groups) {
      for (const item of group.items) {
        this.selected.add(item.file.path);
      }
    }
  }

  onOpen(): void {
    this.renderContent();
  }

  /**
   * 整块重画。
   *
   * 只在**整组全选/全不选**时走这条路：那些勾选框的状态被程序改了，
   * 不重画它们不会自己更新。逐条勾选走 `renderSummary`（只动汇总），
   * 否则用户每勾一个就会丢掉滚动位置。
   *
   * `selected` 集合**不重建** —— 重画的是界面，状态一直在 `this.selected` 里。
   */
  private renderContent(): void {
    const { contentEl } = this;

    contentEl.empty();
    this.summaryEl = undefined;
    this.confirmButton = undefined;

    contentEl.createEl("h2", { text: i18next.t(`batch.title_${this.plan.action}`) });

    for (const group of this.plan.groups) {
      const header = new Setting(contentEl).setName(`${group.site.name || group.site.url}（${group.items.length}）`);

      // 整组全选/全不选：118 篇一条条点太费事，而"我只想发这个站"是最常见的取舍
      header.addButton((button) =>
        button.setButtonText(i18next.t("batch.button_select_all")).onClick(() => {
          this.selectGroup(group, true);
        }),
      );
      header.addButton((button) =>
        button.setButtonText(i18next.t("batch.button_select_none")).onClick(() => {
          this.selectGroup(group, false);
        }),
      );

      for (const item of group.items) {
        new Setting(contentEl).setName(item.file.path).addToggle((toggle) => {
          toggle.setValue(this.selected.has(item.file.path)).onChange((value) => {
            if (value) {
              this.selected.add(item.file.path);
            } else {
              this.selected.delete(item.file.path);
            }

            this.renderSummary();
          });
        });
      }
    }

    if (this.plan.skipped.length > 0) {
      contentEl.createEl("h3", { text: i18next.t("batch.skipped_title", { count: this.plan.skipped.length }) });

      // 每条跳过都带上**它自己的原因**（键与参数由解析阶段给出）：用户要据此决定去改配置、
      // 还是把这篇排除在外。这里只负责把键渲染成文案。
      for (const skip of this.plan.skipped) {
        contentEl.createEl("div", { text: `${skip.path} —— ${i18next.t(skip.key, skip.params)}` });
      }
    }

    // 用 `createEl("div")` 而不是 DOM 的 `document.createElement`：前者是 Obsidian 的
    // 元素工厂，能自动带上主题类名；后者创建的元素游离在 Obsidian 的样式体系之外。
    // 另一个理由更具体：测试脚手架的 `contentEl` 只有 `createEl` ——
    // 这一行决定了整块重画能否在测试里跑到。
    this.summaryEl = contentEl.createEl("div");

    // 这条提示必须在确认**之前**出现：「批量发布」听起来像只动远端，实际会改一批本地文件。
    //
    // ⚠️ 门控条件是 **action**，不是 `settings.replaceImageLinks`。回写 frontmatter 那一步
    //（`executePublish()` 里的 `processFrontMatter()`）是**无条件**的 —— 关掉「替换图片链接」
    // 之后跑批量推草稿 / 发布，笔记里的 `title` / `slug` / `cover` / `excerpt` / `categories` /
    // `tags` 与整个 9 键 `halo` 块**照样被改写**。此前按那个设置门控，等于在最需要提醒的时候
    //（用户以为关掉开关笔记就不会被动）**一条提示都不显示**，是「该响不响的警告」。
    //
    // 撤回不显示：`runBatch()` 的 unpublish 分支只调 `changePostPublish()` 就 `continue`，
    // 从不进 `executePublish()`，本地笔记一个字节都不动 —— 对它显示这条提示才是说一套做一套。
    if (this.plan.action !== "unpublish") {
      new Setting(contentEl)
        .setName(i18next.t("batch.notice_rewrites_notes"))
        .setDesc(i18next.t("batch.notice_rewrites_notes_desc"));
    }

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(i18next.t("common.button_cancel")).onClick(() => {
          this.cancel();
        }),
      )
      .addButton((button) => {
        this.confirmButton = button.setButtonText(i18next.t("batch.button_confirm")).setCta();
        button.onClick(() => {
          this.confirm();
        });
      });

    this.renderSummary();
  }

  /** 确认：交出当前勾选的**快照**。传新集合而不是 `this.selected` 本身，调用方拿到的是一个定值 */
  private confirm(): void {
    this.onDecide(new Set(this.selected));
    this.close();
  }

  /** 取消：交出 `undefined`。**不是空集合** —— 空集合会与「用户明确一个都不发」混为一谈 */
  private cancel(): void {
    this.onDecide(undefined);
    this.close();
  }

  private selectGroup(group: BatchGroup, selected: boolean): void {
    for (const item of group.items) {
      if (selected) {
        this.selected.add(item.file.path);
      } else {
        this.selected.delete(item.file.path);
      }
    }

    this.renderContent();
  }

  /** 重画汇总。**只动 `summaryEl`**，让勾选框与滚动位置保持原样 */
  private renderSummary(): void {
    if (!this.summaryEl) {
      return;
    }

    this.summaryEl.empty();

    const summary = summarizeSelection(this.plan, this.selected);

    this.summaryEl.createEl("p", { text: i18next.t("batch.summary_count", { count: summary.total }) });

    // 撤回**什么也不建** —— 它连 `executePublish()` 都不进（`runBatch()` 的 unpublish 分支
    // 只调 `changePostPublish()` 就 `continue`），所以「将新建的分类 / 标签」对它是一句
    // **本次绝不会发生**的话。不门控的话只要某篇笔记写的显示名与站点现有清单对不上
    //（站点侧改名/删除，或用户手改过 frontmatter），一次「批量撤回」的确认弹窗就会宣称
    // 要新建它们 —— 与图片那一行原本的毛病同源（都不按 action 分档），处置也照抄 A18 那条：
    // 撤回时 `planBatch` 把 `images` 归零、那一行自然不渲染；这里把分类/标签两行直接按 action 分档。
    //
    // ⚠️ **`listTaxonomy` 该跑还跑** —— 「这两行不渲染」不等于「`planBatch` 为撤回打的那批
    // MCP 调用该省」。那是另一个问题（要改的是 `planBatch`，且得先决定撤回是否还需要 taxonomy
    // 快照），本次刻意**不动**。
    const mayCreateTaxonomy = this.plan.action !== "unpublish";

    for (const group of summary.groups) {
      this.summaryEl.createEl("h3", { text: `${group.site.name || group.site.url}（${group.count}）` });

      if (mayCreateTaxonomy && group.newCategories.length > 0) {
        new Setting(this.summaryEl)
          .setName(i18next.t("batch.row_new_categories"))
          .setDesc(group.newCategories.join("、"));
      }

      if (mayCreateTaxonomy && group.newTags.length > 0) {
        new Setting(this.summaryEl).setName(i18next.t("batch.row_new_tags")).setDesc(group.newTags.join("、"));
      }

      if (group.images.pending > 0 || group.images.overLimit.length > 0) {
        new Setting(this.summaryEl)
          .setName(i18next.t("batch.row_images"))
          .setDesc(i18next.t("batch.value_images", { pending: group.images.pending, cached: group.images.cached }));
      }

      if (group.images.overLimit.length > 0) {
        new Setting(this.summaryEl)
          .setName(i18next.t("batch.row_images_over_limit"))
          .setDesc(group.images.overLimit.join("、"));
      }
    }

    // 一篇都没勾时禁掉确认：允许"确认一个空操作"只会让用户以为自己的取消没生效
    this.confirmButton?.setDisabled(summary.total === 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * 末尾汇总。
 *
 * 用弹窗而不是 Notice：失败项可能几十条，`Notice` 几秒就消失且不可复制。
 * 用户此刻最需要的是**能停下来逐条看**的那份清单（哪一篇、为什么）。
 *
 * 三档数字必须**分开**报（成功 / 失败 / 执行前就跳过），不能合并成一个「完成 N 篇」——
 * 118 篇里 3 篇失败而汇总只说「118 篇完成」，用户就被告知了一件假事：
 * 他以为站点上齐了，实际少了三篇，而那三篇正是他需要去手工处理的。
 */
export function showBatchSummary(plugin: HaloPlugin, summary: BatchRunSummary): void {
  new BatchSummaryModal(plugin, summary).open();
}

/**
 * `export` 只为测试，与上面的 `BatchConfirmModal` 同一处置（也同一理由）：
 * `tests/setup.ts` 的 `Modal.open()` 不调 `onOpen()`，所以 `showBatchSummary()` 在测试里
 * 什么也渲染不到。测试直接构造本类、塞一个能记录文字的 `contentEl` 桩、再调 `onOpen()`，
 * 从而钉住「三档数字都出现在文案里、失败项与执行前跳过分**两段**逐条列出」这条用户可见的保证。
 * 生产代码只用 `showBatchSummary()`，不直接引用本类。
 */
export class BatchSummaryModal extends Modal {
  constructor(
    private readonly plugin: HaloPlugin,
    private readonly summary: BatchRunSummary,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;

    // 标题按 action 分档，**不用一句通用的「批量操作完成」**：三个命令跑完是同一句的话，
    // 用户点了「批量推草稿」看到「成功 118 篇」，弹窗**没说是草稿还是已经发出去了** ——
    // 而这正是他跑完之后最需要确认的那件事。`action` 本来就带在 `BatchRunSummary` 上。
    // 动态键的写法与上面 `BatchConfirmModal` 的 `batch.title_${action}` 一致。
    contentEl.createEl("h2", { text: i18next.t(`batch.summary_title_${this.summary.action}`) });
    contentEl.createEl("p", {
      text: i18next.t("batch.summary_line", {
        success: this.summary.successCount,
        failed: this.summary.failureCount,
        skipped: this.summary.skippedCount,
      }),
    });

    // 只列失败项：成功的不需要用户做任何事，118 行「a.md 成功」会把失败的那三行淹掉。
    // `reason ?? ""` 只是兜底 —— `runBatch` 保证失败项一定带原因（`PublishResult.reason`
    // 或 `renderErrorMessage` 的产物），真出现空的时候宁可显示成「路径 —— 」也不要写 undefined。
    for (const result of this.summary.results.filter((item) => !item.ok)) {
      contentEl.createEl("div", { text: `${result.path} —— ${result.reason ?? ""}` });
    }

    // 执行前跳过的**另起一段**，绝不与上面的失败明细合成一张清单。
    //
    // 理由与「三档数字分开报」同源，只是更具体：失败是「跑了但炸了」→ 用户要去站点上确认那篇
    // 现在的状态；跳过是「压根没让它跑」→ 用户要去改配置或补发布。混在一起时他只能靠原因文字
    // 自己猜「这一篇到底有没有被尝试过」，而猜错的代价是把一篇**从没动过**的文章当成半成品
    // 去站点上找。
    //
    // 这一段在确认弹窗里**已经**存在（那份清单是用户在按下「执行」之前看的）；这里重列一遍
    // 不是重复，而是补上时机：跑完之后确认弹窗已经关了，而用户此刻手上只有这份汇总 ——
    // 「是哪几篇没进去、为什么」恰恰是他唯一要做的事。
    //
    // `?? []` 不是多余的：`BatchRunSummary.skipped` 在类型上是必填的，但本类是导出的
    //（测试与将来的调用方都会手工构造 summary）。真让 `undefined.length` 抛出去，
    // 表现是「弹窗打不开」—— 兜底一个空数组就能挡住，代价是零。
    const skipped = this.summary.skipped ?? [];

    if (skipped.length > 0) {
      // 标题里的数字取**这张清单自己的长度**，不取 `summary.skippedCount`：标题与它下面
      // 那张清单必须对得上。生产里两者恒等（都来自 `plan.skipped`），但手工构造的 summary
      // 一分叉，弹窗就会写「已跳过 5 篇」而只列 2 条 —— 一句用户看得见的假话。
      contentEl.createEl("h3", {
        text: i18next.t("batch.summary_skipped_title", { count: skipped.length }),
      });

      // 与确认弹窗**同一套键**（`batch.skip_*`）：两处渲染的是同一份 `BatchSkip`，
      // 另造一套文案只会让同一个原因在两个弹窗里说法不一致。`BatchSkip` 只带 key/params，
      // 渲染留在 UI 侧 —— 这也是它不随结果一起被渲染成字符串的原因（见 `BatchRunSummary` 的注释）。
      for (const skip of skipped) {
        contentEl.createEl("div", { text: `${skip.path} —— ${i18next.t(skip.key, skip.params)}` });
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
