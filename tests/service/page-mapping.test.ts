import { describe, expect, it } from "@rstest/core";
import {
  type McpSinglePageItem,
  toPageCreateArgs,
  toPageUpdateArgs,
  toSinglePage,
} from "src/service/page-mapping";

/**
 * 页面的**扁平**骨架 —— 逐字取自 2026-10-05 实测的 `halo_list_single_pages` outputSchema。
 *
 * 显式标注类型而不是靠推断：`visible: "PUBLIC"` 会被推断成 `string`，而接口里它是字面量联合
 * —— 标注后由上下文定型，才写得出 `"PUBLIC"`。
 *
 * ⚠️ **本文件是 `page-mapping.ts` 唯一的字段名校验**（与 `post-mapping.test.ts` 同一条理由）：
 * 该模块 `import type { SinglePage }` 的 `@halo-dev/api-client` 解析不了
 * （`moduleResolution: "node"` 忽略 `exports`），`SinglePage` 退化成 `any`，于是 tsc **看不见**
 * `item.slugg` 这类拼写错误。所以每个被映射的字段都要有断言。
 */
function pageItem(overrides: Partial<McpSinglePageItem> = {}): McpSinglePageItem {
  return {
    name: "019fcb32-f421-7342-b900-35d1335192f5",
    title: "自己",
    slug: "about",
    excerpt: "",
    published: true,
    publishRequested: true,
    recycled: false,
    visible: "PUBLIC",
    owner: "liuhangyv",
    permalink: "/about",
    ...overrides,
  };
}

describe("toSinglePage", () => {
  it("把扁平表示还原成领域模型，字段名与 Post 同形以便复用编排", () => {
    const page = toSinglePage(pageItem());

    expect(page.metadata.name).toBe("019fcb32-f421-7342-b900-35d1335192f5");
    expect(page.spec.title).toBe("自己");
    expect(page.spec.slug).toBe("about");
    expect(page.spec.visible).toBe("PUBLIC");
    // ⚠️ publish 取 publishRequested，**不是 published** —— 与 toPost 同一条理由：
    // published 是「此刻是否真的在线」（受 publishTime / 回收站影响），
    // 取它会把一篇定时页面判成未发布。
    expect(page.spec.publish).toBe(true);
  });

  it("publishRequested 缺席时 publish 回落 false，而不是 undefined", () => {
    expect(toSinglePage(pageItem({ publishRequested: undefined })).spec.publish).toBe(false);
  });

  /**
   * ⚠️ 这条用例此前把 `pinned` / `priority` 也列进「不该出现」的清单 —— **那个前提是错的**。
   *
   * `SinglePageSpec` 里 `pinned` / `priority` / `allowComment` / `deleted` 都是**必填**字段
   *（页面这个资源确实有这些概念），只是 MCP 的页面工具不暴露它们。此前 `SinglePage` 因为
   * `moduleResolution: "node"` 解析不了 `@halo-dev/api-client` 而退化成 `any`，所以
   * `toSinglePage` 少填这四个键也不会报错，用例就按「页面没有这些字段」写了下来。
   *
   * 真正要防的是**另一件事**：文章独有的字段（`categories` / `tags` / `cover` / `template` /
   * `publishTime`）不能出现在 `spec` 上，因为它们会被 `toPageUpdateArgs` 传回服务端，
   * 而 MCP 的 schema 是 `additionalProperties: false` —— 多传一个键整次调用就被拒。
   *
   * 所以断言分两层：`spec` 上不许有**文章独有**字段；而「不传回服务端」这件事由下面
   * `toPageUpdateArgs` 的键集用例钉住（那才是真正的边界）。
   */
  it("文章独有的字段不会出现在页面的 spec 上", () => {
    const page = toSinglePage(pageItem()) as unknown as { spec: Record<string, unknown> };

    for (const absent of ["categories", "tags", "cover", "template", "publishTime"]) {
      expect(page.spec).not.toHaveProperty(absent);
    }
  });

  /**
   * `SinglePageSpec` 的必填字段必须填上 —— 与 `createEmptyPage()` 的键集**逐个对齐**。
   *
   * 这条用例的存在理由是一次真实缺陷：`toPost` 漏填了必填的 `deleted`，而 `as Post` 断言
   * 把类型检查挡住了，直到把 `moduleResolution` 改成 `bundler`（类型真正解析出来）才暴露。
   * 两个构造同一类型的函数给出不一致的键集，是缺陷而不是风格 —— 这里把它钉住。
   */
  it("spec 的必填字段都填了，且与 createEmptyPage 的键集一致", () => {
    const spec = toSinglePage(pageItem()).spec as unknown as Record<string, unknown>;

    for (const required of ["allowComment", "deleted", "pinned", "priority", "excerpt", "publish", "slug", "title", "visible"]) {
      expect(spec).toHaveProperty(required);
    }

    // 取值也必须是「页面默认值」而不是从文章字段误映射过来的
    expect(spec.allowComment).toBe(true);
    expect(spec.deleted).toBe(false);
    expect(spec.pinned).toBe(false);
    expect(spec.priority).toBe(0);
  });
});

describe("toPageCreateArgs / toPageUpdateArgs", () => {
  it("rawType 必须显式传 markdown（schema 默认值是 html，漏传会静默渲染错乱）", () => {
    const page = toSinglePage(pageItem());

    expect(toPageCreateArgs(page, "# 正文").rawType).toBe("markdown");
    expect(toPageUpdateArgs(page, "# 正文").rawType).toBe("markdown");
  });

  it("create 带 publish:false，update **不带** publish（该工具没有这个入参）", () => {
    const page = toSinglePage(pageItem());

    expect(toPageCreateArgs(page, "x").publish).toBe(false);
    expect(toPageUpdateArgs(page, "x")).not.toHaveProperty("publish");
  });

  it("create 的入参集合恰好是我们决定的 8 个键，且逐个都是 schema 允许的（additionalProperties: false）", () => {
    const page = toSinglePage(pageItem());
    const args = toPageCreateArgs(page, "x");

    // 断言的是「我们发出去的键集」而不是「schema 的键全集」——
    // 实测 halo_create_single_page 的 inputSchema.properties 是
    // {name, title, slug, raw, content, rawType, publish, visible, allowComment} 共 **9** 个，
    // 我们刻意只发 8 个：**不传 `content`**，交给服务端按 `raw` 生成
    // （与文章路径 toCreateArgs 同款）。`publish` 是 schema 认的键（default: false），所以它在集合里。
    // 这个集合一旦变动必须是**有意的**：多一个 schema 不认的键会被服务端直接拒绝。
    expect(Object.keys(args).sort()).toEqual(
      ["allowComment", "name", "publish", "raw", "rawType", "slug", "title", "visible"].sort(),
    );
  });

  it("update 的入参集合恰好是我们决定的 7 个键，且逐个都是 schema 允许的", () => {
    const page = toSinglePage(pageItem());
    const args = toPageUpdateArgs(page, "x");

    // 同一条理由：验的是我们发出去的那一份，不是 schema 的全集。
    // update 的 schema 同样允许 `content`（我们刻意不传），但**不允许 `publish`** —— 见上一条用例。
    expect(Object.keys(args).sort()).toEqual(
      ["allowComment", "name", "raw", "rawType", "slug", "title", "visible"].sort(),
    );
  });

  it("空 slug 传 undefined 而不是空串（schema 有 minLength: 1）", () => {
    const page = toSinglePage(pageItem({ slug: "" }));

    expect(toPageUpdateArgs(page, "x").slug).toBeUndefined();
  });
});
