import { CONTENT_TOOLSETS } from "./content-kind";
import { LIST_PAGE_SIZE, type PagedResult, fetchAllPages } from "./pagination";
import type { McpClient } from "./transport/mcp-client";

/**
 * 回收站里的内容类型。
 *
 * 取值与 `ContentKind` 同形（都是 `"post" | "page"`），但**刻意**写成独立别名而不是
 * 直接 `import type { ContentKind }`：回收站是**另一组能力** —— 列表要多传一个 `recycled`
 * 筛选，动作是「恢复」而不是「发布」。共用一个名字会让「改了内容类型」看起来自动等于
 * 「改了回收站类型」，而这两张能力表实际上是各自独立的（都只是恰好有这两档）。
 *
 * ⚠️ 诚实说明：TS 是结构化的，两个别名**互相可赋值**，所以这层分开是**命名上**的，
 * 不是类型系统强制的边界。真正保证两者一致的是它们都索引同一张 `CONTENT_TOOLSETS`。
 */
export type RecycleKind = "post" | "page";

/**
 * `halo_list_posts` / `halo_list_single_pages` 的列表项（回收站视角）。
 *
 * 文章与页面在回收站里的**字段集不同**：页面项没有 `categories` / `tags`
 * （2026-10-05 实测 `halo_list_single_pages { recycled: true }` 的返回体里没有这两个键）。
 * 所以这里的字段**全部可选** —— 把 `categories` / `tags` 写成必填的话，
 * 页面项会在类型上直接不可赋值。`?` 在这里是**承重**的，不是习惯性写法。
 *
 * 消费方只用到 `name` / `title` / `permalink` 三个；其余声明出来是为了让 fixture 与真实
 * 响应不失真（同 `McpContentItemBase.published` 的处置）。
 *
 * ⚠️ 与 `service/post-mapping.ts` 的 `McpPostItem` **刻意不复用**：那个类型为了发布链路
 * 声明了 `excerptRaw` / `autoGenerateExcerpt` / `cover` / `template` / `pinned` /
 * `priority` / `publishTime` / `allowComment` —— 回收站一个都用不到，复用它等于把
 * 发布链路的契约挂到回收站上。本模块是**独立实测**出来的一份契约，不跟着服务层漂移。
 */
export interface McpRecycledPostItem {
  name?: string;
  title?: string;
  slug?: string;
  published?: boolean;
  publishRequested?: boolean;
  recycled?: boolean;
  visible?: "PUBLIC" | "INTERNAL" | "PRIVATE";
  permalink?: string;
  categories?: string[];
  tags?: string[];
}

export interface RecycledItem {
  kind: RecycleKind;
  name: string;
  title: string;
  permalink: string;
  /**
   * 内容的类型名。取值与 `SearchResult.type` 同一套，由 `kind` 推出。
   *
   * ⚠️ **目前没有任何消费者** —— `recycle-modal.ts` 的两个弹窗都不读这个字段
   *（它们各自只知道自己的 `kind`，标题文案走 `recycle_modal.title_${kind}` /
   * `page_manager_modal.title`，行里只有标题与 permalink）。
   *
   * 保留而非删掉，是因为**它是「这一行是什么」这件事在数据里的唯一落点**：两个弹窗按内容类型
   * 分开（见 `recycle-modal.ts` 文件头与 `README.md`），而分开的理由正是「列表里没有哪一列能
   * 告诉你这一行是文章还是页面」。将来若要把两者合并成一张列表，那一列的数据就是它 ——
   * 到那时再回头补，就得同时改取数、映射与两个弹窗的渲染；现在留着只占一行。
   *
   * 说明白「没有消费者」比说「弹窗据此显示」重要：后者会让下一个读代码的人以为
   * 删掉它 UI 就会变，从而不敢动这个字段，或者反过来以为改它就能改 UI。
   */
  type: "POST" | "SINGLE_PAGE";
}

/**
 * 扁平列表项 → 回收站条目。
 *
 * 剔除缺 `name` 的项：`name` 是恢复时**唯一**的定位依据（`halo_restore_post` /
 * `halo_restore_single_page` 的 `required` 就是 `["name"]`），缺了它那一行按「恢复」
 * 必然失败 —— 与其让用户点一次报一次错，不如那一行根本不出现。
 */
