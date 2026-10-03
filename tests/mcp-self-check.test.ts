import { beforeEach, describe, expect, it, type rs } from "@rstest/core";
import { requestUrl } from "obsidian";
import { describeSelfCheckError, REQUIRED_TOOLS, runSelfCheck } from "../src/mcp-self-check";
import { McpError } from "../src/transport/errors";

const rq = requestUrl as unknown as ReturnType<typeof rs.fn>;

const INIT_OK = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    serverInfo: { name: "halo-mcp-server", version: "1.2.0" },
  },
});

function toolsBody(names: string[]) {
  return JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: names.map((name) => ({ name, inputSchema: {} })) } });
}

describe("runSelfCheck", () => {
  beforeEach(() => {
    rq.mockReset();
  });

  it("全部必需工具都在 → ok 为 true 且 missing 为空", async () => {
    rq.mockImplementation(async () => ({ status: 200, text: "" }));
    rq.mockResolvedValueOnce({ status: 200, text: INIT_OK });
    rq.mockResolvedValueOnce({ status: 200, text: toolsBody([...REQUIRED_TOOLS]) });

    const report = await runSelfCheck("https://blog.example.com/mcp", "hmcp_x");

    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.server?.name).toBe("halo-mcp-server");
    expect(report.availableCount).toBe(REQUIRED_TOOLS.length);
  });

  it("缺工具时列出缺失项且 ok 为 false", async () => {
    rq.mockResolvedValueOnce({ status: 200, text: INIT_OK });
    rq.mockResolvedValueOnce({ status: 200, text: toolsBody(["halo_list_posts"]) });

    const report = await runSelfCheck("https://blog.example.com/mcp", "hmcp_x");

    expect(report.ok).toBe(false);
    expect(report.missing.length).toBe(REQUIRED_TOOLS.length - 1);
    expect(report.missing).not.toContain("halo_list_posts");
  });

  it("握手失败时把错误带回报告而不是抛出", async () => {
    rq.mockResolvedValueOnce({ status: 401, text: "" });

    const report = await runSelfCheck("https://blog.example.com/mcp", "bad");

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe("unauthorized");
  });

  it("REQUIRED_TOOLS 覆盖阶段 0/1 依赖的工具，且不含运维类工具", () => {
    expect(REQUIRED_TOOLS).toContain("halo_create_post");
    expect(REQUIRED_TOOLS).toContain("halo_set_post_publish_state");
    expect(REQUIRED_TOOLS).toContain("halo_upload_attachment");
    expect(REQUIRED_TOOLS).not.toContain("halo_list_comments");
    expect(REQUIRED_TOOLS).not.toContain("halo_update_theme_setting_group");
  });
});

describe("describeSelfCheckError", () => {
  it("McpError 原样返回其 key 与 params", () => {
    const error = new McpError("missing-tool", { tool: "halo_create_post", count: 3 });

    expect(describeSelfCheckError(error)).toEqual({
      key: "transport.error.missing-tool",
      params: { tool: "halo_create_post", count: 3 },
    });
  });

  it("普通 Error 回落到通用连接失败文案，不把 undefined 渲染进提示", () => {
    expect(describeSelfCheckError(new Error("boom"))).toEqual({
      key: "common.error_connection_failed",
      params: {},
    });
  });

  it("undefined 同样回落且不抛", () => {
    expect(() => describeSelfCheckError(undefined)).not.toThrow();
    expect(describeSelfCheckError(undefined)).toEqual({
      key: "common.error_connection_failed",
      params: {},
    });
  });
});
