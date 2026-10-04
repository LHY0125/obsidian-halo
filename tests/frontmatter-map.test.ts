import type { Post } from "@halo-dev/api-client";
import { describe, expect, it } from "@rstest/core";
import { applyPostToFrontmatter, parseHaloPostFields } from "src/frontmatter-map";

describe("parseHaloPostFields —— 缺席语义", () => {
  it("halo 整个缺席时给空对象（等于「一个字段都不要动」）", () => {
    expect(parseHaloPostFields(undefined)).toEqual({ ok: true, fields: {} });
  });

  it("halo 写成非对象时按缺席处理，不抛错", () => {
    // 老笔记里有人把 halo 写成一行字符串是可能的；这里唯一要做的判断是
    // 「有没有要跟随的字段」，为它抛错会连笔记都打不开。
    expect(parseHaloPostFields("x")).toEqual({ ok: true, fields: {} });
    expect(parseHaloPostFields([])).toEqual({ ok: true, fields: {} });
    expect(parseHaloPostFields(42)).toEqual({ ok: true, fields: {} });
  });

  it("键写了但值是 null（YAML 的 `visible:`）时按缺席处理", () => {
    expect(parseHaloPostFields({ visible: null, pinned: null, publishTime: null })).toEqual({ ok: true, fields: {} });
  });

  it("不认识的键被忽略，已知键照常解析", () => {
    expect(parseHaloPostFields({ somethingElse: 1, pinned: true })).toEqual({ ok: true, fields: { pinned: true } });
  });
});

describe("parseHaloPostFields —— 假值必须留存", () => {
  // 这四条钉的是同一个契约：`false` / `0` / `""` 是**用户写下的显式值**，不是「没写」。
  // 用真假判断实现这一层，会让 `pinned: false` 退化成「跟随远端」—— 用户在本地取消置顶后
  // 发布，站上仍然置顶，而回写还会把 true 写回他的笔记。
  it.each([
    ["pinned", false],
    ["allowComment", false],
    ["priority", 0],
    ["template", ""],
  ] as [string, unknown][])("%s 的显式假值被保留", (field, value) => {
    const result = parseHaloPostFields({ [field]: value });
    expect(result).toEqual({ ok: true, fields: { [field]: value } });
  });

  it("publishTime 的空串是合法值（语义是「立即发布」），不做日期解析", () => {
    // Date.parse("") 是 NaN。若不在空串上短路，这个**契约规定的合法值**会被判成非法。
    expect(parseHaloPostFields({ publishTime: "" })).toEqual({ ok: true, fields: { publishTime: "" } });
  });
});

describe("parseHaloPostFields —— visible 枚举", () => {
  it.each(["PUBLIC", "INTERNAL", "PRIVATE"])("%s 通过", (value) => {
    expect(parseHaloPostFields({ visible: value })).toEqual({ ok: true, fields: { visible: value } });
  });

  it('两端空白被吃掉（YAML 里写成 " PUBLIC " 是手滑）', () => {
    expect(parseHaloPostFields({ visible: " PUBLIC " })).toEqual({ ok: true, fields: { visible: "PUBLIC" } });
  });

  it("大小写不对时**报错**并带上原值", () => {
    expect(parseHaloPostFields({ visible: "public" })).toEqual({
      ok: false,
      key: "frontmatter.error_visible",
      params: { value: "public" },
    });
  });

  it("非字符串时报错，且不把对象渲染成 [object Object]", () => {
    expect(parseHaloPostFields({ visible: 1 })).toEqual({
      ok: false,
      key: "frontmatter.error_visible",
      params: { value: "1" },
    });
    expect(parseHaloPostFields({ visible: { a: 1 } })).toEqual({
      ok: false,
      key: "frontmatter.error_visible",
      params: { value: '{"a":1}' },
    });
  });
});

describe("parseHaloPostFields —— 类型校验", () => {
  it.each(["pinned", "allowComment"])('%s 只接受布尔值，字符串 "true" 不接受', (field) => {
    // YAML 里加引号就是字符串。悄悄强转会把用户的书写错误掩盖成「有效配置」，
    // 而他下次看到回写结果时会以为是插件改了他的值。
    expect(parseHaloPostFields({ [field]: "true" })).toEqual({
      ok: false,
      key: "frontmatter.error_boolean",
      params: { field, value: "true" },
    });
  });

  it("priority 只接受整数", () => {
    expect(parseHaloPostFields({ priority: 3 })).toEqual({ ok: true, fields: { priority: 3 } });
    expect(parseHaloPostFields({ priority: "3" })).toEqual({
      ok: false,
      key: "frontmatter.error_integer",
      params: { field: "priority", value: "3" },
    });
    expect(parseHaloPostFields({ priority: 1.5 })).toEqual({
      ok: false,
      key: "frontmatter.error_integer",
      params: { field: "priority", value: "1.5" },
    });
  });

  it("template 只接受字符串", () => {
    expect(parseHaloPostFields({ template: "custom" })).toEqual({ ok: true, fields: { template: "custom" } });
    expect(parseHaloPostFields({ template: 7 })).toEqual({
      ok: false,
      key: "frontmatter.error_string",
      params: { field: "template", value: "7" },
    });
  });

  it("publishTime 非字符串时按字符串类错误报", () => {
    expect(parseHaloPostFields({ publishTime: 20261006 })).toEqual({
      ok: false,
      key: "frontmatter.error_string",
      params: { field: "publishTime", value: "20261006" },
    });
  });
});

