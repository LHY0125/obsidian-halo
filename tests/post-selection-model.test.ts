import { beforeAll, describe, expect, test } from "@rstest/core";
import i18next from "i18next";
import * as obsidianRuntime from "obsidian";
import { resources } from "../src/i18n";
import {
  LIST_PAGE_SIZE,
  describeListFailure,
  fetchSelectablePosts,
  toSelectablePosts,
} from "../src/post-selection-model";
import type { McpPostItem } from "../src/service/post-mapping";
import { McpError } from "../src/transport/errors";
import { createFakeClient } from "./helpers/mcp-mock";

/**
 * 按生产路径初始化 i18n（与 `tests/service/index.test.ts` 同一处置）。
 *
 * 不初始化的话 `i18next.t()` 返回 **undefined**，于是「弹的是具体原因还是泛化文案」这件事
 * 再也分不出来 —— 断言会退化成 `expect(undefined).toBe(undefined)` 这种零判别力的形式。
 */
beforeAll(async () => {
  await i18next.init({ lng: "en", fallbackLng: "en", resources, returnNull: false });
});

/** `tests/setup.ts` 里那个 Notice 构造器会把每条文案推进这个数组 */
function capturedNotices(): string[] {
  return (obsidianRuntime as unknown as { __notices: string[] }).__notices;
}

/**
 * fixture 只填 `toSelectablePosts` 与显示层真正会读的字段 —— `McpPostItem` 的字段全是可选的，
 * 这正是「schema 没把 `name` / `title` / `slug` 列为必需」这件事在类型上的体现。
 *
 * `name` / `title` / `slug` **两两不同**，这是本文件全部判别力的来源：三者中若有任何两个相同，
 * 「取对了字段」与「取错了字段」就会产生完全相同的观测，断言等于白写
 * （`tests/service/post-mapping.test.ts` 的 fixture 踩过同一个坑）。
 */
function item(overrides: Partial<McpPostItem> = {}): McpPostItem {
  return { name: "post-1", title: "标题甲", slug: "biao-ti-jia", ...overrides };
}

describe("fetchSelectablePosts", () => {
  test("走 halo_list_posts 的**读**入口，参数恰好是一页 100 条", async () => {
    const { client, calls } = createFakeClient(() => ({ items: [], hasNext: false }));

    await fetchSelectablePosts(client);

    // 一次断言三件事：工具名、参数、走的哪个入口。
    // `toEqual` 是精确比较，所以「多传了 published」同样会红 —— 这是刻意的：
    // 迁移前的 REST 查询不过滤发布状态（草稿与已发布都要给用户选），多传会让草稿凭空消失。
    expect(calls).toEqual([
      { name: "halo_list_posts", args: { page: 1, size: LIST_PAGE_SIZE }, method: "callToolJson" },
    ]);
  });

  test("扁平项映射成 {name,title,slug}：字段不错位、也不把整项透传出去", async () => {
    const { client } = createFakeClient(() => ({
      items: [item(), item({ name: "post-2", title: "标题乙", slug: "biao-ti-yi" })],
      hasNext: false,
    }));

    const posts = await fetchSelectablePosts(client);

    // 精确相等：多带一个字段（例如直接返回 item）会红，字段错位（title 取成 slug）也会红
    expect(posts).toEqual([
      { name: "post-1", title: "标题甲", slug: "biao-ti-jia" },
      { name: "post-2", title: "标题乙", slug: "biao-ti-yi" },
    ]);
  });

  test("items 缺席时给空数组，不抛", async () => {
    const { client } = createFakeClient(() => ({}));

    expect(await fetchSelectablePosts(client)).toEqual([]);
  });

  test("取数失败：弹的是**含具体原因**的那条，并给空列表（不再把异常放给命令入口）", async () => {
    const { client } = createFakeClient(() => {
      throw new McpError("unauthorized", { status: 401 });
    });
    const notices = capturedNotices();
    const seen = notices.length;

    // 命令入口不该让异常逃进 Obsidian（它只记进控制台，用户什么都看不到），故这里吞掉并返回空
    expect(await fetchSelectablePosts(client)).toEqual([]);

    expect(notices.slice(seen)).toEqual([i18next.t("transport.error.unauthorized", { status: 401 })]);
    // 泛化文案是**回落的兜底**，不该出现在这条路径上 —— 否则「核对密钥」这条线索就丢了
    expect(notices.slice(seen)).not.toContain(i18next.t("common.error_connection_failed"));
  });

  test("hasNext 为 true：弹提示说明列表不完整（否则用户会以为某篇文章不存在）", async () => {
    const { client } = createFakeClient(() => ({ items: [item()], hasNext: true }));
    const notices = capturedNotices();
    const seen = notices.length;

    await fetchSelectablePosts(client);

    expect(notices.slice(seen)).toEqual([i18next.t("post_selection_modal.notice_truncated", { size: LIST_PAGE_SIZE })]);
  });

  test("hasNext 为 false：**不弹** —— 提示必须是判据的函数，不能恒定弹", async () => {
    const { client } = createFakeClient(() => ({ items: [item()], hasNext: false }));
    const notices = capturedNotices();
    const seen = notices.length;

    await fetchSelectablePosts(client);

    expect(notices.slice(seen)).toEqual([]);
  });
});

