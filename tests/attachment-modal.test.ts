import { beforeAll, describe, expect, rs, test } from "@rstest/core";
import i18next from "i18next";
import type { PluginManifest } from "obsidian";
import { AttachmentManagerModal, attachmentUrl } from "../src/attachment-modal";
import type { McpAttachmentItem } from "../src/attachment-model";
import { initializeI18n } from "../src/i18n";
import HaloPlugin from "../src/main";
import { LIST_PAGE_SIZE, type PagedResult } from "../src/pagination";
import { McpClient } from "../src/transport/mcp-client";
import { TEST_SITE, createFile, createMockApp } from "./helpers/obsidian-mocks";

/**
 * 初始化 i18n（生产同一条入口）。
 *
 * 不只是「让文案好看」：不初始化时 `i18next.t()` 原样返回**键名**，
 * 而下面的断言是拿 `i18next.t(键)` 去比的 —— 两边同时退化成键名，断言**照样通过**。
 * 那样一条键被写错（甚至整组被删）都测不出来。初始化之后键名与文案才分得开。
 */
beforeAll(async () => {
  await initializeI18n("en");
});

/**
 * `attachment-modal.ts` 里那个纯函数的测试。
 *
 * 为什么值当单开一个文件：弹窗本身**没有测试脚手架** —— `tests/setup.ts` 把 `obsidian`
 * 整体 mock 了，`Modal.open()` 不调 `onOpen()`，`Setting.addButton` 也不记录回调，
 * 所以弹窗里那个 `for` 加几个 `if` 一行都跑不到。
 *
 * ⚠️ 特别是「复制链接」那个按钮：要写进剪贴板的是**绝对**地址，而它的 `onClick`
 * 在脚手架里永远不会被触发。把拼接抽成 `attachmentUrl()` 是让这条**本任务最关键的行为**
 * 能被测到的唯一办法 —— 留在 `onClick` 里的话，把它改回相对路径（本任务要防的那个缺陷）
 * 全套测试照样全绿。
 *
 * 站点地址与 permalink 的取值逐字取自 2026-10-05 对站点真实调用
 * `halo_list_attachments`（page 1, size 3）的返回，好让这里与线上真实形状对得上，
 * 而不是一组凭空想出来的字符串。
 */
const SITE = "https://blog.example.com";
const PERMALINK = "/upload/QQ20261004-204734-1791118063183.webp";

