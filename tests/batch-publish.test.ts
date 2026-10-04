import { beforeAll, describe, expect, it } from "@rstest/core";
import type { App, TFile } from "obsidian";
import {
  type BatchAction,
  type BatchCandidate,
  type BatchPlan,
  type BatchSkip,
  collectBatchCandidates,
  planBatch,
  runBatch,
  summarizeSelection,
} from "src/batch-publish";
import { initializeI18n } from "src/i18n";
import type HaloService from "src/service";
import type { HaloSetting, HaloSite } from "src/settings";
import type { SiteRoutingRule } from "src/site-routing";

/**
 * `src/batch-publish.ts` 的测试。
 *
 * 本文件里凡断言「某件事**没有**发生」，都必须能在同一个用例里指出它**本可以**发生 ——
 * 这条纪律是被前几个任务教出来的：`expect(calls).toEqual([])` 这类断言在「代码根本没走到」
 * 时同样为真，于是它可能永久为真而没人发现。下面每处「空」断言旁边都配了它的对照物。
 */

/**
 * 初始化 i18n —— 走**生产同一条入口** `initializeI18n()`（`main.ts` 的 `onload` 调的就是它）。
 *
 * `runBatch` 现在会渲染文案（`PublishResult.reason` 与 `renderErrorMessage` 的产物都直接
 * 进汇总、进弹窗），所以「失败原因里带着失败的张数」这类断言只有在 i18next 真的加载了
 * 资源之后才有判别力：不初始化时 `i18next.t()` 原样返回**键名**，`{{failed}}` 不被插值，
 * `toContain("1")` 会去键名字符串里找那个数字 —— 找不到，用例红得莫名其妙。
 */
beforeAll(async () => {
  await initializeI18n("en");
});

const siteA: HaloSite = { name: "A", url: "https://a.example.com", token: "", mcpToken: "", default: true };
const siteB: HaloSite = { name: "B", url: "https://b.example.com", token: "", mcpToken: "", default: false };

/** 造一个只有 `path` 有意义的假文件：本模块只读它的 `path`，其余字段不参与判断 */
function fileAt(path: string): TFile {
  return { path } as TFile;
}

/**
 * 造一个假的 App，`metadataCache.getFileCache(path)` 从传入的 frontmatter 表里取。
 *
 * 本模块只用到这一个 Obsidian API，所以假件的形状只需覆盖它 ——
 * 比把 `tests/setup.ts` 那套整体 mock 搬过来更贴切，也让「读了哪个文件」可断言。
 */
function appWith(frontmatters: Record<string, Record<string, unknown>>): App {
  return {
    metadataCache: {
      getFileCache: (file: TFile) =>
        frontmatters[file.path] === undefined ? null : { frontmatter: frontmatters[file.path] },
    },
  } as unknown as App;
}

/** 直接造一个「已解析好」的候选，用来单测 `planBatch`（它不负责解析站点） */
function candidate(path: string, site: HaloSite, categories: string[] = [], tags: string[] = []): BatchCandidate {
  return {
    file: fileAt(path),
    resolution: { kind: "resolved", site, source: "rule", pattern: "**" },
    categories,
    tags,
  };
}

/**
 * 取候选解析出的站点 URL。
 *
 * 不用 `as` 强转：强转会把「解析结果其实不是 resolved」这个事实抹掉，
 * 断言照常通过，而候选的站点归属根本没被验证过。这里让它直接抛。
 */
function resolvedSiteUrl(item: BatchCandidate): string {
  if (item.resolution.kind !== "resolved") {
    throw new Error(`候选本应解析出站点，实际是 ${item.resolution.kind}`);
  }

  return item.resolution.site.url;
}

function makeSettings(rules: SiteRoutingRule[] = [], sites: HaloSite[] = [siteA, siteB]): HaloSetting {
  return {
    settingsVersion: 1,
    sites,
    publishByDefault: false,
    skipPreviewOnPublish: false,
    siteRouting: rules,
    replaceImageLinks: true,
    imageUploadCache: {},
  };
}

/**
 * 把跳过记录压成 `路径 | 键` 的字符串。
 *
 * 直接 `toEqual` 记录数组时 rstest 会把嵌套结构打平成 `{ path: 'a.md', …(2) }`，
 * 断言失败时看不出差在哪个字段 —— 而键名正是这些用例要钉的东西。压成扁平的字符串数组后，
 * diff 是逐字可读的。`params` 另外单独断言（顶层对象不会被截断）。
 */
function skipSignatures(skipped: BatchSkip[]): string[] {
  return skipped.map((record) => `${record.path} | ${record.key}`);
}

