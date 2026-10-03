import { describe, expect, it } from "@rstest/core";
import { type McpPostItem, generateResourceName, toContent, toPost } from "src/service/post-mapping";

/**
 * fixture 取自实抓的 `halo_get_post` 返回体（2026-10-04 对真实站点复核过字段名）。
 *
 * 保留 `publishRequested` 与 `published`：`toPost` 对 `publish` 的映射正是依赖「意图」与
 * 「此刻在线」的区分，把它们都写进 fixture 才验得出取错了哪一个。
 *
 * 显式标注类型而不是靠推断：`visible: "PUBLIC"` 会被推断成 `string`，而接口里它是字面量联合
 * —— 标注后由上下文定型，才写得出 `"PUBLIC"`。
 */
const ITEM: McpPostItem = {
  name: "real-ip-always-there-and-forgery",
  title: "真实 IP 一直在",
  slug: "real-ip-always-there-and-forgery",
  excerpt: "摘要",
  excerptRaw: "摘要",
  autoGenerateExcerpt: false,
  cover: "/upload/a.webp",
  template: "",
  pinned: true,
  priority: 3,
  publishTime: "2026-10-01T12:10:43.104320897Z",
  allowComment: false,
  published: true,
  publishRequested: true,
  visible: "PUBLIC",
  categories: ["category-sc9pomuo"],
  tags: ["tag-tnpxywrp"],
};

describe("toPost", () => {
  it("把扁平字段还原成 {metadata, spec} 嵌套结构", () => {
    const post = toPost(ITEM);
    expect(post.metadata.name).toBe("real-ip-always-there-and-forgery");
    expect(post.spec.title).toBe("真实 IP 一直在");
    expect(post.spec.visible).toBe("PUBLIC");
    expect(post.spec.pinned).toBe(true);
    expect(post.spec.priority).toBe(3);
    expect(post.spec.allowComment).toBe(false);
    expect(post.spec.publishTime).toBe("2026-10-01T12:10:43.104320897Z");
  });

  it("excerpt 还原成 {autoGenerate, raw} 结构", () => {
    expect(toPost(ITEM).spec.excerpt).toEqual({ autoGenerate: false, raw: "摘要" });
  });

  it("autoGenerateExcerpt 为 true 时 raw 取空串，交给服务端生成", () => {
    const post = toPost({ ...ITEM, autoGenerateExcerpt: true });
    expect(post.spec.excerpt).toEqual({ autoGenerate: true, raw: "" });
  });

  it("categories / tags 原样搬运（它们是 metadata.name 数组，不是显示名）", () => {
    expect(toPost(ITEM).spec.categories).toEqual(["category-sc9pomuo"]);
    expect(toPost(ITEM).spec.tags).toEqual(["tag-tnpxywrp"]);
  });

  it("缺字段时不抛错，给出安全默认值", () => {
    const post = toPost({ name: "x" } as never);
    expect(post.spec.visible).toBe("PUBLIC");
    expect(post.spec.categories).toEqual([]);
    expect(post.spec.tags).toEqual([]);
  });

  it("publish 取 publishRequested（发布意图），而不是写死 false", () => {
    // 这个字段会被 publishPost / updatePost / pullPost 回写进 frontmatter.halo.publish，
    // 下次发布读它决定要不要 set_post_publish_state —— 恒为 false 会把已发布的文章撤回草稿
    expect(toPost(ITEM).spec.publish).toBe(true);
  });

  it("publish 不取 published：定时文章已请求发布但此刻还没上线", () => {
    const scheduled = toPost({ ...ITEM, publishRequested: true, published: false });
    expect(scheduled.spec.publish).toBe(true);
  });

  it("缺 publishRequested 时回落到未发布，不抛错", () => {
    expect(toPost({ name: "x" } as never).spec.publish).toBe(false);
  });
});

describe("toContent", () => {
  it("搬运 raw 与 rawType", () => {
    expect(toContent({ raw: "# 标题", rawType: "markdown" })).toEqual({
      content: "",
      raw: "# 标题",
      rawType: "markdown",
    });
  });

  it("服务端把 raw 置为 null（format 未请求正文）时回落成空串与 markdown", () => {
    // outputSchema 里 rawType / raw 都是 ["string","null"]，null 是合法取值
    expect(toContent({ raw: null, rawType: null })).toEqual({
      content: "",
      raw: "",
      rawType: "markdown",
    });
  });
});

describe("generateResourceName", () => {
  it("与站点现存的 category-xxxxxxxx 同形", () => {
    expect(generateResourceName("category")).toMatch(/^category-[a-z0-9]{8}$/);
    expect(generateResourceName("tag")).toMatch(/^tag-[a-z0-9]{8}$/);
  });

  it("两次调用不重复", () => {
    const names = new Set(Array.from({ length: 200 }, () => generateResourceName("tag")));
    expect(names.size).toBe(200);
  });
});
