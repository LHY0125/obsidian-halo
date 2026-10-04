import { beforeAll, describe, expect, it } from "@rstest/core";
import i18next from "i18next";
import type { App, TFile } from "obsidian";
import { BatchConfirmModal } from "src/batch-confirm-modal";
import type { BatchGroup, BatchItem, BatchPlan } from "src/batch-publish";
import { initializeI18n } from "src/i18n";
import type HaloPlugin from "src/main";
import type { HaloSite } from "src/settings";
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

function planWith(spec: { site: HaloSite; paths: string[] }[]): BatchPlan {
  return {
    action: "publish",
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
function openModal(plan: BatchPlan): Harness {
  let decided = false;
  let result: Set<string> | undefined;

  // 只要满足弹窗构造与渲染的读取面（`app` 传给 Modal 基类、`settings.replaceImageLinks`）
  const plugin = { app: {} as App, settings: createSettings() } as unknown as HaloPlugin;

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
