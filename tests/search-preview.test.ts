import { describe, expect, test } from "@rstest/core";
import { type McpSearchItem, stripHighlight, toSearchResults } from "../src/search-preview";

describe("stripHighlight", () => {
  test("去掉服务端加的高亮标签", () => {
    // 实测口径记在 `src/search-preview.ts` 的 `stripHighlight()` 文档里（2026-10-05 对站点跑
    // `halo_search_content`，7 条结果里 title 与 excerpt 都各有多条带高亮）——
    // **这里刻意不复述那份数字**：抄第二份必然在某次修订后与源码分叉，
    // 而分叉的表现是这份注释自信地写着一个已经不成立的值（此前就是这么错的）。
    // 不清理的话，弹窗里会显示成「我用 <B>Halo</B> 写了一个插件」。
    expect(stripHighlight("因为喜欢开源，我用 <B>Halo</B> 写了一个插件")).toBe("因为喜欢开源，我用 Halo 写了一个插件");
  });

  test("大小写不敏感（服务端可能回 <b>）", () => {
    expect(stripHighlight("a <b>x</b> b")).toBe("a x b");
  });

  test("只去 B 标签，**不动**正文里合法的尖括号", () => {
    // 过度清理会把用户正文里的 `<div>` 也吃掉 —— 那是**误命中**方向，
    // 与「没清理干净」是同一个判据的两个方向，必须都测。
    expect(stripHighlight("用 <div> 包起来")).toBe("用 <div> 包起来");
    expect(stripHighlight("a <br> b")).toBe("a <br> b");
  });

  test("没有标签时原样返回（不改变空白）", () => {
    expect(stripHighlight("普通标题")).toBe("普通标题");
  });
});

describe("toSearchResults", () => {
  function item(overrides: Partial<McpSearchItem> = {}): McpSearchItem {
    return {
      type: "POST",
      name: "01a01fad-96e1-704d-88e2-d0df96c3b0b7",
      title: "因为喜欢开源，我用 <B>Halo</B> 写了一个插件",
      excerpt: "作者因热爱开源…",
      published: true,
      recycled: false,
      exposed: true,
      categories: [],
      tags: [],
      permalink: "/archives/halo-dark-mode-plugin2",
      ...overrides,
    };
  }

  test("标题与摘要都清理高亮标签", () => {
    const [result] = toSearchResults([item()]);

    expect(result.title).toBe("因为喜欢开源，我用 Halo 写了一个插件");
    expect(result.title).not.toContain("<B>");
  });

  test("剔除缺 name 的项（没法定位到具体文章）", () => {
    expect(toSearchResults([item({ name: undefined })])).toHaveLength(0);
  });

  test("保留 type，让弹窗能区分文章与页面", () => {
    const [post, page] = toSearchResults([item(), item({ type: "SINGLE_PAGE", name: "p1" })]);

    expect(post.type).toBe("POST");
    expect(page.type).toBe("SINGLE_PAGE");
  });

  test("permalink 缺省时回落空串（它不是标识，只是「打开」按钮的地址）", () => {
    expect(toSearchResults([item({ permalink: undefined })])[0].permalink).toBe("");
  });
});
