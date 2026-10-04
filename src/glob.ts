/**
 * 一条路由规则：把某类路径的笔记送到某个站点。
 *
 * `site` 存的是**站点 URL**而不是站点名：`halo.site` 用的就是 URL，
 * 两处形态一致才能在 `resolveSite` 里共用 `isSameSiteUrl()` 比较（尾斜杠、大小写都不算差异）。
 */
export interface SiteRoutingRule {
  /** vault 库内相对路径的 glob，如 `博客/**`。支持 `*`（不跨 `/`）、`**`（跨 `/`）、`?`（单个非 `/` 字符） */
  pattern: string;
  site: string;
}

/** 把用户手写的模式规整成库内路径的形态：去空白、去开头斜杠、反斜杠换正斜杠 */
export function normalizeRulePattern(pattern: string): string {
  return pattern.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * glob → 正则。
 *
 * 只认 `*` / `**` / `?` 三个元字符，**其余一律按字面转义**。这样：
 * ① 用户在库里叫 `C++` 的目录能直接用，不会因为 `+` 被当量词而报错或匹配到别的东西；
 * ② 不存在「模式写错导致抛异常」这条路径 —— 编译永远不会失败。
 *
 * 大小写不敏感：用户在 Windows 上看到的目录名与实际大小写未必一致，而**没命中是没有提示的**
 * （规则往下走、最后落到默认站点）。宁可宽松地命中，也不要静默走错站点。
 */
function globToRegExp(pattern: string): RegExp {
  let source = "";

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];

    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index++;

        // `**/` 要能匹配「零层目录」，否则 `**/*.md` 匹配不到库根下的 `a.md` ——
        // 而用户写这个模式时想的显然是「所有笔记」，漏掉根目录是最难发现的错。
        if (pattern[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }

  return new RegExp(`^${source}$`, "i");
}

/** 模式是否匹配某条库内相对路径。空模式恒不匹配（绝不能退化成「命中一切」） */
export function matchGlob(pattern: string, filePath: string): boolean {
  const normalized = normalizeRulePattern(pattern);

  if (normalized === "") {
    return false;
  }

  return globToRegExp(normalized).test(filePath);
}
