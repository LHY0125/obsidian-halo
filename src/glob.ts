/**
 * 路径 glob 匹配 —— 本模块是**零项目内依赖的叶子**。
 *
 * 这条不变式不是洁癖，它存在是为了破一个真的 import 环：`site-routing.ts` 要用 `settings.ts` 的
 * `isSameSiteUrl()`，而 `settings.ts`（设置面板要显示每条规则命中多少篇）又要用本模块的 `matchGlob()`。
 * 一旦把本模块的实现写进 `site-routing.ts`，就成了 `settings.ts ⇄ site-routing.ts` 的**真环**。
 * 环在打包器里未必直接报错，而是在某些 import 顺序下让某个绑定变成 `undefined` ——
 * 本地测试跑得通，发布出去的 `main.js` 才出问题，属于最难反查的一类故障。
 *
 * **往本文件加任何 `import` 之前，先重读上面那段拆分理由**（就在本文件顶部，不另处）。
 * 保持本文件不依赖任何项目内模块，环才是**结构上不可能**，而不只是「目前恰好没出问题」。
 */

/**
 * 一条路由规则：把某类路径的笔记送到某个站点。
 *
 * `site` 存的是**站点 URL**而不是站点名：`halo.site` 用的就是 URL，
 * 两处形态一致才能在 `resolveSite` 里共用 `isSameSiteUrl()` 比较（尾斜杠不算差异）。
 * 注意 `isSameSiteUrl()` 走的是 `normalizeSiteUrl()`，它只做 trim + 去尾斜杠，**大小写敏感**。
 */
export interface SiteRoutingRule {
  /** vault 库内相对路径的 glob，如 `博客/**`。支持 `*`（不跨 `/`）、`**`（跨 `/`）、`?`（单个非 `/` 字符） */
  pattern: string;
  site: string;
}

/**
 * 把用户手写的模式规整成库内路径的形态：去空白、去开头的 `./`、去开头斜杠、反斜杠换正斜杠。
 *
 * 这里刻意把用户**实际会敲出来的**几种写法都收进来，因为漏掉任何一种的后果是同一种：
 * 模式编译出来带上了库内路径里不存在的字面量 → **永远不命中** → 规则静默失效 →
 * 笔记落到默认站点。而「没命中」是没有任何提示的，用户只会觉得规则时灵时不灵。
 * - `\` → `/`：从资源管理器/编辑器复制来的相对路径是反斜杠；
 * - 开头的 `./`：编辑器「复制相对路径」与 `ls` 输出都带这个前缀；
 * - 开头的 `/`：用户会顺手写成 `/博客/**`，把它当"从库根开始"。
 */
export function normalizeRulePattern(pattern: string): string {
  return pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
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

/**
 * 模式是否匹配某条库内相对路径。空模式恒不匹配（绝不能退化成「命中一切」）。
 *
 * @param pattern 用户手写的 glob，`/博客/**`、`.\博客\**` 等形态都行 —— 由 `normalizeRulePattern` 归一化。
 * @param filePath **必须是 `/` 分隔的库内相对路径**（如 `博客/a.md`）。
 *   本函数归一化的是**模式**、**不**归一化**路径**：给错形态既不报错，也不保证不命中。
 *   实测（直载本文件调用 `matchGlob`，反斜杠用 `博客\a.md`）：模式 `博客/*.md` 与 `博客/**`
 *   **漏掉**；而 `**`、`*.md`、`*`，以及 `**` 后接 `/` 再接 `*.md`，都**命中**
 *   —— `*` 与 `?` 编译成的是 `[^/]` 系列、吃得下 `\`；`**` 后接 `/` 时编译出的那一组是
 *   **可选**的，可以不消费任何字符。所以**传反斜杠路径是不可靠的**，调用方必须传 `/` 分隔的路径。
 *
 *   （上面这些模式字符串在注释里刻意拆开写：`**` 紧跟 `/` 会构成块注释的结束符。）
 */
export function matchGlob(pattern: string, filePath: string): boolean {
  const normalized = normalizeRulePattern(pattern);

  if (normalized === "") {
    return false;
  }

  return globToRegExp(normalized).test(filePath);
}
