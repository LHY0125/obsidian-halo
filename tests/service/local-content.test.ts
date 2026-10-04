import { describe, expect, it } from "@rstest/core";
import type { Post } from "@halo-dev/api-client";
import type { TFile } from "obsidian";
import {
  applyPostFrontmatter,
  decodeMarkdownPath,
  formatMarkdownImagePath,
  formatWikiImageEmbed,
  getMarkdownImageAlt,
  getWikiImageAlias,
  getWikiImageAlt,
  isRemotePath,
  parseMarkdownImageTarget,
} from "src/service/local-content";

describe("isRemotePath", () => {
  it.each([
    ["https://example.com/a.png", true],
    ["http://example.com/a.png", true],
    ["//cdn.example.com/a.png", true],
    ["#anchor", true],
    ["assets/a.png", false],
    ["a.png", false],
  ] as [string, boolean][])("%s → %s", (input, expected) => {
    expect(isRemotePath(input)).toBe(expected);
  });
});

describe("decodeMarkdownPath", () => {
  it("解码百分号转义", () => {
    expect(decodeMarkdownPath("a%20b.png")).toBe("a b.png");
  });

  it("不是合法转义时原样返回，不抛错", () => {
    expect(decodeMarkdownPath("100%")).toBe("100%");
  });
});

describe("parseMarkdownImageTarget", () => {
  it("解析尖括号包裹的路径，并给出 rawPath 与 start", () => {
    const target = parseMarkdownImageTarget("<a b.png>");
    expect(target).toEqual({ rawPath: "a b.png", path: "a b.png", start: 1 });
  });

  it("解析裸路径，start 指到首个非空白字符", () => {
    const target = parseMarkdownImageTarget("  a.png");
    expect(target).toEqual({ rawPath: "a.png", path: "a.png", start: 2 });
  });

  it("空串返回 undefined", () => {
    expect(parseMarkdownImageTarget("   ")).toBeUndefined();
  });
});

describe("formatMarkdownImagePath", () => {
  it("含空格或括号时用尖括号包裹", () => {
    expect(formatMarkdownImagePath("a b.png")).toBe("<a b.png>");
    expect(formatMarkdownImagePath("a(1).png")).toBe("<a(1).png>");
  });

  it("普通路径原样返回", () => {
    expect(formatMarkdownImagePath("assets/a.png")).toBe("assets/a.png");
  });
});

describe("getWikiImageAlias / getWikiImageAlt", () => {
  it("取竖线后的别名", () => {
    expect(getWikiImageAlias("a.png|截图")).toBe("截图");
  });

  it("纯数字别名视为尺寸而非 alt，返回空", () => {
    expect(getWikiImageAlt("a.png|200")).toBe("");
    expect(getWikiImageAlt("a.png|200x300")).toBe("");
  });

  it("有意义的别名作为 alt，并转义右方括号", () => {
    expect(getWikiImageAlt("a.png|截图]x")).toBe("截图\\]x");
  });
});

describe("getMarkdownImageAlt", () => {
  it("取出方括号里的 alt", () => {
    expect(getMarkdownImageAlt("![截图](a.png)")).toBe("截图");
  });

  it("空 alt 返回空串", () => {
    expect(getMarkdownImageAlt("![](a.png)")).toBe("");
  });

  it("不是图片语法时返回空串", () => {
    expect(getMarkdownImageAlt("[链接](a.png)")).toBe("");
  });
});

describe("formatWikiImageEmbed", () => {
  const entry = { filePath: "assets/a.png", permalink: "/upload/a.png", size: 1, mtime: 1, updatedAt: 1 };

  it("无别名时生成不含竖线的 embed", () => {
    expect(formatWikiImageEmbed(entry)).toBe("![[assets/a.png]]");
  });

  it("有别名时带上别名", () => {
    expect(formatWikiImageEmbed(entry, "截图")).toBe("![[assets/a.png|截图]]");
  });

  it("别名里的竖线被转义，避免破坏 embed 语法", () => {
    expect(formatWikiImageEmbed(entry, "a|b")).toBe("![[assets/a.png|a\\|b]]");
  });
});

describe("applyPostFrontmatter —— 6 个元数据字段", () => {
  const activeFile = { basename: "笔记", path: "a.md" } as TFile;

  /** 模拟「从服务端读回来的那一篇」：每个字段都有一个与默认值不同的初值，好让覆盖可见 */
  function remotePost(): Post {
    return {
      metadata: { annotations: {} },
      spec: {
        title: "远端标题",
        slug: "remote-slug",
        cover: "",
        template: "remote-template",
        pinned: true,
        priority: 7,
        publishTime: "2026-01-01T00:00:00.000Z",
        allowComment: true,
        visible: "INTERNAL",
        publish: true,
        categories: [],
        tags: [],
        htmlMetas: [],
        excerpt: { autoGenerate: true, raw: "" },
      },
    } as unknown as Post;
  }

  it("不传 haloFields 时一个元数据字段都不动 —— 「没写就跟随远端」", () => {
    const next = applyPostFrontmatter(remotePost(), { activeFile, matterData: {}, useActiveFileDefaults: false });

    expect(next.spec.visible).toBe("INTERNAL");
    expect(next.spec.pinned).toBe(true);
    expect(next.spec.priority).toBe(7);
    expect(next.spec.publishTime).toBe("2026-01-01T00:00:00.000Z");
    expect(next.spec.template).toBe("remote-template");
  });

  it("显式假值覆盖远端的真值（这是真假判断实现会漏掉的那条）", () => {
    const next = applyPostFrontmatter(remotePost(), {
      activeFile,
      matterData: {},
      haloFields: { pinned: false, priority: 0, allowComment: false },
      useActiveFileDefaults: false,
    });

    expect(next.spec.pinned).toBe(false);
    expect(next.spec.priority).toBe(0);
    expect(next.spec.allowComment).toBe(false);
  });

  it("6 个字段逐一落进 spec（名字写错时这里会红）", () => {
    const next = applyPostFrontmatter(remotePost(), {
      activeFile,
      matterData: {},
      haloFields: {
        visible: "PRIVATE",
        pinned: false,
        priority: 3,
        publishTime: "2026-10-06T10:00:00+08:00",
        allowComment: false,
        template: "custom",
      },
      useActiveFileDefaults: false,
    });

    expect(next.spec.visible).toBe("PRIVATE");
    expect(next.spec.pinned).toBe(false);
    expect(next.spec.priority).toBe(3);
    expect(next.spec.publishTime).toBe("2026-10-06T10:00:00+08:00");
    expect(next.spec.allowComment).toBe(false);
    expect(next.spec.template).toBe("custom");
  });

  it("不就地改动入参对象", () => {
    const post = remotePost();
    applyPostFrontmatter(post, {
      activeFile,
      matterData: {},
      haloFields: { pinned: false },
      useActiveFileDefaults: false,
    });

    expect(post.spec.pinned).toBe(true);
  });
});
