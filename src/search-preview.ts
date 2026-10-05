import { Notice } from "obsidian";
import { renderErrorMessage } from "./i18n/error-message";
import type { McpClient } from "./transport/mcp-client";

/**
 * `halo_search_content` 的结果项。
 *
 * 字段逐字取自 2026-10-05 实测的 outputSchema。`required` 是
 * `["type", "published", "recycled", "exposed", "categories", "tags"]` ——
 * **`name` / `title` / `excerpt` / `permalink` 都不在其中**，所以消费方必须自己兜底。
 */
export interface McpSearchItem {
  type?: "POST" | "SINGLE_PAGE";
  name?: string;
  title?: string;
  excerpt?: string;
  published?: boolean;
  recycled?: boolean;
  exposed?: boolean;
  categories?: string[];
  tags?: string[];
  permalink?: string;
}

export interface SearchResult {
  name: string;
  type: "POST" | "SINGLE_PAGE";
  title: string;
  excerpt: string;
  permalink: string;
  published: boolean;
  recycled: boolean;
}

/**
 * 去掉服务端在命中词上加的 `<B>` 高亮标签。
 *
 * **这不是可选项。** 实测站点返回的 `title` 里真的带它：
 * `"因为喜欢开源，我用 <B>Halo</B> 写了一个插件并发布到了应用市场"`。
 * `excerpt` 同样带 —— 2026-10-05 对站点跑 `halo_search_content({ query: "Halo", limit: 50 })`
 * 返回 7 条，其中 **2 条的 title 带高亮、4 条的 excerpt 带**（两个都带的是 2 条）。
 * 所以两个字段都得清（弹窗用 `setName` 显示标题、`setDesc` 显示摘要，都是按 textContent 渲染）。
 * 不清理的话，用户看到的就是字面的 `<B>` 与 `</B>`。
 *
 * **只去 B 标签，不做通用 HTML 剥离。** 通用剥离（`/<[^>]+>/g`）会**误命中**：
 * 用户正文里合法的 `<div>`、`<br>`、`<T>` 会被一起吃掉，而那是不可逆的信息损失 ——
 * 用户看不到自己原本写了什么。判据的两个方向都考虑过了：漏清理 → 显示乱码；
 * 过度清理 → 吞掉正文。选前者，因为它是**可见且可解释**的。
 */
export function stripHighlight(text: string): string {
  return text.replace(/<\/?b>/gi, "");
}

/**
 * 扁平搜索结果 → 弹窗要渲染的条目。
 *
 * 剔除缺 `name` 的项：`name` 是「打开这篇」唯一的定位依据，缺了它那一行按下去必然失败。
 * 列一个按了就坏的按钮比不列更糟（与 `toSelectablePosts` 同一条立场）。
 */
export function toSearchResults(items: McpSearchItem[]): SearchResult[] {
  const results: SearchResult[] = [];

  for (const item of items) {
    if (!item.name) {
      continue;
    }

    results.push({
      name: item.name,
      type: item.type ?? "POST",
      title: stripHighlight(item.title || item.name),
      excerpt: stripHighlight(item.excerpt ?? ""),
      permalink: item.permalink ?? "",
      published: item.published === true,
      recycled: item.recycled === true,
    });
  }

  return results;
}

/**
 * 跑一次全文查重。
 *
 * **不传 `published`**：草稿也要能查到 —— 查重的用途是「我是不是已经写过这个」，
 * 而一篇还没发布的草稿正是最需要被查出来的（否则会写第二遍）。
 * schema 的 `recycled` 默认就是 `false`（不查回收站）。
 *
 * ⚠️ **本函数有副作用：它自己弹 Notice**（加载失败时），并返回空数组、**不抛** ——
 * 与 `fetchSelectablePosts` 同款契约。命令入口不该把异常放给 Obsidian，
 * 它只会记进控制台，用户什么都看不到。
 */
export async function searchContent(client: McpClient, query: string): Promise<SearchResult[]> {
  try {
    const result = await client.callToolJson<{ items?: McpSearchItem[] }>("halo_search_content", {
      query,
      limit: 50,
    });

    return toSearchResults(result.items ?? []);
  } catch (error) {
    new Notice(renderErrorMessage(error));
    return [];
  }
}
