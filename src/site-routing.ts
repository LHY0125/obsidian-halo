import { type SiteRoutingRule, matchGlob, normalizeRulePattern } from "./glob";
import { type HaloSite, isSameSiteUrl, normalizeSiteUrl } from "./settings";

// 调用方（settings.ts 的设置面板、site-routing-modal.ts、main.ts、测试）只需认
// "src/site-routing" 一个入口。glob.ts 是内部实现细节，将来要换匹配算法只动那一处。
export { type SiteRoutingRule, matchGlob, normalizeRulePattern } from "./glob";

/**
 * 站点解析的结果。
 *
 * 刻意做成**带 kind 的联合**而不是 `HaloSite | undefined`：批量操作必须能分辨
 * 「这篇没有可用站点」的**具体原因**并逐条告诉用户，而 `undefined` 把这些原因全揉成了一团。
 * 这也是本阶段反复出现的那条立场 —— 失败要说得出是哪种失败。
 */
export type SiteResolution =
  | { kind: "resolved"; site: HaloSite; source: "frontmatter" | "rule" | "default" | "single"; pattern?: string }
  | { kind: "needs-choice" }
  | { kind: "no-sites" }
  | { kind: "unknown-site"; url: string }
  | { kind: "unknown-rule-site"; url: string; pattern: string };

/**
 * 决定一篇笔记发布到哪个站点。
 *
 * 优先级（用户 2026-10-03 裁定，与 `CLAUDE.md` 一直写着的那条一致）：
 * frontmatter 的 `halo.site` → 规则表自上而下首个命中 → 设置里的默认站点 → 唯一站点 → 让用户选。
 *
 * 两处「报错而不是继续往下找」是刻意的：`unknown-site` / `unknown-rule-site` 都表示
 * **用户的配置有问题**，而这两种情况下继续往下找的后果是把笔记发到**另一个站**上 ——
 * 那是不可恢复的（可能已在目标站建了同名文章），而报错只是让他去改一行配置。
 */
export function resolveSite(
  sites: HaloSite[],
  rules: SiteRoutingRule[],
  filePath: string,
  frontmatterUrl?: string,
): SiteResolution {
  if (sites.length === 0) {
    return { kind: "no-sites" };
  }

  if (frontmatterUrl) {
    const matched = sites.find((site) => isSameSiteUrl(site.url, frontmatterUrl));

    return matched
      ? { kind: "resolved", site: matched, source: "frontmatter" }
      : { kind: "unknown-site", url: frontmatterUrl };
  }

  for (const rule of rules) {
    if (!matchGlob(rule.pattern, filePath)) {
      continue;
    }

    const target = normalizeSiteUrl(rule.site);
    const matched = sites.find((site) => isSameSiteUrl(site.url, target));

    // 首个命中的规则指向一个已经不存在的站点 → 停下报错，不继续往下找（理由见函数注释）
    return matched
      ? { kind: "resolved", site: matched, source: "rule", pattern: normalizeRulePattern(rule.pattern) }
      : { kind: "unknown-rule-site", url: target, pattern: normalizeRulePattern(rule.pattern) };
  }

  const defaultSite = sites.find((site) => site.default);

  if (defaultSite) {
    return { kind: "resolved", site: defaultSite, source: "default" };
  }

  if (sites.length === 1) {
    return { kind: "resolved", site: sites[0], source: "single" };
  }

  return { kind: "needs-choice" };
}
