import { beforeEach, describe, expect, it, type rs } from "@rstest/core";
import { requestUrl } from "obsidian";
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

const rq = requestUrl as unknown as ReturnType<typeof rs.fn>;

/**
 * 把被 mock 掉的 requestUrl 换成真发 HTTP 的适配器。
 *
 * 必须这么做：`tests/setup.ts` 全局 mock 掉了整个 `obsidian` 模块，其中 `requestUrl`
 * 是个裸 `rs.fn()`（返回 undefined）。不替换的话 `McpClient.post()` 会在读
 * `response.status` 时抛 TypeError，本测试永远到不了网络——那它就不是契约测试了。
 *
 * 只替换这一个函数而不是改 `tests/setup.ts`：`requestUrl` 是 Electron 运行时才有的 API，
 * Node 测试环境里没有真货，它是唯一无法真实存在的边界。换上 fetch 之后，`McpClient`、
 * `unwrap`、错误归一化、`runSelfCheck` 全部走真实代码路径。
 */
function useRealHttp(): void {
  rq.mockImplementation(
    async (param: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => {
      const response = await fetch(param.url, {
        method: param.method ?? "GET",
        headers: param.headers,
        body: param.body,
      });

      return { status: response.status, text: await response.text() };
    },
  );
}

describe("MCP 契约（真实站点）", () => {
  beforeEach(() => {
    rq.mockReset();
  });

  it("必需工具全部存在，且服务端为 halo-mcp-server", async () => {
    if (!enabled) {
      // 未配置环境变量时静默跳过：契约测试是可选验证，不阻塞常规开发与 CI
      return;
    }

    useRealHttp();

    const report = await runSelfCheck(endpoint as string, token as string);

    expect(report.error).toBeUndefined();
    expect(report.server?.name).toBe("halo-mcp-server");
    expect(report.missing).toEqual([]);
    expect(report.ok).toBe(true);
  }, 30_000);
});
