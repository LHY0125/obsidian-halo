/**
 * 插件支持的两类「内容」。
 *
 * 独立页面与文章在 MCP 上是**两套工具**、字段集也不同（页面没有 categories / tags / pinned /
 * priority / publishTime / template）。但「读远端 → 套 frontmatter → 写 → 回读 → 回写笔记」
 * 这条**编排**是同一件事，所以本模块只描述**差异**，编排层把它当参数收着。
 *
 * ⚠️ **本文件是零项目内依赖的叶子，加任何 `import` 之前先读这段。**
 * 拆出来是为破一个真 import 环：`service/index.ts` 要用它来分派工具名，
 * 而 `service/page-service.ts` 又要用 `service/index.ts` 的编排逻辑。
 * 环在打包器里未必直接报错，而是在某些 import 顺序下让某个绑定变成 `undefined`
 * —— 本地测试跑得通，发出去的 `main.js` 才出问题。（`glob.ts` 是同一个处置，理由相同。）
 */
export type ContentKind = "post" | "page";

/**
 * 一种内容类型对应的 7 个 MCP 工具名。
 *
 * 七个而不是六个：`recycle` 与 `restore` 是两个独立工具，不是一个带布尔参数的。
 */
export interface ContentToolset {
  list: string;
  get: string;
  create: string;
  update: string;
  setPublish: string;
  recycle: string;
  restore: string;
}

/**
 * 工具名表。**逐字取自 2026-10-05 对真实站点 `tools/list` 的实测**（`halo-mcp-server` 1.2.0，
 * 51 个工具）。写错一个字符的表现是 `missing-tool` 错误 —— 而 `McpClient.callTool` 会在
 * 发请求**之前**用 `tools/list` 拦下它，所以错误信息里会带上可用工具的全集。
 */
export const CONTENT_TOOLSETS: Record<ContentKind, ContentToolset> = {
  post: {
    list: "halo_list_posts",
    get: "halo_get_post",
    create: "halo_create_post",
    update: "halo_update_post",
    setPublish: "halo_set_post_publish_state",
    recycle: "halo_recycle_post",
    restore: "halo_restore_post",
  },
  page: {
    list: "halo_list_single_pages",
    get: "halo_get_single_page",
    create: "halo_create_single_page",
    update: "halo_update_single_page",
    setPublish: "halo_set_single_page_publish_state",
    recycle: "halo_recycle_single_page",
    restore: "halo_restore_single_page",
  },
};
