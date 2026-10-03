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
 *
 * 不映射 `throw` 参数：调用方（`McpClient.post()`）固定传 `throw: false`，而 `fetch` 本就不会
 * 因 HTTP 4xx/5xx 抛错——返回 `{ status, text }` 正好是它要的行为。若将来调用方改用 `throw: true`，
 * 这个适配器需要跟着处理。
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
      // 两个变量都缺 → 这是预期的跳过（可选验证，不阻塞常规开发与 CI）
      // 只缺一个 → 几乎肯定是配置失误，必须让人看见，否则只会得到"1 passed 但什么都没验"
      //
      // 用 process.stderr.write 而非 console.warn：rstest 拦截 console，且**通过的测试其 console
      // 输出默认被吞掉**——console.warn 在 `pnpm test:contract` 这条默认路径上根本看不见，告警会
      // 形同虚设。写 stderr 绕过这层拦截，且无需 CLI 开关、也不用改全局测试配置。
      if (Boolean(endpoint) !== Boolean(token)) {
        process.stderr.write(
          `[mcp-contract] 本次未做任何断言：HALO_MCP_ENDPOINT 与 HALO_MCP_TOKEN 必须同时设置，当前缺少 ${
            endpoint ? "HALO_MCP_TOKEN" : "HALO_MCP_ENDPOINT"
          }。\n`,
        );
      }
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
