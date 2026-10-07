import type { Content, Post } from "@halo-dev/api-client";

/**
 * 文章与独立页面**共有**的扁平字段。抽出来是因为两种类型的差异只在
 * 「多/少哪几个字段」，而 `name` / `title` / `slug` / `published` / `publishRequested` /
 * `recycled` / `visible` / `permalink` 这一批是逐字相同的。
 *
 * 不抽的话，`page-mapping.ts` 会把它们再抄一遍 —— 而两份声明必然在某次服务端改动后分叉，
 * 表现是「文章读得到、页面读不到」。
 *
 * ⚠️ 两条 `required` 契约**不同**，别把这里当成一份完整契约：
 * `halo_list_posts` 的 item required 是 `["published","publishRequested","recycled","categories","tags"]`，
 * 而 `halo_list_single_pages` 的是 `["published","publishRequested","recycled"]`（没有 categories/tags）。
 */
export interface McpContentItemBase {
  name?: string;
  title?: string;
  slug?: string;
  excerpt?: string;
  /**
   * 此刻是否真的在线（受 `publishTime` / 回收站影响）。
   *
   * 声明它**是为了说明这里刻意不用它**：两种类型的映射（`toPost` / `toSinglePage`）
   * 都必须取 `publishRequested`。它也确实会出现在返回体里，删掉声明只会让 fixture 与真实响应失真。
   */
  published?: boolean;
  /**
   * 用户是否**要求**发布 —— 对应 REST 的 `spec.publish`。
   *
   * 服务端同时给出 `published`，但两者不是一回事：`published` 是「此刻是否真的在线」，
   * 还要受 `publishTime`（定时发布）与回收站影响。取 `published` 会把一篇定时文章判成未发布。
   */
  publishRequested?: boolean;
  recycled?: boolean;
  visible?: "PUBLIC" | "INTERNAL" | "PRIVATE";
  permalink?: string;
}

/**
 * MCP 的文章表示是**扁平**的，与 REST 的 {metadata, spec} 嵌套不同。
 *
 * 字段取自 `halo_get_post` 的 outputSchema（实测 2026-10-04 对真实站点 `tools/list` 核对），
 * 服务端声明的属性为：
 * `name / title / slug / excerpt / excerptRaw / autoGenerateExcerpt / cover / template /
 * pinned / priority / publishTime / allowComment / published / publishRequested / recycled /
 * visible / owner / categories / tags / permalink / headSnapshot / releaseSnapshot /
 * baseSnapshot / version / creationTimestamp / updateTimestamp`，
 * 其中 required 是 `published / publishRequested / recycled / categories / tags`。
 *
 * 这里刻意不追求覆盖全部字段：**只声明服务层真正消费的那些**，其余留在服务端。
 * 多声明的字段会变成一份需要跟着服务端走的契约，而服务层并不读它。
 *
 * 与页面共有的那一批（`name` / `title` / `slug` / `excerpt` / `published` / `publishRequested` /
 * `recycled` / `visible` / `permalink`）见 `McpContentItemBase`，此处不再重复声明 ——
 * 重复声明就是两份会各自漂移的契约。
 */
export interface McpPostItem extends McpContentItemBase {
  excerptRaw?: string;
  autoGenerateExcerpt?: boolean;
  cover?: string;
  template?: string;
  pinned?: boolean;
  priority?: number;
  publishTime?: string;
  allowComment?: boolean;
  categories?: string[];
  tags?: string[];
}

/** MCP 的分类表示同样是扁平的（实测 `halo_list_categories` 的 outputSchema） */
export interface McpCategoryItem {
  name: string;
  displayName: string;
  slug?: string;
  priority?: number;
}

export interface McpTagItem {
  name: string;
  displayName: string;
  slug?: string;
}

export interface McpGetPostResult {
  item: McpPostItem;
  content: { snapshotName?: string | null; rawType?: string | null; raw?: string | null };
  /** ⚠️ 服务端可能截断长正文；为 true 时绝不能把内容当完整文章使用 */
  truncated?: boolean;
}

