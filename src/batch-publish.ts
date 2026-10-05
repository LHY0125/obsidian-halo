import i18next from "i18next";
import type { App, TFile } from "obsidian";
import { renderErrorMessage } from "./i18n/error-message";
import type HaloService from "./service";
import type { LocalImageSummary } from "./service/image-upload";
import type { HaloPostFrontmatter } from "./service/local-content";
import { type McpCategoryItem, type McpTagItem, pickNewTerms } from "./service/post-mapping";
import type { HaloSetting, HaloSite } from "./settings";
import type { SiteResolution } from "./site-routing";
import { resolveSite } from "./site-routing";

/**
 * 批量路径的规划与执行。
 *
 * **本模块不是「纯逻辑」：它会渲染文案**（`runBatch` 用 `i18next` 与 `renderErrorMessage` 把
 * 失败原因渲染成用户能看懂的字符串）。这与 `transport/errors.ts`「不依赖 i18next」的约定
 * 不冲突 —— 那条约束只针对 `transport/`，那里的产出是给 UI 层做料的**描述符**（key/params）。
 * 这里相反：`BatchRunSummary` 是**终态产物**，`path` + `reason` 就是要直接喂给汇总弹窗的最终
 * 形态，中间再插一层 `{key, params}` 只会让 `PublishResult.reason`（已经是字符串）与错误描述符
 * 两种形态混在一起，调用方每次都得判一下手里是哪种。代价是这一层的测试需要初始化 i18next。
 *
 * ⚠️ **`BatchRunSummary.skipped` 是上面这条约定的唯一例外**，别按"这里不该有描述符"去改它：
 * 跳过原因必须在**汇总弹窗打开的那一刻**才用 `i18next` 渲染，而 `runBatch` 到那时早就返回了。
 * 提前渲染成字符串等于把界面语言钉死在执行那一刻，还会与确认弹窗里同一份数据的渲染路径
 * 分叉成两套文案。该字段的注释里有完整理由。
 */

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
 *
 * **`action === "unpublish"` 时既不调 `summarizeImages`、也不做概览跳过**：撤回不改写正文、
 * 不上传图片，为它读一遍正文只会制造一条答非所问的跳过理由（「读不出这篇笔记的内容」）。
 * 该分支下每篇条目的 `images` 是零值。
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

  // 复制一份而不是就地 push：`skipped` 是调用方的数组（`collectBatchCandidates` 的产物），
  // 本函数只是把它带下去。就地改会让「调用方手里那份」也被悄悄改掉 —— 一次规划改变了入参，
  // 而这层签名的读法是「这些是给你的原料」。概览阶段的跳过与解析阶段的跳过在这里**合流**，
  // 顺序是「先解析、后概览」，与用户看到的原因顺序一致。
  const allSkipped = [...skipped];

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
      let images: LocalImageSummary;

      if (action === "unpublish") {
        // **撤回不为概览读正文。** 两个理由，都不是性能：
        // ① 概览读不出来会把这一篇记成 `batch.skip_unreadable`，而那句给用户的理由是
        //    「读不出这篇笔记的内容」—— 对撤回**答非所问**：撤回根本不需要正文，用户会被
        //    引去看一个与他这次操作无关的问题，甚至因此以为这篇撤回不了。
        // ② 顺带省掉「跑一次批量撤回把每篇候选正文都读一遍」。
        // 零值而不是跳过渲染：撤回不上传图片，`summarizeSelection` 累加后 `pending` 与
        // `overLimit` 都是 0，确认弹窗那条「要传 N 张图」本来就不会渲染（它门控在
        // `pending > 0 || overLimit.length > 0` 上），所以这里不需要额外分档。
        images = { pending: 0, cached: 0, overLimit: [] };
      } else {
        try {
          images = await deps.summarizeImages(candidate);
        } catch (error) {
          // 概览要读笔记正文（`summarizeLocalImages` 在 `vault.read` 失败时抛），而**一篇读不出来
          // 不该让整份 118 篇的计划一起 reject**。这与上面 `listTaxonomy` 那条处置是同一条立场，
          // 只是失败方向更凶险：`runBatchCommand` 里 `planBatch` 是**裸调用**，异常直接冒到命令
          // 回调 —— 用户点了「批量发布」，没有弹窗、没有汇总、什么都没有，正是本计划要消灭的
          // 「说不清是哪一种失败」。
          //
          // 处置是**跳过这一篇**，而不是给它一个「空概览」蒙混过去：空的概览会让确认弹窗写着
          // 「待上传 0 张」，而执行阶段照样会把那几张贴上去 —— 用户在确认时看到的数字与实际
          // 发生的事不符。跳过则复用了既有的「这篇进不了批，原因是……」这条出路，
          // 用户能在确认弹窗的跳过清单里看见它、知道要去看一眼那篇笔记。
          // （**只有推草稿 / 发布走这条路** —— 撤回在上面那道 `action` 分支里就返回了。）
          allSkipped.push({ path: candidate.file.path, key: "batch.skip_unreadable" });

          // **但线索不能跟着一起吞掉。** 跳过是以「用户的笔记有问题」的措辞告诉他的
          //（「读不出这篇笔记的内容」），而这条 catch 同样会接住 `summarizeImages` 内部的
          // 类型错误 / 接口变更 —— 那时 118 篇会一起被跳过，用户去翻遍自己的笔记也找不到问题，
          // 因为它根本不在笔记里。控制台留一份带路径的原始错误，是「失败要说得出是哪种失败」
          // 在这条路径上的最低要求：至少有人能看出这是插件的问题。
          console.error(
            `[obsidian-halo] 读取笔记以统计图片失败，已把这一篇排除在本次批量之外：${candidate.file.path}`,
            error,
          );
          continue;
        }
      }

      items.push({ ...candidate, images });
    }

    // 整组都读不出来时不留一个 `items: []` 的空组：弹窗会为每个组渲染一行「站点名（N）」，
    // 而「A（0）」只会让用户怀疑自己看错了（`summarizeSelection` 同样只返回有勾选的组，
    // 为的是同一件事）。放在列分类标签**之前**顺带省掉那次无意义的 MCP 调用。
    if (items.length === 0) {
      continue;
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

  return { action, groups, skipped: allSkipped };
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

export interface BatchItemResult {
  path: string;
  ok: boolean;
  /** 失败时**已渲染好**的用户文案（`PublishResult.reason` 或渲染后的错误） */
  reason?: string;
}

export interface BatchRunSummary {
  action: BatchAction;
  results: BatchItemResult[];
  successCount: number;
  failureCount: number;
  /**
   * **执行前**就被排除的那些笔记，逐条带原因。汇总弹窗按它渲染「执行前跳过」那一段。
   *
   * 与 `results` 是两码事，绝不能合并：`results` 是「跑了但炸了」，这里是「压根没让它跑」。
   * 用户对这两者的处置**完全不同**（前者去站点上确认状态，后者去改配置或补发布），
   * 所以汇总里是**两个分开的段落**，不是一个列表。
   *
   * ⚠️ **这是本模块里唯一一处「带 `{key, params}` 描述符而不是渲染好的文案」的字段** ——
   * 与文件头「`BatchRunSummary` 是终态产物，不该再插一层描述符」那条约定**故意不同**。
   * 理由是渲染时机：跳过原因要在**汇总弹窗打开时**用 `i18next` 渲染，而 `runBatch` 到那时
   * 已经返回了。存渲染好的字符串就等于把语言钉死在执行那一刻，且与确认弹窗里同一份数据
   * 的渲染路径分叉成两套文案。`BatchItemResult.reason` 那边不存在这个问题 ——
   * 它的文案由服务层（`PublishResult.reason` / `renderErrorMessage`）产出，本来就是终态。
   */
  skipped: BatchSkip[];
  /**
   * `skipped.length`，汇总行那句「另有 N 篇在执行前就被跳过」用的数字。
   *
   * 与上面那份清单**同源**（都由 `plan.skipped` 决定），留着是因为它已经是既有字段、
   * 且汇总行说的是「整次运行的账」而与清单是两种读法。生产里两者恒等；
   * **清单那一段的标题数的是它自己列了几条**，不读这个字段 —— 标题与它下面那张清单
   * 必须对得上，否则会写「已跳过 5 篇」而只列 2 条。
   */
  skippedCount: number;
}

/**
 * 逐篇执行，**失败不中断**。
 *
 * 这是对上游「任一图片失败即中止发布」的刻意偏离，用户 2026-10-03 裁定只用于批量路径 ——
 * 单篇命令仍保留中止语义（那里用户盯着一篇，中止是最省事的处置）。
 * 批量场景下中止的代价完全不同：118 篇里第 3 篇失败会让后面 115 篇一篇都不发，
 * 而用户重跑时前两篇又要重走一遍。
 *
 * `selected` 是确认弹窗里勾选的路径集合（键是 `file.path`，与弹窗、与计划三处同一把键）。
 * **只跑勾选的** —— 整组都没勾的站点连 `serviceFor` 都不会被调用（不白建客户端）。
 *
 * 逐篇**顺序**执行而不是 `Promise.all`：批量操作会真的改站点与本地文件，
 * 顺序化让失败点可定位，也不会让一百多个并发请求撞上站点的限流。
 */
export async function runBatch(
  plan: BatchPlan,
  selected: Set<string>,
  serviceFor: (site: HaloSite) => HaloService,
): Promise<BatchRunSummary> {
  const results: BatchItemResult[] = [];

  // 空勾选 = 一次无操作，显式挡在最前面。
  //
  // 确认弹窗在零勾选时把「执行」按钮禁掉，但**那道闸门活在 UI 里**，而 `BatchConfirmModal`
  // 是导出的类（测试要用），程序化调用能绕过按钮直接 `confirm()` 交出一个空集合。
  // 调用方只把 `undefined` 当作「取消」，空集合就是「一篇都不发」—— 两者一旦被混淆，
  // 用户以为自己取消了、实际上整批被执行。
  //
  // 这道守卫在**行为上**与下面每组过滤后的 `items.length === 0` 重合（同样什么都不做），
  // 它多出来的是把「空集合是无操作」写成一条不依赖循环结构的不变式：
  // 将来谁调整分组过滤的写法，这条保护还在。
  if (selected.size === 0) {
    return {
      action: plan.action,
      results: [],
      successCount: 0,
      failureCount: 0,
      // 这条提前返回**同样**要带 `skipped`：漏掉它的话这条路径下 `skipped` 是 `undefined`，
      // 而汇总弹窗要读 `summary.skipped.length` —— `undefined.length` 直接抛，
      // 表现是「用户一个都没勾 → 点执行 → 汇总弹窗打不开」。类型系统看不见这件事
      //（接口上它是必填字段），判别它的只有测试。
      skipped: plan.skipped,
      skippedCount: plan.skipped.length,
    };
  }

  for (const group of plan.groups) {
    const items = group.items.filter((item) => selected.has(item.file.path));

    if (items.length === 0) {
      continue;
    }

    const service = serviceFor(group.site);

    for (const item of items) {
      try {
        if (plan.action === "unpublish") {
          // 撤回只动发布状态，连正文都不读 —— 没有理由为它去上传图片或回写笔记。
          // `remoteName` 在真实管线上必有值（`collectBatchCandidates` 对 unpublish 把没有
          // `halo.name` 的笔记拦成了 skipped）；这里的 `?? ""` 只是让一个手工构造的计划
          // 退化成「这一篇失败」而不是抛出去中断整批，服务端会用这个空名字回一个错误。
          await service.changePostPublish(item.remoteName ?? "", false);
          results.push({ path: item.file.path, ok: true });
          continue;
        }

        // 图片先上传：上传会改写笔记里的图片链接，而 `publishPost` 要用改写后的 markdown。
        // 任一图片失败就跳过这一篇 —— 「有的链接是远程、有的是本地」的半成品不落盘，
        // 与单篇路径的处置一致（上游同款）。**跳过 ≠ 中止**：循环继续走下一篇。
        const upload = await service.uploadImages({ file: item.file, silent: true });

        if (upload.failedCount > 0) {
          results.push({
            path: item.file.path,
            ok: false,
            reason: i18next.t("service.error_upload_images_failed_publish_aborted", { failed: upload.failedCount }),
          });
          continue;
        }

        const published = await service.publishPost(item.file, {
          markdown: upload.markdown,
          // 「推草稿」= 强制 false，「发布」= 强制 true。命令的意图高于单篇 frontmatter —
          // 用户点了「批量撤回」却因为某篇写着 publish: true 而被拦下，是这里最坏的表现。
          publishOverride: plan.action === "publish",
          // 批量路径**逐篇静默**：118 篇会弹 118 条成功便签，用户看不过来，
          // 也把「末尾有一次汇总」这件事淹掉了（汇总才是他真正要看的那份清单）。
          quiet: true,
        });

        results.push(
          published.ok
            ? { path: item.file.path, ok: true }
            : { path: item.file.path, ok: false, reason: published.reason },
        );
      } catch (error) {
        // `publishPost` 的契约是「不抛」，但整批的可用性不该押在这条契约上：
        // 一次未捕获的异常会让已经成功的十几篇**没有任何汇总**，用户以为全军覆没。
        results.push({ path: item.file.path, ok: false, reason: renderErrorMessage(error) });
      }
    }
  }

  return {
    action: plan.action,
    results,
    successCount: results.filter((item) => item.ok).length,
    failureCount: results.filter((item) => !item.ok).length,
    // 原样带下去、不复制：`runBatch` 只读它，弹窗也只读它。要复制的是**会往里 push 的那一层**
    //（`planBatch` 就是这么做的），这一层没有那个问题。
    skipped: plan.skipped,
    skippedCount: plan.skipped.length,
  };
}
