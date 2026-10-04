import { describe, expect, it } from "@rstest/core";
import type { HaloSite } from "src/settings";
import { matchGlob, normalizeRulePattern, resolveSite } from "src/site-routing";

function site(url: string, name = url, isDefault = false): HaloSite {
  return { name, url, token: "", mcpToken: "", default: isDefault };
}

describe("matchGlob", () => {
  it.each([
    // [模式, 路径, 期望]
    ["博客/*", "博客/a.md", true],
    ["博客/*", "博客/子目录/a.md", false], // `*` 不跨 `/` —— 这是 glob 的通行语义
    ["博客/**", "博客/a.md", true],
    ["博客/**", "博客/子目录/更深/a.md", true],
    ["**/*.md", "a.md", true], // `**/` 要能匹配「零层目录」
    ["**/*.md", "x/y/a.md", true],
    ["**/*.md", "x/y/a.txt", false],
    ["博客/?.md", "博客/a.md", true],
    ["博客/?.md", "博客/ab.md", false],
    ["a.md", "a.md", true],
    ["a.md", "b/a.md", false], // 模式永远是对**整条路径**匹配，不做后缀匹配
  ] as [string, string, boolean][])("%s 对 %s → %s", (pattern, path, expected) => {
    expect(matchGlob(pattern, path)).toBe(expected);
  });

  it("正则元字符按字面处理，不当作模式", () => {
    // 用户在库里有 `C++/` 这种目录名是常见的。若把 `+` 交给正则，它要么报错要么变成量词。
    expect(matchGlob("C++/**", "C++/a.md")).toBe(true);
    expect(matchGlob("a(1)/**", "a(1)/b.md")).toBe(true);
    expect(matchGlob("a.b/*", "axb/c.md")).toBe(false); // `.` 不能匹配任意字符
  });

  it("不区分大小写（Windows 上是文件系统本来就有的行为；命中不了时用户毫无线索）", () => {
    expect(matchGlob("Blog/**", "blog/a.md")).toBe(true);
    expect(matchGlob("blog/**", "Blog/A.md")).toBe(true);
  });

  it("空模式不匹配任何路径", () => {
    // 空模式若被编译成 `^$`，它什么都匹配不到 —— 但更糟的实现是把它当成 `**`。
    expect(matchGlob("", "a.md")).toBe(false);
    expect(matchGlob("   ", "a.md")).toBe(false);
  });
});

describe("normalizeRulePattern", () => {
  it("去掉首尾空白与开头的斜杠（用户会写 `/博客/**`）", () => {
    expect(normalizeRulePattern("  /博客/**  ")).toBe("博客/**");
  });

  it("反斜杠分隔符换成斜杠（vault 路径永远是斜杠，但用户从资源管理器复制来的是反斜杠）", () => {
    expect(normalizeRulePattern("博客\\**")).toBe("博客/**");
  });
});

describe("resolveSite —— 优先级", () => {
  const sites = [site("https://a.example.com", "A", true), site("https://b.example.com", "B")];

  it("frontmatter 的 halo.site 最高，压过规则表与默认站点", () => {
    const result = resolveSite(
      sites,
      [{ pattern: "**", site: "https://a.example.com" }],
      "x/y.md",
      "https://b.example.com",
    );

    expect(result).toEqual({ kind: "resolved", site: sites[1], source: "frontmatter" });
  });

  it("frontmatter 指向一个没配置的站点时报错，**不静默改道**", () => {
    // 静默改用默认站点会把笔记发到另一个站上（可能已在别处存在同名文章）。
    // 报错是可恢复的，发错站不是。
    expect(resolveSite(sites, [], "x.md", "https://c.example.com")).toEqual({
      kind: "unknown-site",
      url: "https://c.example.com",
    });
  });

  it("规则表自上而下取首个命中", () => {
    const rules = [
      { pattern: "博客/日记/**", site: "https://b.example.com" },
      { pattern: "博客/**", site: "https://a.example.com" },
    ];

    expect(resolveSite(sites, rules, "博客/日记/1.md")).toEqual({
      kind: "resolved",
      site: sites[1],
      source: "rule",
      pattern: "博客/日记/**",
    });
    expect(resolveSite(sites, rules, "博客/技术/1.md")).toEqual({
      kind: "resolved",
      site: sites[0],
      source: "rule",
      pattern: "博客/**",
    });
  });

  it("首条命中的规则指向已删掉的站点时报错，不继续往下找", () => {
    // 继续往下找会把「规则写错了」变成「发到了另一个站」—— 用户改完规则前永远不会知道有问题。
    const rules = [
      { pattern: "博客/**", site: "https://deleted.example.com" },
      { pattern: "**", site: "https://a.example.com" },
    ];

    expect(resolveSite(sites, rules, "博客/1.md")).toEqual({
      kind: "unknown-rule-site",
      url: "https://deleted.example.com",
      pattern: "博客/**",
    });
  });

  it("都不命中时用默认站点", () => {
    expect(resolveSite(sites, [{ pattern: "别处/**", site: "https://b.example.com" }], "x.md")).toEqual({
      kind: "resolved",
      site: sites[0],
      source: "default",
    });
  });

  it("没有默认站点、只有一个站点时直接用它", () => {
    expect(resolveSite([site("https://a.example.com")], [], "x.md")).toEqual({
      kind: "resolved",
      site: { name: "https://a.example.com", url: "https://a.example.com", token: "", mcpToken: "", default: false },
      source: "single",
    });
  });

  it("多个站点、没有默认、规则也不命中时要求用户选", () => {
    expect(resolveSite([site("https://a.example.com"), site("https://b.example.com")], [], "x.md")).toEqual({
      kind: "needs-choice",
    });
  });

  it("一个站点都没配时给出专门的一档", () => {
    expect(resolveSite([], [], "x.md")).toEqual({ kind: "no-sites" });
  });

  it("站点 URL 比较走 isSameSiteUrl：尾斜杠的差异不算不同", () => {
    expect(resolveSite(sites, [], "x.md", "https://b.example.com/")).toEqual({
      kind: "resolved",
      site: sites[1],
      source: "frontmatter",
    });
  });

  it("空模式被跳过，不会变成「命中一切」", () => {
    const rules = [
      { pattern: "  ", site: "https://b.example.com" },
      { pattern: "**", site: "https://a.example.com" },
    ];

    expect(resolveSite(sites, rules, "x.md")).toEqual({
      kind: "resolved",
      site: sites[0],
      source: "rule",
      pattern: "**",
    });
  });
});
