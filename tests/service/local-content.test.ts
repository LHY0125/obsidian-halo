import { describe, expect, it } from "@rstest/core";
import {
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
