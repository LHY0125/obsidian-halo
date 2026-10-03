import { beforeEach, describe, expect, it, type rs } from "@rstest/core";
import { requestUrl } from "obsidian";
import { McpError } from "../../src/transport/errors";
import { McpClient } from "../../src/transport/mcp-client";

const rq = requestUrl as unknown as ReturnType<typeof rs.fn>;

const INIT_OK = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: "2025-06-18",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "halo-mcp-server", version: "1.2.0" },
  },
});

/** 记录每次请求参数，并按脚本返回响应 */
function stub(script: Array<{ status: number; text: string }>) {
  const calls: Array<Record<string, any>> = [];
  let i = 0;
  rq.mockImplementation(async (param: Record<string, any>) => {
    calls.push(param);
    const next = script[Math.min(i, script.length - 1)];
    i += 1;
    return { status: next.status, text: next.text, json: undefined };
  });
  return calls;
}

const options = { endpoint: "https://blog.example.com/mcp", token: "hmcp_demo" };

describe("McpClient.initialize", () => {
  beforeEach(() => {
    rq.mockReset();
  });

  it("Accept 头必须同时包含 application/json 与 text/event-stream", async () => {
    const calls = stub([{ status: 200, text: INIT_OK }]);
    await new McpClient(options).initialize();

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://blog.example.com/mcp");
    expect(calls[0].headers.Accept).toContain("application/json");
    expect(calls[0].headers.Accept).toContain("text/event-stream");
    expect(calls[0].headers.Authorization).toBe("Bearer hmcp_demo");
  });

  it("端点尾部斜杠被规整，不会拼出 //mcp", async () => {
    const calls = stub([{ status: 200, text: INIT_OK }]);
    await new McpClient({ ...options, endpoint: "https://blog.example.com/mcp/" }).initialize();

    expect(calls[0].url).toBe("https://blog.example.com/mcp");
  });

  it("请求体是合法的 initialize JSON-RPC", async () => {
    const calls = stub([{ status: 200, text: INIT_OK }]);
    await new McpClient(options).initialize();

    const body = JSON.parse(calls[0].body);
    expect(body.method).toBe("initialize");
    expect(body.jsonrpc).toBe("2.0");
    expect(body.params.protocolVersion).toBe("2025-06-18");
  });

  it("成功时返回 serverInfo", async () => {
    stub([{ status: 200, text: INIT_OK }]);
    const result = await new McpClient(options).initialize();

    expect(result.serverInfo.name).toBe("halo-mcp-server");
    expect(result.protocolVersion).toBe("2025-06-18");
  });

  it("400 空响应体 → 抛出 McpError，kind 为 protocol", async () => {
    stub([{ status: 400, text: "" }]);

    await expect(new McpClient(options).initialize()).rejects.toMatchObject({ kind: "protocol" });
  });

  it("401 → kind 为 unauthorized", async () => {
    stub([{ status: 401, text: "" }]);

    await expect(new McpClient(options).initialize()).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("200 但响应体是 HTML → kind 为 gateway", async () => {
    stub([{ status: 200, text: "<!DOCTYPE html><html><body>blocked</body></html>" }]);

    await expect(new McpClient(options).initialize()).rejects.toMatchObject({ kind: "gateway" });
  });

  it("initialize 失败后允许重试（不缓存失败结果）", async () => {
    const calls = stub([
      { status: 400, text: "" },
      { status: 200, text: INIT_OK },
    ]);
    const client = new McpClient(options);

    await expect(client.initialize()).rejects.toBeInstanceOf(McpError);
    const result = await client.initialize();

    expect(result.serverInfo.name).toBe("halo-mcp-server");
    expect(calls).toHaveLength(2);
  });

  it("重复调用 initialize 只发一次请求（成功结果被缓存）", async () => {
    const calls = stub([{ status: 200, text: INIT_OK }]);
    const client = new McpClient(options);

    await client.initialize();
    await client.initialize();

    expect(calls).toHaveLength(1);
  });
});
