import { describe, expect, it, rs } from "@rstest/core";
import {
  type McpPostItem,
  generateResourceName,
  pickNewTerms,
  toContent,
  toPost,
} from "../../src/service/post-mapping";

/**
 * fixture 取自实抓的 `halo_get_post` 返回体（2026-10-04 对真实站点复核过字段名）。
 *
 * 保留 `publishRequested` 与 `published`：`toPost` 对 `publish` 的映射正是依赖「意图」与
 * 「此刻在线」的区分，把它们都写进 fixture 才验得出取错了哪一个。
 *
 * 显式标注类型而不是靠推断：`visible: "PUBLIC"` 会被推断成 `string`，而接口里它是字面量联合
 * —— 标注后由上下文定型，才写得出 `"PUBLIC"`。
 *
 * ⚠️ **本文件是 `post-mapping.ts` 唯一的字段名校验**：该模块 `import type { Post }` 的
 * `@halo-dev/api-client` 解析不了（`moduleResolution: "node"` 忽略 `exports`），`Post` 退化成
 * `any`，于是 tsc **看不见** `item.slugg` 这类拼写错误，也看不见漏映射。所以：
 * ① 每个被映射的字段都要有断言；② fixture 里的值必须与回落默认值（`""` / `[]` / `{}`）**不同**，
 * 否则「取错字段 → undefined」与「字段缺失 → 默认值」不可区分，断言没有判别力。
 */
const ITEM: McpPostItem = {
  name: "real-ip-always-there-and-forgery",
  title: "真实 IP 一直在",
  // slug **刻意取得与 name 不同**：两者若字节相同，下面 `post.spec.slug` 的那条断言就分不清
  // 「正确映射了 slug」与「误映射成 name」—— 而字段名写错正是本文件唯一能挡住的东西
  // （tsc 看不见，见文首说明）。断言用的是 `toBe`（精确相等），所以前缀关系不影响判别力。
  slug: "real-ip-always-there",
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
    // slug 最要紧：它既流进 halo_update_post，也回写进 frontmatter。
    // 期望值刻意不等于 fixture 的 name —— 取错成 item.name 时这条必须红。
    expect(post.spec.slug).toBe("real-ip-always-there");
    expect(post.spec.cover).toBe("/upload/a.webp");
    expect(post.spec.visible).toBe("PUBLIC");
    expect(post.spec.pinned).toBe(true);
    expect(post.spec.priority).toBe(3);
    expect(post.spec.allowComment).toBe(false);
    expect(post.spec.publishTime).toBe("2026-10-01T12:10:43.104320897Z");
  });

  it("template 原样搬运", () => {
    // fixture 里 template 是空串，与「字段名写错 → undefined → 回落空串」同形，断言不出东西；
    // 换成非空值才验得出映射本身没写错
    expect(toPost({ ...ITEM, template: "custom.html" }).spec.template).toBe("custom.html");
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
    // 漏掉任何一个被映射的字段都会是一条静默的 undefined —— tsc 看不见，只能靠这几行
    expect(post.spec.slug).toBe("");
    expect(post.spec.cover).toBe("");
    expect(post.spec.template).toBe("");
    expect(post.spec.htmlMetas).toEqual([]);
    expect(post.metadata.annotations).toEqual({});
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

  it("字符集与长度：大量调用下只用字母表内的字符，且恒为 8 位", () => {
    // 拒绝采样只该**丢弃**越界字节，不能顺手少取或多取 —— 长度由 while 循环兜住
    for (const name of Array.from({ length: 2_000 }, () => generateResourceName("tag"))) {
      expect(name).toMatch(/^tag-[a-z0-9]{8}$/);
    }
  });

  it("随机性来自 crypto，而不是 Math.random", () => {
    const mathRandom = rs.spyOn(Math, "random").mockReturnValue(0);

    try {
      // 仍走 Math.random 的实现会产出恒定的 "tag-aaaaaaaa"（两次调用就重复，且恰好是那个值）
      const names = new Set(Array.from({ length: 8 }, () => generateResourceName("tag")));
      expect(names.size).toBeGreaterThan(1);
      expect(names.has("tag-aaaaaaaa")).toBe(false);
    } finally {
      mathRandom.mockRestore();
    }
  });

  it("拒绝采样：越界字节被丢弃，而不是取模映射（分布无偏的关键）", () => {
    // 252 = 7 × 36，正好是阈值：>= 252 的字节必须**丢弃**。
    // 取模实现会把 252 映射成 'a'（252 % 36 === 0）、255 映射成 'd'（255 % 36 === 3），
    // 于是期望值会变成 "9adabcde"；拒绝采样则跳过这两个字节、依次取用后面的 0..6。
    // 251 是最后一个**被接受**的字节（251 % 36 === 35 → '9'），所以这一条同时钉住了阈值的两侧。
    const scripted = [251, 252, 255, 0, 1, 2, 3, 4, 5, 6];
    let cursor = 0;
    const getRandomValues = rs.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array: Uint8Array) => {
      for (let index = 0; index < array.length; index++) {
        array[index] = scripted[Math.min(cursor++, scripted.length - 1)];
      }

      return array;
    });

    try {
      expect(generateResourceName("tag")).toBe("tag-9abcdefg");
    } finally {
      getRandomValues.mockRestore();
    }
  });
});

describe("pickNewTerms", () => {
  it("挑出站点上还没有的显示名（按 displayName 精确匹配）", () => {
    expect(pickNewTerms(["技术", "随笔"], [{ displayName: "技术" }])).toEqual(["随笔"]);
  });

  it("入参缺席时给空数组，不把「没写分类」变成「要建空分类」", () => {
    expect(pickNewTerms(undefined, [])).toEqual([]);
  });

  it("大小写不同算不同的显示名（与创建时的 `===` 判等同一套）", () => {
    expect(pickNewTerms(["halo"], [{ displayName: "Halo" }])).toEqual(["halo"]);
  });

  it("保持入参顺序、不去重（去重是调用方对「并集」的处置）", () => {
    expect(pickNewTerms(["X", "X"], [])).toEqual(["X", "X"]);
  });
});