describe("describeListFailure", () => {
  test("McpError 给的是具体处置指引，而不是那句泛化的连接失败", () => {
    const message = describeListFailure(new McpError("forbidden", { status: 403 }));

    expect(message).toBe(i18next.t("transport.error.forbidden", { status: 403 }));
    expect(message).not.toBe(i18next.t("common.error_connection_failed"));
  });

  test("非 McpError 才回落到泛化文案（这把兜底不能丢）", () => {
    expect(describeListFailure(new Error("boom"))).toBe(i18next.t("common.error_connection_failed"));
    // 连抛出来的东西都不是对象时也不能炸 —— 这条路径的首要职责是「说出点什么」
    expect(() => describeListFailure(undefined)).not.toThrow();
    expect(describeListFailure(undefined)).toBe(i18next.t("common.error_connection_failed"));
  });

  test("工具级失败（kind 为 unknown）必须拼上服务端原文 —— 那类失败的全部线索只在 detail 里", () => {
    // 见 `transport/errors.ts` 的 toolFailureError：它以 HTTP 200 + isError 送达，
    // 归类只能是泛化的 `unknown`，去掉 detail 就只剩一句「MCP 请求失败」
    const message = describeListFailure(new McpError("unknown", { tool: "halo_list_posts" }, "size must be <= 100"));

    expect(message).toContain(i18next.t("transport.error.unknown", { tool: "halo_list_posts" }));
    expect(message).toContain("size must be <= 100");
  });
});

describe("toSelectablePosts", () => {
  test("保持入参顺序，逐项一一对应", () => {
    const posts = toSelectablePosts([
      item({ name: "post-1", title: "甲", slug: "jia" }),
      item({ name: "post-2", title: "乙", slug: "yi" }),
      item({ name: "post-3", title: "丙", slug: "bing" }),
    ]);

    expect(posts.map((post) => post.name)).toEqual(["post-1", "post-2", "post-3"]);
  });

  test("缺 name 的项被剔除 —— 它的按钮按下去必然失败，列出来比不列更糟", () => {
    const posts = toSelectablePosts([item(), item({ name: undefined, title: "没有 name" })]);

    expect(posts).toEqual([{ name: "post-1", title: "标题甲", slug: "biao-ti-jia" }]);
  });

  test("缺 name 时不编造空串 —— 空串同样是无效标识，必须整项丢掉", () => {
    // 与上一条不同的失败方式：`name: ""`。若实现写成先回落空串再判断，这里就会漏出一项
    // `{ name: "" }`，按下去会去拉一篇名字为空的文章
    expect(toSelectablePosts([item({ name: "" })])).toEqual([]);
  });

  test("缺 title（或为空串）时回落成 name，不然列表会出现一行空白", () => {
    expect(toSelectablePosts([item({ title: undefined })])[0].title).toBe("post-1");
    expect(toSelectablePosts([item({ title: "" })])[0].title).toBe("post-1");
  });

  test("缺 slug 时给空串，不把 undefined 漏给 Setting.setDesc", () => {
    expect(toSelectablePosts([item({ slug: undefined })])[0].slug).toBe("");
  });

  test("空列表给空数组", () => {
    expect(toSelectablePosts([])).toEqual([]);
  });
});
