import type { LocalImageSummary } from "../../service/image-upload";

export interface PublishPreviewInput {
  siteName: string;
  siteUrl: string;
  /**
   * 站点是怎么定下来的。比 `SiteResolution["source"]` 多一档 `"picked"` ——
   * 用户在站点选择弹窗里手动点的那个，`resolveSite` 并不知道（它只负责说「需要用户选」）。
   * 预览上把「默认站点」写成「唯一站点」会让人以为配置变了，所以这一档必须分出来。
   */
  siteSource: "frontmatter" | "rule" | "default" | "single" | "picked";
  sitePattern?: string;
  title: string;
  slug: string;
  raw: string;
  /** 最终生效的 spec（`applyPostFrontmatter` + 服务端回读之后）—— 只取其中 6 个字段 */
  spec: Record<string, unknown>;
  newCategories: string[];
  newTags: string[];
  images: LocalImageSummary;
}

export interface PublishPreview {
  site: { name: string; url: string; source: PublishPreviewInput["siteSource"]; pattern?: string };
  title: string;
  slug: string;
  visible: string;
  pinned: boolean;
  priority: number;
  publishTime: string;
  allowComment: boolean;
  template: string;
  /** frontmatter **之后**那部分的字符数 */
  characterCount: number;
  newCategories: string[];
  newTags: string[];
  images: LocalImageSummary;
}

/**
 * 把「即将发布什么」摊平成一块可以在弹窗里逐行渲染的数据。
 *
 * 抽成纯函数是因为**弹窗本身没有测试脚手架**（`tests/setup.ts` 里的 `Modal` 是空壳，
 * 本阶段不新建 UI mock 基建）。凡是能在弹窗外面算出来的东西都算出来，
 * 弹窗里就只剩 `createEl` —— 那部分出错的风险靠 CR 覆盖即可。
 */
export function buildPublishPreview(input: PublishPreviewInput): PublishPreview {
  const spec = input.spec;

  return {
    site: {
      name: input.siteName,
      url: input.siteUrl,
      source: input.siteSource,
      pattern: input.sitePattern,
    },
    title: input.title,
    slug: input.slug,
    visible: String(spec.visible ?? ""),
    pinned: spec.pinned === true,
    priority: typeof spec.priority === "number" ? spec.priority : 0,
    publishTime: String(spec.publishTime ?? ""),
    allowComment: spec.allowComment !== false,
    template: String(spec.template ?? ""),
    // 按 `raw` 算，不按含 frontmatter 的全文算：否则这个数字会随无关的配置项抖动
    characterCount: input.raw.length,
    newCategories: input.newCategories,
    newTags: input.newTags,
    images: input.images,
  };
}
