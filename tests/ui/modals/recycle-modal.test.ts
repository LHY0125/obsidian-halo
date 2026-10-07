import { beforeAll, describe, expect, rs, test } from "@rstest/core";
import i18next from "i18next";
import * as obsidianRuntime from "obsidian";
import type { PluginManifest } from "obsidian";
import { LIST_PAGE_SIZE, type PagedResult } from "../../../src/core/pagination";
import { initializeI18n } from "../../../src/i18n";
import HaloPlugin from "../../../src/main";
import PageService from "../../../src/service/page-service";
import { McpClient } from "../../../src/transport/mcp-client";
import { PageManagerModal, RecycleBinModal } from "../../../src/ui/modals/recycle-modal";
import type { McpRecycledPostItem, RecycledItem } from "../../../src/ui/models/recycle-model";
import { TEST_SITE, createFile, createMockApp, createSettings } from "../../helpers/obsidian-mocks";

/**
 * 初始化 i18n（生产同一条入口）。理由同 `attachment-modal.test.ts`：不初始化时
 * `i18next.t()` 原样返回**键名**，而断言是拿 `i18next.t(键)` 去比的 —— 两边同时退化成
 * 键名，断言**照样通过**，写错键名甚至整组键被删都测不出来。
 */
beforeAll(async () => {
  await initializeI18n("en");
});

/** `tests/setup.ts` 里那个 Notice 构造器会把每条文案推进这个数组 */
function capturedNotices(): string[] {
  return (obsidianRuntime as unknown as { __notices: string[] }).__notices;
}

/** 逐字取自 2026-10-05 对站点 `halo_list_posts` / `halo_list_single_pages` 的实测形状 */
function recycledItem(overrides: Partial<McpRecycledPostItem> = {}): McpRecycledPostItem {
  return {
    name: "019f...",
    title: "AGENTS",
    slug: "agents",
    published: false,
    publishRequested: false,
    recycled: true,
    visible: "PUBLIC",
    permalink: "/archives/agents",
    ...overrides,
  };
}

function page(items: McpRecycledPostItem[], hasNext = false): PagedResult<McpRecycledPostItem> {
  return { items, page: 1, size: LIST_PAGE_SIZE, total: items.length, totalPages: 1, hasNext };
}

/** 一条已经映射好的条目（恢复 / 回收那两个动作的入参） */
function item(name: string, kind: "post" | "page" = "post"): RecycledItem {
  return {
    kind,
    name,
    title: `title-${name}`,
    permalink: `/archives/${name}`,
    type: kind === "post" ? "POST" : "SINGLE_PAGE",
  };
}

interface CapturedEl {
  tag: string;
  text: string;
}

/**
 * 造一个插件实例。与 `tests/main.test.ts` 的 `makePlugin` 同一处置：`tests/setup.ts` 的
 * `Plugin` 构造函数**不接参数**，所以 `this.app` 是 undefined（真实 Obsidian 由框架注入），
 * 传进构造函数的两个参数只为满足 tsc。
 *
 * `settings` 必须显式赋值：`PageManagerModal` 会拿它构造 `PageService`。
 */
function makePlugin(): HaloPlugin {
  const { app } = createMockApp("", createFile("notes/a.md"), []);
  const plugin = new HaloPlugin(app, {} as PluginManifest) as unknown as { app: unknown; settings: unknown };

  plugin.app = app;
  plugin.settings = createSettings();

  return plugin as unknown as HaloPlugin;
}

/**
 * 把弹窗那个哑的 `contentEl` 换成会记录 `createEl` 的假对象 —— 桩里那个是
 * `createEl: () => undefined`，不抛错但也什么都不留，断言无从下手。
 * 它在桩里是**普通实例属性**（不是 getter），所以可以直接替换。
 */
function attachRecordingEl(modal: unknown): CapturedEl[] {
  const created: CapturedEl[] = [];

  (modal as { contentEl: unknown }).contentEl = {
    createEl: (tag: string, options?: { text?: string }) => {
      created.push({ tag, text: options?.text ?? "" });
      return undefined;
    },
    // 生产代码每次渲染都先 `empty()` 再重建，所以这里也清一遍 ——
    // 否则「恢复 / 回收之后重渲」那条路径会把上一次的残留混进来。
    empty: () => {
      created.length = 0;
    },
  };

  return created;
}

