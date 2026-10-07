import { beforeAll, beforeEach, expect, rs, test } from "@rstest/core";
import type { PluginManifest, TFile } from "obsidian";
import { initializeI18n } from "../src/i18n";
import HaloPlugin from "../src/main";
import HaloService from "../src/service";
import { confirmBatchPlan, showBatchSummary } from "../src/ui/modals/batch-confirm-modal";
import { createFile, createSettings } from "./helpers/obsidian-mocks";

/**
 * `runBatchCommand` **越过确认弹窗之后**的那一段。
 *
 * 为什么必须单独一个文件：`confirmBatchPlan` 的 Promise 在 `tests/setup.ts` 的假
 * `Modal.open()`（不调 `onOpen()`）下永不 settle，所以 `tests/main.test.ts` 里那条用例
 * 只能断言「流程**停在**弹窗上」。停在弹窗**之前**的那些事（守卫、候选筛选、规划）
 * 都还有覆盖，但**三段之后**的事全都没有：
 *
 * 1. 弹窗交回来的 `selected` 是否**原样**透传给了 `runBatch`；
 * 2. `showBatchSummary` 是否真的被调用了（以及拿到的 summary 是不是本次运行的结果）；
 * 3. `await this.saveSettings()` 是否还在（图片缓存不落盘，下次还得重传一遍）。
 *
 * 第 1 条的后果最重：把 `selected` 换成「全部路径」的话，**用户取消勾选的那几篇照发不误** ——
 * 正是 `src/batch-publish.ts` 里那段注释点名的灾难（「用户以为自己取消了、实际上整批被执行」），
 * 而此前**没有任何一条用例会因此变红**（37 条 batch-publish + main 里那 3 条全绿）。
 *
 * 手法是把 `src/batch-confirm-modal` 整个模块换成假的，让确认那一步**立即返回**。
 * 这是唯一能越过去的办法：真弹窗的 Promise 没有别的出口（`Button.onClick` 在
 * `tests/setup.ts` 里也不记录回调）。
 */
rs.mock("src/ui/modals/batch-confirm-modal", () => ({
  confirmBatchPlan: rs.fn(),
  showBatchSummary: rs.fn(),
}));

/** 上面工厂产出的两个 `rs.fn()`，按模块导出取回来用（不引用外部变量，见工厂的约束） */
type MockFn = ReturnType<typeof rs.fn>;
const confirmMock = confirmBatchPlan as unknown as MockFn;
const summaryMock = showBatchSummary as unknown as MockFn;

/**
 * 初始化 i18n —— 走生产同一条入口。这个文件本身不直接断言文案，但
 * `runBatchCommand` → `collectBatchCandidates` → `resolveSite` 这条链上有 `Notice`，
 * 且 `main.ts` 的 `batch.*` 键在未初始化时会被原样当文案弹出去，不利于排错。
 */
beforeAll(async () => {
  await initializeI18n("en");
});

beforeEach(() => {
  confirmMock.mockReset();
  summaryMock.mockReset();
});

type Internals = {
  app: unknown;
  settings: unknown;
  saveSettings(): Promise<void>;
  runBatchCommand(action: "draft" | "publish" | "unpublish"): Promise<void>;
};

/**
 * 造一个插件实例 + 一个只够跑完本流程的假 app。
 *
 * 注意**必须显式赋 `plugin.app`**：测试里 `obsidian` 被整体 mock，`tests/setup.ts` 的
 * `Plugin` 构造函数不接参数，真实注入的 `this.app` 是 undefined。
 */
function makePlugin(files: TFile[]): Internals {
  const app = {
    vault: { getMarkdownFiles: () => files, read: rs.fn(async () => "") },
    metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
  };
  const plugin = new HaloPlugin(app as never, {} as PluginManifest) as unknown as Internals;

  plugin.app = app;
  plugin.settings = createSettings();

  return plugin;
}

test("确认交回来的集合被原样执行：只发勾选的那一篇，并弹出汇总", async () => {
  // 判别器：把 `main.ts` 里 `runBatch(plan, selected, serviceFor)` 的 `selected`
  // 换成 `new Set(plan.groups.flatMap((g) => g.items.map((i) => i.file.path)))`
  // （或换成「全选」）就会红 —— 而那种改动的后果是用户取消勾选的那几篇照发不误。
  const plugin = makePlugin([createFile("notes/a.md"), createFile("notes/b.md")]);

  // 勾选集合的键是 **`file.path`**（`notes/a.md`），不是 `file.name`（`a.md`）。
  // 第一版这里写成 `a.md`，结果 `runBatch` 一篇都匹配不上、什么都不发 ——
  // 而那条用例当时是**红的**，正好说明这个键确实被端到端地用着（不是摆设）。
  confirmMock.mockResolvedValue(new Set(["notes/a.md"]));

  const published: string[] = [];
  const publish = rs.spyOn(HaloService.prototype, "publishPost").mockImplementation((async (file: TFile) => {
    published.push(file.path);
    return { ok: true };
  }) as never);
  const save = rs.spyOn(plugin, "saveSettings");

  try {
    await plugin.runBatchCommand("publish");

    // b.md 一次都不该被碰：它没在弹窗交回来的集合里
    expect(published).toEqual(["notes/a.md"]);

    // 三段之后的事各自要有断言，否则「它还在」这件事没人守
    expect(summaryMock).toHaveBeenCalledTimes(1);
    // 弹的是**本次运行的结果**，不是一个空壳：成功 1 篇、失败 0 篇、没有执行前跳过
    expect(summaryMock.mock.calls[0][1]).toMatchObject({ successCount: 1, failureCount: 0, skippedCount: 0 });
    // 图片缓存写进了 settings，必须落盘
    expect(save).toHaveBeenCalledTimes(1);
  } finally {
    publish.mockRestore();
    save.mockRestore();
  }
});

test("用户取消（confirmBatchPlan 交回 undefined）：一篇都不发，也不弹汇总", async () => {
  // 与上一条**成对**：同一段代码、只换确认的返回值。上一条证明「交回集合时确实会发、
  // 确实会弹汇总」，所以这里的两个「没有」才不是「代码根本没走到」的假绿。
  const plugin = makePlugin([createFile("notes/a.md")]);

  confirmMock.mockResolvedValue(undefined);

  const published: string[] = [];
  const publish = rs.spyOn(HaloService.prototype, "publishPost").mockImplementation((async (file: TFile) => {
    published.push(file.path);
    return { ok: true };
  }) as never);

  try {
    await plugin.runBatchCommand("publish");

    // 本用例内**自己的**在场对照物：确认那一步确实走到了。没有它，下面两个「没有发生」
    // 的断言在「流程根本没走到弹窗」的实现下也永久为真（本阶段最主要的缺陷类）。
    // 上一条用例虽然也证明了这一点，但那是**跨用例**的依赖 —— 单跑这一条时它不成立。
    expect(confirmMock).toHaveBeenCalledTimes(1);

    expect(published).toEqual([]);
    // 取消不该弹出一份「成功 0 篇」的汇总 —— 那会让用户以为操作执行过了
    expect(summaryMock).not.toHaveBeenCalled();
  } finally {
    publish.mockRestore();
  }
});