/** 把 MCP 的扁平文章表示还原成领域模型 Post，让既有消费点无需改动 */
export function toPost(item: McpPostItem): Post {
  return {
    apiVersion: "content.halo.run/v1alpha1",
    kind: "Post",
    metadata: { name: item.name ?? "", annotations: {} },
    spec: {
      title: item.title ?? "",
      slug: item.slug ?? "",
      cover: item.cover ?? "",
      template: item.template ?? "",
      pinned: item.pinned ?? false,
      priority: item.priority ?? 0,
      publishTime: item.publishTime ?? "",
      allowComment: item.allowComment ?? true,
      visible: item.visible ?? "PUBLIC",
      // 必须映射真实值，**不能写死 false**：`publishPost` / `updatePost` / `pullPost`
      // 都会把 `params.spec.publish` 回写进 `frontmatter.halo.publish`，而下次发布正是
      // 读它决定要不要调 `halo_set_post_publish_state`。恒为 false 会让「发布一次」
      // 变成「把已发布的文章撤回草稿」—— 而本地看不出任何异常。
      publish: item.publishRequested ?? false,
      excerpt: {
        autoGenerate: item.autoGenerateExcerpt ?? true,
        // autoGenerate 时 raw 交给服务端生成，本地留空
        raw: item.autoGenerateExcerpt ? "" : (item.excerptRaw ?? item.excerpt ?? ""),
      },
      categories: item.categories ?? [],
      tags: item.tags ?? [],
      htmlMetas: [],
      // `deleted` 是 `PostSpec` 的**必填**字段，而 MCP 的扁平表示里没有它 ——
      // 写死 `false` 是刻意的，不是偷懒：能走到这里的文章都是 `halo_get_post` 读回来的，
      // 而回收站里的文章读不到（要读得先 `halo_restore_post`）。所以「读到即未删除」。
      //
      // ⚠️ 之前这里**整个漏了这个键**，而 `as Post` 断言把类型检查挡住了 ——
      // 与 `createEmptyPost()` 逐键对比才看出来（那份字面量有 `deleted: false`）。
      // 两个构造同一类型的函数给出不一致的键集，是真缺陷而不是风格问题。
      deleted: false,
    },
  };
}

/**
 * 把 MCP 的正文负载还原成领域模型 Content。
 *
 * `content` 字段留空：上游填的是 draft 快照注解里的**已渲染 HTML**，而 `halo_get_post`
 * 用 `format: "RAW"` 只取原文。服务层只消费 `raw`（见 `updatePost` / `pullPost`），
 * 客户端渲染的那份 HTML 本来也不是读者看到的页面（见 spec F1）。
 */
export function toContent(content: McpGetPostResult["content"]): Content {
  return {
    content: "",
    raw: content.raw ?? "",
    rawType: content.rawType ?? "markdown",
  };
}

/**
 * 生成 Halo 风格的资源 `name`：前缀 + 8 位小写字母数字，与站点现存数据
 * （`category-sc9pomuo` / `tag-tnpxywrp`）同形。36^8 ≈ 2.8e12，撞名概率可忽略。
 *
 * 为什么在客户端造：REST 有 `metadata.generateName` 让服务端造 name，**MCP 没有等价物** ——
 * `halo_create_category` / `halo_create_tag` 的 inputSchema 里 `name` 是 required。
 *
 * 用 `crypto.getRandomValues` 而非 `Math.random`：这个 name 是服务端的唯一标识，
 * 撞名会被服务端拒绝；CSPRNG 成本为零且不依赖引擎自身的 PRNG 质量。
 * 注意它**不是机密** —— 不参与任何鉴权（授权来自 `mcpToken`），也不出现在公开 URL 里
 * （分类 permalink 用的是 `slug`）。这一改动是为了「唯一」，不是为了「不可预测」。
 *
 * 用拒绝采样而非 `byte % 36`：256 不是 36 的整数倍，取模会让字母表前 4 个字符偏多。
 */
export function generateResourceName(prefix: "category" | "tag"): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  // 252 = 7 × 36，故 0..251 能均匀映射到 36 个字符；其余字节（252..255）丢弃
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  const bytes = new Uint8Array(8);
  let suffix = "";

  while (suffix.length < 8) {
    crypto.getRandomValues(bytes);

    for (const byte of bytes) {
      if (byte >= limit) {
        continue;
      }

      suffix += alphabet[byte % alphabet.length];

      if (suffix.length === 8) {
        break;
      }
    }
  }

  return `${prefix}-${suffix}`;
}

/**
 * 从「期望的显示名」里挑出站点上还没有的那些。
 *
 * 判等用 `displayName` 精确匹配，**与 `getCategoryNames()` / `getTagNames()` 创建时的判等
 * 必须是同一套**：两处判等一分叉，就会出现「预览说将新建、执行时又不建」或反过来，
 * 而用户在预览里刚为它做过决定。所以这一份实现同时服务预览、执行路径与批量确认。
 *
 * 刻意**不去重**：它是个过滤器，去重是调用方对"并集"的处置（批量路径要先去重再传进来）。
 * 在过滤器里偷偷去重会让调用方失去对顺序与重复的控制。
 */
export function pickNewTerms(desired: string[] | undefined, existing: { displayName: string }[]): string[] {
  if (!desired) {
    return [];
  }

  return desired.filter((name) => !existing.some((item) => item.displayName === name));
}
