import type { App, TFile } from "obsidian";
import type { LocalImageSummary } from "./service/image-upload";
import type { HaloPostFrontmatter } from "./service/local-content";
import { type McpCategoryItem, type McpTagItem, pickNewTerms } from "./service/post-mapping";
import type { HaloSetting, HaloSite } from "./settings";
import type { SiteResolution } from "./site-routing";
import { resolveSite } from "./site-routing";

/** 三个批量命令。`unpublish` 与另两个走的是完全不同的 MCP 工具，故显式分档 */
export type BatchAction = "draft" | "publish" | "unpublish";

/**
 * 一篇被跳过的笔记。**只给 i18n 键与参数，不渲染文案** ——
 * 与 `transport/errors.ts` 同一套分层：渲染需要 i18next，放在 UI 侧。
 */
export interface BatchSkip {
  path: string;
  key: string;
  params?: Record<string, unknown>;
}

export interface BatchCandidate {
  file: TFile;
  resolution: SiteResolution;
  /**
   * 归一化后的 `halo.name`。有它才是「已发布过」，撤回也才有对象。
   *
   * **只有「有名字」与「没有」两档**：显式空串在解析时就收敛成 `undefined`（见
   * `collectBatchCandidates`）—— `halo.name: ""` 的语义是「还没发布过」，留着空串会让
   * 下游多出一个既非更新、也非新建的第三态。
   */
  remoteName?: string;
  /** frontmatter 里写着的分类/标签**显示名**（还没解析成资源名） */
  categories: string[];
  tags: string[];
}

/**
 * 已解析出站点的候选。
 *
 * 单独一档是为了让分桶时**不必**到处强转 `resolution.site`：过滤后的数组若仍是
 * `BatchCandidate[]`，`bucket[0].resolution.site` 就得靠 `as` 才编得过，而 `as` 会把
 * 「这里其实可能不是 resolved」这件事从类型里抹掉 —— 将来谁把过滤删了，类型系统不会拦。
 */
type ResolvedCandidate = BatchCandidate & { resolution: Extract<SiteResolution, { kind: "resolved" }> };

/** 计划里的一个条目：候选 + 它自己的图片概览（勾选变化时汇总要按它重算） */
export interface BatchItem extends BatchCandidate {
  images: LocalImageSummary;
}

export interface BatchGroup {
  site: HaloSite;
  items: BatchItem[];
  /**
   * 该站点的分类/标签**快照**，在 `planBatch` 里取一次。
   * 留着它才能让「将新建」跟着勾选实时重算，而不必每勾一次就打一次 MCP。
   */
  taxonomy: { categories: McpCategoryItem[]; tags: McpTagItem[] };
}

export interface BatchPlan {
  action: BatchAction;
  groups: BatchGroup[];
  skipped: BatchSkip[];
}

/**
 * 按目录/标签筛出可批量的笔记，并逐篇解析目标站点。
 *
 * 三种「不能进批」的情况各有各的键，**绝不合并成一句「失败」**：用户要据此决定
 * 是去补配置（未知站点）、去补发布（还没发过）、还是把这篇排除在外（需要手选站点）。
 * 批量路径**不弹站点选择弹窗** —— 一篇一弹会把「批量」变成 118 次点击。
 */
export function collectBatchCandidates(
  files: TFile[],
  app: App,
  settings: HaloSetting,
  action: BatchAction,
): { candidates: BatchCandidate[]; skipped: BatchSkip[] } {
  const candidates: BatchCandidate[] = [];
  const skipped: BatchSkip[] = [];

  for (const file of files) {
    const matterData = app.metadataCache.getFileCache(file)?.frontmatter as HaloPostFrontmatter | undefined;
    const resolution = resolveSite(settings.sites, settings.siteRouting ?? [], file.path, matterData?.halo?.site);

    if (resolution.kind === "needs-choice") {
      skipped.push({ path: file.path, key: "batch.skip_needs_choice" });
      continue;
    }

    if (resolution.kind === "no-sites") {
      skipped.push({ path: file.path, key: "batch.skip_no_sites" });
      continue;
    }

    if (resolution.kind === "unknown-site") {
      skipped.push({ path: file.path, key: "batch.skip_unknown_site", params: { url: resolution.url } });
      continue;
    }

    if (resolution.kind === "unknown-rule-site") {
      skipped.push({
        path: file.path,
        key: "batch.skip_unknown_rule_site",
        params: { pattern: resolution.pattern, url: resolution.url },
      });
      continue;
    }

    // 归一化掉显式空串：`halo.name: ""` 在单篇路径（`service/index.ts` 的 `planPublish`）走的
    // 就是**新建**分支，那里已经把这件事收敛成 `undefined` 并写明理由。批量路径与它必须逐字对齐 ——
    // 否则同一个 `halo.name: ""` 在单篇下是「新建」、在批量下 `remoteName` 是 `""`，而下游一旦按
    // 「有名字就更新」判档，就会拿 `""` 当远端文章名去调 MCP，**逐篇失败**。
    // 这条归一化也让本字段对下游只有「有名字」与「没有」两档，与它自己的注释所说的一致。
    const remoteName = matterData?.halo?.name || undefined;

    // 撤回只对已经发布过的笔记有意义：没有 halo.name 就没有可撤回的远端文章。
    // 把它列进候选会让用户在清单里看到它、确认、然后在汇总里看到它"失败" —— 而它从一开始就不该在。
    if (action === "unpublish" && !remoteName) {
      skipped.push({ path: file.path, key: "batch.skip_not_published" });
      continue;
    }

    candidates.push({
      file,
      resolution,
      remoteName,
      categories: matterData?.categories ?? [],
      tags: matterData?.tags ?? [],
    });
  }

  return { candidates, skipped };
}

