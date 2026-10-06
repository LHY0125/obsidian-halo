import { beforeAll, describe, expect, it } from "@rstest/core";
import i18next from "i18next";
import { initializeI18n } from "../../src/i18n";
import * as en from "../../src/i18n/locales/en.json";
import * as zhCN from "../../src/i18n/locales/zh-cn.json";
import * as zhTW from "../../src/i18n/locales/zh-tw.json";

/**
 * 全局 i18n 配置的围栏：**插值一律不做 HTML 转义**。
 *
 * 为什么要有这个文件：`interpolation.escapeValue` 是**全局一份**配置，而全局配置可以被
 * 无声地改回去 —— 没有任何一行代码会因为「它变成 true 了」而报错。本计划已经反复证明
 * 「不能被失败地测到的修复」等于没修，所以这条修复必须配一条能变红的围栏。
 *
 * 用**真实的生产入口** `initializeI18n()` 初始化：断言的是它的实际效果，而不是某个
 * options 字面量 —— 后者会与函数体分叉，前者不会。
 *
 * ⚠️ 这条围栏的边界（如实写清，免得被读成比实际更强）：它守的是 `initializeI18n` 是否
 * 关掉了转义。**「`main.ts` 是否仍然调用它」观察不到** —— 唯一的生产调用点在 `onload()`
 * 里，而 `onload()` 在测试脚手架里跑不起来（`src/icons.ts` 要 `addIcon`，`tests/setup.ts`
 * 的 obsidian mock 没有它）。那一层只能靠代码审查。真要在测试里堵死，得给 mock 补 `addIcon`
 * 并接受「i18n 围栏被 onload 的无关依赖拖垮」的脆弱性 —— 本阶段判定不值当。
 */
beforeAll(async () => {
  await initializeI18n("en");
});

describe("全局 i18n 配置：插值不做 HTML 转义", () => {
  /**
   * 表驱动，而不是只钉 I-1 那一个键。
   *
   * 这个缺陷类在本计划里现身过 6 次（预览弹窗的路由 pattern、frontmatter 原始值、
   * 用户打的分类标签名、远端服务端自报的名字、本地图片文件名……）。**逐点打补丁挡不住
   * 下一个调用点**，所以围栏也要盖住「同一类里的其它点」，而不只是最后一个被发现的。
   *
   * 三个键分别代表：本次新增的（预览）、既有的提示文案（路由/分类标签）。
   */
  const cases = [
    {
      label: "预览弹窗的目标站点行（I-1，本次新增）",
      key: "publish_preview.site_from_rule",
      params: { pattern: "博客/**" },
      literal: "博客/**",
    },
    {
      label: "路由规则指向未知站点的提示（既有调用点）",
      key: "service.error_unknown_rule_site",
      params: { pattern: "博客/**", url: "https://blog.example.com" },
      literal: "https://blog.example.com",
    },
    {
      label: "分类/标签未能应用的提示（既有调用点）",
      key: "service.error_term_not_applied",
      params: { name: "技术/前端" },
      literal: "技术/前端",
    },
  ];

  for (const { label, key, params, literal } of cases) {
    it(`${label}：${literal} 原样显示，不是 &#x2F;`, () => {
      const out = i18next.t(key, params);

      // ① 命名症状的那一条放在**最前**：转义一开（`escapeValue` 被改回 true，或这行配置被删），
      //    红的就是它，而失败信息直接指出 `&#x2F;` —— 而不是「本该包含某个字面量、实际没有」，
      //    后者要读的人自己反推「为什么没有」。i18next 的转义表连 `/` 也转，而 `/` 在路径、
      //    URL、glob 模式里到处都是，所以这条判据覆盖面很宽。
      expect(out).not.toContain("&#x2F;");

      // ② 反空洞的伴随断言：值**真的**被插进来了。
      //
      // 没有它时，一个「键丢了」或「参数名写错」的实现在 ① 上**也是绿的** ——
      // 因为那时 `out` 就是键名本身（或一段没插值的文案），里面既没有 `&#x2F;`、也没有那个值。
      // 这与 Task 8 那两条「零写入」判别器旁边的反空洞守卫是同一个道理：
      // **「断言某件事没有发生」需要一条「证明它本来可以发生」的伴随断言。**
      //
      // 两条断言各自可独立变红（① 由转义回归触发，② 由键名/参数名错触发），
      // 不是同一件事写两遍。
      expect(out).toContain(literal);
    });
  }

  it("HTML 特殊字符同样不被转义（既然输出一律按纯文本渲染）", () => {
    // 这一条盖住的是**整类**而不是 `/` 一个字符：`mcp-self-check` 的既有用例正是被
    // `&lt;!doctype` 咬过。输出按纯文本渲染时，`<` 变成 `&lt;` 只让用户读到实体名。
    const out = i18next.t("publish_preview.site_from_rule", { pattern: "<博客/>" });

    expect(out).toContain("<博客/>");
    expect(out).not.toContain("&lt;");
  });
});

