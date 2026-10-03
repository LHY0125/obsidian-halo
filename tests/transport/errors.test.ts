import { describe, expect, it } from "@rstest/core";
import { McpError, assertJsonBody, classifyHttpFailure, missingToolError } from "../../src/transport/errors";

/** 捕获同步抛出的 McpError，便于断言 kind / params，而不是本地化文案 */
function captureError(fn: () => unknown): McpError {
  try {
    fn();
  } catch (error) {
    return error as McpError;
  }
  throw new Error("expected the call to throw");
}

describe("classifyHttpFailure", () => {
  it("400 且响应体为空 → protocol（误解 Accept 头或握手顺序的典型症状）", () => {
    const err = classifyHttpFailure(400, "");

    expect(err).toBeInstanceOf(McpError);
    expect(err.kind).toBe("protocol");
    expect(err.key).toBe("transport.error.protocol");
  });

  it("400 但响应体非空 → 不判为 protocol，交回 unknown", () => {
    expect(classifyHttpFailure(400, '{"error":"bad params"}').kind).toBe("unknown");
  });

  it("401 → unauthorized（密钥无效，处置与 403 不同）", () => {
    expect(classifyHttpFailure(401, "").kind).toBe("unauthorized");
  });

  it("403 → forbidden（密钥未获授权调用该工具）", () => {
    expect(classifyHttpFailure(403, "").kind).toBe("forbidden");
  });

  it("状态码正常但响应体是 HTML → gateway（ESA/WAF 拦截页）", () => {
    expect(classifyHttpFailure(200, "<!DOCTYPE html><html><body>blocked</body></html>").kind).toBe("gateway");
  });

  it("其它状态码 → unknown，并把响应体片段留在 detail", () => {
    const err = classifyHttpFailure(500, "boom");

    expect(err.kind).toBe("unknown");
    expect(err.detail).toBe("boom");
    expect(err.params).toMatchObject({ status: 500 });
  });

  it("每个 kind 都映射到 transport.error.* 下的 i18n 键，供 UI 层解析文案", () => {
    const errors = [
      classifyHttpFailure(400, ""),
      classifyHttpFailure(401, ""),
      classifyHttpFailure(403, ""),
      classifyHttpFailure(500, "x"),
      missingToolError("halo_create_post", []),
    ];

    for (const err of errors) {
      expect(err.key).toBe(`transport.error.${err.kind}`);
      expect(err.key).toMatch(/^transport\.error\.[a-z-]+$/);
    }
  });
});

describe("assertJsonBody", () => {
  it("合法 JSON 正常解析", () => {
    expect(assertJsonBody('{"a":1}')).toEqual({ a: 1 });
  });

  it("HTML 即便状态码是 200 也判为 gateway——不能把拦截页当 JSON 解", () => {
    expect(captureError(() => assertJsonBody("<html><head></head></html>")).kind).toBe("gateway");
  });

  it("非 JSON 非 HTML → unknown", () => {
    expect(captureError(() => assertJsonBody("not json at all")).kind).toBe("unknown");
  });
});

describe("missingToolError", () => {
  it("把缺失工具名与可用数量放进 params，供 UI 层插值", () => {
    const err = missingToolError("halo_create_post", ["halo_list_posts", "halo_get_post"]);

    expect(err.kind).toBe("missing-tool");
    expect(err.params).toEqual({ tool: "halo_create_post", count: 2 });
  });
});
