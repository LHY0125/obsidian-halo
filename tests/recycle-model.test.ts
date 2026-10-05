import { describe, expect, test } from "@rstest/core";
import { LIST_PAGE_SIZE } from "../src/pagination";
import {
  type McpRecycledPostItem,
  type RecycleKind,
  fetchActivePages,
  fetchRecycled,
  restoreRecycled,
  toRecycledItems,
} from "../src/recycle-model";
import { createFakeClient } from "./helpers/mcp-mock";

function recycledPost(overrides: Partial<McpRecycledPostItem> = {}): McpRecycledPostItem {
  return {
    name: "019f...",
    title: "AGENTS",
    slug: "agents",
    published: false,
    publishRequested: false,
    recycled: true,
    visible: "PUBLIC",
    categories: [],
    tags: [],
    ...overrides,
  };
}

describe("toRecycledItems", () => {
  test("剔除缺 name 的项（恢复时 name 是必填入参）", () => {
    expect(toRecycledItems([recycledPost({ name: undefined })], "post")).toHaveLength(0);
  });

  test("缺 title 时回落成 name，避免一行空白", () => {
    expect(toRecycledItems([recycledPost({ title: undefined })], "post")[0].title).toBe("019f...");
  });

  test("kind 决定 type 字段（⚠️ 该字段目前无生产消费者，只在这里被断言）", () => {
    // `RecycledItem.type` 是「这一行是什么」在数据里的唯一落点，但 `recycle-modal.ts` 的两个
    // 弹窗**都不读它**（各自只知道自己的 kind，行里只有标题与 permalink）—— 详 `recycle-model.ts`
    // 的字段注释。所以这条断言钉的是**映射本身**，不是任何一处 UI；用例名如实这么写，
    // 免得下一个读的人以为删掉 `type` 会改到弹窗。
    expect(toRecycledItems([recycledPost()], "post")[0].type).toBe("POST");
    expect(toRecycledItems([recycledPost()], "page")[0].type).toBe("SINGLE_PAGE");
  });

  test("permalink 缺省时回落空串", () => {
    expect(toRecycledItems([recycledPost({ permalink: undefined })], "post")[0].permalink).toBe("");
  });
});

/**
 * 按页切片的假站点。返回外壳逐字对齐 2026-10-05 实测：
 * `halo_list_posts` / `halo_list_single_pages` 回的是
 * `{ items, page, size, total, totalPages, hasNext }`。
 *
 * 未列出的工具一律抛错 —— 静默返回 `{}` 会把「调了不该调的工具」变成看不见的假绿。
 * 这个 responder 只认 `kind` 对应的那一个列表工具，所以「文章走了页面的工具」
 * （或反过来）会当场炸掉，而不是悄悄通过。
 */
function pagedResponder(kind: RecycleKind, all: McpRecycledPostItem[]) {
  const expectedTool = kind === "post" ? "halo_list_posts" : "halo_list_single_pages";

  return (name: string, args: Record<string, unknown>) => {
    if (name !== expectedTool) {
      throw new Error(`Unexpected tool: ${name}`);
    }

    const page = args.page as number;
    const size = args.size as number;
    const start = (page - 1) * size;
    const totalPages = Math.ceil(all.length / size);

    return {
      items: all.slice(start, start + size),
      page,
      size,
      total: all.length,
      totalPages,
      hasNext: page < totalPages,
    };
  };
}