describe("parseHaloPostFields —— publishTime 取值", () => {
  it.each(["2026-10-06T10:00:00+08:00", "2026-10-06T02:00:00.000Z", "2026-10-06 10:00"])("%s 被接受", (value) => {
    expect(parseHaloPostFields({ publishTime: value })).toEqual({ ok: true, fields: { publishTime: value } });
  });

  it("解析不出时间的字符串被拒绝", () => {
    // 校验刻意宽松（Date.parse 认的就算数）：目标是拦住「明天」「下周三」这类
    // 一眼就不是机器时间的值，而不是当 RFC 3339 的守门员 —— 那会拒掉服务端本来能接受的写法。
    expect(parseHaloPostFields({ publishTime: "明天" })).toEqual({
      ok: false,
      key: "frontmatter.error_publish_time",
      params: { value: "明天" },
    });
  });
});

describe("parseHaloPostFields —— 多个非法字段时的确定性", () => {
  it("按固定顺序报第一个（visible → pinned → allowComment → priority → publishTime → template）", () => {
    // 顺序固定是为了让错误可复现：两个字段都写错时，用户改完第一个能立刻看到第二个，
    // 而不是每次启动都随机看到一个。
    expect(parseHaloPostFields({ publishTime: "明天", visible: "public" })).toEqual({
      ok: false,
      key: "frontmatter.error_visible",
      params: { value: "public" },
    });
  });
});

function makePost(): Post {
  return {
    metadata: { name: "post-1", annotations: {} },
    spec: {
      title: "标题",
      slug: "slug",
      cover: "/upload/a.webp",
      excerpt: { autoGenerate: false, raw: "摘要" },
      categories: ["category-1"],
      tags: ["tag-1"],
      publish: true,
    },
  } as unknown as Post;
}

describe("applyPostToFrontmatter", () => {
  it("写入 4 个元数据字段与 halo 块", () => {
    const frontmatter: Record<string, unknown> = {};

    applyPostToFrontmatter(frontmatter, makePost(), {
      siteUrl: "https://blog.example.com",
      name: "post-1",
      categoryNames: ["技术思考"],
      tagNames: ["Halo"],
    });

    expect(frontmatter).toEqual({
      title: "标题",
      slug: "slug",
      cover: "/upload/a.webp",
      excerpt: "摘要",
      categories: ["技术思考"],
      tags: ["Halo"],
      halo: { site: "https://blog.example.com", name: "post-1", publish: true },
    });
  });

  it("excerpt 由服务端自动生成时写 undefined（等于不写这个键）", () => {
    const post = makePost();
    post.spec.excerpt = { autoGenerate: true, raw: "" };
    const frontmatter: Record<string, unknown> = { excerpt: "旧的摘要" };

    applyPostToFrontmatter(frontmatter, post, { siteUrl: "https://blog.example.com", name: "post-1" });

    expect(frontmatter.excerpt).toBeUndefined();
  });

  it("显示名解析失败（undefined）时跳过该字段，保持笔记原值", () => {
    // 落回 spec 里的 metadata.name（`category-sc9pomuo`）看着像「不丢信息」，
    // 实际会在下次发布时被当成新的显示名建到站点上 —— 垃圾分类永久留存。
    const frontmatter: Record<string, unknown> = { categories: ["旧分类"], tags: ["旧标签"] };

    applyPostToFrontmatter(frontmatter, makePost(), { siteUrl: "https://blog.example.com", name: "post-1" });

    expect(frontmatter.categories).toEqual(["旧分类"]);
    expect(frontmatter.tags).toEqual(["旧标签"]);
  });

  it("入参是空数组时**照写**（真值判断拦不住 `[]`），与改动前的三份代码逐字一致", () => {
    // 这一条是**特征化测试**：钉的是「重构没改行为」，不是「这个行为是对的」。
    //
    // 事实：`[]` 在 JS 里是**真值**，所以 `if (options.categoryNames)` 拦不住它，空数组会被
    // 原样写进 frontmatter。改动前的三份代码同样如此 —— 已用**改动前的 `pullPost`** 实测确认：
    // 远端分类一个都解析不出来时观测到 `{ categories: [], tags: [] }`，
    // 笔记里原有的 `["旧分类"]` / `["旧标签"]` 被覆盖。所以断言是 `[]` 而不是 `["旧分类"]`。
    //
    // ⚠️ 由此暴露一个**改动前既有**的缺口（不在本任务范围内，本任务是纯重构）：
    // `getCategoryDisplayNames()` 的 `[]` 有两种来源且不可分辨 ——「这篇确实没有分类」与
    // 「这篇的分类一个都没解析出来」，后者会把用户笔记里现有的分类清空。
    // 真要拦住它，判据得是 `if (options.categoryNames?.length)`；那是**行为变更**，
    // 应由后续任务单独决策。
    const frontmatter: Record<string, unknown> = { categories: ["旧分类"] };

    applyPostToFrontmatter(frontmatter, makePost(), {
      siteUrl: "https://blog.example.com",
      name: "post-1",
      categoryNames: [],
    });

    expect(frontmatter.categories).toEqual([]);
  });

  it("halo.name 取 options.name，不取 post.metadata.name", () => {
    // 拉取路径必须传调用方的入参 name：toPost() 在服务端没回 name 时给的是空串，
    // 写进去会让下次发布认不出这篇已发布的笔记，**再建一篇重复文章**。
    const frontmatter: Record<string, unknown> = {};

    applyPostToFrontmatter(frontmatter, makePost(), { siteUrl: "https://blog.example.com", name: "requested-name" });

    expect((frontmatter.halo as { name: string }).name).toBe("requested-name");
  });
});