/**
 * 直接 `await` 那个私有的 `render()`，**不走 `onOpen()`**。
 *
 * 这一步是必需的、不是风格选择：`onOpen()` 里是 `void this.render()`，于是 `render()`
 * 抛出的异常变成一条**未处理的 rejection** —— rstest 只往 stderr 刷一行，`failedTests`
 * 仍然是 **0**，没有哪条用例认领它（`attachment-modal.test.ts` 实测过同一件事）。
 *
 * 用 cast 取私有方法与本仓既有约定一致（`tests/main.test.ts` 的 `Internals` 就是这么做的）。
 */
async function renderOf(modal: unknown): Promise<void> {
  await (modal as { render(): Promise<void> }).render();
}

/**
 * 回收站弹窗。
 *
 * ⚠️ 这里钉的是**取数参数**，不是「弹窗长什么样」：逐行渲染的 `Setting` 在桩里不记录任何
 * 东西，所以每行的标题与 permalink 观察不到；能观察到的是 `contentEl` 上直接建出来的
 * 元素（标题、空态提示、截断提示）以及**打桩后的取数调用**。取数参数才是这个弹窗里最要紧的
 * 那一处 —— 传错的表现是两个弹窗的内容正好对调（见下面 `PageManagerModal` 那一组）。
 */
