import { beforeAll, describe, expect, rs, test } from "@rstest/core";
import i18next from "i18next";
import * as obsidianRuntime from "obsidian";
import { initializeI18n } from "../../src/i18n";
import { LIST_PAGE_SIZE } from "../../src/pagination";
import type { McpGetSinglePageResult, McpSinglePageItem } from "../../src/service/page-mapping";
import PageService from "../../src/service/page-service";
import { McpError } from "../../src/transport/errors";
import { createFakeClient } from "../helpers/mcp-mock";
import { createFile, createMockApp, createSettings, TEST_SITE as site } from "../helpers/obsidian-mocks";

/**
 * 走**生产同一条入口**初始化 i18n（`main.ts` 的 `onload` 调的就是它）。
 * 不初始化的话 `i18next.t()` 返回 undefined，notice 断言会退化成零判别力的形式。
 */
beforeAll(async () => {
  await initializeI18n("en");
});

/**
 * 页面的扁平骨架。`name` 用真实站点上那种 UUID 形态 —— 形如 `page-1` 的假名会让
 * 「本地生成的 name 有没有被服务端回声盖掉」这类断言失去意义。
 */
function pageItem(overrides: Partial<McpSinglePageItem> = {}): McpSinglePageItem {
  return {
    name: "019fcb32-f421-7342-b900-35d1335192f5",
    title: "关于",
    slug: "about",
    excerpt: "",
    published: false,
    publishRequested: false,
    recycled: false,
    visible: "PUBLIC",
    ...overrides,
  };
}

function getPageResult(item: McpSinglePageItem = pageItem(), raw = "正文"): McpGetSinglePageResult {
  return { item, content: { snapshotName: "snapshot-1", rawType: "markdown", raw }, truncated: false };
}

/**
 * 注入 frontmatter。
 *
 * ⚠️ **不能把 frontmatter 写进 `createMockApp()` 的 markdown 字符串**：那个假 app 的
 * `getFileCache` 恒返回 `{ frontmatter: {} }`，不解析正文。写在那里的话「更新分支」的用例
 * 会静默跑成「新建分支」—— 断言 `halo_create_single_page` 被调过时照样绿。
 */
function frontmatter(fields: Record<string, unknown>): () => { frontmatter: Record<string, unknown> } {
  return () => ({ frontmatter: fields });
}

/** 带 `halo.name` 的 frontmatter —— 走更新分支的前提 */
function remoteFrontmatter(halo: Record<string, unknown> = {}): () => { frontmatter: Record<string, unknown> } {
  return frontmatter({ title: "关于", slug: "about", halo: { name: "page-1", site: site.url, ...halo } });
}

/** `tests/setup.ts` 把每条 `Notice` 文本推进 `__notices`；该数组**文件级共享**，故只能取增量 */
function capturedNotices(): string[] {
  return (obsidianRuntime as unknown as { __notices: string[] }).__notices;
}

/**
 * 按工具名分派的假客户端，未列出的工具一律抛错 ——
 * 静默返回 `{}` 会把「调了不该调的工具」变成一条看不见的假绿。
 */
function fakePageService(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  return createFakeClient((name, args) => {
    const handler = handlers[name];

    if (!handler) {
      throw new Error(`Unexpected tool: ${name}`);
    }

    return handler(args);
  });
}

/**
 * 捕获回写进笔记的那份 frontmatter（假 app 的 `processFrontMatter` 默认丢掉了回调产物）。
 *
 * `seed` 模拟**笔记里原本就有的**前言：真实的 `processFrontMatter` 是把现有前言交给回调去改的，
 * 所以「实现有没有动某个键」只有在**先把它放进去**时才测得出来 —— 空对象起步的话，
 * 「没写」与「赋成 `undefined`」看起来一模一样，而那正是 F1 要钉住的那条区别。
 */
function captureFrontmatter(
  fileManager: ReturnType<typeof createMockApp>["fileManager"],
  seed: Record<string, unknown> = {},
): () => Record<string, unknown> {
  let written: Record<string, unknown> = {};

  fileManager.processFrontMatter.mockImplementation(
    (_file: unknown, callback: (frontmatter: Record<string, unknown>) => void) => {
      written = { ...seed };
      callback(written);
    },
  );

  return () => written;
}

