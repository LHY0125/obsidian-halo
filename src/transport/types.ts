/** MCP 使用的 JSON-RPC 2.0 响应外壳 */
export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id?: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: { tools?: { listChanged?: boolean } };
  serverInfo: { name: string; version: string };
  instructions?: string;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolsListResult {
  tools: McpTool[];
}

/** MCP 工具返回的内容块 */
export interface McpContentBlock {
  type: string;
  text?: string;
}

export interface McpToolCallResult {
  content?: McpContentBlock[];
  isError?: boolean;
}
