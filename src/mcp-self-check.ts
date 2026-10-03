import i18next from "i18next";
import { renderErrorMessage } from "./i18n/error-message";
import type { McpError } from "./transport/errors";
import { McpClient } from "./transport/mcp-client";

/**
 * 自检与契约测试共同断言的工具集。站点侧少掉任何一个，插件都会在**对应的那条路径上**静默失效，
 * 所以这份清单必须覆盖全部被调用的工具 —— 漏一个，防线就在那个工具上开了口子。
 *
 * 成分（逐条核对过，两类）：
 * - **当前代码实际调用（10 个）**：文章列表 / 读取 / 新建 / 修改、发布状态、
 *   分类与标签的列举及创建、附件上传。
 * - **设计预留（3 个）**：`halo_recycle_post`、`halo_restore_post`、`halo_search_content` ——
 *   回收站与全文检索尚未接进命令，但站点侧若撤下它们，同样说明工具集已经变了，提前炸出来更好。
 *
 * 评论、独立页面、主题设置等运维类工具刻意不在其中。
 *
 * 清单不敢靠「看起来对」：2026-10-04 对真实站点拉过一次 `tools/list`（`halo-mcp-server` 1.2.0，
 * 共 44 个工具），这 13 项**逐条命中、missing 为空**。契约测试 `pnpm test:contract` 是它的自动化版本。
 */
export const REQUIRED_TOOLS: readonly string[] = [
  "halo_get_post",
  "halo_list_posts",
  "halo_create_post",
  "halo_update_post",
  "halo_set_post_publish_state",
  "halo_recycle_post",
  "halo_restore_post",
  "halo_list_categories",
  "halo_create_category",
  "halo_list_tags",
  "halo_create_tag",
  "halo_search_content",
  "halo_upload_attachment",
];

export interface SelfCheckReport {
  ok: boolean;
  endpoint: string;
  server?: { name: string; version: string; protocolVersion: string };
  availableCount: number;
  missing: string[];
  error?: McpError;
}

/** 探测站点 MCP 端点：握手 + 断言必需工具存在。不抛异常，一切结论走返回值。 */
export async function runSelfCheck(endpoint: string, token: string): Promise<SelfCheckReport> {
  const client = new McpClient({ endpoint, token });

  try {
    const info = await client.initialize();
    const names = (await client.listTools()).map((tool) => tool.name);

    return {
      ok: REQUIRED_TOOLS.every((tool) => names.includes(tool)),
      endpoint,
      server: {
        name: info.serverInfo.name,
        version: info.serverInfo.version,
        protocolVersion: info.protocolVersion,
      },
      availableCount: names.length,
      missing: REQUIRED_TOOLS.filter((tool) => !names.includes(tool)),
    };
  } catch (error) {
    return {
      ok: false,
      endpoint,
      availableCount: 0,
      missing: [...REQUIRED_TOOLS],
      error: error as McpError,
    };
  }
}

/**
 * 自检失败时给用户看的**完整文案**：「自检失败」框架 + 具体原因（`McpError` 的 key 本就是
 * 可操作的处置指引：核对密钥 / 为该密钥勾工具授权 / 检查端点与插件），**并把服务端原文一并附上**。
 *
 * 自检这一处为什么要拼 `detail`（而服务层的「发布失败」另有固定框架）：用户跑自检**恰恰是在
 * 出问题的时候**，此时把服务端原文藏起来，等于把诊断工具最该给的那条线索掐掉。
 * 工具级失败（HTTP 200 + `isError`）更是只剩 `detail` 可说 —— 见 `transport/errors.ts` 的 `toolFailureError`。
 *
 * 另外两件事顺带解决了：
 * - 它**收掉了两处调用点重复的框架 key**：命令面板的自检与站点编辑弹窗的「验证」按钮
 *   原本各写一遍 `command.mcp_self_check.error_failed`，改文案时容易只改一处；
 * - 这条路径**第一次有了判别器**：`main.ts` 与弹窗都没有测试脚手架，渲染逻辑抽到这里才测得到。
 *
 * 本模块因此开始依赖 i18next。放这里（而不是放回两个调用点）是刻意的：自检模块已经拥有
 * `REQUIRED_TOOLS` 与该命令的语义，它的用户文案由它自己拥有是自然的；放回调用点则等于
 * 为「可测」付出「无法测」的代价。（`transport/` 仍然零 i18next 依赖，那条约定未受影响。）
 */
export function describeSelfCheckFailure(error: unknown): string {
  // `escapeValue: false` 是**必须的**，不是顺手关的：i18next 默认对插值做 HTML 转义，而这里插进去的
  // 是**已经渲染好的用户文案**（可能含服务端原文），Obsidian 的 Notice 按纯文本显示，不解析 HTML。
  // 开着转义的后果很具体：网关类失败的 `detail` 是一段 HTML 片段，会被转义成 `&lt;!doctype …&gt;`，
  // 用户看到的是一堆实体字符而不是服务端原话 —— 比不给原文更糟。
  // （其余调用点不经 i18next 插值，故没有这个问题。）
  return i18next.t("command.mcp_self_check.error_failed", {
    message: renderErrorMessage(error),
    interpolation: { escapeValue: false },
  });
}
