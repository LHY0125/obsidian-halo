import { describe, expect, it } from "@rstest/core";
import type { App, TFile } from "obsidian";
import { BatchConfirmModal } from "src/batch-confirm-modal";
import type { BatchGroup, BatchItem, BatchPlan } from "src/batch-publish";
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
 * 覆盖不到的部分（已在实现文件里注明）：逐条勾选框的 `onChange`、`renderSummary` 的重画
 * 与按钮的禁用态 —— 那几处只有 DOM 与 mock 配合才验得到，本仓库不为 UI 建 mock 基建。
 */

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

/** 弹窗的三个私有出口 —— 见 `openModal` 里为什么不走「模拟点击」 */
type ModalInternals = {
  confirm(): void;
  cancel(): void;
  selectGroup(group: BatchGroup, selected: boolean): void;
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
    const { modal, decision } = openModal(plan);

    modal.selectGroup(plan.groups[0], false);

    // 这一步也顺带证明 `selectGroup` 会整块重画（重画跑不通的话这里会先抛）
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
    expect(decision()).toBeUndefined();

    modal.selectGroup(plan.groups[0], false);
    modal.confirm();

    expect(wasDecided()).toBe(true);
    expect(decision()).toEqual(new Set());
  });
});
