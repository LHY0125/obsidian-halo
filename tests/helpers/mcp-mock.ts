import type { McpClient } from "../../src/transport/mcp-client";

export interface FakeToolCall {
  name: string;
  args: Record<string, unknown>;
  /**
   * 走的是哪个入口。写路径必须用 `callToolVoid`（不解析返回体），
   * 读路径用 `callToolJson`（要求返回体是可解析的 JSON 负载）——
   * 这个字段就是让「用错入口」在服务层也能被断言到。
   */
  method: "callToolJson" | "callToolVoid";
}

export interface FakeMcpClient {
  client: McpClient;
  calls: FakeToolCall[];
}

/** 字符串载荷必须是可解析的 JSON —— 与真实 `parseToolResult` 的回落解析同一要求 */
function assertJsonPayload(value: unknown, name: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    return;
  }

  try {
    JSON.parse(value);
  } catch {
    throw new Error(`callToolJson(${name}): 返回体不是可解析的 JSON 负载: ${value.slice(0, 40)}`);
  }
}

/**
 * 造一个假的 `McpClient`，实现业务代码会用的两个入口：`callToolJson` 与 `callToolVoid`。
 *
 * 为什么要有它：`McpClient` 内部走 `requestUrl`，用真的就得在测试里模拟整条
 * JSON-RPC 握手 + tools/list + tools/call 的报文。服务层测试要断言的是
 * 「调了哪个工具、传了什么参数、走的哪个入口」，不是「发了什么 HTTP 请求」。
 *
 * 两个入口的差别**按真实语义建模**：`callToolJson` 要求通过它的载荷是可解析的 JSON
 * （真实实现里 `parseToolResult` 会 parse 并在失败时抛错），`callToolVoid` 只看副作用、
 * 不碰返回体。不建模这层差别的话，服务层测试无法区分二者，
 * 「写路径误用 callToolJson」就会是一条静默通过的假绿。
 *
 * 本次调用**先记录再求值**：responder 抛错时该调用仍留在 `calls` 里，
 * 否则「失败的那一次没有打 MCP」这类断言会假阳性。
 *
 * responder 一律 `await`：不 await 的话，**async responder 的 rejection 会被吞掉** ——
 * 调用看起来成功，而同一个 responder 交给 `callToolJson` 却会正确地抛。
 * 「写入失败」的用例于是变成静默的假绿，且两个入口对同一份 responder 行为不一致。
 */
export function createFakeClient(responder: (name: string, args: Record<string, unknown>) => unknown): FakeMcpClient {
  const calls: FakeToolCall[] = [];

  const client = {
    callToolJson: async (name: string, args: Record<string, unknown> = {}) => {
      calls.push({ name, args, method: "callToolJson" });
      const value = await responder(name, args);
      assertJsonPayload(value, name);
      return value;
    },
    callToolVoid: async (name: string, args: Record<string, unknown> = {}) => {
      // responder 仍然执行（故仍可用来模拟工具级失败），但返回值一概不参与判定
      calls.push({ name, args, method: "callToolVoid" });
      await responder(name, args);
    },
  } as unknown as McpClient;

  return { client, calls };
}
