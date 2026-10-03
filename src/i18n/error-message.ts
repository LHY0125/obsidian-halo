import i18next from "i18next";
import { describeError } from "../transport/errors";

/**
 * 把服务端原文接到**已译好**的提示语后面。
 *
 * 必须显示：工具级失败（HTTP 200 + `isError: true`）的全部线索都在 `detail` 里
 * （见 `transport/errors.ts` 的 `toolFailureError`），只弹一句泛泛的提示会让用户完全无从自查。
 *
 * 拼接用换行而非标点：`detail` 是服务端原文、未经本地化，标点却需要翻译。
 * 「有没有 detail」的判据不在这里，在 `describeError`（真值判断 —— 空串不算，否则会多出一个空行）。
 *
 * 需要**先拼自己的框架**再附原因时用它（例如发布失败：保留「发布失败」这句话，而不是换成
 * `transport.error.*` 的处置指引）；否则直接用下面的 `renderErrorMessage`。
 */
export function withErrorDetail(message: string, error: unknown): string {
  // 这里只取 `detail`，`describeError` 的 `fallbackKey` 与本次调用无关，故用默认值
  const { detail } = describeError(error);

  return detail ? `${message}\n${detail}` : message;
}

/**
 * 错误 → 用户可见文案：命中 `McpError` 就用它自带的 key（`transport.error.*` 本就是**可操作的
 * 处置指引**：核对密钥 / 为该密钥勾工具授权 / 检查端点与插件），否则用 `fallbackKey`。
 *
 * 这是「一个错误该怎么显示给用户」的**唯一实现** —— 服务层的读取/解析失败文案与拉取弹窗的
 * 列表加载都走它。它的上半段（key/params/detail 的归一化）在 `transport/errors.ts`，
 * 那里刻意不依赖 i18next；下半段（拼 detail）是本文件的 `withErrorDetail`。
 * **不要在任何调用点重新拼一遍这两步**，那正是这次收敛要消灭的重复。
 */
export function renderErrorMessage(error: unknown, fallbackKey?: string): string {
  const { key, params } = describeError(error, fallbackKey);

  return withErrorDetail(i18next.t(key, params), error);
}
