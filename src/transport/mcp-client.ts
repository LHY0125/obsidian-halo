import { requestUrl } from "obsidian";
import { McpError, assertJsonBody, classifyHttpFailure, missingToolError, toolFailureError } from "./errors";
import type { JsonRpcResponse, McpInitializeResult, McpTool, McpToolCallResult, McpToolsListResult } from "./types";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "obsidian-halo-mcp";
const CLIENT_VERSION = "0.1.0";

export interface McpClientOptions {
  /** MCP 端点，形如 https://blog.example.com/mcp */
  endpoint: string;
  /** hmcp_ 访问密钥 */
  token: string;
}

/** 解析 JSON-RPC 外壳，取出 result；error 字段存在时抛错 */
function unwrap<T>(body: string, context: string): T {
  const json = assertJsonBody(body) as JsonRpcResponse<T>;

  if (json.error) {
    throw new McpError("unknown", { context }, json.error.message);
  }
  if (json.result === undefined) {
    throw new McpError("unknown", { context });
  }
  return json.result;
}

/**
 * 解包 `tools/call` 的结果。
 *
 * 三条实测出来的形状约束（见 Global Constraints）：
 * ① 工具级失败是 HTTP 200 + `isError: true`，必须显式检查，否则会把报错文本当数据；
 * ② 成功时优先取 `structuredContent`（已解析），它缺席才回落解析 `content[0].text`；
 * ③ `content` 是文本块**数组**——首块是负载，末块是人读摘要，拼接全部会得到非法 JSON。
 */
export function parseToolResult<T>(result: McpToolCallResult | undefined, tool: string): T {
  const blocks = result?.content ?? [];
  const message = blocks
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();

  if (result?.isError) {
    throw toolFailureError(tool, message);
  }

  if (result?.structuredContent !== undefined) {
    return result.structuredContent as T;
  }

  const first = blocks.find((block) => block.type === "text" && block.text)?.text;

  if (first === undefined) {
    throw toolFailureError(tool, message || `no content in ${tool} result`);
  }

  try {
    return JSON.parse(first) as T;
  } catch {
    throw new McpError("unknown", { tool }, first.slice(0, 200));
  }
}

export class McpClient {
  /** 成功的握手结果缓存；失败时会被清空以允许重试 */
  private handshake?: Promise<McpInitializeResult>;

  /** 工具列表缓存；站点侧工具集可变，必要时用 listTools(true) 强制刷新 */
  private toolCache?: McpTool[];

  constructor(private readonly options: McpClientOptions) {}

  private get url(): string {
    return this.options.endpoint.trim().replace(/\/+$/, "");
  }

  private get headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      // 必须同时包含 text/event-stream：缺了会被服务端判为 400 且响应体为空
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.options.token}`,
    };
  }

  private async post(payload: unknown, context: string): Promise<string> {
    let response: { status: number; text: string };

    try {
      response = await requestUrl({
        url: this.url,
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(payload),
        throw: false,
      });
    } catch (error) {
      throw new McpError("network", { context }, (error as Error).message);
    }

    if (response.status >= 400) {
      throw classifyHttpFailure(response.status, response.text);
    }
    return response.text;
  }

  public initialize(): Promise<McpInitializeResult> {
    if (!this.handshake) {
      this.handshake = this.doInitialize().catch((error: unknown) => {
        this.handshake = undefined;
        throw error;
      });
    }
    return this.handshake;
  }

  private async doInitialize(): Promise<McpInitializeResult> {
    const body = await this.post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
        },
      },
      "MCP handshake",
    );

    return unwrap<McpInitializeResult>(body, "MCP handshake");
  }

  public async listTools(force = false): Promise<McpTool[]> {
    if (this.toolCache && !force) {
      return this.toolCache;
    }

    await this.initialize();
    const body = await this.post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "tools/list");

    this.toolCache = unwrap<McpToolsListResult>(body, "tools/list").tools;
    return this.toolCache;
  }

  public async callTool<T = McpToolCallResult>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.initialize();

    const tools = await this.listTools();
    if (!tools.some((tool) => tool.name === name)) {
      throw missingToolError(
        name,
        tools.map((tool) => tool.name),
      );
    }

    const body = await this.post(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } },
      `tools/call ${name}`,
    );

    return unwrap<T>(body, `tools/call ${name}`);
  }

  /**
   * 调用工具并解包成实际负载。
   *
   * 业务代码一律用这个方法，**不要**直接用 `callTool()` —— 后者返回的是
   * 未解包的 MCP 外壳，会让每个调用点都重复一遍「检查 isError / 取 structuredContent」。
   */
  public async callToolJson<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.callTool<McpToolCallResult>(name, args);
    return parseToolResult<T>(result, name);
  }
}
