import { describe, expect, test } from "@rstest/core";
import { fetchSelectablePosts, toSelectablePosts } from "../src/post-selection-model";
import type { McpPostItem } from "../src/service/post-mapping";
import { McpError } from "../src/transport/errors";
import { createFakeClient } from "./helpers/mcp-mock";

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
    const { client, calls } = createFakeClient(() => ({ items: [] }));

    await fetchSelectablePosts(client);

    // 一次断言三件事：工具名、参数、走的哪个入口。
    // `toEqual` 是精确比较，所以「多传了 published」同样会红 —— 这是刻意的：
    // 迁移前的 REST 查询不过滤发布状态（草稿与已发布都要给用户选），多传会让草稿凭空消失。
    expect(calls).toEqual([{ name: "halo_list_posts", args: { page: 1, size: 100 }, method: "callToolJson" }]);
  });

  test("扁平项映射成 {name,title,slug}：字段不错位、也不把整项透传出去", async () => {
    const { client } = createFakeClient(() => ({
      items: [item(), item({ name: "post-2", title: "标题乙", slug: "biao-ti-yi" })],
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

  test("工具级失败向上抛 —— modal 的 .catch 正是靠它弹提示", async () => {
    const { client } = createFakeClient(() => {
      throw new McpError("forbidden", { status: 403 });
    });

    const thrown = await fetchSelectablePosts(client).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(McpError);
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
    // 与上一条不同的失败方式：`name: ""`。若实现写成 `item.name ?? ""` 再判断长度，
    // 这里就会漏出一项 `{ name: "" }`，按下去会去拉一篇名字为空的文章
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
