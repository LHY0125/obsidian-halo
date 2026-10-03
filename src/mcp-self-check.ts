import { McpError } from "./transport/errors";
import { McpClient } from "./transport/mcp-client";

/**
 * 自检与契约测试共同断言的工具集。站点侧少掉任何一个，插件都会在**对应的那条路径上**静默失效，
 * 所以这份清单必须覆盖全部被调用的工具 —— 漏一个，防线就在那个工具上开了口子。
 *
 * 成分（逐条核对过，三类）：
 * - **当前代码实际调用（9 个）**：文章读/建/改、发布状态、分类与标签的列举及创建、附件上传。
 * - **设计预留（3 个）**：`halo_recycle_post`、`halo_restore_post`、`halo_search_content` ——
 *   回收站与全文检索尚未接进命令，但站点侧若撤下它们，同样说明工具集已经变了，提前炸出来更好。
 * - **上游遗留（1 个）**：`halo_list_posts` —— 当前代码并不调用它（已用全量 grep 核过，
 *   拉取文章的选择列表走的是 `post-selection-model.ts` 的 REST 路径，不在 MCP 上）。
 *   作为既有清单的一部分保留，不因为这次改造没用到就删。
 *
 * 评论、独立页面、主题设置等运维类工具刻意不在其中。
 *
 * 清单不敢靠「看起来对」：2026-10-04 对真实站点拉过一次 `tools/list`（`halo-mcp-server` 1.2.0，
 * 共 44 个工具），这 13 项**逐条命中、missing 为空**。契约测试 `pnpm test:contract` 是它的自动化版本。
 */
export const REQUIRED_TOOLS: readonly string[] = [
  "halo_get_post",
  "halo_list_posts",
  "halo_create_post",
  "halo_update_post",
  "halo_set_post_publish_state",
  "halo_recycle_post",
  "halo_restore_post",
  "halo_list_categories",
  "halo_create_category",
  "halo_list_tags",
  "halo_create_tag",
  "halo_search_content",
  "halo_upload_attachment",
];

export interface SelfCheckReport {
  ok: boolean;
  endpoint: string;
  server?: { name: string; version: string; protocolVersion: string };
  availableCount: number;
  missing: string[];
  error?: McpError;
}

/** 探测站点 MCP 端点：握手 + 断言必需工具存在。不抛异常，一切结论走返回值。 */
export async function runSelfCheck(endpoint: string, token: string): Promise<SelfCheckReport> {
  const client = new McpClient({ endpoint, token });

  try {
    const info = await client.initialize();
    const names = (await client.listTools()).map((tool) => tool.name);

    return {
      ok: REQUIRED_TOOLS.every((tool) => names.includes(tool)),
      endpoint,
      server: {
        name: info.serverInfo.name,
        version: info.serverInfo.version,
        protocolVersion: info.protocolVersion,
      },
      availableCount: names.length,
      missing: REQUIRED_TOOLS.filter((tool) => !names.includes(tool)),
    };
  } catch (error) {
    return {
      ok: false,
      endpoint,
      availableCount: 0,
      missing: [...REQUIRED_TOOLS],
      error: error as McpError,
    };
  }
}

/**
 * 把任意抛出物归一化为可本地化的 { key, params }；非 McpError 时回落到通用文案。
 *
 * 存在的理由：`runSelfCheck` 里那句 `error as McpError` 是未校验的断言，一旦逃出来的不是
 * McpError（例如 initialize 返回体缺 serverInfo），调用方直接读 `.key` 会把 undefined
 * 渲染进 Notice —— 用户得到一条空白提示，而这个按钮的全部职责就是告诉用户哪儿不对。
 *
 * 分层：本函数**不 import i18next**，只产 key/params，由 UI 边界用 i18next.t(key, params) 解析。
 */
export function describeSelfCheckError(error: unknown): {
  key: string;
  params: Record<string, string | number>;
} {
  if (error instanceof McpError) {
    return { key: error.key, params: error.params };
  }
  return { key: "common.error_connection_failed", params: {} };
}
