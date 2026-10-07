import { describe, expect, test } from "@rstest/core";
import { buildSearchRows, normalizeQuery } from "../../../src/ui/modals/search-modal";
// 类型从它**定义**的地方取（`search-preview.ts`），不从 `search-modal.ts` 转一道 ——
// 后者只是 `import type`，并没有 re-export，而 rstest 会剥掉类型所以测试照样绿，
// 只有 `tsc --noEmit` 会报 TS2459。
import type { SearchResult } from "../../../src/ui/models/search-preview";

/**
 * `search-modal.ts` 里两个纯函数的测试。
 *
 * 为什么值当为它们单开一个文件：弹窗本身**没有测试脚手架** —— `tests/setup.ts` 把
 * `obsidian` 整体 mock 了，`Modal.open()` 不调 `onOpen()`，`Setting.addButton` 也不记录回调，
 * 所以弹窗里那个 `for` 加两个 `if` 一行都跑不到。本任务因此把「该渲染成什么样」全算在了
 * `buildSearchRows()` 里（与 `publish-preview.ts` 的 `buildPublishPreview()` 同一条约定），
 * 这份文件就是那层约定的围栏。
 */
function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    name: "01a01fad-96e1-704d-88e2-d0df96c3b0b7",
    type: "POST",
    title: "因为喜欢开源，我用 Halo 写了一个插件",
    excerpt: "作者因热爱开源…",
    permalink: "/archives/halo-dark-mode-plugin2",
    published: true,
    recycled: false,
    ...overrides,
  };
}

describe("normalizeQuery", () => {
  test("去掉首尾空白", () => {
    // 用户从别处粘贴关键词时很容易带上空格，而带空格的查询在服务端是按**含空格**匹配的。
    expect(normalizeQuery("  Halo  ")).toBe("Halo");
  });

  test("空串归一成 undefined（服务端 minLength: 1 会拒掉空查询）", () => {
    // 实测 2026-10-05：传空串会被服务端拒掉 ——
    // `[/query: must be at least 1 characters long]`。
    // 归一成 undefined 之后，命令入口一个判据就能同时挡住「取消」与「什么都没输」。
    expect(normalizeQuery("")).toBeUndefined();
  });

  test("纯空白同样归一成 undefined", () => {
    // 与上一条不是同一件事：`value || undefined` 放得过 `"   "`（非空字符串），
    // 而它去空白之后同样是空查询。判据必须是**去空白之后**的非空。
    expect(normalizeQuery("   ")).toBeUndefined();
  });

  test("非空关键词原样返回（不动内部空格）", () => {
    expect(normalizeQuery("Halo 插件")).toBe("Halo 插件");
  });
});

describe("buildSearchRows", () => {
  const SITE = "https://blog.example.com";

  test("摘要截断到 200 字符", () => {
    // 实测口径记在 `src/search-modal.ts` 的 `EXCERPT_MAX_LENGTH` 文档里（站点返回的 excerpt
    // 无一短于该长度）。**这里刻意不复述最长/最短那两个数字** —— 抄第二份就是这么错的：
    // 源码那边改成了新值之后，这份注释还留着旧值。逐条铺满会把「一共几条」挤出屏幕。
    const long = "甲".repeat(250);
    const [row] = buildSearchRows(SITE, [result({ excerpt: long })]);

    expect(row.excerpt).toHaveLength(200);
    expect(row.excerpt).toBe(long.slice(0, 200));
  });

  test("短摘要不补不截", () => {
    const [row] = buildSearchRows(SITE, [result({ excerpt: "很短" })]);

    expect(row.excerpt).toBe("很短");
  });

  test("已发布的没有草稿标记，未发布的才有", () => {
    const [published] = buildSearchRows(SITE, [result({ published: true })]);
    const [draft] = buildSearchRows(SITE, [result({ published: false })]);

    expect(published.isDraft).toBe(false);
    expect(draft.isDraft).toBe(true);
  });

  test("按类型选图标，并把类型带出去（弹窗靠它挑类型 tooltip）", () => {
    const rows = buildSearchRows(SITE, [result(), result({ type: "SINGLE_PAGE", name: "p1" })]);

    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe("POST");
    expect(rows[0].icon).toBe("lucide-file-text");
    expect(rows[1].type).toBe("SINGLE_PAGE");
    expect(rows[1].icon).toBe("lucide-file");
    // 图标名带 `lucide-` 前缀是本仓既有约定（`settings.ts` / `sites-modal.ts` 都这么写），
    // 写成裸 `file-text` 在 Obsidian 里渲染不出来 —— 那是一次**静默**的空图标。
    expect(rows.every((row) => row.icon.startsWith("lucide-"))).toBe(true);
  });

  test("permalink 拼成绝对地址（站点地址无尾斜杠）", () => {
    // 实测 permalink 形如 `/archives/halo-dark-mode-plugin2`。
    const [row] = buildSearchRows(SITE, [result()]);

    expect(row.openUrl).toBe("https://blog.example.com/archives/halo-dark-mode-plugin2");
  });

  test("站点地址带尾斜杠时不拼出双斜杠", () => {
    // 站点地址由 `normalizeSite()` 归一，settings 还可能被手工改过 —— 两种都得对。
    const [row] = buildSearchRows("https://blog.example.com/", [result()]);

    expect(row.openUrl).toBe("https://blog.example.com/archives/halo-dark-mode-plugin2");
  });

  test("permalink 缺前导斜杠时仍然拼得对", () => {
    // 朴素的 `base + permalink` 会拼出 `https://blog.example.comarchives/x` ——
    // 那是一个**看起来像成功、点开却 404** 的地址，而这里没有任何东西能察觉它。
    const [row] = buildSearchRows(SITE, [result({ permalink: "archives/x" })]);

    expect(row.openUrl).toBe("https://blog.example.com/archives/x");
  });

  test("没有 permalink 时 openUrl 是空串（弹窗据此不画「打开」按钮）", () => {
    // 少了这一条，弹窗会画一个按了没反应的按钮 —— `toSearchResults()` 已经把缺失的
    // permalink 回落成空串，这里要保证它不会拼出「站点首页」这种看着能用的地址。
    const [row] = buildSearchRows(SITE, [result({ permalink: "" })]);

    expect(row.openUrl).toBe("");
  });

  test("没有结果时给空数组", () => {
    // 「什么都没找到」由弹窗显示 `search_modal.empty` 文案，不在这一层。
    expect(buildSearchRows(SITE, [])).toEqual([]);
  });
});
