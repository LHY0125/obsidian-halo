import { describe, expect, it } from "@rstest/core";
import { buildPublishPreview } from "src/publish-preview";

describe("buildPublishPreview", () => {
  const base = {
    siteName: "博客",
    siteUrl: "https://blog.example.com",
    siteSource: "rule" as const,
    sitePattern: "博客/**",
    title: "标题",
    slug: "slug",
    raw: "正文",
    newCategories: ["新分类"],
    newTags: [],
    images: { pending: 3, cached: 1, overLimit: [] },
  };

  it("把 6 个字段的最终取值原样带出来（含显式假值）", () => {
    const preview = buildPublishPreview({
      ...base,
      spec: {
        visible: "INTERNAL",
        pinned: false,
        priority: 0,
        publishTime: "",
        allowComment: false,
        template: "",
      },
    });

    expect(preview.visible).toBe("INTERNAL");
    expect(preview.pinned).toBe(false);
    expect(preview.priority).toBe(0);
    expect(preview.publishTime).toBe("");
    expect(preview.allowComment).toBe(false);
  });

  it("字符数按正文（frontmatter 之后的部分）算，不把 frontmatter 算进去", () => {
    // 算上 frontmatter 会让这个数字随无关的配置项抖动，用户没法用它估长度。
    const preview = buildPublishPreview({ ...base, spec: {}, raw: "一二三" });
    expect(preview.characterCount).toBe(3);
  });

  it("站点来源被带出来，好让用户在预览里看到是规则命中的", () => {
    const preview = buildPublishPreview({ ...base, spec: {} });
    expect(preview.site).toEqual({
      name: "博客",
      url: "https://blog.example.com",
      source: "rule",
      pattern: "博客/**",
    });
  });

  it("将新建的分类标签为空时给出空数组，不是 undefined", () => {
    const preview = buildPublishPreview({ ...base, spec: {}, newCategories: [], newTags: [] });
    expect(preview.newCategories).toEqual([]);
    expect(preview.newTags).toEqual([]);
  });
});
