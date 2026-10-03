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

const TOOLS_OK = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  result: {
    tools: [
      { name: "halo_create_post", inputSchema: { type: "object" } },
      { name: "halo_list_posts", inputSchema: { type: "object" } },
    ],
  },
});

const CALL_OK = JSON.stringify({
  jsonrpc: "2.0",
  id: 3,
  result: { content: [{ type: "text", text: "ok" }] },
});

describe("McpClient.listTools / callTool", () => {
  beforeEach(() => {
    rq.mockReset();
  });

  it("listTools 前会自动握手（连发 initialize + tools/list 两次请求）", async () => {
    const calls = stub([
      { status: 200, text: INIT_OK },
      { status: 200, text: TOOLS_OK },
    ]);
    const tools = await new McpClient(options).listTools();

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].body).method).toBe("tools/list");
    expect(tools.map((t) => t.name)).toEqual(["halo_create_post", "halo_list_posts"]);
  });

  it("listTools 结果被缓存，第二次不再发请求", async () => {
    const calls = stub([
      { status: 200, text: INIT_OK },
      { status: 200, text: TOOLS_OK },
    ]);
    const client = new McpClient(options);

    await client.listTools();
    await client.listTools();

    expect(calls).toHaveLength(2);
  });

  it("listTools(true) 强制刷新", async () => {
    const calls = stub([
      { status: 200, text: INIT_OK },
      { status: 200, text: TOOLS_OK },
      { status: 200, text: TOOLS_OK },
    ]);
    const client = new McpClient(options);

    await client.listTools();
    await client.listTools(true);

    expect(calls).toHaveLength(3);
  });

  it("callTool 发送 tools/call 与 arguments", async () => {
    const calls = stub([
      { status: 200, text: INIT_OK },
      { status: 200, text: TOOLS_OK },
      { status: 200, text: CALL_OK },
    ]);
    await new McpClient(options).callTool("halo_create_post", { title: "标题" });

    const body = JSON.parse(calls[2].body);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("halo_create_post");
    expect(body.params.arguments).toEqual({ title: "标题" });
  });

  it("工具不在站点可用列表中时抛 missing-tool，且不发出 tools/call 请求", async () => {
    const calls = stub([
      { status: 200, text: INIT_OK },
      { status: 200, text: TOOLS_OK },
    ]);
    const client = new McpClient(options);

    await expect(client.callTool("halo_not_exists")).rejects.toMatchObject({ kind: "missing-tool" });
    expect(calls).toHaveLength(2);
  });

  it("callTool 的 arguments 缺省为空对象", async () => {
    const calls = stub([
      { status: 200, text: INIT_OK },
      { status: 200, text: TOOLS_OK },
      { status: 200, text: CALL_OK },
    ]);
    await new McpClient(options).callTool("halo_list_posts");

    expect(JSON.parse(calls[2].body).params.arguments).toEqual({});
  });

  it("JSON-RPC error 字段被转成 McpError", async () => {
    stub([
      { status: 200, text: INIT_OK },
      { status: 200, text: TOOLS_OK },
      {
        status: 200,
        text: JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32602, message: "invalid params" } }),
      },
    ]);

    await expect(new McpClient(options).callTool("halo_create_post")).rejects.toMatchObject({
      kind: "unknown",
      detail: "invalid params",
    });
  });
});

import { parseToolResult } from "src/transport/mcp-client";

// 以下两个外壳取自 2026-10-03 对 https://blog.liuhangyv.top/mcp 的实测原始响应
const SUCCESS_RESULT = {
  content: [
    { type: "text", text: '{"items":[{"name":"real-ip-always-there-and-forgery"}],"total":74}' },
    { type: "text", text: "Listed 1 posts" },
  ],
  isError: false,
  structuredContent: { items: [{ name: "real-ip-always-there-and-forgery" }], total: 74 },
};

// 工具级失败：HTTP 状态码是 200，但它不是成功
const TOOL_FAILURE_RESULT = {
  content: [
    {
      type: "text",
      text: "Tool (halo_list_posts) input validation failed: Validation failed: JSON schema validation errors: [/size: must have a maximum value of 100]",
    },
  ],
  isError: true,
};