describe("collectBatchCandidates", () => {
  it("规则命中的笔记归到对应站点（end-to-end 走 resolveSite）", () => {
    const { candidates, skipped } = collectBatchCandidates(
      [fileAt("博客/技术/a.md"), fileAt("日记/b.md")],
      appWith({ "博客/技术/a.md": { title: "A" }, "日记/b.md": { title: "B" } }),
      makeSettings([{ pattern: "博客/**", site: siteB.url }]),
      "draft",
    );

    expect(candidates.map((item) => [item.file.path, resolvedSiteUrl(item)])).toEqual([
      ["博客/技术/a.md", siteB.url],
      ["日记/b.md", siteA.url],
    ]);
    // 「没跳过任何一篇」这条**空**断言本身是弱断言，但上面那条非空断言就是它的对照物：
    // 一个「把所有笔记都当无法解析」的实现会在上面先失败。
    expect(skipSignatures(skipped)).toEqual([]);
  });

  it("解析不出站点的笔记进 skipped，带上**具体原因**而不是一句「失败」", () => {
    const { candidates, skipped } = collectBatchCandidates(
      [fileAt("a.md")],
      appWith({ "a.md": { title: "A", halo: { site: "https://gone.example.com" } } }),
      makeSettings([]),
      "draft",
    );

    // 这两条断言必须成对看：`candidates` 为空也可能是「压根没进循环」，
    // 而下一条非空的 skipped（还带着笔记里的那个 URL）证明循环跑了、且这一篇是被**判**掉的。
    expect(candidates).toEqual([]);
    expect(skipSignatures(skipped)).toEqual(["a.md | batch.skip_unknown_site"]);
    // 参数单独断言：它正是「用户要照着去改的那一行配置」的内容
    expect(skipped[0].params).toEqual({ url: "https://gone.example.com" });
  });

  it("其余三种跳过原因也各有各的键：needs-choice / no-sites / unknown-rule-site", () => {
    // 三种「进不了批」的原因分别对应三种用户动作（去配默认站点 / 去配站点 / 去修规则）。
    // 合并成一句「失败」会让用户无从下手，所以逐档钉住键名。
    const noDefault = makeSettings([], [{ ...siteA, default: false }, siteB]);
    const needsChoice = collectBatchCandidates([fileAt("a.md")], appWith({ "a.md": {} }), noDefault, "draft");

    expect(needsChoice.candidates).toHaveLength(0);
    expect(skipSignatures(needsChoice.skipped)).toEqual(["a.md | batch.skip_needs_choice"]);

    const noSites = collectBatchCandidates([fileAt("a.md")], appWith({ "a.md": {} }), makeSettings([], []), "draft");

    expect(noSites.candidates).toHaveLength(0);
    expect(skipSignatures(noSites.skipped)).toEqual(["a.md | batch.skip_no_sites"]);

    const staleRule = collectBatchCandidates(
      [fileAt("日记/b.md")],
      appWith({ "日记/b.md": {} }),
      makeSettings([{ pattern: "日记/**", site: "https://gone.example.com" }]),
      "draft",
    );

    // 规则指向的站点已经不在站点列表里：报规则本身（模式 + URL），用户才知道要改哪一行
    expect(staleRule.candidates).toHaveLength(0);
    expect(skipSignatures(staleRule.skipped)).toEqual(["日记/b.md | batch.skip_unknown_rule_site"]);
    expect(staleRule.skipped[0].params).toEqual({ pattern: "日记/**", url: "https://gone.example.com" });
  });

  it("撤回只收已经有 halo.name 的笔记（没有就没什么可撤回的）", () => {
    const { candidates, skipped } = collectBatchCandidates(
      [fileAt("a.md"), fileAt("b.md")],
      appWith({ "a.md": { title: "A", halo: { name: "post-1" } }, "b.md": { title: "B" } }),
      makeSettings([]),
      "unpublish",
    );

    expect(candidates.map((item) => item.file.path)).toEqual(["a.md"]);
    expect(candidates[0].remoteName).toBe("post-1");
    expect(skipSignatures(skipped)).toEqual(["b.md | batch.skip_not_published"]);
  });

  it("halo.name 是空串时归一化成 undefined —— 与单篇路径同档，不留第三态", () => {
    // `halo.name: ""` 的语义是「还没发布过」。留着空串，下游按「有名字就更新」判档时
    // 会拿 `""` 当远端文章名去调 MCP（逐篇失败），而单篇路径在同一份笔记上走的是「新建」。
    const blank = collectBatchCandidates(
      [fileAt("a.md")],
      appWith({ "a.md": { title: "A", halo: { name: "" } } }),
      makeSettings([]),
      "draft",
    );

    expect(blank.candidates).toHaveLength(1);
    expect(blank.candidates[0].remoteName).toBeUndefined();
    // 对照物：**有**名字时必须原样带出来。少了它，一个「一律返回 undefined」的实现
    // 也会让上面那条通过 —— 而那种实现会让每次批量发布都变成新建、在站点上重复建文章。
    const named = collectBatchCandidates(
      [fileAt("a.md")],
      appWith({ "a.md": { title: "A", halo: { name: "post-1" } } }),
      makeSettings([]),
      "draft",
    );

    expect(named.candidates[0].remoteName).toBe("post-1");
  });

  it("halo.name 为空串时撤回照样跳过它（存的两档与用的真值判据不分叉）", () => {
    // 这条**不**验归一化本身（`!""` 与 `!undefined` 在这里都是真，改不改都一样红不了）。
    // 它挡的是另一件事：存储侧归一化被撤掉**且**判据被换成 `remoteName === undefined`
    // 的那种「单边不一致」—— 那时空串会被当成「已发布过」，于是一篇没发过的笔记
    // 被列进批量撤回的清单里。
    const { candidates, skipped } = collectBatchCandidates(
      [fileAt("a.md")],
      appWith({ "a.md": { title: "A", halo: { name: "" } } }),
      makeSettings([]),
      "unpublish",
    );

    expect(candidates).toHaveLength(0);
    expect(skipSignatures(skipped)).toEqual(["a.md | batch.skip_not_published"]);
  });

  it("推草稿 / 发布**不**要求 halo.name（没有就是新建）", () => {
    // 与上一条成对：同一个「没有 halo.name」的笔记，在 unpublish 下被跳过，在 publish 下是候选。
    // 两条合起来才说明筛选条件真的挂在 action 上，而不是「一律要求 halo.name」。
    const { candidates, skipped } = collectBatchCandidates(
      [fileAt("b.md")],
      appWith({ "b.md": { title: "B" } }),
      makeSettings([]),
      "publish",
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].remoteName).toBeUndefined();
    expect(skipSignatures(skipped)).toEqual([]);
  });
});

