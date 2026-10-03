import { requestUrl } from "obsidian";
import { McpError, assertJsonBody, classifyHttpFailure, missingToolError } from "./errors";
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
}
