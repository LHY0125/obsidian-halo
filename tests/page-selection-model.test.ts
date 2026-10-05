import { describe, expect, test } from "@rstest/core";
import { type SelectablePage, toSelectablePages } from "../src/page-selection-model";

/**
 * `toSelectablePages` 的三条规范化，各自对应 schema 的一条事实：
 * `halo_list_single_pages` 的 item `required` 只有 `["published", "publishRequested", "recycled"]`
 * —— **`name` / `title` / `slug` 都不在其中**，所以它们随时可以缺席。
 *
 * fixture 里 `name` / `title` / `slug` **两两不同**：三者中若有任何两个相同，
 * 「取对了字段」与「取错了字段」就会产生完全相同的观测，断言等于白写
 * （`tests/service/post-mapping.test.ts` 的 fixture 踩过同一个坑）。
 */
describe("toSelectablePages", () => {
  test("剔除缺 name 的项（按下去必然失败）", () => {
    // `name` 是 `pullPage` 的**唯一**入参，缺了它这个条目按下去必然失败 ——
    // 列一个按了就坏的按钮比不列更糟，也不该编一个空串去凑。
    const pages = toSelectablePages([
      { name: "page-1", title: "关于", slug: "about" },
      { title: "没有名字", slug: "x" },
    ]);

    expect(pages).toHaveLength(1);
    expect(pages[0].name).toBe("page-1");
  });

  test("缺 title 时回落成 name，避免一行空白", () => {
    const pages = toSelectablePages([{ name: "page-1", slug: "about" }]);

    expect(pages[0].title).toBe("page-1");
  });

  test("空串 title 同样回落成 name（判据是**非空**，不是非 null）", () => {
    // 这条与上一条不是同一件事，也不能合并：`??` 会挡住 `undefined` 却放行 `""`，
    // 而空串在列表里同样是一行空白。改用 `??` 时上一条仍绿、只有这条会红。
    const pages = toSelectablePages([{ name: "page-1", title: "", slug: "about" }]);

    expect(pages[0].title).toBe("page-1");
  });

  test("缺 slug 时回落成空串（它不是标识，只是副标题）", () => {
    const pages = toSelectablePages([{ name: "page-1", title: "关于" }]);

    expect(pages[0].slug).toBe("");
  });

  test("规范化后的条目类型是「一定拿得到东西」的形状（服务层不必再处理 undefined）", () => {
    // 类型级断言写成运行期断言：三个字段都必须真的是 string，任何一个是 undefined
    // 都会让 `setName()` 显示空白、`pullPage()` 发一个空 name 出去。
    const pages: SelectablePage[] = toSelectablePages([{ name: "page-1" }]);

    expect(pages).toEqual([{ name: "page-1", title: "page-1", slug: "" }]);
  });
});
