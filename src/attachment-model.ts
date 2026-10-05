import { LIST_PAGE_SIZE, type PagedResult, fetchAllPages } from "./pagination";
import type { McpClient } from "./transport/mcp-client";

/**
 * `halo_list_attachments` / `halo_get_attachment` 的项。
 *
 * 字段逐字取自 2026-10-05 实测的 outputSchema。
 * ⚠️ **`required` 是空数组 `[]`** —— 全部字段可选，所以消费方必须逐项兜底。
 * 这与文章/页面的列表项不同（那两个至少 required 了 3–5 个字段）。
 */
export interface McpAttachmentItem {
  name?: string;
  displayName?: string;
  groupName?: string;
  policyName?: string;
  ownerName?: string;
  mediaType?: string;
  size?: number;
  permalink?: string;
  /** 按尺寸名索引的缩略图 URL。**本阶段不使用** —— 声明它只为说明这里刻意不用 */
  thumbnails?: Record<string, string>;
  version?: number;
}

export interface AttachmentItem {
  name: string;
  displayName: string;
  mediaType: string;
  size: number;
  permalink: string;
  /** 删除接口的 `expectedVersion` 是**必填**的，所以它必须一路带到底 */
  version: number;
  isImage: boolean;
}

/**
 * 扁平附件项 → 弹窗要渲染的条目。
 *
 * 剔除缺 `name` 的项：`name` 是删除时唯一的定位依据（`halo_delete_attachment` 的
 * `required` 就是 `["name", "expectedVersion"]`），缺了它那一行按「删除」必然失败。
 */
export function toAttachmentItems(items: McpAttachmentItem[]): AttachmentItem[] {
  const result: AttachmentItem[] = [];

  for (const item of items) {
    if (!item.name) {
      continue;
    }

    result.push({
      name: item.name,
      displayName: item.displayName || item.name,
      mediaType: item.mediaType ?? "",
      size: item.size ?? 0,
      permalink: item.permalink ?? "",
      // 回落 0 而不是 `undefined`：`expectedVersion` 是必填的，传 undefined 会被
      // JSON.stringify 丢掉，服务端报「缺参数」—— 而用户此刻需要知道的是
      // 「这个附件的版本号读不出来」，不是「参数错误」。
      version: item.version ?? 0,
      // 按 mediaType 判而不是按扩展名：mediaType 是服务端探测的，比文件名可信
      isImage: (item.mediaType ?? "").startsWith("image/"),
    });
  }

  return result;
}

/** 人类可读的字节数。按 1024 进制 —— 与 Halo 后台的显示一致 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * 取全部附件。
 *
 * **必须翻页**：站点实测有 **264 个附件、88 页**（每页 3 个时是 88 页；按 100 一页算是 3 页）。
 * 只取一页会让用户看到 100 个，而他会以为站点上只有 100 个 —— 这正是 1-B 反复处理的
 * 「静默截断」。触顶时把 `truncated` 交给调用方去提示。
 *
 * ⚠️ **服务端没有提供任何筛选参数**：`halo_list_attachments` 的 `inputSchema` 只有
 * `{ page, size }`（2026-10-05 实测），**没有** `keyword` / `mediaType` / `groupName` 之类的字段。
 * 所以「按类型筛」「按名字搜」这类需求若要做，只有在**取回来之后**在本地过一遍 ——
 * 代价是「先翻完所有页再筛」。本阶段刻意不做（YAGNI），
 * 写在这里是为了让下一个想加筛选的人先知道：那不是给这个函数加一个入参就能办到的事。
 */
export async function fetchAttachments(client: McpClient): Promise<{ items: AttachmentItem[]; truncated: boolean }> {
  const { items, truncated } = await fetchAllPages<McpAttachmentItem>(
    async (page, size) =>
      await client.callToolJson<PagedResult<McpAttachmentItem>>("halo_list_attachments", { page, size }),
    { pageSize: LIST_PAGE_SIZE },
  );

  return { items: toAttachmentItems(items), truncated };
}

/**
 * 删除一个附件。
 *
 * ⚠️ **`expectedVersion` 是必填的**（实测 `required: ["name", "expectedVersion"]`）——
 * 这是 Halo 的乐观锁：版本号对不上说明这个附件在用户看到它之后被改过，
 * 服务端会拒绝，而不是删掉一个用户没看过的版本。
 *
 * 走 `callToolVoid`：删除工具最可能回一句确认文案，用 `callToolJson` 会在删成功之后抛错。
 */
export async function deleteAttachment(client: McpClient, item: AttachmentItem): Promise<void> {
  await client.callToolVoid("halo_delete_attachment", {
    name: item.name,
    expectedVersion: item.version,
  });
}
