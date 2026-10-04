import { beforeAll, describe, expect, it } from "@rstest/core";
import i18next from "i18next";
import { initializeI18n } from "../../src/i18n";

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
