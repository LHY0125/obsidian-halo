import i18next from "i18next";
import * as en from "./locales/en.json";
import * as zhCN from "./locales/zh-cn.json";
import * as zhTW from "./locales/zh-tw.json";

export const resources = {
  en: { translation: en },
  "zh-CN": { translation: zhCN },
  "zh-TW": { translation: zhTW },
} as const;

/**
 * 初始化 i18next。**生产代码里只有 `main.ts` 的 `onload` 该调用它。**
 *
 * 收成函数、而不是让调用方自己拼一份 options，是因为 `interpolation.escapeValue` 这条设置
 * 必须是**全局唯一一份**（理由见下）。拼在调用点上，就等于给「下次再有人拼一份」留了门 ——
 * 而这类缺陷在本计划里已经反复出现过：**逐点打补丁挡不住下一个调用点**。
 */
export async function initializeI18n(locale: string): Promise<void> {
  await i18next.init({
    lng: locale,
    fallbackLng: "en",
    resources,
    returnNull: false,
    // 全局关掉插值的 HTML 转义。
    //
    // i18next 默认对 `{{var}}` 做 HTML 转义，而它的转义表**连 `/` 也转**。于是凡是插进
    // 用户数据的文案都会变成乱码：路由规则的 pattern `博客/**` 显示成 `博客&#x2F;**`，
    // 本地图片名 `Bob's photo.png`、frontmatter 里的原始值、远端服务端自报的名字……
    // 这些值全都要经过 i18next 插值，而每一处都是用户**看得见**的地方。
    //
    // **关掉转义不损失任何 XSS 防护。** Obsidian 侧一律按**纯文本**渲染本插件产出的一切：
    // `Notice` 收纯文本，`createEl(..., { text })` 与 `Setting.setName/setDesc` 走的都是
    // textContent。全仓 `innerHTML` / `insertAdjacentHTML` / `outerHTML` **零命中**，
    // 没有任何地方把 i18n 的输出当 HTML 解析。所以开着转义只提供乱码，不提供安全。
    //
    // 那两处逐调用点的 `interpolation: { escapeValue: false }`（`main.ts` 的 unknown-rule-site、
    // `mcp-self-check.ts`）自此**已属冗余**。保留无害，因此不去动它们 —— 但它们的存在说明
    // 这个坑被独立踩过两次，这正是要在根上关一次的原因。
    interpolation: { escapeValue: false },
  });
}
