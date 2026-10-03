import { describe, expect, it } from "@rstest/core";
import { runSelfCheck } from "../../src/mcp-self-check";

/**
 * 对真实站点的契约测试。
 *
 * 站点侧的 MCP 工具集是可变的（管理员可在密钥里取消工具授权，官方也会新增），
 * 所以本设计依赖的每个工具都必须被断言存在 —— 否则站点侧一变，插件会静默失效。
 *
 * 未提供环境变量时自动跳过，不阻塞常规开发与 CI。
 */
const endpoint = process.env.HALO_MCP_ENDPOINT;
const token = process.env.HALO_MCP_TOKEN;
const enabled = Boolean(endpoint && token);

describe("MCP 契约（真实站点）", () => {
  it("必需工具全部存在，且服务端为 halo-mcp-server", async () => {
    if (!enabled) {
      // 未配置环境变量时静默跳过：契约测试是可选验证，不阻塞常规开发与 CI
      return;
    }

    const report = await runSelfCheck(endpoint as string, token as string);

    expect(report.error).toBeUndefined();
    expect(report.server?.name).toBe("halo-mcp-server");
    expect(report.missing).toEqual([]);
    expect(report.ok).toBe(true);
  }, 30_000);
});
