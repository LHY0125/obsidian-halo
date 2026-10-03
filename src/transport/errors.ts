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

/**
 * 工具执行失败。
 *
 * ⚠️ 这类失败以 `HTTP 200` + `result.isError: true` 送达，**不是 HTTP 错误**——
 * `classifyHttpFailure()` 看不到它。只检查 JSON-RPC 的 `error` 字段会把参数错误当成成功。
 * 归类沿用 `unknown`（服务端拒绝的原因千差万别，硬拆 kind 只会拆错），
 * 但**必须把服务端原文放进 `detail`**，否则用户看到「MCP 请求失败」却拿不到任何线索。
 */
export function toolFailureError(tool: string, message: string): McpError {
  return new McpError("unknown", { tool }, message);
}

/**
 * 一个错误「意味着什么」—— **尚未本地化**。
 *
 * `detail` 是服务端原文（工具级失败才有，见 `toolFailureError`）：它必须被交给 UI 层拼在译文之后，
 * 否则用户看到一句「MCP 请求失败」却拿不到任何线索。
 */
export interface ErrorDescriptor {
  key: string;
  params: Record<string, string | number>;
  detail?: string;
}

/**
 * 把任意抛出物归一化成可本地化的描述。
 *
 * **本模块不依赖 i18next**（见 file 首注释的同类约定）：这里只回答「用哪个 key、带什么参数、
 * 服务端原文是什么」，渲染成用户文案是 UI 边界的事 —— 见 `src/i18n/error-message.ts`。
 *
 * 存在的理由：调用点常有一个未校验的 `error as McpError` 断言，一旦逃出来的不是 McpError
 * （例如 initialize 返回体缺 serverInfo），直接读 `.key` 会把 undefined 渲染进提示 ——
 * 用户得到一条空白，而调用点的全部职责正是告诉用户哪儿不对。
 *
 * `fallbackKey` 是「连具体原因都拿不到」时的兜底，各调用点按自己的语义取
 * （读取失败说「文章不存在」，列表加载 / 自检说「连接失败」）。
 * 默认值就是「连接失败」——它同时是历史上写死在此处的那一个。
 */
export function describeError(error: unknown, fallbackKey = "common.error_connection_failed"): ErrorDescriptor {
  if (!(error instanceof McpError)) {
    return { key: fallbackKey, params: {} };
  }

  // detail 用**真值**判据而非 `??`：它合法地可以是空串（服务端失败了但没给原因），
  // 而拼一个空的 detail 只会留下一个孤零零的换行。
  return error.detail
    ? { key: error.key, params: error.params, detail: error.detail }
    : { key: error.key, params: error.params };
}
