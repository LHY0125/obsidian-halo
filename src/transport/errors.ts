export type McpErrorKind =
  | "protocol"
  | "unauthorized"
  | "forbidden"
  | "gateway"
  | "missing-tool"
  | "network"
  | "unknown";

/**
 * MCP 传输层错误。
 *
 * 职责划分：`key` + `params` 交给 UI 层用 i18next 解析出**用户可见文案**；
 * `message` 就是那个键本身（供日志定位），本模块**不携带任何用户文案、也不依赖 i18next**，
 * 因此它的单测无需初始化 i18n。
 */
export class McpError extends Error {
  readonly key: string;

  constructor(
    readonly kind: McpErrorKind,
    readonly params: Record<string, string | number> = {},
    readonly detail?: string,
  ) {
    const key = `transport.error.${kind}`;
    super(key);
    this.name = "McpError";
    this.key = key;
  }
}

/** 响应体看上去是 HTML —— 说明命中了网关（ESA/WAF）拦截页而非 MCP 端点 */
const HTML_BODY = /<\s*(!doctype|html|head|body)\b/i;

/**
 * 把 HTTP 层现象归一化成可操作的错误类别。
 * 判据取自真实站点的实测行为（见 spec 的 F4 / F7）。
 *
 * 401 与 403 拆成两个 kind：spec §4.3 给它们的处置不同（核对密钥 vs 为该密钥勾选工具），
 * 合成一个 kind 就没法各自给出正确的指引。
 */
export function classifyHttpFailure(status: number, body: string): McpError {
  const trimmed = body.trim();

  if (HTML_BODY.test(trimmed)) {
    return new McpError("gateway", { status }, trimmed.slice(0, 200));
  }
  if (status === 400 && trimmed === "") {
    return new McpError("protocol", { status });
  }
  if (status === 401) {
    return new McpError("unauthorized", { status });
  }
  if (status === 403) {
    return new McpError("forbidden", { status });
  }
  return new McpError("unknown", { status }, trimmed.slice(0, 200));
}

/** 响应体必须能解析为 JSON；HTML 一律判为网关拦截，即使状态码是 200 */
export function assertJsonBody(body: string): unknown {
  const trimmed = body.trim();

  if (HTML_BODY.test(trimmed)) {
    throw new McpError("gateway", {}, trimmed.slice(0, 200));
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new McpError("unknown", {}, trimmed.slice(0, 200));
  }
}

export function missingToolError(name: string, available: string[]): McpError {
  return new McpError("missing-tool", { tool: name, count: available.length });
}
