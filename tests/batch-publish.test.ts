import { describe, expect, it } from "@rstest/core";
import type { App, TFile } from "obsidian";
import {
  type BatchCandidate,
  type BatchPlan,
  type BatchSkip,
  collectBatchCandidates,
  planBatch,
  summarizeSelection,
} from "src/batch-publish";
import type { HaloSetting, HaloSite } from "src/settings";
import type { SiteRoutingRule } from "src/site-routing";

/**
 * `src/batch-publish.ts` 的测试。
 *
 * 本文件里凡断言「某件事**没有**发生」，都必须能在同一个用例里指出它**本可以**发生 ——
 * 这条纪律是被前几个任务教出来的：`expect(calls).toEqual([])` 这类断言在「代码根本没走到」
 * 时同样为真，于是它可能永久为真而没人发现。下面每处「空」断言旁边都配了它的对照物。
 */

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