describe("planBatch", () => {
  const noImages = async () => ({ pending: 0, cached: 0, overLimit: [] });
  const noTaxonomy = async () => ({ categories: [], tags: [] });

  it("按站点分组，并为每组取一份分类/标签快照", async () => {
    const plan = await planBatch([candidate("a.md", siteA), candidate("b.md", siteB)], [], "draft", {
      listTaxonomy: async (site) => ({ categories: [{ name: "c", displayName: `${site.name} 的分类` }], tags: [] }),
      summarizeImages: noImages,
    });

    expect(plan.groups.map((group) => group.site.url)).toEqual([siteA.url, siteB.url]);
    expect(plan.groups[0].taxonomy.categories).toEqual([{ name: "c", displayName: "A 的分类" }]);
    expect(plan.groups[1].taxonomy.categories).toEqual([{ name: "c", displayName: "B 的分类" }]);
  });

  it("action 与 skipped 原样带进计划（确认弹窗上「已跳过 N 篇」靠它）", async () => {
    const plan = await planBatch(
      [candidate("a.md", siteA)],
      [{ path: "b.md", key: "batch.skip_not_published" }],
      "unpublish",
      { listTaxonomy: noTaxonomy, summarizeImages: noImages },
    );

    expect(plan.action).toBe("unpublish");
    expect(plan.skipped).toEqual([{ path: "b.md", key: "batch.skip_not_published" }]);
  });

  it("同一个站点只列一次分类标签（118 篇不该打 118 次 halo_list_categories）", async () => {
    let listCalls = 0;
    await planBatch([candidate("a.md", siteA), candidate("b.md", siteA), candidate("c.md", siteA)], [], "draft", {
      listTaxonomy: async () => {
        listCalls++;
        return { categories: [], tags: [] };
      },
      summarizeImages: noImages,
    });

    expect(listCalls).toBe(1);
  });

  it("每篇的图片概览挂在它自己身上（勾选变化时要能重算汇总）", async () => {
    const plan = await planBatch([candidate("a.md", siteA), candidate("b.md", siteA)], [], "draft", {
      listTaxonomy: noTaxonomy,
      summarizeImages: async (item) =>
        item.file.path === "a.md"
          ? { pending: 1, cached: 0, overLimit: ["big.png"] }
          : { pending: 2, cached: 1, overLimit: [] },
    });

    expect(plan.groups[0].items.map((item) => item.images.pending)).toEqual([1, 2]);
  });

  it("跨站点的候选分成多组，组内保持候选顺序", async () => {
    const plan = await planBatch(
      [candidate("a.md", siteA), candidate("b.md", siteB), candidate("c.md", siteA)],
      [],
      "draft",
      { listTaxonomy: noTaxonomy, summarizeImages: noImages },
    );

    expect(plan.groups.map((group) => group.site.url)).toEqual([siteA.url, siteB.url]);
    expect(plan.groups[0].items.map((item) => item.file.path)).toEqual(["a.md", "c.md"]);
  });

  it("某个站点的分类列表拿不到时，该组照常在计划里，只是 taxonomy 为空", async () => {
    // 列表失败不该让整批不可用 —— 分类标签本来就有「解析失败就跳过该字段」的既有语义。
    // 真正的失败发生在执行阶段（那里会逐篇记进汇总），预览阶段只负责让用户看清要做什么。
    const plan = await planBatch([candidate("a.md", siteA, ["技术"])], [], "draft", {
      listTaxonomy: async () => {
        throw new Error("boom");
      },
      summarizeImages: noImages,
    });

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].taxonomy).toEqual({ categories: [], tags: [] });
    // 快照为空 → `summarizeSelection` 会把这篇写的分类全列进「将新建」。
    // 宁可多列（用户看到"将新建：技术"而站点上其实有）也不要漏列 ——
    // 漏列的代价是用户以为不会建，而执行时会建。
    expect(summarizeSelection(plan, new Set(["a.md"])).groups[0].newCategories).toEqual(["技术"]);
  });

  it("某一篇的图片概览读不出来时跳过它，其余照常进计划（不整份计划 reject）", async () => {
    // 判别器：`await deps.summarizeImages(candidate)` 不带 try/catch 时这条会红 ——
    // `summarizeLocalImages` 在 `vault.read` 失败时抛，一篇读不出来会让**整份 118 篇的计划**
    // 一起 reject。后果不是「发布了一篇坏文章」（那样至少还有汇总），而是用户连确认弹窗都
    // 看不到：`runBatchCommand` 里 `planBatch` 是裸调用，异常直接冒到命令回调，
    // 表现为「点了批量发布，什么都没发生」——正是本计划要消灭的「说不清是哪一种失败」。
    const plan = await planBatch([candidate("a.md", siteA), candidate("b.md", siteA)], [], "draft", {
      listTaxonomy: noTaxonomy,
      summarizeImages: async (item) => {
        if (item.file.path === "a.md") {
          throw new Error("这篇读不出来");
        }

        return { pending: 2, cached: 0, overLimit: [] };
      },
    });

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].items.map((item) => item.file.path)).toEqual(["b.md"]);
    // 对照物：剩下的那一篇**带着真实的概览**，证明循环没有在 a.md 处整体中断
    expect(plan.groups[0].items[0].images.pending).toBe(2);
    expect(plan.skipped).toEqual([{ path: "a.md", key: "batch.skip_unreadable" }]);
  });

  it("撤回不为概览读正文：unpublish 下压根不调 summarizeImages", async () => {
    // 判别器：把 `if (action === "unpublish")` 那道闸门换成无条件调用就会红。
    //
    // 为什么这是缺陷而不是性能问题：概览读不出来会把这一篇记成 `batch.skip_unreadable`，
    // 而那句给用户的理由是「读不出这篇笔记的内容（正文或其图片不可用）」—— 对撤回**答非所问**，
    // 撤回根本不需要正文。一篇读不出正文的笔记**连撤回都进不去**，用户被引去看一个
    // 与他这次操作无关的问题。
    let summarizeCalls = 0;
    const plan = await planBatch([candidate("a.md", siteA)], [], "unpublish", {
      listTaxonomy: noTaxonomy,
      summarizeImages: async () => {
        summarizeCalls++;
        throw new Error("这篇读不出来");
      },
    });

    expect(summarizeCalls).toBe(0);
    expect(plan.skipped).toEqual([]);
    expect(plan.groups[0].items.map((item) => item.file.path)).toEqual(["a.md"]);
    // 撤回不上传图片，概览是零值 —— 确认弹窗那条「要传 N 张图」因此不会渲染
    expect(plan.groups[0].items[0].images).toEqual({ pending: 0, cached: 0, overLimit: [] });
  });

  it("同样的候选换成 draft 时 summarizeImages 确实被调到（上一条「没有调」的对照物）", async () => {
    // 「没有调」在代码路径压根没走到时永久为真。这条用**同一份候选、同一个会抛的实现**证明
    // 那条路径本来会走到 —— 换成 draft 就真的调了，而且那个抛异常照样把它记成跳过。
    let summarizeCalls = 0;
    const plan = await planBatch([candidate("a.md", siteA)], [], "draft", {
      listTaxonomy: noTaxonomy,
      summarizeImages: async () => {
        summarizeCalls++;
        throw new Error("这篇读不出来");
      },
    });

    expect(summarizeCalls).toBe(1);
    expect(plan.skipped).toEqual([{ path: "a.md", key: "batch.skip_unreadable" }]);
    // 对照物之二：draft 既然跳过了这一篇，组里就不剩任何条目（与上一条的「照样进计划」相反）
    expect(plan.groups).toHaveLength(0);
  });

  it("解析阶段与概览阶段的跳过**并集**带进计划（前者不被后者挤掉）", async () => {
    // `planBatch` 收到的 `skipped` 来自解析阶段，它自己在概览阶段又要往里加。
    // 一个「直接返回自己那份新数组」的实现会把解析阶段的跳过全丢掉 ——
    // 确认弹窗上「已跳过 N 篇」随即少掉一半，用户以为那些笔记都在清单里。
    const plan = await planBatch([candidate("a.md", siteA)], [{ path: "z.md", key: "batch.skip_no_sites" }], "draft", {
      listTaxonomy: noTaxonomy,
      summarizeImages: async () => {
        throw new Error("读不出来");
      },
    });

    expect(plan.skipped).toEqual([
      { path: "z.md", key: "batch.skip_no_sites" },
      { path: "a.md", key: "batch.skip_unreadable" },
    ]);
    // 对照物：入参数组**没有**被就地改写（`planBatch` 不持有调用方的数组）
    const incoming: BatchSkip[] = [];
    await planBatch([candidate("a.md", siteA)], incoming, "draft", {
      listTaxonomy: noTaxonomy,
      summarizeImages: async () => {
        throw new Error("读不出来");
      },
    });
    expect(incoming).toEqual([]);
  });

  it("一整组都读不出来时，那一组不进计划（不留一个 0 篇的空组）", async () => {
    // 弹窗会为每个分组渲染一行「站点名（N）」。留着一个 `items: []` 的组，用户看到的是
    // 「A（0）」—— 一张列着 0 的清单只会让人怀疑自己看错了（`summarizeSelection` 同样
    // 只返回有勾选的组，为的是同一件事）。
    const plan = await planBatch([candidate("a.md", siteA)], [], "draft", {
      listTaxonomy: noTaxonomy,
      summarizeImages: async () => {
        throw new Error("读不出来");
      },
    });

    expect(plan.groups).toEqual([]);
    expect(plan.skipped).toEqual([{ path: "a.md", key: "batch.skip_unreadable" }]);
    // 对照物：同一组依赖下，一个**读得出来**的候选确实会产生一个分组。
    // 没有它的话，「空 groups」也可能只是因为这段代码根本没在干活。
    const readable = await planBatch([candidate("a.md", siteA)], [], "draft", {
      listTaxonomy: noTaxonomy,
      summarizeImages: noImages,
    });

    expect(readable.groups).toHaveLength(1);
  });

  it("候选全部解析不出站点时给出空 groups，不抛错", async () => {
    // 这条挡的是「planBatch 假设候选一定已解析」：那样的实现在 `bucket[0].resolution.site` 上抛。
    // 真实管线走不到这个输入（`collectBatchCandidates` 已把未解析的拦成 skipped），
    // 所以它是**特征化**断言 —— 它钉的是「这个防御性过滤别被删掉」，不是一条用户可见的行为。
    const needsChoice: BatchCandidate = {
      file: fileAt("a.md"),
      resolution: { kind: "needs-choice" },
      categories: [],
      tags: [],
    };
    const plan = await planBatch([needsChoice], [], "draft", {
      listTaxonomy: noTaxonomy,
      summarizeImages: noImages,
    });

    expect(plan.groups).toEqual([]);
    // 对照物：同一组依赖下，一个**已解析**的候选确实会产生一个分组。
    // 没有它的话，「空 groups」也可能只是因为这段代码根本没在干活。
    const withResolved = await planBatch([candidate("a.md", siteA)], [], "draft", {
      listTaxonomy: noTaxonomy,
      summarizeImages: noImages,
    });

    expect(withResolved.groups).toHaveLength(1);
  });
});

