/**
 * 通用翻页取数器 —— 本模块是**零项目内依赖的叶子**。
 */

/**
 * 列表工具每页取多少。**100 是 schema 的 `maximum`**，不是随手取的整数 ——
 * 传 101 会被服务端拒绝。（实测自 `halo_list_posts` / `halo_list_categories` 等工具的 inputSchema。）
 *
 * 定义在这里而不是各个调用点，是因为**四个调用点必须用同一个值**：
 * 分散定义时，改一处漏三处，而症状只是「某些列表莫名其妙少了后面的条目」。
 * `post-selection-model.ts` 仍然原路径重导出它，既有 import 不会断。
 */
export const LIST_PAGE_SIZE = 100;

/**
 * MCP 列表工具的统一返回外壳。
 *
 * 逐字取自实测：`halo_list_posts` / `halo_list_single_pages` / `halo_list_attachments` /
 * `halo_list_categories` / `halo_list_tags` 的 outputSchema 都声明了这 6 个字段，
 * 且 `required` 里**六个全在**。`size` 的上限统一是 100（`maximum: 100`）。
 */
export interface PagedResult<T> {
  items: T[];
  page: number;
  size: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
}

export interface FetchAllPagesOptions {
  /** 每页取多少。上限 100（schema 的 maximum），传大了会被服务端拒绝 */
  pageSize: number;
  /**
   * 最多翻几页。**默认 20**（= 2000 条）。
   *
   * 有上限不是为了省请求，是为了**保证终止**：站点侧若给出一个自相矛盾的
   * `hasNext`（永远为真），没有上限的循环会一直发请求直到 Obsidian 卡死。
   * 触顶时返回 `truncated: true`，调用方据此**明确告诉用户列表不完整** ——
   * 静默截断正是 1-B 反复处理的同一类问题。
   */
  maxPages?: number;
}

/** 翻页取数的结果。`truncated` 为真表示**列表不完整**，调用方必须提示用户 */
export interface FetchAllPagesResult<T> {
  items: T[];
  truncated: boolean;
}

/**
 * 按 `hasNext` 翻完一个列表工具的所有页。
 *
 * 抽成通用函数是因为**四个调用点**面临同一件事（分类、标签、拉取文章列表、附件列表），
 * 而 1-B 的记录显示它们此前各写各的：分类标签写死 `size: 100` 且**静默漏掉**后面的，
 * 拉取列表会提示但**不翻页**。两种处置都不对，且都对得不一致。
 *
 * **两条终止保证，缺一不可**：
 * ① `hasNext` 为假 —— 正常出口；
 * ② 某一页返回空 `items` —— 即使 `hasNext` 说还有。服务端自相矛盾的响应必须在这里挡住，
 *    否则这个循环会挂住 Obsidian 的主线程，而用户看到的是「插件卡死了」，无从自查。
 */
export async function fetchAllPages<T>(
  fetchPage: (page: number, size: number) => Promise<PagedResult<T>>,
  options: FetchAllPagesOptions,
): Promise<FetchAllPagesResult<T>> {
  const maxPages = options.maxPages ?? 20;
  const items: T[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const result = await fetchPage(page, options.pageSize);
    const batch = result.items ?? [];

    // 终止保证 ②：空页一律停。放在 `hasNext` 判断**之前** —— 反过来的话，
    // 一个永远说 hasNext:true 的服务端会让这个循环跑到 maxPages 才停，
    // 白打 20 次请求。
    if (batch.length === 0) {
      return { items, truncated: result.hasNext === true };
    }

    items.push(...batch);

    if (!result.hasNext) {
      return { items, truncated: false };
    }
  }

  // 走到这里说明翻满了 maxPages 而 hasNext 一直为真。
  return { items, truncated: true };
}