describe("fetchRecycled", () => {
  test("显式传 recycled:true —— schema 的默认值是 false，漏传会返回全部内容", async () => {
    const { client, calls } = createFakeClient(pagedResponder("post", [recycledPost()]));

    await fetchRecycled(client, "post");

    // 逐字断言整个参数对象。`recycled` 的 default 是 `false`（2026-10-05 实测 schema），
    // 漏传的表现是这个函数返回**站点上全部文章**，而用户以为自己在看回收站 ——
    // 两个界面看起来都在「正常工作」。
    expect(calls[0].args).toEqual({ page: 1, size: LIST_PAGE_SIZE, recycled: true });
  });

  test("kind 决定列表工具 —— 文章与页面是两套工具", async () => {
    const post = createFakeClient(pagedResponder("post", [recycledPost()]));
    await fetchRecycled(post.client, "post");
    expect(post.calls.map((call) => call.name)).toEqual(["halo_list_posts"]);

    const page = createFakeClient(pagedResponder("page", [recycledPost()]));
    await fetchRecycled(page.client, "page");
    expect(page.calls.map((call) => call.name)).toEqual(["halo_list_single_pages"]);
  });

  test("翻页取全 —— 站点实测回收站有 4 篇文章 + 1 个页面，一页够用，但那是数据规模不是契约", async () => {
    const all = Array.from({ length: 250 }, (_, index) => recycledPost({ name: `post-${index}` }));
    const { client, calls } = createFakeClient(pagedResponder("post", all));

    const result = await fetchRecycled(client, "post");

    expect(result.items).toHaveLength(250);
    expect(result.truncated).toBe(false);
    // 250 条按 100 一页 → 3 页。只取一页的话这里会是 1，而结果会少 150 条。
    expect(calls.map((call) => call.args.page)).toEqual([1, 2, 3]);
    // 页大小必须是 schema 的 maximum（100），传大了会被服务端拒绝
    expect(calls.every((call) => call.args.size === LIST_PAGE_SIZE)).toBe(true);
    // 每一页都带 `recycled: true`，不只是第一页 —— 只给第一页加的话
    // 「第 2 页突然返回全部内容」会是一个极难反查的脏数据来源。
    expect(calls.every((call) => call.args.recycled === true)).toBe(true);
  });

  test("触顶时把 truncated 交给调用方 —— 本层既不吞掉也不自己弹提示", async () => {
    // 永远说 hasNext:true 的服务端。`fetchAllPages` 会在 maxPages（默认 20）处停下并标记触顶；
    // 没有这条上限的话这个循环会一直发请求直到 Obsidian 卡死。
    let calls = 0;
    const { client } = createFakeClient((name) => {
      if (name !== "halo_list_posts") {
        throw new Error(`Unexpected tool: ${name}`);
      }

      calls++;
      return {
        items: [recycledPost()],
        page: calls,
        size: LIST_PAGE_SIZE,
        total: 9999,
        totalPages: 9999,
        hasNext: true,
      };
    });

    const result = await fetchRecycled(client, "post");

    expect(result.truncated).toBe(true);
    expect(calls).toBe(20);
  });

  test("返回的是映射后的条目 —— 缺 name 的项在取数结果里已经没了", async () => {
    const { client } = createFakeClient(
      pagedResponder("post", [recycledPost({ name: undefined }), recycledPost({ name: "kept" })]),
    );

    const result = await fetchRecycled(client, "post");

    expect(result.items.map((item) => item.name)).toEqual(["kept"]);
  });
});

/**
 * `fetchActivePages` —— 管理页面弹窗那一档。
 *
 * 它与 `fetchRecycled` 共用同一个私有 `fetchByKind`，**只差 `recycled` 这一档**。
 * 这组用例钉的正是那一档：写错的表现是两个弹窗的内容**正好对调**
 *（「管理页面」列出回收站里的、「回收站」列出全部），而两个弹窗看起来都「正常工作」。
 */
describe("fetchActivePages", () => {
  test("显式传 recycled:false —— 与 fetchRecycled 正好相反的那一档", async () => {
    const { client, calls } = createFakeClient(pagedResponder("page", [recycledPost({ recycled: false })]));

    await fetchActivePages(client);

    // 逐字断言整个参数对象。管理页面弹窗要的是「站点上还活着的页面」，
    // 而 `recycled` 的 schema 默认值就是 `false` —— 所以这一档**传错反而不会报错**，
    // 只会让「管理页面」列出回收站里的东西。与 `fetchRecycled` 那条对称着看。
    expect(calls[0].args).toEqual({ page: 1, size: LIST_PAGE_SIZE, recycled: false });
  });

  test("走的是**页面**的列表工具 —— 管理页面弹窗不看文章", async () => {
    const { client, calls } = createFakeClient(pagedResponder("page", [recycledPost()]));

    await fetchActivePages(client);

    expect(calls.map((call) => call.name)).toEqual(["halo_list_single_pages"]);
  });

  test("翻页取全，且**每一页**都带 recycled:false", async () => {
    // 只给第一页加的话，「第 2 页突然返回回收站内容」会是一个极难反查的脏数据来源
    //（与 `fetchRecycled` 那条同源）—— 列表会变成一半活着一半已回收，而没有任何提示。
    const all = Array.from({ length: 250 }, (_, index) => recycledPost({ name: `page-${index}` }));
    const { client, calls } = createFakeClient(pagedResponder("page", all));

    const result = await fetchActivePages(client);

    expect(result.items).toHaveLength(250);
    expect(calls.map((call) => call.args.page)).toEqual([1, 2, 3]);
    expect(calls.every((call) => call.args.recycled === false)).toBe(true);
  });
});

describe("restoreRecycled", () => {
  test("文章走文章的恢复工具，并把 name 传下去", async () => {
    const [post] = toRecycledItems([recycledPost({ name: "post-1" })], "post");
    const { client, calls } = createFakeClient(() => undefined);

    await restoreRecycled(client, post);

    // 一次断言同时钉住三件事：调了哪个工具、name 有没有传下去、
    // 走的是不是写路径（`callToolVoid`）。走 `callToolJson` 的话会在**恢复成功之后**抛错 ——
    // 而恢复工具最可能回一句人读确认文案。
    expect(calls).toEqual([{ name: "halo_restore_post", args: { name: "post-1" }, method: "callToolVoid" }]);
  });

  test("页面走页面的恢复工具 —— 工具名由 item.kind 决定，写死一个会把页面当文章恢复", async () => {
    const [page] = toRecycledItems([recycledPost({ name: "page-1" })], "page");
    const { client, calls } = createFakeClient(() => undefined);

    await restoreRecycled(client, page);

    expect(calls).toEqual([{ name: "halo_restore_single_page", args: { name: "page-1" }, method: "callToolVoid" }]);
  });
});
