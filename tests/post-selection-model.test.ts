import { beforeAll, describe, expect, test } from "@rstest/core";
import i18next from "i18next";
import * as obsidianRuntime from "obsidian";
import { initializeI18n } from "../src/i18n";
// `MAX_PAGES_DEFAULT` 从**定义处**取（`pagination.ts`），不从 `post-selection-model.ts` 转一道 ——
// 后者只重导出了 `LIST_PAGE_SIZE`（那是为了不断既有 import），并没有这一个。
import { MAX_PAGES_DEFAULT } from "../src/pagination";
import { LIST_PAGE_SIZE, fetchSelectablePosts, toSelectablePosts } from "../src/post-selection-model";
import type { McpPostItem } from "../src/service/post-mapping";
import { McpError } from "../src/transport/errors";
import { createFakeClient } from "./helpers/mcp-mock";

/**
 * 初始化 i18n —— 走**生产同一条入口** `initializeI18n()`（`main.ts` 的 `onload` 调的就是它）。
 *
 * 不初始化的话 `i18next.t()` 返回 **undefined**，于是「弹的是具体原因还是泛化文案」这件事
 * 再也分不出来 —— 断言会退化成 `expect(undefined).toBe(undefined)` 这种零判别力的形式。
 *
 * 刻意**不再自己拼 options**：那样测试与生产跑在**两套配置**下，而其中一处差异（全局
 * `interpolation.escapeValue`）恰好决定插值出来的字符串长什么样 —— 断言插值文案的用例会看到
 * 与用户所见不同的输出。收敛到生产入口之后，两边只有一份配置。
 */
beforeAll(async () => {
  await initializeI18n("en");
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

  test("列表超过一页时翻页取全，**不再**提示列表不完整", async () => {
    // 改动前：只取第一页 + 弹 `post_selection_modal.notice_truncated`。
    // 现在：翻完所有页。那句提示随之删除 —— 留着它会在**列表已经完整**时谎报不完整。
    const all = Array.from({ length: 150 }, (_, i) => ({ name: `post-${i}`, title: `文章 ${i}` }));
    const { client, calls } = createFakeClient((name, args) => {
      const page = Number(args.page ?? 1);
      const size = Number(args.size ?? 20);
      const start = (page - 1) * size;
      return {
        items: all.slice(start, start + size),
        page,
        size,
        total: all.length,
        totalPages: Math.ceil(all.length / size),
        hasNext: page < Math.ceil(all.length / size),
      };
    });
    const notices = capturedNotices();
    const seen = notices.length;

    const posts = await fetchSelectablePosts(client);

    expect(posts).toHaveLength(150);
    expect(calls).toHaveLength(2);
    // 断言「这一次一条都没弹」，而不是「没弹某句特定文案」——
    // 后者在文案或插值参数变化之后会静默退化成永真的假绿（`not.toContain` 尤其容易踩）。
    expect(notices.slice(seen)).toEqual([]);
  });

  test("翻页触顶（maxPages）时才弹截断提示 —— 那是列表**真的**不完整的唯一情形", async () => {
    // 服务端永远说 hasNext：`fetchAllPages` 靠自己的 maxPages 兜底停下并置 `truncated`。
    // 判据由此从「hasNext 为真」改成「触顶」—— 翻页之后 `hasNext` 为真只是「还有下一页」，
    // 那是翻页过程里正常的中间状态，不是给用户看的异常。
    const { client, calls } = createFakeClient(() => ({ items: [item()], hasNext: true }));
    const notices = capturedNotices();
    const seen = notices.length;

    const posts = await fetchSelectablePosts(client);

    // 默认上限是 `MAX_PAGES_DEFAULT`。这里**刻意写字面量 20** 当独立的绊线：若改用常量，
    // 有人把默认值改掉时这条断言会跟着一起变，就再也拦不住「上限被悄悄改掉」——
    // 而下面那条 `{{size}}` 断言必须用常量，因为它复现的是**生产里同一个表达式**
    //（那里也是 `LIST_PAGE_SIZE × MAX_PAGES_DEFAULT`），写成字面量才是抄了一份会分叉的副本。
    expect(calls).toHaveLength(20);
    expect(posts).toHaveLength(20);
    expect(notices.slice(seen)).toEqual([
      i18next.t("post_selection_modal.notice_truncated", { size: LIST_PAGE_SIZE * MAX_PAGES_DEFAULT }),
    ]);
  });

  test("hasNext 为 false：**不弹** —— 提示必须是判据的函数，不能恒定弹", async () => {
    const { client } = createFakeClient(() => ({ items: [item()], hasNext: false }));
    const notices = capturedNotices();
    const seen = notices.length;

    await fetchSelectablePosts(client);

    expect(notices.slice(seen)).toEqual([]);
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
