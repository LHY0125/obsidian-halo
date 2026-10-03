import { beforeAll, beforeEach, describe, expect, it, type rs } from "@rstest/core";
import i18next from "i18next";
import { requestUrl } from "obsidian";
import { resources } from "../src/i18n";
import { REQUIRED_TOOLS, describeSelfCheckFailure, runSelfCheck } from "../src/mcp-self-check";
import { McpError, toolFailureError } from "../src/transport/errors";

/**
 * 按生产路径初始化 i18n（与 `tests/service/index.test.ts` 同一处置）。
 *
 * 不初始化的话 `i18next.t()` 返回 **undefined**，于是「弹的是含服务端原文那条还是泛化兜底」
 * 再也分不出来 —— 断言会退化成 `expect(undefined).toBe(undefined)` 这种零判别力的形式。
 */
beforeAll(async () => {
  await i18next.init({ lng: "en", fallbackLng: "en", resources, returnNull: false });
});

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

  it("REQUIRED_TOOLS 覆盖代码实际调用的每个工具，且不含运维类工具", () => {
    // 逐个点名，而不是抽查三个：这 10 个是 `src/` 里真的会调用的工具（grep `callTool` 可复核）。
    // 漏掉任何一个，运行时 `callTool` 会抛 missing-tool，而自检却报「一切正常」——
    // 那正是这份清单存在的意义所在。
    const calledByCode = [
      "halo_list_posts",
      "halo_get_post",
      "halo_create_post",
      "halo_update_post",
      "halo_set_post_publish_state",
      "halo_list_categories",
      "halo_create_category",
      "halo_list_tags",
      "halo_create_tag",
      "halo_upload_attachment",
    ];

    for (const tool of calledByCode) {
      expect(REQUIRED_TOOLS).toContain(tool);
    }

    expect(REQUIRED_TOOLS).not.toContain("halo_list_comments");
    expect(REQUIRED_TOOLS).not.toContain("halo_update_theme_setting_group");
  });
});

describe("describeSelfCheckFailure", () => {
  /**
   * 「自检失败」框架 + 内层原因 —— 用来构造期望值，避免把整句文案抄进测试。
   *
   * **必须带上 `escapeValue: false`**，与实现一致：i18next 默认转义插值，而这里的插值是
   * 已渲染好的用户文案。少了它，期望值会是被转义的版本，`toBe` 立刻不等 —— 这正是下面那条
   * 「含 `<` 的原文必须原样出现」要钉的行为（实现若把该选项删掉，这里会红）。
   */
  function failureNotice(inner: string): string {
    return i18next.t("command.mcp_self_check.error_failed", {
      message: inner,
      interpolation: { escapeValue: false },
    });
  }

  it("把服务端原文拼进「自检失败」文案 —— 自检就是拿来诊断的，藏起原文等于掐掉最该给的线索", () => {
    const message = describeSelfCheckFailure(toolFailureError("halo_list_posts", "size must be <= 100"));

    // 具体原因与原文都要在：前者告诉用户去哪儿处置，后者是服务端说的原话
    expect(message).toContain(i18next.t("transport.error.unknown", { tool: "halo_list_posts" }));
    expect(message).toContain("size must be <= 100");
    // 整串相等：框架只包一层，不能把原文拼到框架外面去
    expect(message).toBe(
      failureNotice(`${i18next.t("transport.error.unknown", { tool: "halo_list_posts" })}\nsize must be <= 100`),
    );
  });

  it("含 `<` 的服务端原文必须原样出现 —— 不能被 i18next 的插值转义成 HTML 实体", () => {
    // 这不是假想：网关类失败的 detail 就是一段 HTML 片段（站点被 ESA/WAF 拦下时）。
    // 若开着 i18next 默认的 escapeValue，用户会看到 `&lt;!doctype …` 而不是服务端原话
    const message = describeSelfCheckFailure(
      new McpError("gateway", { status: 502 }, "<!doctype html><html>blocked by WAF</html>"),
    );

    expect(message).toContain("<!doctype html><html>blocked by WAF</html>");
    expect(message).not.toContain("&lt;");
  });

  it("detail 为空时不出现多余分隔符或空行", () => {
    const message = describeSelfCheckFailure(new McpError("unauthorized", { status: 401 }));

    // 精确相等钉住「没有后缀」；再显式断言没有任何换行 —— 多一个 `\n` 都会红
    expect(message).toBe(failureNotice(i18next.t("transport.error.unauthorized", { status: 401 })));
    expect(message).not.toContain("\n");
  });

  it("非 McpError 时回落到通用连接失败文案，且同样不加后缀", () => {
    const message = describeSelfCheckFailure(new Error("boom"));

    expect(message).toBe(failureNotice(i18next.t("common.error_connection_failed")));
    expect(message).not.toContain("\n");
    // 连抛出来的东西都不是对象时也不能炸：这条路径的首要职责是「说出点什么」
    expect(() => describeSelfCheckFailure(undefined)).not.toThrow();
  });
});