// isError 为 true，但负载本身是**可解析的 JSON**。
// 这才是 `isError` 分支的真正判别器：TOOL_FAILURE_RESULT 的文本无法 JSON.parse，
// 即使删掉 isError 分支也会在回落解析时抛错，因此它判别不出该分支是否还在。
// 本 fixture 一旦漏检 isError，就会被原样当数据返回——正是本任务要堵的洞。
const TOOL_FAILURE_WITH_PAYLOAD = {
  content: [{ type: "text", text: '{"items":[{"name":"should-never-be-returned"}],"total":74}' }],
  isError: true,
};

describe("parseToolResult", () => {
  it("优先使用 structuredContent，而不是解析 content 文本", () => {
    const parsed = parseToolResult<{ total: number }>(SUCCESS_RESULT, "halo_list_posts");
    expect(parsed.total).toBe(74);
  });

  it("structuredContent 缺席时回落解析 content[0].text", () => {
    const withoutStructured = {
      content: [{ type: "text", text: '{"total":9}' }],
      isError: false,
    };
    const parsed = parseToolResult<{ total: number }>(withoutStructured, "halo_list_posts");
    expect(parsed.total).toBe(9);
  });

  it("isError 为 true 时抛 McpError，且 detail 带上服务端原文", () => {
    let thrown: unknown;
    try {
      parseToolResult(TOOL_FAILURE_RESULT, "halo_list_posts");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).detail).toContain("must have a maximum value of 100");
  });

  it("isError 为 true 时绝不能被当成数据返回", () => {
    expect(() => parseToolResult(TOOL_FAILURE_RESULT, "halo_list_posts")).toThrow(McpError);
    expect(() => parseToolResult(TOOL_FAILURE_WITH_PAYLOAD, "halo_list_posts")).toThrow(McpError);
  });

  it("既无 structuredContent 又无可用文本块时抛错，而不是返回 undefined", () => {
    let thrown: unknown;
    try {
      parseToolResult({ content: [], isError: false }, "halo_x");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).detail).toBeTruthy();
    expect((thrown as McpError).detail).toContain("halo_x");
  });

  it("content[0].text 不是合法 JSON 时抛错", () => {
    expect(() => parseToolResult({ content: [{ type: "text", text: "not json" }], isError: false }, "halo_x")).toThrow(
      McpError,
    );
  });
});

describe("McpClient.callToolJson", () => {
  beforeEach(() => {
    rq.mockReset();
  });

  it("成功时返回解包后的负载，而不是未解包的 MCP 外壳", async () => {
    const calls = stub([
      { status: 200, text: INIT_OK },
      { status: 200, text: TOOLS_OK },
      {
        status: 200,
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          result: {
            content: [{ type: "text", text: '{"total":74}' }],
            isError: false,
            structuredContent: { total: 74 },
          },
        }),
      },
    ]);

    const parsed = await new McpClient(options).callToolJson<{ total: number }>("halo_list_posts", { size: 1 });

    // 拿到的是解包后的负载，不是 `{ content, isError, structuredContent }` 外壳
    expect(parsed).toEqual({ total: 74 });
    expect(parsed).not.toHaveProperty("content");

    // 且确实经由 tools/call 把工具名与参数透传下去
    const body = JSON.parse(calls[2].body);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("halo_list_posts");
    expect(body.params.arguments).toEqual({ size: 1 });
  });

  it("外壳 isError 为 true 时抛 McpError 且带服务端原文，而不是把 content 当返回值", async () => {
    stub([
      { status: 200, text: INIT_OK },
      { status: 200, text: TOOLS_OK },
      { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id: 3, result: TOOL_FAILURE_RESULT }) },
    ]);

    let thrown: unknown;
    try {
      await new McpClient(options).callToolJson("halo_list_posts");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).kind).toBe("unknown");
    expect((thrown as McpError).detail).toContain("must have a maximum value of 100");
  });
});