describe("summarizeSelection", () => {
  /** 两篇在 A 站（都打 Halo 标签）、一篇在 B 站，A 站已有「技术」分类 */
  async function threeItemPlan(): Promise<BatchPlan> {
    return planBatch(
      [
        candidate("a.md", siteA, ["技术"], ["Halo"]),
        candidate("b.md", siteA, ["随笔"], ["Halo"]),
        candidate("c.md", siteB),
      ],
      [],
      "draft",
      {
        listTaxonomy: async (site) =>
          site.url === siteA.url
            ? { categories: [{ name: "c1", displayName: "技术" }], tags: [] }
            : { categories: [], tags: [] },
        summarizeImages: async (item) =>
          item.file.path === "a.md"
            ? { pending: 3, cached: 1, overLimit: ["big.png"] }
            : { pending: 1, cached: 0, overLimit: [] },
      },
    );
  }

  it("只统计勾选的笔记（取消勾选后汇总立刻变小）", async () => {
    // 这是「带勾选的一次聚合确认」能成立的全部依据：汇总必须跟着勾选走。
    // 若汇总按整份 plan 算，用户取消勾选后弹窗上仍写着「将发布 3 篇」——
    // 他会以为自己没取消成功，或者干脆关掉弹窗。
    const plan = await threeItemPlan();
    const summary = summarizeSelection(plan, new Set(["b.md"]));

    expect(summary.total).toBe(1);
    expect(summary.groups.map((group) => group.count)).toEqual([1]);
    expect(summary.groups[0].images).toEqual({ pending: 1, cached: 0, overLimit: [] });
  });

  it("「将新建」按勾选范围并集去重后算（多篇共用一个显示名只列一次）", async () => {
    const plan = await threeItemPlan();
    const all = summarizeSelection(plan, new Set(["a.md", "b.md", "c.md"]));

    // A 站：技术（已有，不算新建）+ 随笔（新建）；两篇都打了 Halo → 只列一次
    expect(all.groups[0].newCategories).toEqual(["随笔"]);
    expect(all.groups[0].newTags).toEqual(["Halo"]);
    // B 站没有分类标签，且 c.md 也没写
    expect(all.groups[1].newCategories).toEqual([]);
    expect(all.total).toBe(3);
  });

  it("把某一篇取消勾选后，它独占的「将新建」跟着消失", async () => {
    const plan = await threeItemPlan();
    const summary = summarizeSelection(plan, new Set(["a.md"]));

    expect(summary.groups[0].newCategories).toEqual([]); // 技术已存在，随笔的那篇被取消了
    expect(summary.groups[0].newTags).toEqual(["Halo"]);
  });

  it("图片概览按勾选的笔记累加", async () => {
    const plan = await threeItemPlan();
    const all = summarizeSelection(plan, new Set(["a.md", "b.md"]));

    expect(all.groups[0].images).toEqual({ pending: 4, cached: 1, overLimit: ["big.png"] });
  });

  it("超限文件名去重：同一个文件被多篇引用时只列一次", async () => {
    // 上一条用例里只有 a.md 带超限文件，**去重分支根本没被走到** —— 用例标题写了「去重」
    // 却验不出任何东西。这里让两篇都带同一个文件名，去掉 `includes` 守卫的实现会返回
    // `["big.png", "big.png"]`，用户会以为要处理两张。
    const plan = await planBatch([candidate("a.md", siteA), candidate("b.md", siteA)], [], "draft", {
      listTaxonomy: async () => ({ categories: [], tags: [] }),
      summarizeImages: async () => ({ pending: 0, cached: 0, overLimit: ["big.png"] }),
    });

    const all = summarizeSelection(plan, new Set(["a.md", "b.md"]));

    expect(all.groups[0].images.overLimit).toEqual(["big.png"]);
  });

  it("某一组一篇都没勾时整组不出现（而不是显示成「0 篇」）", async () => {
    const plan = await threeItemPlan();
    const summary = summarizeSelection(plan, new Set(["a.md", "b.md"]));

    // 只剩 A 站那一组。一张列着"0 篇"的卡片只会让人怀疑自己看错了。
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0].site.url).toBe(siteA.url);
  });

  it("勾选集合里混进不存在的路径时忽略它，不抛错", async () => {
    const plan = await threeItemPlan();
    const summary = summarizeSelection(plan, new Set(["不存在.md"]));

    expect(summary.total).toBe(0);
    expect(summary.groups).toEqual([]);
    // 对照物：同一份 plan 下一个**真实存在**的路径确实会被算进去。
    // 否则「total 为 0」也可能只是因为这计划本身是空的（那样这条用例永远为真）。
    expect(summarizeSelection(plan, new Set(["a.md"])).total).toBe(1);
  });

  it("没有任何勾选时给空汇总（弹窗据此禁用确认按钮）", async () => {
    const plan = await threeItemPlan();
    const summary = summarizeSelection(plan, new Set());

    expect(summary).toEqual({ total: 0, groups: [] });
    // 同上的对照物：全勾时总数是 3，证明这份 plan 里确实有三篇
    expect(summarizeSelection(plan, new Set(["a.md", "b.md", "c.md"])).total).toBe(3);
  });
});

