import { describe, expect, it } from "@rstest/core";
import { matchGlob, normalizeRulePattern, resolveSite } from "../../src/core/site-routing";
import type { HaloSite } from "../../src/settings";

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

  it("`?` 只吃一个非 `/` 字符，不跨目录分隔符", () => {
    // 守的是实现里的 `[^/]`：若有人把 `?` 简化成正则的 `.`，`博客/?.md` 就会命中 `博客//.md`
    // —— 一个 `?` 悄悄变成「任意字符（含 /）」。表驱动里那两条 `?` 用例拦不住这种退化。
    expect(matchGlob("博客/?.md", "博客//.md")).toBe(false);
  });
});

describe("normalizeRulePattern", () => {
  it("去掉首尾空白与开头的斜杠（用户会写 `/博客/**`）", () => {
    expect(normalizeRulePattern("  /博客/**  ")).toBe("博客/**");
  });

  it("反斜杠分隔符换成斜杠（vault 路径永远是斜杠，但用户从资源管理器复制来的是反斜杠）", () => {
    expect(normalizeRulePattern("博客\\**")).toBe("博客/**");
  });

  it.each([
    // [用户实际会敲出来的写法, 期望归一化结果]
    ["./博客/**", "博客/**"], // 编辑器「复制相对路径」与 `ls` 输出都带这个前缀
    [".\\博客\\**", "博客/**"], // 前缀与分隔符同时是 Windows 形态
  ])("%s 归一化后是 %s，且真的能命中 博客/a.md", (input, expected) => {
    expect(normalizeRulePattern(input)).toBe(expected);
    // 只断言归一化字符串还不够：本用例守的其实是「规则真的命中」这个结局。
    // 一条只把 `./` 删掉却没接上匹配的退化实现，也不该通过。
    expect(matchGlob(input, "博客/a.md")).toBe(true);
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

  it("frontmatter 写了空串也算「写了」：报错，不当作没写而改道", () => {
    // 空串是用户**显式**写下的值（模板/变量没展开时很常见）。若用真假判断读它，这篇会被判成
    // 「没写 frontmatter」，转而落到下面那条 `**` 规则指向的站点上 —— 一个与 frontmatter
    // 毫无关系的站点，且不可恢复。所以期望值刻意是 unknown-site，而不是任何 resolved。
    expect(resolveSite(sites, [{ pattern: "**", site: "https://a.example.com" }], "x.md", "")).toEqual({
      kind: "unknown-site",
      url: "",
    });
  });

  it("unknown-site 报的是归一化后的 URL，与 unknown-rule-site 形态一致", () => {
    // 两档错误同类同形，否则将来拼提示文案会出现「一个带尾斜杠、一个不带」的不一致。
    expect(resolveSite(sites, [], "x.md", "https://c.example.com///")).toEqual({
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
