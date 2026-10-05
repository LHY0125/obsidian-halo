import type { SinglePage } from "@halo-dev/api-client";
import type { TFile } from "obsidian";
import { slugify } from "transliteration";
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

/**
 * 独立页面认得的**前言**字段。
 *
 * `halo` 下只有这三个键。1-B 为文章开放的 6 个元数据字段（`visible` / `pinned` / `priority` /
 * `publishTime` / `allowComment` / `template`）对页面**没有意义** —— 写了也不报错，只是被忽略。
 * 这是刻意的：`halo_update_single_page` 的入参里**根本没有**它们，为它们造一层校验只会让用户
 * 以为自己写下的值生效了，而站点上什么都没变。
 *
 * `excerpt` / `cover` / `categories` / `tags` 同样不在**读取**侧：页面一件都发不出去
 * （`toPageUpdateArgs` 的 7 个键里没有它们）。收进来就是一份「写了也不会有结果」的配置。
 */
export interface HaloPageFrontmatter {
  title?: string;
  slug?: string;
  halo?: {
    site?: string;
    name?: string;
    publish?: boolean;
  };
}

export interface ApplyPageFrontmatterOptions {
  activeFile: TFile;
  matterData?: HaloPageFrontmatter;
  useActiveFileDefaults: boolean;
}

/**
 * 把本地笔记的前言套到一个页面上（读方向 / 建 spec）。
 *
 * **只处理 `title` 与 `slug`**，而且刻意**不复用** `local-content.ts` 的
 * `applyPostFrontmatter()`：两者管的不是同一件事 —— 文章那份要展开 6 个元数据字段、要挑分类
 * 标签、要处理 `cover` 与 `excerpt`，页面一件都不需要。把文章那份改成泛型再传一个
 * 「页面时请传 `undefined`」的参数，就是用**一个恒为 undefined 的开关**去表达
 * 「这两种内容不一样」，而那个参数一旦哪天被传了真值，症状是发布时才出现的。
 *
 * 两条回落与文章路径一致：`useActiveFileDefaults` 为真（＝这次是**新建**）时，缺 `title` 用文件名、
 * 缺 `slug` 用 title 的拼音；为假（＝这次更新一个已存在的页面）时，缺的字段**保留远端值** ——
 * 本地没写不等于要把远端清空。
 */
export function applyPageFrontmatter(page: SinglePage, options: ApplyPageFrontmatterOptions): SinglePage {
  const { activeFile, matterData, useActiveFileDefaults } = options;
  const nextPage: SinglePage = {
    ...page,
    metadata: {
      ...page.metadata,
      annotations: {
        ...page.metadata.annotations,
      },
    },
    spec: {
      ...page.spec,
      excerpt: {
        ...page.spec.excerpt,
      },
    },
  };

  if (matterData?.title) {
    nextPage.spec.title = matterData.title;
  } else if (useActiveFileDefaults) {
    nextPage.spec.title = activeFile.basename;
  }

  if (matterData?.slug) {
    nextPage.spec.slug = matterData.slug;
  } else if (useActiveFileDefaults) {
    nextPage.spec.slug = slugify(nextPage.spec.title, { trim: true });
  }

  return nextPage;
}

export interface PageToFrontmatterOptions {
  /** 写入 `halo.site` 的站点 URL */
  siteUrl: string;
  /**
   * 写入 `halo.name` 的值。**必须由调用方显式给**，理由与 `PostToFrontmatterOptions.name`
   * 逐字相同：服务端可能不回 `name`（`toSinglePage()` 会把缺的填成空串），照搬回读结果会把
   * `halo.name` 写成 `""` —— 下次推送读不到它，于是**再建一个重复页面**，而用户看到的是「推送成功」。
   */
  name: string;
}

/**
 * 把一个（服务端归一化之后的）页面回写进前言（写方向）。
 *
 * **三键的 `halo` 块**，与 `applyPostToFrontmatter()` 的九键是**两个契约**而不是一个：
 * `SinglePage.spec` 上没有 `cover` / `pinned` / `priority` / `publishTime` / `template`，
 * 借文章那份来写会往每一篇页面笔记里塞进 **5 个 `undefined`**（`cover` 与 halo 里的四项）。
 * 「一个函数写两份契约」正是本阶段要消灭的分叉：改文章的契约会静默改掉页面的行为。
 *
 * 取值一律来自 `page.spec`（服务端回读之后的产物），**不来自 `matterData` 或本地字面量** ——
 * 从本地字面量回写会把**陈旧值**写进前言，下次推送据此静默改掉远端状态（1-A 的 I1）。
 */
export function applyPageToFrontmatter(
  frontmatter: Record<string, unknown>,
  page: SinglePage,
  options: PageToFrontmatterOptions,
): void {
  frontmatter.title = page.spec.title;
  frontmatter.slug = page.spec.slug;
  // 与文章路径同一条判据（`autoGenerate` 为真说明摘要由服务端生成，本地不钉一个值）。
  // 页面这条今天**恒为「不钉」**：`toSinglePage()` 永远给 `autoGenerate: true`
  //（MCP 的页面项没有 `autoGenerateExcerpt` 字段）。保留它而不是写死，是因为
  // 页面根本没有 excerpt 入参 —— 写成空串会抹掉用户本地写的摘要，而那个摘要发不出去。
  frontmatter.excerpt = page.spec.excerpt.autoGenerate ? undefined : page.spec.excerpt.raw;

  frontmatter.halo = {
    site: options.siteUrl,
    name: options.name,
    publish: page.spec.publish,
  };
}