describe("attachmentUrl", () => {
  test("permalink 拼成**绝对**地址", () => {
    // 实测：`halo_list_attachments` 回的 permalink 以**单个** `/` 开头。
    expect(attachmentUrl(SITE, PERMALINK)).toBe("https://blog.example.com/upload/QQ20261004-204734-1791118063183.webp");
  });

  test("拼出来的一定带 scheme —— 相对路径会被本地图片管线当成 vault 内的文件", () => {
    // 这条断言是本任务的核心。判据在 `src/service/local-content.ts` 的 `isRemotePath()`：
    //
    //     /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//") || path.startsWith("#")
    //
    // `/upload/x.webp` **三条都不匹配**（`startsWith("//")` 要**两个**斜杠）。
    // 于是粘进笔记后被判成**本地路径**：`collectLocalImageReferences()` 会去 vault 里找它，
    // `resolveImageFile()` 找不到就**静默跳过** —— 图片不上传、链接不替换，Obsidian 里也显示不出来。
    // 用户看到的是「我明明粘了链接」，没有任何报错。所以这里钉的是「有 scheme」，
    // 而不是「看起来像不像网址」。
    const url = attachmentUrl(SITE, PERMALINK);

    expect(url).toMatch(/^https:\/\//);
    // 顺带钉住它**没有**退化成以 `/` 开头的相对路径 —— 那正是会被静默丢掉的那种形状。
    expect(url.startsWith("/")).toBe(false);
  });

  test("站点地址带尾斜杠时不拼出双斜杠", () => {
    // 站点地址由 `normalizeSiteUrl()` 归一，但 settings 还可能被手工改过 —— 两种都得对。
    expect(attachmentUrl("https://blog.example.com/", PERMALINK)).toBe(
      "https://blog.example.com/upload/QQ20261004-204734-1791118063183.webp",
    );
  });

  test("permalink 缺前导斜杠时仍然拼得对", () => {
    // 朴素的 `base + permalink` 会拼出 `https://blog.example.comupload/x.webp` ——
    // 那是一个**看起来像成功、点开却 404** 的地址，而这里没有任何东西能察觉它
    //（按钮就在那儿，只是打不开）。与 `search-modal.ts` 的处置一致。
    expect(attachmentUrl(SITE, "upload/x.webp")).toBe("https://blog.example.com/upload/x.webp");
  });

  test("没有 permalink 时回落空串（弹窗据此不画「复制链接」按钮）", () => {
    // 少了这一条，弹窗会画一个按了没反应的按钮。`toAttachmentItems()` 已经把缺失的
    // permalink 回落成空串（`halo_list_attachments` 的 `required` 是空数组，全部字段可选），
    // 这里要保证它不会拼出「站点首页」这种看着能用、点开却与附件无关的地址。
    expect(attachmentUrl(SITE, "")).toBe("");
  });

  test("permalink 只有一个斜杠时同样回落空串", () => {
    // `/` 去前导斜杠之后是空 —— 它指向的不是任何一个附件。回落成站点首页
    //（`https://blog.example.com/`）会让「复制链接」按钮画出来却是错的，
    // 与上一条合起来，判据只有一条：**没有文件名就不给地址**。
    expect(attachmentUrl(SITE, "/")).toBe("");
  });
});

/**
 * 弹窗 `render()` 的冒烟测试。
 *
 * 这一层通常**测不到**：`tests/setup.ts` 的 `Modal.open()` 不调 `onOpen()`，
 * 所以走 `new AttachmentManagerModal(...).open()` 那条路时 `render()` 一行都跑不到。
 * 这里绕开 `open()`，直接 `await` 那个私有的 `render()`（理由见 `renderOf()`），
 * 并把桩里那个哑的 `contentEl` 换成一个会记录 `createEl` 的假对象。
 *
 * ⚠️ **能断言的东西是有边界的，如实写在这里**：`Setting`/`Button` 在桩里不记录任何东西，
 * 所以逐行的附件名与副标题**观察不到**（单个附件的 `Setting` 不进 `contentEl` 的记录）。
 * 能观察到的只有 `contentEl` 上直接建出来的元素：标题、空态提示、截断提示。
 * 逐行的渲染判据落在 `attachmentUrl()` 上，由上面那个 describe 覆盖。这两条买到的是：
 *
 * ① `render()` 在**取数成功、取数为空、列表触顶**三种输入下都不抛 ——
 *    它顺带把 `tests/setup.ts` 新补的 `Button.setWarning()` 真实地跑了一遍
 *   （删除按钮就标在那儿）。实测删掉那个桩，这里会以
 *   `button.setButtonText(...).setWarning is not a function` 变红 —— 前提正是 `renderOf()`
 *    里那句 `await`，理由见它自己的说明。
 * ② 空态提示与截断提示各自**只在对应状态下**出现 —— 前者在有条目时不该出现，
 *    后者在触顶时不该缺席。
 *
 * **没被盖住的**：删除按钮有没有真的被标成危险操作（`setWarning` 有没有被调用）——
 * 桩只做到「不抛」，不记录调用。要钉住它得让共享桩记录调用，那是 `tests/setup.ts`
 * 的改动，本次刻意没做。
 */
describe("AttachmentManagerModal.render", () => {
  /** `contentEl.createEl` 建出来的元素。`Setting` 系列不经过它，故不在记录里 */
  interface CapturedEl {
    tag: string;
    text: string;
  }

  function attachmentOf(overrides: Partial<McpAttachmentItem> = {}): McpAttachmentItem {
    return {
      name: "2e475d53-43f6-489a-9958-f1b14610d655",
      displayName: "QQ20261004-204734.webp",
      mediaType: "image/webp",
      size: 43224,
      permalink: "/upload/QQ20261004-204734.webp",
      version: 1,
      ...overrides,
    };
  }

  function page(items: McpAttachmentItem[], hasNext = false): PagedResult<McpAttachmentItem> {
    return { items, page: 1, size: LIST_PAGE_SIZE, total: items.length, totalPages: 1, hasNext };
  }

  /**
   * 造一个插件 + 一个把 `contentEl` 换成记录版的弹窗。
   *
   * 换 `contentEl` 是因为桩里那个是 `createEl: () => undefined` 的哑对象 ——
   * 它不抛错，但也什么都不留，断言无从下手。它在桩里是**普通实例属性**（不是 getter），
   * 所以可以直接替换。
   */
  function makeModal(): { modal: AttachmentManagerModal; created: CapturedEl[] } {
    const { app } = createMockApp("", createFile("notes/a.md"), []);
    const plugin = new HaloPlugin(app, {} as PluginManifest);
    const modal = new AttachmentManagerModal(plugin, TEST_SITE);
    const created: CapturedEl[] = [];

    (modal as unknown as { contentEl: unknown }).contentEl = {
      createEl: (tag: string, options?: { text?: string }) => {
        created.push({ tag, text: options?.text ?? "" });
        return undefined;
      },
      // 生产代码每次渲染都先 `empty()` 再重建，所以这里也清一遍 ——
      // 否则「删掉一个之后重渲」那条路径会把上一次的残留混进来。
      empty: () => {
        created.length = 0;
      },
    };

    return { modal, created };
  }

  /**
   * 直接 `await` 那个私有的 `render()`，**不走 `onOpen()`**。
   *
   * ⚠️ 这一步是必需的、不是风格选择：`onOpen()` 里是 `void this.render()`，
   * 于是 `render()` 抛出的异常变成一条**未处理的 rejection** —— 实测把
   * `tests/setup.ts` 的 `setWarning` 桩删掉之后，rstest 往 stderr 刷
   * `button.setButtonText(...).setWarning is not a function`，而 `failedTests` 仍然是 **0**：
   * 没有哪条用例认领这个异常。`await` 之后异常才回到调用方，测试也才真的拦得住它。
   *
   * 用 cast 取私有方法与本仓既有约定一致（`tests/main.test.ts` 的 `Internals` 就是这么做的）。
   */
  async function renderOf(modal: AttachmentManagerModal): Promise<void> {
    await (modal as unknown as { render(): Promise<void> }).render();
  }

  function textsOf(created: CapturedEl[]): string[] {
    return created.map((element) => element.text);
  }

  test("渲染标题，且附件存在时不显示空态提示", async () => {
    const { modal, created } = makeModal();
    const call = rs.spyOn(McpClient.prototype, "callToolJson").mockResolvedValue(page([attachmentOf()]));

    try {
      await renderOf(modal);

      // 先证明文案键**真的解析出了文案**：没解析的话下面那条断言会与代码一起
      // 退化成键名比较，键写错了也照样绿。
      expect(i18next.t("attachment_modal.title")).not.toBe("attachment_modal.title");
      expect(created[0]).toEqual({ tag: "h2", text: i18next.t("attachment_modal.title") });

      // 空态提示是**一句结论**，只在真的没有附件时出现 —— 有附件时铺一句
      // 「还没有附件」会让用户以为列表是坏的。
      expect(textsOf(created)).not.toContain(i18next.t("attachment_modal.empty"));
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      call.mockRestore();
    }
  });

  test("没有附件时给出「还没有附件」这句结论，而不是一片空白", async () => {
    const { modal, created } = makeModal();
    const call = rs.spyOn(McpClient.prototype, "callToolJson").mockResolvedValue(page([]));

    try {
      await renderOf(modal);

      expect(textsOf(created)).toContain(i18next.t("attachment_modal.empty"));
    } finally {
      call.mockRestore();
    }
  });

  test("列表触顶时提示「不完整」", async () => {
    // `fetchAllPages()` 在**空页**上停下并把该页的 `hasNext` 报成 `truncated`
    //（终止保证 ②，见 `pagination.ts`）—— 所以第一页有内容 + 第二页空 + 两页都声明
    // 还有下一页，就是「触顶」在测试里最省的造法。静默截断正是本阶段反复处理的那类问题。
    const { modal, created } = makeModal();
    let calls = 0;
    const call = rs.spyOn(McpClient.prototype, "callToolJson").mockImplementation(async () => {
      calls++;
      return calls === 1 ? page([attachmentOf()], true) : page([], true);
    });

    try {
      await renderOf(modal);

      expect(calls).toBe(2);
      expect(textsOf(created)).toContain(i18next.t("attachment_modal.notice_truncated"));
    } finally {
      call.mockRestore();
    }
  });
});
