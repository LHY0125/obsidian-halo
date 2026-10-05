import type { SinglePage } from "@halo-dev/api-client";
import type { McpContentItemBase } from "./post-mapping";

/**
 * 独立页面的**扁平**表示。
 *
 * 字段逐字取自 2026-10-05 对真实站点 `tools/list` 的核对（`halo-mcp-server` 1.2.0）：
 * `halo_list_single_pages` / `halo_get_single_page` / `halo_create_single_page` /
 * `halo_update_single_page` 的 outputSchema.properties 列的是同一套。
 *
 * **页面比文章少 9 个字段**：`categories` / `tags` / `pinned` / `priority` / `publishTime` /
 * `template` / `cover` / `autoGenerateExcerpt` / `excerptRaw`。这不是「服务端没回」，
 * 是**页面这个资源本来就没有这些概念** —— 所以本类型里一个都不能有，
 * 有的话 `toSinglePage` 会把它映射进 `spec`，而 `toPageUpdateArgs` 又会把它传回服务端，
 * 被 `additionalProperties: false` 拒绝。
 *
 * 与 `McpPostItem` 一样**只声明服务层真正消费的字段**：多声明就是一份要跟着服务端走的契约。
 */
export interface McpSinglePageItem extends McpContentItemBase {
  headSnapshot?: string;
  releaseSnapshot?: string;
  baseSnapshot?: string;
  version?: number;
  creationTimestamp?: string;
  updateTimestamp?: string;
}

export interface McpGetSinglePageResult {
  item: McpSinglePageItem;
  content: { snapshotName?: string | null; rawType?: string | null; raw?: string | null };
  /** ⚠️ 服务端可能截断长正文；为 true 时绝不能把内容当完整页面使用 */
  truncated?: boolean;
}

/**
 * 把 MCP 的扁平页面表示还原成领域模型 `SinglePage`，让既有消费点无需改动。
 *
 * **只填页面真有的字段** —— 与 `toPost` 的关键差别就在这里：`toPost` 会把 9 个文章字段
 * 全部填上（缺的用默认值），而页面填了就会被 `toPageUpdateArgs` 传出去、被 schema 拒绝。
 * 所以这里**不补任何文章独有的字段**。
 */
export function toSinglePage(item: McpSinglePageItem): SinglePage {
  return {
    apiVersion: "content.halo.run/v1alpha1",
    kind: "SinglePage",
    metadata: { name: item.name ?? "", annotations: {} },
    spec: {
      title: item.title ?? "",
      slug: item.slug ?? "",
      visible: item.visible ?? "PUBLIC",
      // 与 `toPost` 同一条理由：必须取 `publishRequested`，不能取 `published`，
      // 也不能写死 false —— 回写会把它写进 `frontmatter.halo.publish`，而下次发布读它决定
      // 要不要调发布状态工具。恒为 false 会让「发布一次」变成「把已发布的页面撤回草稿」。
      publish: item.publishRequested ?? false,
      excerpt: {
        autoGenerate: true,
        raw: item.excerpt ?? "",
      },
    },
  } as SinglePage;
}

/**
 * 把领域模型投影成 `halo_create_single_page` 的入参。
 *
 * **我们发出 8 个键，逐个都在 schema 的 properties 里**（schema 是 `additionalProperties: false`，
 * 多传一个 schema 不认的键会被服务端拒绝）。实测 `required: ["name","title","raw"]`。
 *
 * ⚠️ 这**不是** schema 的键全集：`halo_create_single_page` 的 properties 有 9 个
 * （`name / title / slug / raw / content / rawType / publish / visible / allowComment`）。
 * 少的那一个是 `content` —— **刻意不传**，交给服务端按 `raw` 生成，与文章路径 `toCreateArgs` 同款。
 * `publish` 则**必须传**：它是本工具与 `halo_update_single_page` 的唯一入参差异
 * （update 没有这个键），而 schema 的默认值正是 `false`，漏传会让「一次调用建好已发布的页面」
 * 这条能力静默消失（表面行为不变，因为后面还有一次 set_publish_state 兜着）。
 *
 * `rawType` 必须显式传 `"markdown"`：schema 的默认值是 **`"html"`**，漏传会把 Markdown
 * 当 HTML 存，站点渲染错乱而本地看不出任何异常 —— 与文章那条硬约束同源。
 */
export function toPageCreateArgs(page: SinglePage, raw: string): Record<string, unknown> {
  return {
    ...toPageUpdateArgs(page, raw),
    // 新建时默认推草稿；是否发布由随后的 set_single_page_publish_state 决定
    publish: false,
  };
}

/** 把领域模型投影成 `halo_update_single_page` 的入参。注意该工具**没有** `publish`。 */
export function toPageUpdateArgs(page: SinglePage, raw: string): Record<string, unknown> {
  return {
    name: page.metadata.name,
    title: page.spec.title,
    // `|| undefined` 而不是空串：schema 的 `slug` 有 `minLength: 1`，空串会被拒绝。
    // 传 `undefined` 时 JSON.stringify 会**整个丢掉这个键**，服务端就用它自己的默认值。
    slug: page.spec.slug || undefined,
    raw,
    rawType: "markdown",
    visible: page.spec.visible,
    // 写死 true 是刻意的：页面的 `spec` 上没有这个字段（MCP 的 `halo_create_single_page`
    // 收它，但 `halo_get_single_page` 不回它），所以本地无从得知远端值。
    // **不要**把它做成 frontmatter 可配的 —— 那会引入一个「读不回来」的字段，
    // 而 1-B 的教训正是「写出去读不回来的字段会静默漂移」。
    allowComment: true,
  };
}