/**
 * 三语 locale 的键集必须完全相同 —— 这是 i18n 的**结构性约束**，不是风格偏好。
 *
 * 为什么要有这条围栏：新增文案时只往 `en.json` 加键、忘了另两份，表现是**切到那个语言时
 * 界面显示原始键名**（`i18next.t()` 找不到键就把键名原样返回），而**全套测试会全绿** ——
 * 没有任何一行代码会因为「某个键只存在于一份文件里」而报错。
 * 本计划此前每个任务都跑一遍手工脚本数键数，那不是防线，是**记得去数**。
 *
 * 直接 import 三个 locale 文件，而不是用 `src/i18n/index.ts` 的 `resources`：
 * `resources` 是**派生视图**（由 `index.ts` 把文件绑到 i18next 的语言名上）。那里一旦绑错
 * （例如复制粘贴成 `en: { translation: zhCN }`），基于 `resources` 的比较会把一份文件与
 * 它自己比，**键集必然相等、测试变绿**，而生产环境已经坏了。本围栏要守的约束是
 * 「三个**文件**的键集相同」，所以直接量文件本身；失败信息也因此能给出要改的文件路径。
 * 已知边界：这条测不到「某个文件没被注册进 `resources`」—— 那是另一个缺陷。它的反方向
 * 由本文件上面那组用例覆盖：那里走真实入口 `initializeI18n()`，证明 `en` 的键真的能解析。
 */
describe("三语 locale 的键集完全相同", () => {
  /** 把嵌套的 locale JSON 摊平成点号路径（如 `command.publish.name`）。 */
  function flattenKeys(value: unknown, prefix = ""): string[] {
    if (value === null || typeof value !== "object") {
      return prefix ? [prefix] : [];
    }
    const out: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(...flattenKeys(child, prefix ? `${prefix}.${key}` : key));
    }
    return out;
  }

  /**
   * 剥掉 JSON 模块的互操作外壳，取到 locale 的**真实顶层对象**。
   *
   * 实测（`import * as x from "./x.json"` 在 rstest 下）：命名空间形如
   * `{ ...顶层键, default: <整个 JSON> }` —— 每个顶层键各是一条具名导出，外加一个 `default`。
   * 不剥掉 `default`，摊平后每条键路径都会被数两遍（一次经具名导出、一次经 `default` 里的
   * 整份 JSON），于是失败信息里的计数是真实值的**两倍** —— 一个「看起来在工作」的假数字。
   * 另一种打包器给的形状是只有 `default` 一项（`{ default: <整个 JSON> }`），一并处理。
   *
   * ⚠️ **这里刻意不写任何具体数字。** 此前写的两个数字都错：一个把**叶子键数**当成了
   * 顶层键数（顶层键只有二十来个），另一个是它的两倍。而数字本来就不是这条注释要传达的东西 ——
   * 「有一个 `default` 要剥」才是；写进来的数字只会随着下一次加键再错一遍。
   */
  function localeObject(moduleNamespace: unknown): Record<string, unknown> {
    const ns = (moduleNamespace ?? {}) as Record<string, unknown>;
    // 形状 A：`{ ...顶层键, default: <整个 JSON> }` —— 除 `default` 之外的顶层键就是真实内容。
    // 用 filter 而不是 `delete ns.default`：`delete` 触 lint/performance/noDelete，而 biome 给的
    // 「unsafe fix」（改成 `= undefined`）是**错的** —— 键还在，`Object.keys` 照样数得到它。
    const withoutInterop = Object.fromEntries(Object.entries(ns).filter(([key]) => key !== "default"));
    if (Object.keys(withoutInterop).length > 0) {
      return withoutInterop;
    }
    // 形状 B：整份 JSON 都挂在 `default` 上
    const wrapped = ns.default;
    return (wrapped && typeof wrapped === "object" ? wrapped : {}) as Record<string, unknown>;
  }

  const locales: [string, unknown][] = [
    ["en", en],
    ["zh-cn", zhCN],
    ["zh-tw", zhTW],
  ];
  const keySets = new Map(locales.map(([name, mod]) => [name, flattenKeys(localeObject(mod))]));

  it("三个文件的键集逐键相同，且不一致时逐条报出缺/多的是哪些键", () => {
    const baseline = "en";
    const baseKeys = keySets.get(baseline) as string[];

    // ① 反空洞的伴随断言：读不到东西时，下面那条「三者互等」会以
    //    「三个空集互相相等」的形式变绿 —— 那不是通过，是没读到。用一个必定存在的键当探针：
    //    它一丢，说明读到的不是 locale 的顶层键（例如拿到的是互操作外壳而不是内容）。
    expect(baseKeys, "读不到 en 的 locale 内容，键集断言会失去意义").toContain("command.publish.name");

    // ② 主断言。把差异拼成一段**能直接指向原因**的文本，而不是一个「209 ≠ 208」的数字：
    //    那个数字只说明不等，读的人还得自己去两份文件里找是哪个键。
    //    每一条都带文件名 + 方向（缺/多）+ 键名。
    const differences: string[] = [];
    for (const [name, keys] of keySets) {
      if (name === baseline) continue;
      const file = `src/i18n/locales/${name}.json`;
      const missing = baseKeys.filter((k) => !keys.includes(k)).sort();
      const extra = keys.filter((k) => !baseKeys.includes(k)).sort();
      if (missing.length > 0) {
        differences.push(`${file} 比 ${baseline} 少 ${missing.length} 个键：${missing.join(", ")}`);
      }
      if (extra.length > 0) {
        differences.push(`${file} 比 ${baseline} 多 ${extra.length} 个键：${extra.join(", ")}`);
      }
    }

    const counts = [...keySets].map(([name, keys]) => `${name}=${keys.length}`).join(" / ");
    const report =
      differences.length === 0
        ? ""
        : [
            `三语 locale 的键集不一致（${counts}）：`,
            ...differences.map((line) => `  · ${line}`),
            "修法：三份 src/i18n/locales/*.json 必须同步增删键，否则切到缺键的那个语言时界面会显示原始键名。",
          ].join("\n");

    expect(report).toBe("");
  });
});
