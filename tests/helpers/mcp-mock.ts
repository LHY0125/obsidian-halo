import type { McpClient } from "../../src/transport/mcp-client";

export interface FakeToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface FakeMcpClient {
  client: McpClient;
  calls: FakeToolCall[];
}

/**
 * 造一个假的 `McpClient`，只实现业务代码真正会用的 `callToolJson`。
 *
 * 为什么要有它：`McpClient` 内部走 `requestUrl`，用真的就得在测试里模拟整条
 * JSON-RPC 握手 + tools/list + tools/call 的报文。服务层测试要断言的是
 * 「调了哪个工具、传了什么参数」，不是「发了什么 HTTP 请求」，所以在这一层替换掉。
 *
 * 本次调用**先记录再求值**：responder 抛错时该调用仍留在 `calls` 里，
 * 否则「失败的那一次没有打 MCP」这类断言会假阳性。
 */
export function createFakeClient(responder: (name: string, args: Record<string, unknown>) => unknown): FakeMcpClient {
  const calls: FakeToolCall[] = [];

  const client = {
    callToolJson: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args });
      return responder(name, args);
    },
  } as unknown as McpClient;

  return { client, calls };
}