/**
 * 把候选整理成「按站点分组」的完整清单，并给每组取一份分类/标签快照。
 *
 * **刻意不算汇总数字**（"将新建 N 个标签""要传 N 张图"）—— 那些是
 * `summarizeSelection()` 的活，因为确认弹窗里用户会勾选/取消勾选，汇总必须跟着变。
 * 本函数只做一次性的、与勾选无关的重活：解析站点、按站点取分类标签快照、逐篇扫图片。
 *
 * `skipped` 与 `action` 由调用方传进来而不是在这里算：跳过发生在**解析阶段**
 * （`collectBatchCandidates`），而计划只是把它们原样带给确认弹窗。
 * 分开的好处是两者各自可测，代价是组装时不能漏 —— 漏掉 `skipped` 的话，
 * 确认弹窗上的「已跳过 N 篇」永远是 0，用户会以为所有笔记都在清单里。
 *
 * `deps` 注入也是为了让这层可测：`listTaxonomy` 走 MCP、`summarizeImages` 读文件，
 * 两者都是副作用，而本函数的产出全是纯数据。
 */
export async function planBatch(
  candidates: BatchCandidate[],
  skipped: BatchSkip[],
  action: BatchAction,
  deps: {
    listTaxonomy: (site: HaloSite) => Promise<{ categories: McpCategoryItem[]; tags: McpTagItem[] }>;
    summarizeImages: (candidate: BatchCandidate) => Promise<LocalImageSummary>;
  },
): Promise<BatchPlan> {
  const resolved = candidates.filter(
    (candidate): candidate is ResolvedCandidate => candidate.resolution.kind === "resolved",
  );

  // 先按站点分桶，再逐桶干活。**分桶必须在最前面**：分类标签要按站点整桶取一次，
  // 边遍历边取会让"这个站点的候选还没遍历完"变成一道需要额外小心才能维持的不变式。
  const buckets = new Map<string, ResolvedCandidate[]>();

  for (const candidate of resolved) {
    const key = candidate.resolution.site.url;
    const bucket = buckets.get(key);

    if (bucket) {
      bucket.push(candidate);
    } else {
      buckets.set(key, [candidate]);
    }
  }

  const groups: BatchGroup[] = [];

  for (const bucket of buckets.values()) {
    const site = bucket[0].resolution.site;
    const items: BatchItem[] = [];

    for (const candidate of bucket) {
      items.push({ ...candidate, images: await deps.summarizeImages(candidate) });
    }

    // 分类/标签**每个站点只取一次**：118 篇各取一次会是 118 次 MCP 调用，
    // 而它们本来就与"是哪一篇"无关。
    let taxonomy: BatchGroup["taxonomy"] = { categories: [], tags: [] };

    try {
      taxonomy = await deps.listTaxonomy(site);
    } catch {
      // 列表失败**不让整批不可用**：分类标签本来就有「解析失败就跳过该字段」的既有语义。
      // 快照留空会让 `summarizeSelection` 把该组的分类全列成"将新建" —— 宁可多列也不要漏列：
      // 多列的代价是用户看到"将新建：技术"而站点上其实有，漏列的代价是他以为不会建而执行时建了。
      // 真正的失败会在执行阶段逐篇记进汇总。
      taxonomy = { categories: [], tags: [] };
    }

    groups.push({ site, items, taxonomy });
  }

  return { action, groups, skipped };
}

/** 一次勾选范围下的汇总。弹窗每变一次勾选就重算一次 */
export interface BatchSelectionSummary {
  total: number;
  groups: { site: HaloSite; count: number; newCategories: string[]; newTags: string[]; images: LocalImageSummary }[];
}

/**
 * 按**勾选范围**算汇总。
 *
 * 抽成纯函数是因为确认弹窗要跟着勾选实时更新它 —— 用户在清单里取消勾选几篇之后，
 * 弹窗上的「将发布 N 篇 / 将新建这些标签 / 要传 N 张图」必须同步变小。
 * 汇总按整份 plan 算的话，用户会以为自己的取消没生效。
 *
 * 只返回**有勾选项**的组：取消掉某一站的全部勾选后那一组整块消失，而不是显示成「0 篇」——
 * 一张列着三个"0"的清单只会让人怀疑自己看错了。
 */
export function summarizeSelection(plan: BatchPlan, selected: Set<string>): BatchSelectionSummary {
  const groups: BatchSelectionSummary["groups"] = [];
  let total = 0;

  for (const group of plan.groups) {
    const picked = group.items.filter((item) => selected.has(item.file.path));

    if (picked.length === 0) {
      continue;
    }

    total += picked.length;

    // 并集**先去重再比**：多篇笔记打同一个标签是常态，不去重的话确认弹窗上会写
    // 「将新建：Halo、Halo」——用户会以为要建两个同名标签，而执行时只会建一个。
    // 顺序按首次出现，让清单读起来与笔记的排列一致。
    const images: LocalImageSummary = { pending: 0, cached: 0, overLimit: [] };

    for (const item of picked) {
      images.pending += item.images.pending;
      images.cached += item.images.cached;

      // 同一个超限文件可能被多篇笔记引用，累加时会重复；这里按文件名去重。
      for (const name of item.images.overLimit) {
        if (!images.overLimit.includes(name)) {
          images.overLimit.push(name);
        }
      }
    }

    groups.push({
      site: group.site,
      count: picked.length,
      newCategories: pickNewTerms([...new Set(picked.flatMap((item) => item.categories))], group.taxonomy.categories),
      newTags: pickNewTerms([...new Set(picked.flatMap((item) => item.tags))], group.taxonomy.tags),
      images,
    });
  }

  return { total, groups };
}