describe("RecycleBinModal.render", () => {
  test("文章档取的是**回收站里**的文章 —— 显式传 recycled:true", async () => {
    const modal = new RecycleBinModal(makePlugin(), TEST_SITE, "post");
    const created = attachRecordingEl(modal);
    const call = rs.spyOn(McpClient.prototype, "callToolJson").mockResolvedValue(page([recycledItem()]));

    try {
      await renderOf(modal);

      // 一次断言同时钉住三件事：调的是文章的列表工具、走的是读路径、`recycled` 显式传了 true。
      // 漏传 `recycled` 时（schema 的默认值是 false）这里会红 —— 而线上表现为
      // 「回收站里列出了站点上全部文章」，用户以为自己删过一堆东西。
      expect(call).toHaveBeenCalledWith("halo_list_posts", { page: 1, size: LIST_PAGE_SIZE, recycled: true });
      // 先证明文案键**真的解析出了文案**：没解析的话下面那条断言会与代码一起退化成键名比较
      expect(i18next.t("recycle_modal.title_post")).not.toBe("recycle_modal.title_post");
      expect(created[0]).toEqual({ tag: "h2", text: i18next.t("recycle_modal.title_post") });
    } finally {
      call.mockRestore();
    }
  });

  test("页面档走的是页面的列表工具，标题也换成页面那一句", async () => {
    // 与上一条成对：`kind` 只在工具名、标题键这两处分档。写死其中一档的实现只有这一条能拆穿。
    const modal = new RecycleBinModal(makePlugin(), TEST_SITE, "page");
    const created = attachRecordingEl(modal);
    const call = rs.spyOn(McpClient.prototype, "callToolJson").mockResolvedValue(page([recycledItem()]));

    try {
      await renderOf(modal);

      expect(call).toHaveBeenCalledWith("halo_list_single_pages", { page: 1, size: LIST_PAGE_SIZE, recycled: true });
      expect(created[0]).toEqual({ tag: "h2", text: i18next.t("recycle_modal.title_page") });
    } finally {
      call.mockRestore();
    }
  });

  test("回收站为空时给出「空的」这句结论，而不是一片空白", async () => {
    // 站点实测今天回收站里有 4 篇文章 + 1 个页面，所以这条**不是**当前的真实状态 ——
    // 它防的是另一种情况：用户把里面的东西都恢复完之后打开，看到空白会以为插件坏了。
    const modal = new RecycleBinModal(makePlugin(), TEST_SITE, "post");
    const created = attachRecordingEl(modal);
    const call = rs.spyOn(McpClient.prototype, "callToolJson").mockResolvedValue(page([]));

    try {
      await renderOf(modal);

      expect(created.map((element) => element.text)).toContain(i18next.t("recycle_modal.empty"));
    } finally {
      call.mockRestore();
    }
  });

  test("有条目时不显示空态提示", async () => {
    const modal = new RecycleBinModal(makePlugin(), TEST_SITE, "post");
    const created = attachRecordingEl(modal);
    const call = rs.spyOn(McpClient.prototype, "callToolJson").mockResolvedValue(page([recycledItem()]));

    try {
      await renderOf(modal);

      expect(created.map((element) => element.text)).not.toContain(i18next.t("recycle_modal.empty"));
    } finally {
      call.mockRestore();
    }
  });

  test("列表不完整时提示「不完整」—— 本用例用**空页**造 truncated", async () => {
    // `truncated` 有两个来源：① 某一页返回空 `items`（终止保证 ②，见 `pagination.ts`）；
    // ② 翻满 `maxPages` 而 `hasNext` 一直为真。本用例走的是**前者** ——
    // 「第一页有内容 + 第二页空 + 两页都说还有下一页」就是造 `truncated` 最省的写法。
    //
    // ⚠️ 正因如此，本用例对 **`maxPages` 那条分支零判别力**：把 `MAX_PAGES_DEFAULT` 改大、
    // 或把上限整个删掉，这里照样绿（钉 `maxPages` 的是 `tests/pagination.test.ts`）。
    // 别把它当成「上限还在」的证据。静默截断是本阶段反复处理的那类问题。
    const modal = new RecycleBinModal(makePlugin(), TEST_SITE, "post");
    const created = attachRecordingEl(modal);
    let calls = 0;
    const call = rs.spyOn(McpClient.prototype, "callToolJson").mockImplementation(async () => {
      calls++;
      return calls === 1 ? page([recycledItem()], true) : page([], true);
    });

    try {
      await renderOf(modal);

      expect(calls).toBe(2);
      expect(created.map((element) => element.text)).toContain(i18next.t("recycle_modal.notice_truncated"));
    } finally {
      call.mockRestore();
    }
  });

  test("恢复走 `restoreRecycled` 那条路：写路径 + 按 item.kind 选工具", async () => {
    // 「恢复」这个按钮的 `onClick` 在脚手架里**永远不会被触发**（`Setting.addButton` 不记录
    // 回调），所以动作体被抽成了具名的 `restoreItem` —— 内联进 `onClick` 的话，
    // 把恢复改成 `callToolJson`（会在**恢复成功之后**抛错）或者写死文章工具
    //（会把页面当文章恢复）这两件事，全套测试照样全绿。
    const modal = new RecycleBinModal(makePlugin(), TEST_SITE, "page");
    attachRecordingEl(modal);
    const read = rs.spyOn(McpClient.prototype, "callToolJson").mockResolvedValue(page([]));
    const write = rs.spyOn(McpClient.prototype, "callToolVoid").mockResolvedValue(undefined);
    const before = capturedNotices().length;

    try {
      // 先渲染一次，这样下面那条「读路径调了两次」才是在说**动作后又重取了一遍**，
      // 而不是把首次渲染那一次也算进来。
      await renderOf(modal);

      await (modal as unknown as { restoreItem(item: RecycledItem): Promise<void> }).restoreItem(
        item("page-1", "page"),
      );

      expect(write).toHaveBeenCalledWith("halo_restore_single_page", { name: "page-1" });
      // 成功之后要留一句话：恢复是静默发生的，没有提示用户不知道点没点上。
      expect(capturedNotices().slice(before)).toEqual([
        i18next.t("recycle_modal.notice_restored", { title: "title-page-1" }),
      ]);
      // 动作完成后要重取一遍（而不是从内存里删掉那一行）：服务端才是权威。
      // 首次渲染一次 + 动作后重渲一次 = 2。
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });
});

/**
 * 管理独立页面弹窗。
 *
 * ⚠️ **它和回收站弹窗最关键的区别就是 `recycled` 那一档**，而这恰恰是最难看出来的一处：
 * 传错时两个弹窗都「正常工作」，只是内容正好对调（「管理页面」列出回收站里的、
 * 「回收站」列出全部）。所以下面第一条断言与上面文章档那条是**成对的**，要一起看。
 */
describe("PageManagerModal.render", () => {
  test("取的是**不在回收站里**的页面 —— recycled:false，与回收站弹窗正好相反", async () => {
    const modal = new PageManagerModal(makePlugin(), TEST_SITE);
    const created = attachRecordingEl(modal);
    const call = rs
      .spyOn(McpClient.prototype, "callToolJson")
      .mockResolvedValue(page([recycledItem({ recycled: false })]));

    try {
      await renderOf(modal);

      expect(call).toHaveBeenCalledWith("halo_list_single_pages", { page: 1, size: LIST_PAGE_SIZE, recycled: false });
      expect(i18next.t("page_manager_modal.title")).not.toBe("page_manager_modal.title");
      expect(created[0]).toEqual({ tag: "h2", text: i18next.t("page_manager_modal.title") });
    } finally {
      call.mockRestore();
    }
  });

  test("站点上没有页面时给出结论，而不是一片空白", async () => {
    const modal = new PageManagerModal(makePlugin(), TEST_SITE);
    const created = attachRecordingEl(modal);
    const call = rs.spyOn(McpClient.prototype, "callToolJson").mockResolvedValue(page([]));

    try {
      await renderOf(modal);

      expect(created.map((element) => element.text)).toContain(i18next.t("page_manager_modal.empty"));
    } finally {
      call.mockRestore();
    }
  });

  test("列表不完整时同样提示「不完整」—— 同样用**空页**造 truncated", async () => {
    // 与回收站弹窗同一个判据：`PageService.getPages()`（拉取选择器那条路）会在列表不完整时
    // 提示，这里是页面列表的另一个出口 —— 少掉它，用户看到的是一个「少了几个页面」的列表
    // 而没有任何线索。
    //
    // 造法与那条一样（空页，见 `pagination.ts` 的终止保证 ②），所以同样**验不到 `maxPages`
    // 那条分支**。这里多一层：本弹窗的取数走 `fetchActivePages()`，与 `PageService.getPages()`
    // 是**两份实现**（一份抛、一份不抛），所以这条用例钉的是弹窗自己那一份。
    const modal = new PageManagerModal(makePlugin(), TEST_SITE);
    const created = attachRecordingEl(modal);
    let calls = 0;
    const call = rs.spyOn(McpClient.prototype, "callToolJson").mockImplementation(async () => {
      calls++;
      return calls === 1 ? page([recycledItem()], true) : page([], true);
    });

    try {
      await renderOf(modal);

      expect(created.map((element) => element.text)).toContain(i18next.t("page_manager_modal.notice_truncated"));
    } finally {
      call.mockRestore();
    }
  });

  test("回收**走 `PageService`**，不在弹窗里自己拼工具名", async () => {
    // 这是本任务的一处刻意偏离（计划的草案里直接把 `CONTENT_TOOLSETS.page.recycle` 拼在
    // `onClick` 里）。拼工具名等于给「回收页面」开了**第二个入口**：以后要加重试、加日志、
    // 改工具名，只改服务层那一处，而这个入口会静默掉队 —— 本地完全看不出来。
    //
    // 动作体抽成具名的 `recycleItem` 才能测到这里（理由同回收站那条）。改成直接调
    // `this.client.callToolVoid(...)` 的话，`recyclePage` 这条断言会红。
    const modal = new PageManagerModal(makePlugin(), TEST_SITE);
    attachRecordingEl(modal);
    const read = rs.spyOn(McpClient.prototype, "callToolJson").mockResolvedValue(page([]));
    const recycle = rs.spyOn(PageService.prototype, "recyclePage").mockResolvedValue(undefined);
    const before = capturedNotices().length;

    try {
      await (modal as unknown as { recycleItem(item: RecycledItem): Promise<void> }).recycleItem(
        item("page-1", "page"),
      );

      expect(recycle).toHaveBeenCalledWith("page-1");
      expect(capturedNotices().slice(before)).toEqual([
        i18next.t("page_manager_modal.notice_recycled", { title: "title-page-1" }),
      ]);
    } finally {
      read.mockRestore();
      recycle.mockRestore();
    }
  });
});