describe("PageService.pushPage", () => {
  test("新建走 halo_create_single_page，且**不**传文章独有的字段", async () => {
    const file = createFile("pages/about.md");
    const { app, metadataCache } = createMockApp("正文", file, []);
    metadataCache.getFileCache.mockImplementation(frontmatter({ title: "关于" }));
    const { client, calls } = fakePageService({
      halo_get_single_page: () => getPageResult(),
      halo_create_single_page: () => ({}),
    });

    const result = await new PageService(app, createSettings(), site, client).pushPage(file);

    expect(result.ok).toBe(true);

    const created = calls.find((call) => call.name === "halo_create_single_page");
    expect(created).toBeDefined();
    expect(created?.method).toBe("callToolVoid");
    expect(created?.args.rawType).toBe("markdown");
    expect(created?.args).not.toHaveProperty("categories");
    expect(created?.args).not.toHaveProperty("tags");
    expect(created?.args).not.toHaveProperty("pinned");
    expect(created?.args).not.toHaveProperty("priority");
    expect(created?.args).not.toHaveProperty("publishTime");
    expect(created?.args).not.toHaveProperty("template");
    // MCP 没有 `metadata.generateName` 的等价物，而 `halo_create_single_page` 的 required 含 name
    // —— 所以 name 必须由本地生成，空串会被服务端直接拒绝。
    expect(created?.args.name).toEqual(expect.any(String));
    expect(created?.args.name).not.toEqual("");
  });

  test("已存在 halo.name 时走 halo_update_single_page，且一次 create 都不发", async () => {
    const file = createFile("pages/about.md");
    const { app, metadataCache } = createMockApp("正文", file, []);
    metadataCache.getFileCache.mockImplementation(remoteFrontmatter());
    const { client, calls } = fakePageService({
      halo_get_single_page: () => getPageResult(),
      halo_update_single_page: () => ({}),
    });

    await new PageService(app, createSettings(), site, client).pushPage(file);

    expect(calls.some((call) => call.name === "halo_update_single_page")).toBe(true);
    expect(calls.some((call) => call.name === "halo_create_single_page")).toBe(false);
    expect(calls.find((call) => call.name === "halo_update_single_page")?.method).toBe("callToolVoid");
  });

  test("更新分支里两个必需 name 的调用用**同一个**来源（服务端不回 name 时也不会送空串）", async () => {
    // `toSinglePage()` 在服务端不回 `name` 时把 `metadata.name` 填成**空串**，而
    // `halo_update_single_page` 与 `halo_set_single_page_publish_state` 的 `required`
    // **都含 `name`** —— 空串会被服务端直接拒绝，用户只看到一句「推送失败」而无从自查。
    // 这条用例让服务端**全程不回 name**，两处调用就必须都锚回前言里那个。
    const file = createFile("pages/about.md");
    const { app, metadataCache } = createMockApp("正文", file, []);
    metadataCache.getFileCache.mockImplementation(remoteFrontmatter({ publish: true }));
    const { client, calls } = fakePageService({
      halo_get_single_page: () => getPageResult(pageItem({ name: undefined })),
      halo_update_single_page: () => ({}),
      halo_set_single_page_publish_state: () => ({}),
    });

    await new PageService(app, createSettings(), site, client).pushPage(file);

    expect(calls.find((call) => call.name === "halo_update_single_page")?.args.name).toBe("page-1");
    expect(calls.find((call) => call.name === "halo_set_single_page_publish_state")?.args).toEqual({
      name: "page-1",
      publish: true,
    });
  });

  test("truncated 为真时中止并如实告知，绝不把截断正文当完整页面", async () => {
    const file = createFile("pages/about.md");
    const { app, metadataCache } = createMockApp("正文", file, []);
    metadataCache.getFileCache.mockImplementation(remoteFrontmatter());
    let reads = 0;
    const { client, calls } = fakePageService({
      halo_get_single_page: () => {
        reads += 1;
        return { ...getPageResult(pageItem(), "截断的"), truncated: true };
      },
    });

    const notices = capturedNotices();
    const seen = notices.length;

    // 基准读现在带发布级重试（`readRemotePage`），所以这条会跑满三次退避 500+1000+1500ms。
    // 快进掉 —— 与本仓 `tests/service/index.test.ts` 里那几条重试用例同一处置。
    rs.useFakeTimers();

    let result: Awaited<ReturnType<PageService["pushPage"]>>;

    try {
      const pending = new PageService(app, createSettings(), site, client).pushPage(file);
      await rs.advanceTimersByTimeAsync(5_000);
      result = await pending;
    } finally {
      rs.useRealTimers();
    }

    expect(result.ok).toBe(false);
    // 首次 + 3 次重试 = 4 次读 —— 这就是 PUBLISH_RETRY_COUNT = 3 的确切含义
    expect(reads).toBe(4);
    // 但一个写工具都不能调：截断的正文一旦写出去，用户的服务端内容就被静默覆盖了
    expect(calls.filter((call) => call.method === "callToolVoid")).toHaveLength(0);
    expect(notices.slice(seen).some((text) => text.startsWith(i18next.t("service.error_publish_failed")))).toBe(true);
  });

  test("更新分支的基准读带发布级重试：一次瞬时抖动不该毁掉整次推送", async () => {
    // 与文章路径（`HaloService.readRemotePost`）对齐的那条性质。没有它的话，一次网络抖动会从
    // 「重试后成功」变成「直接报推送失败」—— 正是 Global Constraint 1 说的那类分叉：
    // 「文章会重试、页面不会」，而本地完全看不出来。
    const file = createFile("pages/about.md");
    const { app, metadataCache } = createMockApp("正文", file, []);
    metadataCache.getFileCache.mockImplementation(remoteFrontmatter());
    let reads = 0;
    const { client, calls } = fakePageService({
      halo_get_single_page: () => {
        reads += 1;

        // 只有第一次读抖动，之后全程成功
        if (reads === 1) {
          throw new McpError("unknown", { tool: "halo_get_single_page" }, "The page is locked");
        }

        return getPageResult();
      },
      halo_update_single_page: () => ({}),
    });

    // 一次退避 500ms
    rs.useFakeTimers();

    let result: Awaited<ReturnType<PageService["pushPage"]>>;

    try {
      const pending = new PageService(app, createSettings(), site, client).pushPage(file);
      await rs.advanceTimersByTimeAsync(5_000);
      result = await pending;
    } finally {
      rs.useRealTimers();
    }

    expect(result.ok).toBe(true);
    // 基准读 2 次（首次抖动 + 退避后重试成功），加上写成功之后那次回读 = 3 次。
    // 没有重试覆盖时首次抖动就直接报「推送失败」了，所以 `ok` 与这个次数一起构成判别器。
    expect(reads).toBe(3);
    expect(calls.filter((call) => call.name === "halo_get_single_page")).toHaveLength(3);
    expect(calls.some((call) => call.name === "halo_update_single_page")).toBe(true);
  });

  test("frontmatter 的 halo.site 与目标站点不一致时中止，且**一个工具都不调**", async () => {
    const file = createFile("pages/about.md");
    const { app, metadataCache } = createMockApp("正文", file, []);
    metadataCache.getFileCache.mockImplementation(frontmatter({ halo: { site: "https://other.example.com" } }));
    const { client, calls } = fakePageService({});

    const result = await new PageService(app, createSettings(), site, client).pushPage(file);

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

/**
 * 发布状态的三档，**与文章路径（`HaloService.executePublish`）逐档对齐**：
 * ① 调用方的显式覆盖；② frontmatter 的 `halo.publish`；③ 设置里的 `publishByDefault`。
 *
 * ⚠️ 第三档在开关为**假**时**不发这次调用**，而不是发一次 `publish: false`。后者会把一篇
 * 已发布页面悄悄退回草稿（笔记里恰好没写 `halo.publish` 时），而本地看不出任何异常 ——
 * 用户看到的是「推送成功」。
 */
describe("PageService 的发布状态三档", () => {
  test("笔记里没有 halo.publish 且 publishByDefault 为假时，一次 set_publish_state 都不发", async () => {
    const file = createFile("pages/about.md");
    const { app, metadataCache } = createMockApp("正文", file, []);
    metadataCache.getFileCache.mockImplementation(remoteFrontmatter());
    const { client, calls } = fakePageService({
      halo_get_single_page: () => getPageResult(),
      halo_update_single_page: () => ({}),
    });

    await new PageService(app, createSettings(), site, client).pushPage(file);

    expect(calls.some((call) => call.name === "halo_set_single_page_publish_state")).toBe(false);
  });

  test("笔记里显式写 halo.publish: false 时主动退回草稿（显式假值不被吃掉）", async () => {
    const file = createFile("pages/about.md");
    const { app, metadataCache } = createMockApp("正文", file, []);
    metadataCache.getFileCache.mockImplementation(remoteFrontmatter({ publish: false }));
    const { client, calls } = fakePageService({
      halo_get_single_page: () => getPageResult(),
      halo_update_single_page: () => ({}),
      halo_set_single_page_publish_state: () => ({}),
    });

    await new PageService(app, createSettings(), site, client).pushPage(file);

    const publishCall = calls.find((call) => call.name === "halo_set_single_page_publish_state");
    expect(publishCall?.method).toBe("callToolVoid");
    expect(publishCall?.args).toEqual({ name: "page-1", publish: false });
  });

  test("笔记没写 halo.publish 时第三档生效：publishByDefault 为真即发布", async () => {
    const file = createFile("pages/about.md");
    const { app, metadataCache } = createMockApp("正文", file, []);
    metadataCache.getFileCache.mockImplementation(remoteFrontmatter());
    const { client, calls } = fakePageService({
      halo_get_single_page: () => getPageResult(),
      halo_update_single_page: () => ({}),
      halo_set_single_page_publish_state: () => ({}),
    });

    await new PageService(app, createSettings({ publishByDefault: true }), site, client).pushPage(file);

    expect(calls.find((call) => call.name === "halo_set_single_page_publish_state")?.args).toEqual({
      name: "page-1",
      publish: true,
    });
  });

  test("options.publish 覆盖 frontmatter 的 halo.publish", async () => {
    const file = createFile("pages/about.md");
    const { app, metadataCache } = createMockApp("正文", file, []);
    metadataCache.getFileCache.mockImplementation(remoteFrontmatter({ publish: false }));
    const { client, calls } = fakePageService({
      halo_get_single_page: () => getPageResult(),
      halo_update_single_page: () => ({}),
      halo_set_single_page_publish_state: () => ({}),
    });

    await new PageService(app, createSettings(), site, client).pushPage(file, { publish: true });

    expect(calls.find((call) => call.name === "halo_set_single_page_publish_state")?.args).toEqual({
      name: "page-1",
      publish: true,
    });
  });
});

describe("PageService 的回写", () => {
  test("写出去的键集恰好是 title / slug / halo 三个 —— cover / categories / tags / excerpt 一个都不新增", async () => {
    // 这条用例是「页面用自己的回写实现」这一裁定的**判别器**：改成复用
    // `applyPostToFrontmatter()` 会立刻红 —— 它会无条件写 `cover` 与一个 9 键的 halo 块，
    // 而 `SinglePage.spec` 上没有 `cover` / `pinned` / `priority` / `publishTime` / `template`，
    // 于是每推一次页面就往笔记里写进 5 个 `undefined`。
    //
    // ⚠️ 断言的是**键集**而不是 `not.toHaveProperty(...)`：赋成 `undefined` 会让键**存在**
    // （值为 undefined），`not.toHaveProperty` 恰好会红，但读起来不如键集直白。
    const file = createFile("pages/about.md");
    const { app, fileManager, metadataCache } = createMockApp("正文", file, []);
    metadataCache.getFileCache.mockImplementation(remoteFrontmatter());
    const { client } = fakePageService({
      halo_get_single_page: () => getPageResult(pageItem({ publishRequested: true })),
      halo_update_single_page: () => ({}),
    });
    const written = captureFrontmatter(fileManager);

    await new PageService(app, createSettings(), site, client).pushPage(file);

    const result = written();
    expect(Object.keys(result).sort()).toEqual(["halo", "slug", "title"]);
    expect(result.title).toBe("关于");
    expect(result.slug).toBe("about");
    expect(result).not.toHaveProperty("cover");
    expect(result).not.toHaveProperty("categories");
    expect(result).not.toHaveProperty("tags");
    expect(result).not.toHaveProperty("excerpt");

    const halo = result.halo as Record<string, unknown>;
    expect(Object.keys(halo).sort()).toEqual(["name", "publish", "site"]);
    expect(halo.site).toBe(site.url);
    // `publish` 取的是**服务端归一化之后的** `spec.publish`（映射自 publishRequested），
    // 而不是本地构造时那个陈旧的 false。
    expect(halo.publish).toBe(true);
  });

  test("笔记里原本写着的 excerpt / cover / categories / tags **一个都不动**", async () => {
    // 「不碰」这个契约只有在**先把它放进去**时才测得出来（空对象起步的话，「没写」与
    // 「赋成 `undefined`」看起来一模一样）。页面**根本不发** `excerpt`
    //（`halo_create_single_page` / `halo_update_single_page` 都没有这个入参），
    // 而 `toSinglePage()` 给页面的 `autoGenerate` 恒为 `true` —— 照文章那条判据回写，
    // 就是每次推送都把 `frontmatter.excerpt` 赋成 `undefined`，用户本地写的摘要被静默丢掉
    //（序列化时被丢弃或变成 `null`，两个方向都是丢），而收益是零。
    const file = createFile("pages/about.md");
    const { app, fileManager, metadataCache } = createMockApp("正文", file, []);
    metadataCache.getFileCache.mockImplementation(remoteFrontmatter());
    const { client } = fakePageService({
      halo_get_single_page: () => getPageResult(),
      halo_update_single_page: () => ({}),
    });
    const existing = {
      excerpt: "用户写的摘要",
      cover: "旧封面.png",
      categories: ["旧分类"],
      tags: ["旧标签"],
    };
    const written = captureFrontmatter(fileManager, existing);

    await new PageService(app, createSettings(), site, client).pushPage(file);

    const result = written();
    expect(result.excerpt).toBe("用户写的摘要");
    expect(result.cover).toBe("旧封面.png");
    expect(result.categories).toEqual(["旧分类"]);
    expect(result.tags).toEqual(["旧标签"]);
    // 键集 = 原本那 4 个 + 本次写的 3 个，一个不多一个不少
    expect(Object.keys(result).sort()).toEqual(["categories", "cover", "excerpt", "halo", "slug", "tags", "title"]);
  });

  test("halo.name 用本地那个，不回读到的 —— 服务端不回 name 时不至于把笔记写成空", async () => {
    const file = createFile("pages/about.md");
    const { app, fileManager, metadataCache } = createMockApp("正文", file, []);
    metadataCache.getFileCache.mockImplementation(frontmatter({ title: "关于" }));
    // 回读故意回一个缺 name 的 item：`toSinglePage()` 会把它填成空串
    const { client, calls } = fakePageService({
      halo_get_single_page: () => getPageResult(pageItem({ name: undefined })),
      halo_create_single_page: () => ({}),
    });
    const written = captureFrontmatter(fileManager);

    await new PageService(app, createSettings(), site, client).pushPage(file);

    const createdName = calls.find((call) => call.name === "halo_create_single_page")?.args.name;
    expect(createdName).toEqual(expect.any(String));
    // 写成空串的话下次发布读不到 halo.name，就当新建 —— **再建一个重复页面**，而用户看到「成功」
    expect((written().halo as Record<string, unknown>).name).toBe(createdName);
  });

  test("回读失败时 halo.publish 仍是本次的意图，不是陈旧的 spec 值", async () => {
    // 回读失败时 `refreshPageAfterWrite()` 返回的是本地构造的 page，其 `spec.publish` 是
    // **改发布状态之前**的值（`toSinglePage()` 映射自 publishRequested: false）。
    // 直接沿用会把这个陈旧值写进 frontmatter，**下一次**推送据此把已发布的页面静默退回草稿
    // —— 而用户两次都看到「推送成功」。与文章路径的 `intendedPublish` 同一条理由。
    const file = createFile("pages/about.md");
    const { app, fileManager, metadataCache } = createMockApp("正文", file, []);
    metadataCache.getFileCache.mockImplementation(remoteFrontmatter({ publish: true }));
    let reads = 0;
    const { client, calls } = fakePageService({
      halo_get_single_page: () => {
        reads += 1;

        if (reads > 1) {
          throw new Error("network down");
        }

        return getPageResult();
      },
      halo_update_single_page: () => ({}),
      halo_set_single_page_publish_state: () => ({}),
    });
    const written = captureFrontmatter(fileManager);

    const result = await new PageService(app, createSettings(), site, client).pushPage(file);

    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.name === "halo_set_single_page_publish_state")?.args).toEqual({
      name: "page-1",
      publish: true,
    });
    expect((written().halo as Record<string, unknown>).publish).toBe(true);
  });
});

describe("PageService 的回收与恢复", () => {
  test("recyclePage / restorePage 走页面专属工具（不是文章的），且都是写路径", async () => {
    const { app } = createMockApp("", createFile("a.md"), []);
    const { client, calls } = fakePageService({
      halo_recycle_single_page: () => ({}),
      halo_restore_single_page: () => ({}),
    });
    const service = new PageService(app, createSettings(), site, client);

    await service.recyclePage("page-1");
    await service.restorePage("page-1");

    expect(calls.map((call) => call.name)).toEqual(["halo_recycle_single_page", "halo_restore_single_page"]);
    expect(calls.every((call) => call.method === "callToolVoid")).toBe(true);
    expect(calls[0].args).toEqual({ name: "page-1" });
  });

  test("setPagePublish 走 halo_set_single_page_publish_state，两个入参都必填", async () => {
    const { app } = createMockApp("", createFile("a.md"), []);
    const { client, calls } = fakePageService({ halo_set_single_page_publish_state: () => ({}) });
    const service = new PageService(app, createSettings(), site, client);

    await service.setPagePublish("page-1", true);

    expect(calls[0].name).toBe("halo_set_single_page_publish_state");
    expect(calls[0].method).toBe("callToolVoid");
    expect(calls[0].args).toEqual({ name: "page-1", publish: true });
  });
});

describe("PageService.getPages", () => {
  test("按 hasNext 翻页取全，每页 size 用共享的 LIST_PAGE_SIZE", async () => {
    const { app } = createMockApp("", createFile("a.md"), []);
    const { client, calls } = fakePageService({
      halo_list_single_pages: (args) => ({
        items: [pageItem({ name: `page-${String(args.page)}` })],
        page: Number(args.page),
        size: LIST_PAGE_SIZE,
        total: 2,
        totalPages: 2,
        hasNext: args.page === 1,
      }),
    });

    const pages = await new PageService(app, createSettings(), site, client).getPages();

    expect(pages.map((page) => page.name)).toEqual(["page-1", "page-2"]);
    expect(calls.map((call) => call.args)).toEqual([
      { page: 1, size: LIST_PAGE_SIZE },
      { page: 2, size: LIST_PAGE_SIZE },
    ]);
  });

  test("翻到上限时明确提示列表不完整，不静默截断", async () => {
    const { app } = createMockApp("", createFile("a.md"), []);
    const { client, calls } = fakePageService({
      halo_list_single_pages: (args) => ({
        items: [pageItem({ name: `page-${String(args.page)}` })],
        page: Number(args.page),
        size: LIST_PAGE_SIZE,
        total: 9999,
        totalPages: 9999,
        hasNext: true,
      }),
    });
    const notices = capturedNotices();
    const seen = notices.length;

    await new PageService(app, createSettings(), site, client).getPages();

    // `fetchAllPages` 的 maxPages 默认 20 —— 服务端永远说 hasNext 时必须能停下来
    expect(calls).toHaveLength(20);
    expect(notices.length).toBeGreaterThan(seen);
  });
});

describe("PageService.pullPage", () => {
  test("建一篇新笔记，写三键 halo 且 name 用入参（不是服务端回声）", async () => {
    const { app, contents, fileManager } = createMockApp("", createFile("a.md"), []);
    const { client } = fakePageService({
      halo_get_single_page: () => getPageResult(pageItem({ publishRequested: true }), "# 正文"),
    });
    const written = captureFrontmatter(fileManager);

    await new PageService(app, createSettings(), site, client).pullPage("page-1");

    expect(contents.get("关于.md")).toBe("# 正文");
    const result = written();
    expect(result.title).toBe("关于");
    expect(result.slug).toBe("about");
    expect(Object.keys(result.halo as Record<string, unknown>).sort()).toEqual(["name", "publish", "site"]);
    expect((result.halo as Record<string, unknown>).name).toBe("page-1");
    expect((result.halo as Record<string, unknown>).publish).toBe(true);
  });

  test("读失败时弹提示且**一篇笔记都不建**", async () => {
    const { app, vault } = createMockApp("", createFile("a.md"), []);
    const { client } = fakePageService({
      halo_get_single_page: () => {
        throw new Error("network down");
      },
    });

    await new PageService(app, createSettings(), site, client).pullPage("page-1");

    expect(vault.create).not.toHaveBeenCalled();
  });
});