export function toRecycledItems(items: McpRecycledPostItem[], kind: RecycleKind): RecycledItem[] {
  const result: RecycledItem[] = [];

  for (const item of items) {
    if (!item.name) {
      continue;
    }

    result.push({
      kind,
      name: item.name,
      title: item.title || item.name,
      permalink: item.permalink ?? "",
      type: kind === "post" ? "POST" : "SINGLE_PAGE",
    });
  }

  return result;
}

/**
 * 按 `kind` + `recycled` 取一页页取全内容。**本模块唯一的取数实现。**
 *
 * 为什么 `recycled` 是**必填的位置参数**、不给默认值：`halo_list_posts` /
 * `halo_list_single_pages` 的 `inputSchema` 里 `recycled` 的 `default` 是 **`false`**
 * （2026-10-05 实测），漏传会让这个函数返回**站点上全部内容**，而用户以为自己在看回收站。
 * 两处调用点（回收站弹窗取 `true`、管理页面弹窗取 `false`）**看起来都在正常工作** ——
 * 唯一能把它挡住的办法就是让编译器要求每个调用点显式表态。
 *
 * 保留一个私有实现而不是两份：`recycled` 传错的表现是**两个弹窗的内容正好对调**
 * （「管理页面」列出回收站里的、「回收站」列出全部），而这不是任何测试之外能看出来的。
 * 两份实现会各自漂移，一份不会。
 *
 * **必须翻页**：站点实测回收站里有 **4 篇文章 + 1 个页面**（2026-10-05），一页够用 ——
 * 但「一页够用」是**当前数据规模**的事实，不是契约。漏掉一篇的表现是
 * 「用户以为回收站是空的」，而多翻一页的代价只是一次请求。
 */
async function fetchByKind(
  client: McpClient,
  kind: RecycleKind,
  recycled: boolean,
): Promise<{ items: RecycledItem[]; truncated: boolean }> {
  const { items, truncated } = await fetchAllPages<McpRecycledPostItem>(
    async (page, size) =>
      await client.callToolJson<PagedResult<McpRecycledPostItem>>(CONTENT_TOOLSETS[kind].list, {
        page,
        size,
        // 逐页都传，不是只给第一页：只给第一页加的话，「第 2 页突然返回全部内容」
        // 会是一个极难反查的脏数据来源。
        recycled,
      }),
    { pageSize: LIST_PAGE_SIZE },
  );

  return { items: toRecycledItems(items, kind), truncated };
}

/**
 * 取某一类内容在回收站里的全部条目。
 *
 * `truncated` 交给调用方去提示：本层既不吞掉也不自己弹通知（与 `fetchAttachments` 同一处置）。
 */
export function fetchRecycled(
  client: McpClient,
  kind: RecycleKind,
): Promise<{ items: RecycledItem[]; truncated: boolean }> {
  return fetchByKind(client, kind, true);
}

/**
 * 取**不在回收站**的页面（`PageManagerModal` 用）。
 *
 * 与 `fetchRecycled` 共用同一个私有 `fetchByKind` —— **刻意不写第二份取数**：
 * `recycled` 传错的表现是两个弹窗的内容**正好对调**（「管理页面」列出回收站里的、
 * 「回收站」列出全部），而两个弹窗看起来都「正常工作」。
 *
 * 返回形状与 `fetchRecycled` **保持一致**（把 `truncated` 一并交给调用方）而不是只给
 * `items`：一旦只给数组，「触顶了」这件事在跨过模块边界时就没了 —— 两个公开取数函数
 * 形状不同还会让每个调用方都得先看一眼「这个要不要提示」。触顶提示由调用方出，
 * 本层既不吞掉也不自己弹通知（三处取数同一处置）。
 */
export function fetchActivePages(client: McpClient): Promise<{ items: RecycledItem[]; truncated: boolean }> {
  return fetchByKind(client, "page", false);
}

/**
 * 把一条内容从回收站恢复。
 *
 * 工具名由 `item.kind` 决定 —— 文章与页面是**两个不同的工具**（`halo_restore_post` /
 * `halo_restore_single_page`），写死一个会把页面当文章恢复。取 `item.kind` 而不是
 * 再收一个 `kind` 入参，是为了让「这个条目是从哪来的」与「用哪个工具恢复」不可能对不上。
 *
 * 走 `callToolVoid`：恢复工具最可能回一句确认文案，用 `callToolJson` 会在
 * **服务端已经恢复成功之后**抛错，用户看到「恢复失败」而那篇其实已经回来了。
 */
export async function restoreRecycled(client: McpClient, item: RecycledItem): Promise<void> {
  await client.callToolVoid(CONTENT_TOOLSETS[item.kind].restore, { name: item.name });
}
