import { beforeAll, describe, expect, it } from "@rstest/core";
import i18next from "i18next";
import { initializeI18n } from "../../src/i18n";
import { renderErrorMessage, withErrorDetail } from "../../src/i18n/error-message";
import { McpError, toolFailureError } from "../../src/transport/errors";

/**
 * 初始化 i18n —— 走**生产同一条入口** `initializeI18n()`（`main.ts` 的 `onload` 调的就是它）。
 *
 * 不初始化的话 `i18next.t()` 返回 **undefined**，于是「给的是具体原因还是泛化兜底」
 * 再也分不出来 —— 断言会退化成 `expect(undefined).toBe(undefined)` 这种零判别力的形式。
 *
 * 刻意**不再自己拼 options**：那样测试与生产跑在**两套配置**下，而其中一处差异（全局
 * `interpolation.escapeValue`）恰好决定插值出来的字符串长什么样 —— 断言插值文案的用例会看到
 * 与用户所见不同的输出。收敛到生产入口之后，两边只有一份配置。
 */
beforeAll(async () => {
  await initializeI18n("en");
});

describe("withErrorDetail", () => {
  it("有服务端原文时另起一行附上，且原文逐字保留（不翻译、不改写）", () => {
    const error = toolFailureError("halo_list_posts", "size must be <= 100");

    expect(withErrorDetail("发布失败", error)).toBe("发布失败\nsize must be <= 100");
  });

  it("没有原文时原样返回 —— 不留一个孤零零的换行", () => {
    expect(withErrorDetail("发布失败", new McpError("unauthorized", { status: 401 }))).toBe("发布失败");
    // 空串同样是「没有原文」：判据是真值，不是 `??`
    expect(withErrorDetail("发布失败", new McpError("unknown", {}, ""))).toBe("发布失败");
  });

  it("非 McpError 一律不加后缀，也不抛", () => {
    expect(withErrorDetail("发布失败", new Error("boom"))).toBe("发布失败");
    expect(withErrorDetail("发布失败", undefined)).toBe("发布失败");
  });
});

describe("renderErrorMessage", () => {
  it("命中 McpError 时用它的 key —— 那本就是处置指引，而不是泛化兜底", () => {
    const message = renderErrorMessage(new McpError("forbidden", { status: 403 }));

    expect(message).toBe(i18next.t("transport.error.forbidden", { status: 403 }));
    expect(message).not.toBe(i18next.t("common.error_connection_failed"));
  });

  it("工具级失败把服务端原文拼在译文之后（否则这类失败只剩一句泛泛的提示）", () => {
    const message = renderErrorMessage(toolFailureError("halo_list_posts", "size must be <= 100"));

    expect(message).toContain(i18next.t("transport.error.unknown", { tool: "halo_list_posts" }));
    expect(message).toContain("size must be <= 100");
  });

  it("fallbackKey 指定兜底文案，默认是「连接失败」", () => {
    expect(renderErrorMessage(new Error("boom"), "service.error_post_not_found")).toBe(
      i18next.t("service.error_post_not_found"),
    );
    expect(renderErrorMessage(new Error("boom"))).toBe(i18next.t("common.error_connection_failed"));
    // 兜底路径与 key 路径一样不能对 undefined 抛
    expect(renderErrorMessage(undefined)).toBe(i18next.t("common.error_connection_failed"));
  });

  it("fallbackKey 只影响非 McpError：命中 McpError 时具体原因优先", () => {
    expect(renderErrorMessage(new McpError("unauthorized", { status: 401 }), "service.error_post_not_found")).toBe(
      i18next.t("transport.error.unauthorized", { status: 401 }),
    );
  });
});