/** 造一个只属于某个站点的计划。`remoteNames` 只对 `unpublish` 有意义 */
function planOf(
  paths: string[],
  action: BatchAction = "draft",
  site: HaloSite = siteA,
  remoteNames: Record<string, string> = {},
): BatchPlan {
  return {
    action,
    groups: [
      {
        site,
        items: paths.map((path) => ({
          ...candidate(path, site),
          remoteName: remoteNames[path],
          images: { pending: 0, cached: 0, overLimit: [] },
        })),
        taxonomy: { categories: [], tags: [] },
      },
    ],
    skipped: [],
  };
}

/** 「全部勾选」—— 多数用例只想验循环语义，不必逐条写路径集合 */
function allOf(plan: BatchPlan): Set<string> {
  return new Set(plan.groups.flatMap((group) => group.items.map((item) => item.file.path)));
}

/** 一个每篇都成功、且什么都不做的假服务；用 `overrides` 替换掉要测的那一个方法 */
function serviceWith(overrides: Partial<Record<string, unknown>>): HaloService {
  return {
    uploadImages: async () => ({
      processedCount: 0,
      uploadedCount: 0,
      reusedCount: 0,
      failedCount: 0,
      replaced: false,
    }),
    publishPost: async () => ({ ok: true }),
    changePostPublish: async () => undefined,
    ...overrides,
  } as unknown as HaloService;
}

