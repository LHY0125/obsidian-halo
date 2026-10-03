import { McpError } from "./transport/errors";
import { McpClient } from "./transport/mcp-client";

/**
 * 阶段 0/1 依赖的 MCP 工具。
 * 只列本设计用到的内容创作类工具；评论与主题设置等运维类工具刻意不在其中。
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
