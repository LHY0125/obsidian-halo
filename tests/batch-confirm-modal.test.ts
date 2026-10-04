import { beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18next from "i18next";
import { type App, Setting, type TFile } from "obsidian";
import { BatchConfirmModal, BatchSummaryModal } from "src/batch-confirm-modal";
import type { BatchGroup, BatchItem, BatchPlan, BatchRunSummary } from "src/batch-publish";
import { initializeI18n } from "src/i18n";
import type HaloPlugin from "src/main";
import type { HaloSetting, HaloSite } from "src/settings";
import { createSettings } from "./helpers/obsidian-mocks";

/**
 * `src/batch-confirm-modal.ts` 的**决定路径**测试。
 *
 * 这里钉的是「批量发布」这条命令的安全边界：弹窗打开时勾了什么、取消时交回什么、
 * 「全不选本组」到底有没有把那一组清掉。默认值写反、取消交回全部路径，都会让
 * 「批量发布」变成「把整库发出去」，而这两种错误在界面上**看不出任何异常**。
 *
 * 覆盖不到的只有逐条勾选框的 `onChange`（`tests/setup.ts` 的 `ToggleComponent.onChange`
 * 丢弃回调）与真实 DOM 结构 —— 本仓库不为 UI 建 mock 基建。
 * `renderSummary` 与确认按钮的禁用态**已经**覆盖：给实例塞一个最小的 `summaryEl` 桩，
 * 那段原本每跑必提前返回的代码就能跑到（见 `attachSummaryStub`），不必动 `tests/setup.ts`。
 *
 * 末尾那份汇总弹窗（`BatchSummaryModal`）同理：`showBatchSummary()` 在测试里开不出窗口
 *（`Modal.open()` 不调 `onOpen()`），所以直接构造导出的类、塞一个记录文字的 `contentEl` 桩，
 * 钉住「三档数字分开报、失败项逐条列、成功项不列」。仍然验不到的只有真实排版。
 */

/**
 * 初始化 i18n —— 走**生产同一条入口** `initializeI18n()`（`main.ts` 的 `onload` 调的就是它）。
 *
 * 不初始化的话 `i18next.t()` 返回键名本身、`{{count}}` 不被插值，于是「汇总里写着几篇」
 * 在渲染结果里根本看不出来 —— 那条钉「汇总跟着活集合走」的用例会退化成零判别力
 *（`count: 1` 与 `count: 3` 算出来是同一个字符串）。
 */
beforeAll(async () => {
  await initializeI18n("en");
});

const siteA: HaloSite = { name: "A", url: "https://a.example.com", token: "", mcpToken: "", default: true };
const siteB: HaloSite = { name: "B", url: "https://b.example.com", token: "", mcpToken: "", default: false };

/** 造一个只有 `path` 有意义的计划条目：弹窗只读它的 `path` 与 `images` */
function item(path: string, site: HaloSite): BatchItem {
  return {
    file: { path } as TFile,
    resolution: { kind: "resolved", site, source: "rule", pattern: "**" },
    categories: [],
    tags: [],
    images: { pending: 0, cached: 0, overLimit: [] },
  };
}

function planWith(spec: { site: HaloSite; paths: string[] }[], action: BatchPlan["action"] = "publish"): BatchPlan {
  return {
    action,
    groups: spec.map(({ site, paths }) => ({
      site,
      items: paths.map((path) => item(path, site)),
      taxonomy: { categories: [], tags: [] },
    })),
    skipped: [],
  };
}

/** 弹窗的私有出口 —— 见 `openModal` 里为什么不走「模拟点击」 */
type ModalInternals = {
  confirm(): void;
  cancel(): void;
  selectGroup(group: BatchGroup, selected: boolean): void;
  renderContent(): void;
  renderSummary(): void;
  /** 汇总容器。生产里由 `renderContent` 建出来；测试里塞桩就能让 `renderSummary` 不再提前返回 */
  summaryEl?: HTMLElement;
  confirmButton?: { setDisabled(value: boolean): unknown };
};

interface Harness {
  modal: ModalInternals;
  /** 弹窗交出的决定。`undefined` 有两种来源（取消 / 还没决定），故必须配 `wasDecided()` 用 */
  decision(): Set<string> | undefined;
  wasDecided(): boolean;
}

/**
 * 构造一个弹窗并捕获它的决定。
 *
 * 用「构造 + 直接调决定方法」而不是「模拟点击」：`tests/setup.ts` 的 `Modal.open()` 不调
 * `onOpen()`、`Button.onClick()` 也不记录回调，所以按钮与勾选框在测试里**根本点不到**。
 * 这与 `tests/main.test.ts` 对插件私有方法用的是同一套办法 —— 不新建 UI mock 基建，
 * 也不把安全攸关的勾选状态留在测不到的地方。
 */
function openModal(plan: BatchPlan, settings: HaloSetting = createSettings()): Harness {
  let decided = false;
  let result: Set<string> | undefined;

  // 只要满足弹窗构造与渲染的读取面（`app` 传给 Modal 基类）。`settings` 曾经也被读到
  //（改写提示门控在 `replaceImageLinks` 上），那条门控已改成按 action —— 但仍显式传进来，
  // 好让「关掉那个开关时的行为」有地方可测，也避免 fixture 与生产读取面悄悄脱节。
  const plugin = { app: {} as App, settings } as unknown as HaloPlugin;

  const modal = new BatchConfirmModal(plugin, plan, (value) => {
    decided = true;
    result = value;
  }) as unknown as ModalInternals;

  return { modal, decision: () => result, wasDecided: () => decided };
}

/**
 * 给弹窗塞一个能记录文字的汇总容器桩，让 `renderSummary()` **真的跑到**。
 *
 * 为什么必须这么做：`tests/setup.ts` 的 `Modal.contentEl.createEl()` 返回 `undefined`，于是
 * `renderContent` 里那句 `this.summaryEl = contentEl.createEl("div")` 让 `summaryEl` 恒为
 * `undefined`，而 `renderSummary` 第一句就是 `if (!this.summaryEl) return;` —— 整段汇总逻辑
 * （含「空勾选禁用确认」那道唯一的闸门）在测试里**从未执行过**。一个「构造时快照 selected、
 * 汇总读快照」的实现能通过全部 5 条用例，因为那行代码根本没跑。
 *
 * 不动 `tests/setup.ts`（那是本仓明确不建的 UI mock 基建），只给这一个实例喂最小桩。
 */
function attachSummaryStub(internals: ModalInternals): { texts: string[] } {
  const texts: string[] = [];
  const stub = {
    // `renderSummary` 每次先 `empty()` 再重画，桩要跟着清 —— 否则上一轮的文案会留在里面，
    // 「重画后不该再出现旧数字」这条断言就永远为假。
    empty: () => {
      texts.length = 0;
    },
    createEl: (_tag: string, options?: { text?: string }) => {
      if (options?.text !== undefined) {
        texts.push(options.text);
      }

      return undefined;
    },
  };

  internals.summaryEl = stub as unknown as HTMLElement;

  return { texts };
}

/**
 * 记下确认按钮收到的 `setDisabled` 调用。
 *
 * 按钮实例在每次**整块重画**时都会被重建（`Setting.addButton` 每次回调一个新的
 * `ButtonComponent`），所以要在最后一次重画**之后**再接，接早了记的是个已经被丢掉的实例。
 */
function recordDisabled(internals: ModalInternals): boolean[] {
  const button = internals.confirmButton;

  if (!button) {
    throw new Error("确认按钮还没建出来 —— 先调 renderContent() 或 selectGroup()");
  }

  const calls: boolean[] = [];
  button.setDisabled = (value: boolean) => {
    calls.push(value);

    return button;
  };

  return calls;
}

const plan = planWith([
  { site: siteA, paths: ["a.md", "b.md"] },
  { site: siteB, paths: ["c.md"] },
]);

/**
 * 在 spy 生效期间跑 `run`，把每个 `Setting` 的**名称**收集回来。
 *
 * 手法是给 `Setting.prototype.setName` 打 spy：`tests/setup.ts` 的 `Setting` 是个丢弃参数的壳
 * （`setName(): this`），文案读不回来，而 spy 记录的是**调用参数**，不受壳影响。
 * 与 `tests/settings.test.ts` 用 `Modal.prototype.open` 拿实例是同一套办法 —— 不新建 UI mock 基建。
 *
 * `finally` 里必须还原：`Setting.prototype` 是**全局共享**的，泄漏出去的 spy 会让后面所有用例
 * 都收不到真实的 `Setting` 行为，那种故障会以别的测试失败的形式出现，极难反查。
 */
function captureSettingNames(run: () => void): string[] {
  const spy = rs.spyOn(Setting.prototype, "setName");

  try {
    run();

    return spy.mock.calls.map((call) => String(call[0]));
  } finally {
    spy.mockRestore();
  }
}

describe("BatchConfirmModal 的勾选状态", () => {
  it("默认全勾：什么都不动就确认 = 整批都发（这是默认值，不是遗漏）", () => {
    const { modal, decision } = openModal(plan);

    modal.confirm();

    // 用**精确集合**断言而不是「长度 > 0」：勾选集合的键必须自始至终是 `file.path`
    //（执行阶段按路径取文件）。写成 `file.name` 之类的实现，长度断言照样通过，
    // 而执行时一篇都匹配不上。
    expect(decision()).toEqual(new Set(["a.md", "b.md", "c.md"]));
  });

  it("取消交回 undefined，而不是空集合、也不是全部路径", () => {
    const { modal, decision, wasDecided } = openModal(plan);

    modal.cancel();

    // **先证明回调被调过**：`decision()` 是 `undefined` 也可能是「cancel 里什么都没写」，
    // 那样下面那条断言永远为真 —— 而后果是弹窗的 Promise 永不 settle、用户点取消毫无反应。
    expect(wasDecided()).toBe(true);
    // 必须是 `undefined` 而不是「等于全部路径」：调用方（Task 10）把 `undefined` 当作
    // 「用户放弃、什么都不做」，把全部路径当作「发布整批」—— 两者差着一次全库发布。
    expect(decision()).toBeUndefined();
  });

  it("「全不选本组」只清掉这一组，别的组照旧", () => {
    const { modal, decision, wasDecided } = openModal(plan);

    // `selectGroup` 内部会整块重画：重画跑不通的话**这一行**就会抛（不是因为下面的断言）
    modal.selectGroup(plan.groups[0], false);

    // 清一组**不是**一个决定。`decision()` 此时确实是 `undefined`，但那是「还没决定」的
    // `undefined`，不是「取消」的那个 —— 而「还没决定」的初始值就是 `undefined`，
    // 所以单靠它分不出「selectGroup 里错误地替用户做了决定」。配一条 `wasDecided()` 为假
    // 才挡得住那种实现（它会让用户一勾选就被当成"取消"，弹窗的 Promise 直接 settle）。
    expect(wasDecided()).toBe(false);
    expect(decision()).toBeUndefined();

    modal.confirm();
    expect(decision()).toEqual(new Set(["c.md"]));
  });

  it("「全选本组」能把清掉的组加回来", () => {
    const { modal, decision } = openModal(plan);

    modal.selectGroup(plan.groups[0], false);
    modal.selectGroup(plan.groups[0], true);
    modal.confirm();

    expect(decision()).toEqual(new Set(["a.md", "b.md", "c.md"]));
  });

  it("两组都清掉后确认交出空集合：与「取消」的 undefined 是两回事", () => {
    // 空集合是用户明确表达的结果（他一个个清掉了），`undefined` 是他放弃了这次操作。
    // 两者必须不同，否则调用方没法区分「一个都不发」与「取消」—— 而它俩的后续处置完全不同。
    const { modal, decision, wasDecided } = openModal(plan);

    modal.selectGroup(plan.groups[1], false);
    // 与上一条同理：这个 `undefined` 是「还没决定」，靠 `wasDecided()` 为假才站得住
    expect(wasDecided()).toBe(false);
    expect(decision()).toBeUndefined();

    modal.selectGroup(plan.groups[0], false);
    modal.confirm();

    expect(wasDecided()).toBe(true);
    expect(decision()).toEqual(new Set());
  });

  it("汇总跟着**活集合**走：清掉一组后重画，篇数立刻变小", () => {
    // 这条钉的是「汇总按 `this.selected` 这个**活集合**算，而不是构造时拍的快照」。
    // 一个「构造时拷一份 selected、renderSummary 读那份拷贝」的实现会让用户在弹窗上看到
    // 取消勾选**之前**的数字 —— 他会以为自己的取消没生效，而本阶段「一次聚合确认」的
    // 全部依据就是汇总跟着勾选走。
    const internals = openModal(plan).modal;
    const initial = attachSummaryStub(internals);

    internals.renderSummary();

    expect(initial.texts).toContain(i18next.t("batch.summary_count", { count: 3 }));

    internals.selectGroup(plan.groups[0], false); // 清掉 A 组两篇（内部整块重画，把桩冲掉了）
    const after = attachSummaryStub(internals);

    internals.renderSummary();

    expect(after.texts).toContain(i18next.t("batch.summary_count", { count: 1 }));
    // 反面：重画后**不该**还写着 3 篇。少了这一条，一个只把新数字"追加"上去的实现也能过。
    expect(after.texts).not.toContain(i18next.t("batch.summary_count", { count: 3 }));
  });

  it("汇总按站点分组重画：整组清掉后那一组不再出现在汇总里", () => {
    const internals = openModal(plan).modal;

    internals.selectGroup(plan.groups[0], false);
    const stub = attachSummaryStub(internals);

    internals.renderSummary();

    // 汇总里的组标题是 `站点名（篇数）`。清掉 A 组后只剩 B 组
    expect(stub.texts.some((text) => text.startsWith("B（"))).toBe(true);
    expect(stub.texts.some((text) => text.startsWith("A（"))).toBe(false);
  });

  it("一篇都没勾时把确认按钮禁掉 —— 空勾选不能发布", () => {
    // `confirmButton.setDisabled(summary.total === 0)` 是「空勾选不发布」的**唯一**闸门，
    // 而它就在那段原本从不执行的 `renderSummary` 里。
    const internals = openModal(plan).modal;

    internals.selectGroup(plan.groups[0], false);
    internals.selectGroup(plan.groups[1], false);

    const disabled = recordDisabled(internals);
    attachSummaryStub(internals); // 闸门在 renderSummary 里 —— 没这个桩它会提前返回，什么都记不到
    internals.renderSummary();

    expect(disabled).toEqual([true]);
  });

  it("还有勾选时不禁用确认按钮（与上一条成对：闸门是看值，不是恒禁用）", () => {
    const internals = openModal(plan).modal;

    internals.selectGroup(plan.groups[0], false); // 还剩 B 组一篇

    const disabled = recordDisabled(internals);
    attachSummaryStub(internals);
    internals.renderSummary();

    expect(disabled).toEqual([false]);
  });
});

/** 造一份执行结果。`ok: false` 的那几条只有 `path` 与 `reason` 是汇总要用的 */
function summaryOf(
  action: BatchRunSummary["action"],
  results: BatchRunSummary["results"],
  skippedCount = 0,
): BatchRunSummary {
  return {
    action,
    results,
    successCount: results.filter((item) => item.ok).length,
    failureCount: results.filter((item) => !item.ok).length,
    skippedCount,
  };
}

/**
 * 渲染一份汇总，把弹窗写出来的每一段文字收集回来。
 *
 * `tests/setup.ts` 的 `Modal.contentEl.createEl()` 返回 `undefined`（不记录任何东西），
 * 所以这里跟 `attachSummaryStub` 一样，只给这一个实例喂最小桩 —— 不建 UI mock 基建，
 * 又让 `onOpen()` 真的跑起来。`showBatchSummary()` 本身在测试里什么也开不起来
 *（`Modal.open()` 不调 `onOpen`），所以直接构造导出的类。
 */
function renderSummary(summary: BatchRunSummary): string[] {
  const plugin = { app: {} as App, settings: createSettings() } as unknown as HaloPlugin;
  const modal = new BatchSummaryModal(plugin, summary) as unknown as {
    contentEl: HTMLElement;
    onOpen(): void;
  };
  const texts: string[] = [];

  modal.contentEl = {
    createEl: (_tag: string, options?: { text?: string }) => {
      if (options?.text !== undefined) {
        texts.push(options.text);
      }

      return undefined;
    },
    empty: () => {
      texts.length = 0;
    },
  } as unknown as HTMLElement;

  modal.onOpen();

  return texts;
}

describe("BatchSummaryModal 的汇总渲染", () => {
  it("成功 / 失败 / 执行前跳过三档分开报，不是一个「完成 N 篇」", () => {
    // 判别器：把 `summary_line` 的插值只留 `success`（或者把 failed 与 skipped 对调）就会红。
    // 后果很具体：118 篇里 3 篇失败而汇总只说「118 篇完成」—— 用户被告知了一件假事，
    // 他以为站点上齐了，实际少了三篇，而那三篇正是他需要去手工处理的。
    const texts = renderSummary(
      summaryOf(
        "publish",
        [
          { path: "a.md", ok: true },
          { path: "b.md", ok: false, reason: "炸了" },
        ],
        2,
      ),
    );

    expect(texts).toContain(i18next.t("batch.summary_line", { success: 1, failed: 1, skipped: 2 }));
  });

  it("失败篇数变了汇总行就跟着变（数字真的来自 summary，不是写死的）", () => {
    // 上一条断言的是「用对了键与参数」。这一条补的是它的反面：
    // 一个把三个参数都硬编码成常量的实现能过上一条吗？不能 —— 但它也过不了这一条。
    // 两条合起来才把「渲染出来的数字确实随 summary 变」钉住。
    const one = renderSummary(summaryOf("publish", [{ path: "a.md", ok: false, reason: "炸了" }], 0));
    const two = renderSummary(
      summaryOf(
        "publish",
        [
          { path: "a.md", ok: false, reason: "炸了" },
          { path: "b.md", ok: false, reason: "炸了" },
        ],
        0,
      ),
    );

    expect(one).not.toEqual(two);
  });

  it("失败项逐条列出（路径 + 原因），成功项一条都不列", () => {
    // 只列失败项是刻意的：118 行「x.md 成功」会把失败的那三行淹掉，
    // 而用户此刻唯一要做的事就是处理那三行。
    const texts = renderSummary(
      summaryOf(
        "publish",
        [
          { path: "ok.md", ok: true },
          { path: "b.md", ok: false, reason: "上传图片失败" },
          { path: "c.md", ok: false, reason: "站点拒绝" },
        ],
        0,
      ),
    );

    expect(texts).toContain("b.md —— 上传图片失败");
    expect(texts).toContain("c.md —— 站点拒绝");
    // 空断言，上面两条就是它的对照物（同一份 summary 里确实有失败项可列）。
    // 它挡的是「把成功项也一并列出来」——那正是这条用例存在的理由。
    expect(texts.some((text) => text.includes("ok.md"))).toBe(false);
  });

  it("没有失败项时一行失败明细都不出现（但仍报三档数字）", () => {
    const texts = renderSummary(summaryOf("unpublish", [{ path: "a.md", ok: true }], 1));

    expect(texts.some((text) => text.includes(" —— "))).toBe(false);
    // 对照物：上面那条证明「 —— 」这种明细行本来是会出现的（同一段代码、换成有失败的输入就有）。
    expect(texts).toContain(i18next.t("batch.summary_line", { success: 1, failed: 0, skipped: 1 }));
  });

  it("失败项没有 reason 时显示空串，绝不把 undefined 印给用户", () => {
    const texts = renderSummary(summaryOf("draft", [{ path: "b.md", ok: false }], 0));

    expect(texts).toContain("b.md —— ");
    expect(texts.some((text) => text.includes("undefined"))).toBe(false);
  });

  it("标题按 action 分档：跑完撤回不会显示成「发布完成」", () => {
    // 三个命令跑完都是同一句话的话，用户点了「批量撤回」看到「成功 118 篇」，
    // 弹窗**没说是撤回了还是发出去了** —— 而这正是他跑完之后最需要确认的那件事。
    const draft = renderSummary(summaryOf("draft", [{ path: "a.md", ok: true }]));
    const unpublish = renderSummary(summaryOf("unpublish", [{ path: "a.md", ok: true }]));

    expect(draft).toContain(i18next.t("batch.summary_title_draft"));
    expect(unpublish).toContain(i18next.t("batch.summary_title_unpublish"));
    // 反面：写死一个标题的实现能过上一条、过不了这一条
    expect(draft).not.toContain(i18next.t("batch.summary_title_unpublish"));
  });
});

describe("确认弹窗的「笔记会被改写」提示", () => {
  /** 渲染一次确认弹窗，收回每个 `Setting` 的名称（spy 手法见 `captureSettingNames`） */
  function settingNames(plan: BatchPlan, settings?: HaloSetting): string[] {
    return captureSettingNames(() => {
      openModal(plan, settings).modal.renderContent();
    });
  }

  it("关掉「替换图片链接」也照提示：回写 frontmatter 与那个开关无关", () => {
    // 判别器：把门控条件改回 `this.plugin.settings.replaceImageLinks` 就会红。
    //
    // 为什么这条提示必须**不**依赖那个开关：`executePublish()` 的 `processFrontMatter()` 是
    // **无条件**的 —— 关掉开关后跑批量推草稿 / 发布，笔记里的 title / slug / cover / excerpt /
    // categories / tags 与整个 `halo` 块照样被改写。按那个开关门控 = 在最需要提醒的时候
    //（用户刚关掉它、以为笔记不会再被动）**一条提示都不显示**，是「该响不响的警告」。
    const names = settingNames(
      planWith([{ site: siteA, paths: ["a.md"] }]),
      createSettings({ replaceImageLinks: false }),
    );

    // 在场对照物：同一个弹窗确实把内容渲染出来了（分组标题在），
    // 所以下面那条「包含」不会是「什么都没渲染」的假绿。
    expect(names).toContain("A（1）");
    expect(names).toContain(i18next.t("batch.notice_rewrites_notes"));
  });

  it("撤回时不提示：撤回一个字节都不改本地笔记", () => {
    // 判别器：把门控改回「恒显示」就会红。
    const names = settingNames(planWith([{ site: siteA, paths: ["a.md"] }], "unpublish"));

    // 同上：先证明渲染真的跑到了，再说「没有那条提示」
    expect(names).toContain("A（1）");
    expect(names).not.toContain(i18next.t("batch.notice_rewrites_notes"));
  });
});

/**
 * 一份「笔记写的显示名与站点现有清单对不上」的计划：站点的分类/标签快照为空，而笔记写着两个
 * 显示名 —— `summarizeSelection` 的 `pickNewTerms` 因此把它们算成「将新建」。
 * 对撤回而言这**绝不会发生**（撤回一个分类/标签都不建），正是下面两条要钉的那件事。
 */
function planWithNewTerms(action: BatchPlan["action"]): BatchPlan {
  return {
    action,
    groups: [
      {
        site: siteA,
        items: [{ ...item("a.md", siteA), categories: ["技术"], tags: ["Halo"] }],
        taxonomy: { categories: [], tags: [] },
      },
    ],
    skipped: [],
  };
}

describe("确认弹窗的「将新建」汇总按 action 分档", () => {
  /** 跑一次 `renderSummary()`，同时收回 `Setting` 的名称与写进汇总容器的文字 */
  function renderSummarySettings(plan: BatchPlan): { names: string[]; texts: string[] } {
    let texts: string[] = [];
    const names = captureSettingNames(() => {
      const { modal } = openModal(plan);
      texts = attachSummaryStub(modal).texts;
      modal.renderSummary();
    });

    return { names, texts };
  }

  it("撤回不渲染「将新建的分类 / 标签」：撤回什么也不建", () => {
    // 判别器：把 `mayCreateTaxonomy` 那道门控去掉（恢复成只看 `length > 0`）就会红。
    //
    // 为什么这属于「说一套做一套」：撤回连 `executePublish()` 都不进，一个分类/标签都不会建。
    // 只要某篇笔记写的显示名与站点现有清单对不上（站点侧改名/删除，或用户手改过 frontmatter），
    // 一次「批量撤回」的确认弹窗就会宣称要新建它们 —— 用户在按下「确认」之前看到的是一件
    // **本次绝不会发生**的事。这与图片那一行原本的毛病同源（都不按 action 分档），
    // 处置也照抄 A18：撤回时 `planBatch` 把 `images` 归零、那一行自然不渲染。
    const { names, texts } = renderSummarySettings(planWithNewTerms("unpublish"));

    // 在场对照物：汇总**确实重画过**（「将处理 1 篇」那一行在）。
    // 没有它，下面两个「不在」在 `renderSummary()` 提前返回时也永久为真。
    expect(texts).toContain(i18next.t("batch.summary_count", { count: 1 }));
    expect(names).not.toContain(i18next.t("batch.row_new_categories"));
    expect(names).not.toContain(i18next.t("batch.row_new_tags"));
  });

  it("同样的候选换成 publish 时两行都在（上一条「不渲染」的对照物）", () => {
    const { names, texts } = renderSummarySettings(planWithNewTerms("publish"));

    expect(texts).toContain(i18next.t("batch.summary_count", { count: 1 }));
    expect(names).toContain(i18next.t("batch.row_new_categories"));
    expect(names).toContain(i18next.t("batch.row_new_tags"));
  });
});