/**
 * `runBatch` 的循环语义。
 *
 * 这里测的**不是**「撤回到底调了哪个 MCP 工具」—— 那是 `tests/service/index.test.ts` 里
 * `changePostPublish` 的既有断言的活，在这里再验一遍只会多出一份要跟着服务端走的契约。
 * 这里只钉循环本身：「跳过失败项继续」是用户 2026-10-03 的明确裁定，
 * 也是本插件**唯一**一处逐项失败不中止整个操作的地方。
 */
describe("runBatch", () => {
  it("只执行勾选的笔记（没勾的连碰都不碰）", async () => {
    // 判别器：`runBatch` 若忽略 `selected` 直接跑整份 plan，这条会红 ——
    // 而它的后果就是"用户取消了勾选，那几篇还是被发了"。
    const attempted: string[] = [];
    const plan = planOf(["a.md", "b.md", "c.md"]);
    const summary = await runBatch(plan, new Set(["a.md", "c.md"]), () =>
      serviceWith({
        publishPost: async (file: { path: string }) => {
          attempted.push(file.path);
          return { ok: true };
        },
      }),
    );

    expect(attempted).toEqual(["a.md", "c.md"]);
    expect(summary.successCount).toBe(2);
  });

  it("勾选集合里混进不存在的路径时忽略它，不抛错", async () => {
    const plan = planOf(["a.md"]);

    const summary = await runBatch(plan, new Set(["a.md", "幽灵.md"]), () => serviceWith({}));

    expect(summary.successCount).toBe(1);
    // 对照物：`results` 是按**计划里真实存在的条目**攒出来的，不是按勾选集合。
    // 少了它，「成功 1 篇」也可能是「幽灵.md 也被当成一篇跑了」。
    expect(summary.results.map((item) => item.path)).toEqual(["a.md"]);
  });

  it("中间一篇失败时后面的照常执行（跳过失败项继续）", async () => {
    // 判别器：循环体里任何一个 `break` / `throw` / `return` 都会让这条红。
    // 这是用户 2026-10-03 明确裁定的语义，也是对上游「一失败即中止」的刻意偏离。
    const attempted: string[] = [];
    const plan = planOf(["a.md", "b.md", "c.md"]);
    const summary = await runBatch(plan, allOf(plan), () =>
      serviceWith({
        publishPost: async (file: { path: string }) => {
          attempted.push(file.path);
          return file.path === "b.md" ? { ok: false, reason: "炸了" } : { ok: true };
        },
      }),
    );

    expect(attempted).toEqual(["a.md", "b.md", "c.md"]);
    expect(summary.successCount).toBe(2);
    expect(summary.failureCount).toBe(1);
    expect(summary.results.find((item) => item.path === "b.md")).toEqual({ path: "b.md", ok: false, reason: "炸了" });
  });

  it("图片上传失败的那一篇被记成失败，且**不进** publishPost（半成品 markdown 不落盘）", async () => {
    // 判别器：把 `if (upload.failedCount > 0) { …continue }` 删掉就会红。
    // 后果是拿一份「有的链接是远程、有的是本地」的半成品 markdown 去发布 ——
    // 与单篇路径的中止语义背道而驰，而站点上已经留下了一篇链接半坏的正文。
    const publishedPaths: string[] = [];
    const plan = planOf(["a.md", "b.md"]);
    const summary = await runBatch(plan, allOf(plan), () =>
      serviceWith({
        uploadImages: async () => ({
          processedCount: 1,
          uploadedCount: 0,
          reusedCount: 0,
          failedCount: 1,
          replaced: false,
        }),
        publishPost: async (file: { path: string }) => {
          publishedPaths.push(file.path);
          return { ok: true };
        },
      }),
    );

    // `publishedPaths` 为空是**空**断言，它自己证明不了循环跑过 —— 下面两条是它的对照物：
    // 两篇都被记了结果，且原因里带着失败的张数（只有真的调了 uploadImages 才拿得到这个数）。
    expect(publishedPaths).toEqual([]);
    expect(summary.failureCount).toBe(2);
    expect(summary.results[0].reason).toContain("1");
  });

  it("撤回走 changePostPublish(name, false)，不碰文章正文", async () => {
    const calls: [string, boolean][] = [];
    const plan = planOf(["a.md", "b.md"], "unpublish", siteA, { "a.md": "post-1", "b.md": "post-2" });
    const summary = await runBatch(plan, allOf(plan), () =>
      serviceWith({
        changePostPublish: async (name: string, publish: boolean) => {
          calls.push([name, publish]);
        },
        publishPost: async () => {
          throw new Error("撤回路径不该碰 publishPost —— 那会重新上传图片并改写本地笔记");
        },
      }),
    );

    expect(calls).toEqual([
      ["post-1", false],
      ["post-2", false],
    ]);
    expect(summary.successCount).toBe(2);
  });

  it("推草稿与发布都走 publishPost，区别只在 publishOverride", async () => {
    const seen: (boolean | undefined)[] = [];
    const draft = planOf(["a.md"], "draft");
    const publish = planOf(["a.md"], "publish");
    const record = () =>
      serviceWith({
        publishPost: async (_file: unknown, options: { publishOverride?: boolean }) => {
          seen.push(options.publishOverride);
          return { ok: true };
        },
      });

    await runBatch(draft, allOf(draft), record);
    await runBatch(publish, allOf(publish), record);

    expect(seen).toEqual([false, true]);
  });

  it("quiet 为真：批量路径不逐篇弹便签", async () => {
    const optionsSeen: { quiet?: boolean }[] = [];
    const plan = planOf(["a.md"]);

    await runBatch(plan, allOf(plan), () =>
      serviceWith({
        publishPost: async (_file: unknown, options: { quiet?: boolean }) => {
          optionsSeen.push(options);
          return { ok: true };
        },
      }),
    );

    expect(optionsSeen).toEqual([expect.objectContaining({ quiet: true })]);
  });

  it("跨站点的计划按组各取一次 service（同一个站点共用同一个客户端）", async () => {
    const built: string[] = [];
    const items = (paths: string[], site: HaloSite) =>
      paths.map((path) => ({ ...candidate(path, site), images: { pending: 0, cached: 0, overLimit: [] } }));
    const plan: BatchPlan = {
      action: "draft",
      groups: [
        { site: siteA, items: items(["a.md", "b.md"], siteA), taxonomy: { categories: [], tags: [] } },
        { site: siteB, items: items(["c.md"], siteB), taxonomy: { categories: [], tags: [] } },
      ],
      skipped: [],
    };

    await runBatch(plan, allOf(plan), (site) => {
      built.push(site.url);
      return serviceWith({});
    });

    expect(built).toEqual([siteA.url, siteB.url]);
  });

  it("整组没勾时那一组的 service 根本不会被构造（不白建客户端）", async () => {
    const built: string[] = [];
    const items = (paths: string[], site: HaloSite) =>
      paths.map((path) => ({ ...candidate(path, site), images: { pending: 0, cached: 0, overLimit: [] } }));
    const plan: BatchPlan = {
      action: "draft",
      groups: [
        { site: siteA, items: items(["a.md"], siteA), taxonomy: { categories: [], tags: [] } },
        { site: siteB, items: items(["c.md"], siteB), taxonomy: { categories: [], tags: [] } },
      ],
      skipped: [],
    };

    await runBatch(plan, new Set(["a.md"]), (site) => {
      built.push(site.url);
      return serviceWith({});
    });

    expect(built).toEqual([siteA.url]);
  });

  it("一次异常不终止整批：循环体自己接住每一篇的异常", async () => {
    // publishPost 的契约是「不抛」，但批量循环不该把整批的可用性押在这条契约上 ——
    // 一次未捕获的异常会让 100 篇已经成功的笔记**没有任何汇总**，用户以为全军覆没。
    const plan = planOf(["a.md", "b.md"]);
    const summary = await runBatch(plan, allOf(plan), () =>
      serviceWith({
        publishPost: async (file: { path: string }) => {
          if (file.path === "a.md") {
            throw new Error("boom");
          }
          return { ok: true };
        },
      }),
    );

    expect(summary.failureCount).toBe(1);
    expect(summary.successCount).toBe(1);
    // 失败原因必须是**能看懂的文案**，不是 `undefined`（那样汇总里只有文件名，用户无从下手）
    expect(summary.results[0].reason).toBeTruthy();
  });

  it("概览阶段的跳过原样带进 summary.skippedCount（用户要知道那些笔记去哪了）", async () => {
    // 「跳过」有两个不同的时刻：**执行前**（站点解析不出、正文读不出来）与**执行中**（发布失败）。
    // 汇总里把两者分开报，用户才分得清「这几篇我根本没让它跑」与「这几篇跑了但炸了」——
    // 混成一个数字会让他以为有 3 篇被尝试过。
    const plan: BatchPlan = {
      ...planOf(["a.md"]),
      skipped: [{ path: "z.md", key: "batch.skip_not_published" }],
    };

    const summary = await runBatch(plan, allOf(plan), () => serviceWith({}));

    expect(summary.skippedCount).toBe(1);
    // 对照物：同一次运行里 `results` 只有计划里的那一篇 ——
    // `skippedCount` 数的是**没进 results 的那些**，两者不能是同一个来源。
    expect(summary.results.map((item) => item.path)).toEqual(["a.md"]);
    expect(summary.failureCount).toBe(0);
  });

  it("空勾选集合：一篇都不执行、一个客户端都不建（程序化确认也挡得住）", async () => {
    // **这条用例钉的是行为，不是那道 `if (selected.size === 0)` 守卫 —— 它判别不了守卫。**
    // 实测：把守卫整段删掉，本文件 37 条**全绿**。原因是守卫在行为上与下面「每组过滤后
    // `items.length === 0` → continue」完全重合：空集合进来时每个组都是空的，循环什么也不做。
    // 那条每组过滤的路径**另有覆盖**（「整组没勾时那一组的 service 根本不会被构造」），
    // 所以这不是覆盖缺口。守卫本身留在生产代码里，作为一条不依赖循环结构的不变式。
    //
    // 上面那三条「空」断言配了下面对照物，能挡住的是**过滤条件被改坏**（例如变成
    // 「selected 为空就全选」）—— 那种改动会让这篇用例真正地红。
    const built: string[] = [];
    const plan = planOf(["a.md", "b.md"]);

    const summary = await runBatch(plan, new Set(), (site) => {
      built.push(site.url);
      return serviceWith({});
    });

    // 空的断言，配下面两条对照物用
    expect(built).toEqual([]);
    expect(summary.results).toEqual([]);
    expect(summary.successCount + summary.failureCount).toBe(0);

    // 对照物：同一份 plan、只勾一篇时**循环确实跑起来了**（否则上面三条也可能只是因为
    // 这段代码压根没被执行到）。
    const ran: string[] = [];
    await runBatch(plan, new Set(["a.md"]), (site) => {
      ran.push(site.url);
      return serviceWith({});
    });
    expect(ran).toEqual([siteA.url]);
  });
});
