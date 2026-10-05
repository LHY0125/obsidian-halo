# 阶段 2：内容能力对标（查重 / 独立页面 / 附件管理 / 回收站）— 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **⚠️ 关于本文件里的代码与文案清单**：本文件的代码块、函数清单与三语文案是**规划当时的字面量**。
> 实现与后续修复轮会改动若干处，因此这些清单**可能已与交付代码分叉**。**以 `src/` 为准。**

**Goal:** 把 MCP 已经暴露、但插件还够不着的四类内容能力接进 Obsidian：全文查重、独立页面（推/拉/发布/回收）、附件管理（列出/复用/删除）、回收站（移入/恢复）。

**Architecture:** 阶段 0 / 1-A / 1-B 已经把「传输层 → 服务层 → 交互面」这条链修完，且**所有写路径都收敛到 `HaloService` 的少数几个方法**上。阶段 2 的重心因此**不在新架构**，而在三件事：① 把 1-B 里为「文章」写的那套编排**参数化到第二种内容类型**（独立页面），且**必须共用同一份实现** —— 否则「页面」会变成一份永远慢半拍的复制品；② 给附件与回收站各建一条**只读列表 + 单对象操作**的最小通路；③ 把 1-B 留下的两个产品语义决策（B6 / B8）与三个已知缺口（分页、跳过原因、死模块）**收口**。

**Tech Stack:** TypeScript 5.1.6 / Rslib / rstest（`globals: false`）/ Biome / pnpm。**不新增任何运行时依赖。**

**Spec:** `docs/superpowers/specs/2026-10-03-obsidian-halo-mcp-reshape-design.md`（覆盖 **G5 内容能力对标**；G1–G4 已在前三份计划落地）

**前一阶段的实现记录：** `docs/superpowers/plans/2026-10-04-metadata-routing-preview-batch.md`（1-B，11 任务）

---

## Global Constraints

以下每一条对**每个任务**都生效。违反其中任何一条，任务都不算完成。

### 来自本阶段的第一性约束

1. **第二种内容类型必须复用第一份实现，不许复制。**
   独立页面与文章在 MCP 上是**两套工具**（`halo_*_single_page` vs `halo_*_post`），字段集也不同
   （页面没有 `categories` / `tags` / `pinned` / `priority` / `publishTime` / `template`）。
   但「读远端 → 套 frontmatter → 写 → 回读 → 回写笔记」这条**编排**是同一件事。
   判断标准：**同一个决策出现两份实现时，它们必然在某次改动后分叉**，而分叉的表现是
   「文章路径对了、页面路径没跟上」—— 1-A 的最终审查把这一类记作最贵的缺陷来源。
   本计划的做法是**把内容类型抽成一个参数**（`ContentKind`），而不是写第二个 `HaloService`。

2. **回写进 frontmatter 的必须是「本次生效的值」，不是「本地构造的值」。**
   这是 1-A 的 I1 的教训（写后回读失败时把陈旧值写进 `frontmatter.halo.publish`，下次发布
   把已发布的文章静默退回草稿）。**回写一律从 `post.spec` 取值。**

3. **`null` 与「键不存在」同义；`false` / `0` / `""` 是显式值。**
   判据是 **`value !== undefined && value !== null`**，不是真假判断。
   ⚠️ **唯一例外是分类/标签回写那道真值判断**（`if (options.categoryNames)`）——
   它实际区分的是 `undefined`（解析失败）与「拿到了结果」，对 `string[] | undefined` 而言
   与 `!== undefined` 行为完全相同。**不许「顺手统一」**，理由见 `src/frontmatter-map.ts`。

4. **任何"可能不命中"或"可能误命中"的判据，必须把两个方向都写出来。**
   1-B 在 glob 那条判据上错了四次，根因都是只证了一个方向。写「这样会漏掉 X」时，
   必须同时写「这样会不会把不该匹配的也匹配上」。

### 来自 spec 与既有阶段的约束

5. **不新增运行时依赖。** `package.json` 的 `dependencies` 一个字都不改。
6. **i18n 三语必须同步。** `src/i18n/locales/{en,zh-cn,zh-tw}.json` 三个文件的键**逐一对应**，
   键数与键路径都一致；漏一个，切到那个语言就显示原始键名。**当前三份各 157 键，收尾时必须相等。**
7. **代码注释用中文。** 注释写「为什么」，不写「是什么」。
8. **新文件写成 LF**（`.editorconfig` 与 `biome.json` 都要求 LF）。既有文件不要跑全量
   `biome check --write`（本仓库 `core.autocrlf=true` 且无 `.gitattributes`，全量跑会产生
   一堆换行符噪声）。
9. **绝不 `git add -A` / `git add .` / `git add -u`** —— 逐名 stage。
10. **绝不把 `hmcp_` 密钥或 PAT 值写进任何文件、报告或提交信息。** 站点配置在
    `<vault>/.obsidian/plugins/halo-mcp/data.json`（git-ignored），需要它时**运行时读**，
    不要复制到仓库里。

### 来自真实站点的实测事实（2026-10-05 对 `blog.liuhangyv.top` 拉 `tools/list` 核对）

这些是**服务端自己声明的契约**，不是推测。写代码时按它们来，不要按记忆来。

| 事实 | 值 |
|---|---|
| MCP Server 版本 | `halo-mcp-server` **1.2.0**，协议 `2025-06-18`，**51 个工具** |
| 独立页面的字段集 | `name / title / slug / excerpt / published / publishRequested / recycled / visible / owner / permalink / headSnapshot / releaseSnapshot / baseSnapshot / version / creationTimestamp / updateTimestamp` |
| 页面的 `required`（outputSchema） | `["published", "publishRequested", "recycled"]` —— **`name` / `title` / `slug` 都不在其中** |
| `halo_create_single_page` 的 `required` | `["name", "title", "raw"]` —— **`name` 必填**（MCP 没有 `generateName` 等价物） |
| `halo_update_single_page` 的 `required` | `["name"]` |
| `rawType` 的 schema 默认值 | **`"html"`** —— 与文章一样，**必须显式传 `"markdown"`** |
| 页面**没有**的字段 | `categories` / `tags` / `pinned` / `priority` / `publishTime` / `template` / `cover` / `autoGenerateExcerpt` / `excerptRaw` |
| `halo_delete_attachment` 的入参 | `name` + **`expectedVersion`（必填！）** —— 两者都在 `required` 里 |
| `halo_search_content` 的标题 | **含 `<B>` 高亮标签**：实测 `"因为喜欢开源，我用 <B>Halo</B> 写了一个插件…"` |
| `halo_search_content` 的 `required` | `["type", "published", "recycled", "exposed", "categories", "tags"]` |
| 列表工具的 `size` 上限 | **100**（`maximum: 100`），全部返回 `page/size/total/totalPages/hasNext` |
| 站点真实规模 | 文章 74 篇、**独立页面 11 个**、**附件 264 个（88 页）**、回收站 **4 篇文章 + 1 个页面** |
| 附件项的 `required` | **`[]`** —— 全部字段可选，消费方必须自己兜底 |

### 本阶段要收口的三个既有缺口（来自 1-B 的终审）

11. **分页**：`getCategories()` / `getTags()` 写死 `size: 100` 且**静默漏掉后面的**；
    `fetchSelectablePosts()` 会提示但**不翻页**。本阶段统一处理（Task 13）。
12. **批量汇总不列跳过原因**：末尾汇总里「执行前跳过」**只有一个数字**，逐条原因只在确认弹窗里。
    这是 1-B 终审留下的开放项，本阶段实现（Task 13）。
13. **两个死模块**：`src/utils/markdown.ts` 与 `src/utils/yaml.ts` 无人 import，
    `markdown-it` / `markdown-it-anchor` / `gray-matter` / `js-yaml` 四个依赖只为它们存在。
    **删除需用户书面同意**（全局规则），故本阶段只**报告**、不删（Task 14）。

### 用户已拍板的两个产品语义（2026-10-05）

14. **批量撤回不写回本地 `halo.publish`** —— **保持现状**。理由：撤回是「只动远端」的操作，
    回写本地会让「我本地写着 publish: true」与「远端是草稿」这两件事在笔记里失去分辨力；
    而且回写会让撤回之后的笔记**看起来像用户手动改过**。代价（撤回后再跑批量发布会复活文章）
    已在 `CLAUDE.md` 与 `docs/e2e-manual-checklist.md` 写明，**文档是这次的交付物，不是代码**。
15. **三个批量命令都不看笔记里的 `halo.publish`** —— **保持现状**。理由：批量命令的语义由
    **命令名**承载（「批量发布」就是发布），若某篇写着 `publish: false` 就跳过它，
    用户会看到「批量发布完成」而这几篇没上去，且**没有任何提示**。
    想排除某几篇的唯一办法是在确认弹窗里取消勾选 —— 这是**可见的**取舍。
    ⇒ Task 14 只**核对文档是否如实描述**，不改代码。

---

## 文件结构

### 新建

| 文件 | 唯一职责 |
|---|---|
| `src/content-kind.ts` | **零项目内依赖的叶子**：`ContentKind`（`"post" \| "page"`）与两种类型的工具名/字段集差异表。拆成叶子是为破 `service ⇄ page-service` 的 import 环（同 `glob.ts` 的处置） |
| `src/service/page-mapping.ts` | 独立页面的扁平表示 ↔ 领域模型（`toSinglePage` / `toPageArgs`），与 `post-mapping.ts` 同构但**字段集更小** |
| `src/service/page-service.ts` | 独立页面的编排：推 / 拉 / 发布 / 回收 / 恢复。**复用** `HaloService` 的 `withPublishRetry` / `refreshPostAfterWrite` 等私有逻辑 —— 见 Task 5 的接口设计 |
| `src/page-selection-model.ts` | 拉取页面时选远程页面（与 `post-selection-model.ts` 同构） |
| `src/search-modal.ts` | 查重结果列表弹窗（纯渲染，数据由纯函数构造） |
| `src/search-preview.ts` | 查重结果的纯数据构造（`buildSearchResults`），弹窗只负责 `createEl` |
| `src/attachment-model.ts` | 附件列表的取数 + 映射（`fetchAttachments` / `toAttachmentItems`），纯函数可测 |
| `src/attachment-modal.ts` | 附件管理弹窗（列出 / 复制链接 / 删除） |
| `src/recycle-model.ts` | 回收站的取数 + 映射（`fetchRecycled` / `toRecycledItems`），纯函数可测 |
| `src/recycle-modal.ts` | 回收站弹窗（列出 / 恢复） |
| `src/pagination.ts` | **零项目内依赖的叶子**：`fetchAllPages()` —— 按 `hasNext` 翻完所有页的通用取数器 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/service/post-mapping.ts` | 抽出 `McpContentItemBase`（两种类型共有的字段），`McpPostItem` 继承它 |
| `src/service/index.ts` | `getCategories()` / `getTags()` 改用 `fetchAllPages()`；`fetchSelectablePosts()` 的调用方改用翻页 |
| `src/post-selection-model.ts` | 改用 `fetchAllPages()`，**删掉**那条「列表不完整」的提示（不再会不完整） |
| `src/mcp-self-check.ts` | `REQUIRED_TOOLS` 从 13 项扩到**本阶段实际调用的全部工具**（见 Task 1） |
| `src/main.ts` | 注册 6 条新命令；`runBatchCommand` 的汇总改用新字段 |
| `src/batch-publish.ts` | `BatchRunSummary` 增加 `skipped: BatchSkip[]`（逐条带原因） |
| `src/batch-confirm-modal.ts` | 末尾汇总渲染逐条跳过原因 |
| `src/i18n/locales/{en,zh-cn,zh-tw}.json` | 新增文案（三语同步） |
| `README.md` / `README.zh-CN.md` / `CLAUDE.md` | 新命令、新契约、两个产品语义的如实描述 |
| `docs/e2e-manual-checklist.md` | 追加阶段 2 的手工验证项 |

---

## 任务总览

| # | 任务 | 依赖 | 产出 |
|---|---|---|---|
| 1 | 内容类型抽象与工具清单 | — | `src/content-kind.ts`、`REQUIRED_TOOLS` 扩到 22 项 |
| 2 | 独立页面的映射层 | 1 | `src/service/page-mapping.ts` |
| 3 | 通用翻页取数器 | — | `src/pagination.ts` |
| 4 | 服务层分页收口 | 3 | `getCategories` / `getTags` / 拉取列表都翻页 |
| 5 | 独立页面的服务层 | 1,2 | `src/service/page-service.ts` |
| 6 | 独立页面命令与选择器 | 5 | 3 条命令 + `src/page-selection-model.ts` |
| 7 | 查重的纯数据层 | — | `src/search-preview.ts`（含 `<B>` 清理） |
| 8 | 查重命令与弹窗 | 7 | `src/search-modal.ts` + 命令 |
| 9 | 附件的纯数据层 | 3 | `src/attachment-model.ts` |
| 10 | 附件命令与弹窗 | 9 | `src/attachment-modal.ts` + 命令 |
| 11 | 回收站的纯数据层 | — | `src/recycle-model.ts` |
| 12 | 回收站命令与弹窗 | 11 | `src/recycle-modal.ts` + 2 条命令 |
| 13 | 批量汇总的逐条跳过原因 | — | `batch-publish.ts` + `batch-confirm-modal.ts` |
| 14 | 文档收口与两个产品语义 | 6,8,10,12,13 | 三份文档 + 手工清单 |
| 15 | 全阶段自审 | 全部 | 三语键数相等、无死引用、构建通过 |

---

## Task 1: 内容类型抽象与工具清单

**Files:**
- Create: `src/content-kind.ts`
- Modify: `src/mcp-self-check.ts`
- Test: `tests/content-kind.test.ts`, `tests/mcp-self-check.test.ts`

**Interfaces:**
- Consumes: 无（本任务不依赖任何既有代码）
- Produces:
  - `type ContentKind = "post" | "page"`
  - `interface ContentToolset { list: string; get: string; create: string; update: string; setPublish: string; recycle: string; restore: string }`
  - `const CONTENT_TOOLSETS: Record<ContentKind, ContentToolset>`
  - `const REQUIRED_TOOLS: readonly string[]`（扩到 22 项）

- [ ] **Step 1: 写失败的测试**

```ts
// tests/content-kind.test.ts
import { describe, expect, test } from "@rstest/core";
import { CONTENT_TOOLSETS, type ContentKind } from "../src/content-kind";

describe("content-kind", () => {
  test("两种内容类型的工具名逐项不同，且都带正确的前缀", () => {
    const post = CONTENT_TOOLSETS.post;
    const page = CONTENT_TOOLSETS.page;

    for (const key of Object.keys(post) as (keyof typeof post)[]) {
      expect(post[key]).toMatch(/^halo_[a-z_]*post/);
      expect(page[key]).toMatch(/^halo_[a-z_]*single_page/);
      expect(post[key]).not.toBe(page[key]);
    }
  });

  test("页面没有文章独有的工具（发布状态是两套）", () => {
    expect(CONTENT_TOOLSETS.post.setPublish).toBe("halo_set_post_publish_state");
    expect(CONTENT_TOOLSETS.page.setPublish).toBe("halo_set_single_page_publish_state");
  });

  test("每一种内容类型都有完整的 7 个工具", () => {
    const keys = ["list", "get", "create", "update", "setPublish", "recycle", "restore"] as const;

    for (const kind of ["post", "page"] as ContentKind[]) {
      for (const key of keys) {
        expect(CONTENT_TOOLSETS[kind][key]).toBeTruthy();
      }
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/content-kind.test.ts`
Expected: FAIL —— `Cannot find module '../src/content-kind'`

- [ ] **Step 3: 写实现**

```ts
// src/content-kind.ts

/**
 * 插件支持的两类「内容」。
 *
 * 独立页面与文章在 MCP 上是**两套工具**、字段集也不同（页面没有 categories / tags / pinned /
 * priority / publishTime / template）。但「读远端 → 套 frontmatter → 写 → 回读 → 回写笔记」
 * 这条**编排**是同一件事，所以本模块只描述**差异**，编排层把它当参数收着。
 *
 * ⚠️ **本文件是零项目内依赖的叶子，加任何 `import` 之前先读这段。**
 * 拆出来是为破一个真 import 环：`service/index.ts` 要用它来分派工具名，
 * 而 `service/page-service.ts` 又要用 `service/index.ts` 的编排逻辑。
 * 环在打包器里未必直接报错，而是在某些 import 顺序下让某个绑定变成 `undefined`
 * —— 本地测试跑得通，发出去的 `main.js` 才出问题。（`glob.ts` 是同一个处置，理由相同。）
 */
export type ContentKind = "post" | "page";

/**
 * 一种内容类型对应的 7 个 MCP 工具名。
 *
 * 七个而不是六个：`recycle` 与 `restore` 是两个独立工具，不是一个带布尔参数的。
 */
export interface ContentToolset {
  list: string;
  get: string;
  create: string;
  update: string;
  setPublish: string;
  recycle: string;
  restore: string;
}

/**
 * 工具名表。**逐字取自 2026-10-05 对真实站点 `tools/list` 的实测**（`halo-mcp-server` 1.2.0，
 * 51 个工具）。写错一个字符的表现是 `missing-tool` 错误 —— 而 `McpClient.callTool` 会在
 * 发请求**之前**用 `tools/list` 拦下它，所以错误信息里会带上可用工具的全集。
 */
export const CONTENT_TOOLSETS: Record<ContentKind, ContentToolset> = {
  post: {
    list: "halo_list_posts",
    get: "halo_get_post",
    create: "halo_create_post",
    update: "halo_update_post",
    setPublish: "halo_set_post_publish_state",
    recycle: "halo_recycle_post",
    restore: "halo_restore_post",
  },
  page: {
    list: "halo_list_single_pages",
    get: "halo_get_single_page",
    create: "halo_create_single_page",
    update: "halo_update_single_page",
    setPublish: "halo_set_single_page_publish_state",
    recycle: "halo_recycle_single_page",
    restore: "halo_restore_single_page",
  },
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test tests/content-kind.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 扩充 `REQUIRED_TOOLS`**

把 `src/mcp-self-check.ts` 的 `REQUIRED_TOOLS` 换成下面这份。**逐条核对过**：每一条都是
本阶段结束后代码**真的会调用**的工具，没有一条是「预留」。

```ts
/**
 * 自检与契约测试共同断言的工具集。站点侧少掉任何一个，插件都会在**对应的那条路径上**静默失效，
 * 所以这份清单必须覆盖全部被调用的工具 —— 漏一个，防线就在那个工具上开了口子。
 *
 * 成分（逐条核对过，三类）：
 * - **文章路径（11 个）**：列表 / 读取 / 新建 / 修改、发布状态、回收、恢复、
 *   分类与标签的列举及创建、全文检索。
 * - **独立页面路径（7 个）**：与文章同构的一套（不含分类标签 —— 页面没有这两个字段）。
 * - **附件与上传（4 个）**：附件列表 / 读取 / 删除、附件上传。
 *
 * 共 **22 项**。评论、主题设置、`upload_attachment_from_url`、插件贡献的工具
 *（PluginMoments / image-stream）刻意不在其中 —— 见 spec 的 N2 / N3 与附录 A。
 *
 * 清单不敢靠「看起来对」：2026-10-05 对真实站点拉过一次 `tools/list`
 *（`halo-mcp-server` 1.2.0，共 51 个工具），下列 22 项**逐条命中**。
 * 契约测试 `pnpm test:contract` 是它的自动化版本。
 */
export const REQUIRED_TOOLS: readonly string[] = [
  // 文章
  "halo_list_posts",
  "halo_get_post",
  "halo_create_post",
  "halo_update_post",
  "halo_set_post_publish_state",
  "halo_recycle_post",
  "halo_restore_post",
  // 独立页面
  "halo_list_single_pages",
  "halo_get_single_page",
  "halo_create_single_page",
  "halo_update_single_page",
  "halo_set_single_page_publish_state",
  "halo_recycle_single_page",
  "halo_restore_single_page",
  // 分类与标签
  "halo_list_categories",
  "halo_create_category",
  "halo_list_tags",
  "halo_create_tag",
  // 检索与附件
  "halo_search_content",
  "halo_list_attachments",
  "halo_get_attachment",
  "halo_delete_attachment",
  "halo_upload_attachment",
];
```

⚠️ **注意：上面是 23 项，不是 22。** 逐个数一遍：
文章 7 + 页面 7 + 分类标签 4 + 检索附件 5 = **23**。
把注释里的「共 22 项」改成「共 23 项」，并在 `tests/mcp-self-check.test.ts` 里加一条断言把它钉住：

```ts
test("REQUIRED_TOOLS 覆盖到本阶段全部被调用的工具，且数量与注释一致", () => {
  // 数量写死是刻意的：这份清单每加一项都要有人重新数一遍，
  // 而 1-B 的教训正是「我接受了别人给的数字而没有自己数」。
  expect(REQUIRED_TOOLS).toHaveLength(23);
  expect(new Set(REQUIRED_TOOLS).size).toBe(23);
});
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm test tests/mcp-self-check.test.ts tests/content-kind.test.ts`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/content-kind.ts src/mcp-self-check.ts tests/content-kind.test.ts tests/mcp-self-check.test.ts
git commit -m "feat: 抽出内容类型抽象，自检清单扩到本阶段全部工具"
```

---

## Task 2: 独立页面的映射层

**Files:**
- Create: `src/service/page-mapping.ts`
- Modify: `src/service/post-mapping.ts`（抽出共有基类）
- Test: `tests/service/page-mapping.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface McpSinglePageItem`（字段见下）
  - `interface McpGetSinglePageResult`
  - `function toSinglePage(item: McpSinglePageItem): SinglePage`
  - `function toPageCreateArgs(page: SinglePage, raw: string): Record<string, unknown>`
  - `function toPageUpdateArgs(page: SinglePage, raw: string): Record<string, unknown>`
  - `interface McpContentItemBase`（在 `post-mapping.ts` 里）

- [ ] **Step 1: 写失败的测试**

```ts
// tests/service/page-mapping.test.ts
import { describe, expect, test } from "@rstest/core";
import {
  type McpSinglePageItem,
  toPageCreateArgs,
  toPageUpdateArgs,
  toSinglePage,
} from "../../src/service/page-mapping";

/** 页面的**扁平**骨架 —— 逐字取自 2026-10-05 实测的 `halo_list_single_pages` outputSchema */
function pageItem(overrides: Partial<McpSinglePageItem> = {}): McpSinglePageItem {
  return {
    name: "019fcb32-f421-7342-b900-35d1335192f5",
    title: "自己",
    slug: "about",
    excerpt: "",
    published: true,
    publishRequested: true,
    recycled: false,
    visible: "PUBLIC",
    owner: "liuhangyv",
    permalink: "/about",
    ...overrides,
  };
}

describe("toSinglePage", () => {
  test("把扁平表示还原成领域模型，字段名与 Post 同形以便复用编排", () => {
    const page = toSinglePage(pageItem());

    expect(page.metadata.name).toBe("019fcb32-f421-7342-b900-35d1335192f5");
    expect(page.spec.title).toBe("自己");
    expect(page.spec.slug).toBe("about");
    expect(page.spec.visible).toBe("PUBLIC");
    // ⚠️ publish 取 publishRequested，**不是 published** —— 与 toPost 同一条理由：
    // published 是「此刻是否真的在线」（受 publishTime / 回收站影响），
    // 取它会把一篇定时页面判成未发布。
    expect(page.spec.publish).toBe(true);
  });

  test("publishRequested 缺席时 publish 回落 false，而不是 undefined", () => {
    expect(toSinglePage(pageItem({ publishRequested: undefined })).spec.publish).toBe(false);
  });

  test("页面没有的字段不会凭空出现在 spec 上", () => {
    const page = toSinglePage(pageItem()) as unknown as { spec: Record<string, unknown> };

    for (const absent of ["categories", "tags", "pinned", "priority", "publishTime", "template"]) {
      expect(page.spec).not.toHaveProperty(absent);
    }
  });
});

describe("toPageCreateArgs / toPageUpdateArgs", () => {
  test("rawType 必须显式传 markdown（schema 默认值是 html，漏传会静默渲染错乱）", () => {
    const page = toSinglePage(pageItem());

    expect(toPageCreateArgs(page, "# 正文").rawType).toBe("markdown");
    expect(toPageUpdateArgs(page, "# 正文").rawType).toBe("markdown");
  });

  test("create 带 publish:false，update **不带** publish（该工具没有这个入参）", () => {
    const page = toSinglePage(pageItem());

    expect(toPageCreateArgs(page, "x").publish).toBe(false);
    expect(toPageUpdateArgs(page, "x")).not.toHaveProperty("publish");
  });

  test("create 的入参集合恰好是 schema 允许的那些（additionalProperties: false）", () => {
    const page = toSinglePage(pageItem());
    const args = toPageCreateArgs(page, "x");

    // 实测 inputSchema.properties 的键全集
    expect(Object.keys(args).sort()).toEqual(
      ["allowComment", "name", "raw", "rawType", "slug", "title", "visible"].sort(),
    );
  });

  test("update 的入参集合同样恰好是 schema 允许的那些", () => {
    const page = toSinglePage(pageItem());
    const args = toPageUpdateArgs(page, "x");

    expect(Object.keys(args).sort()).toEqual(["allowComment", "name", "raw", "rawType", "slug", "title", "visible"].sort());
  });

  test("空 slug 传 undefined 而不是空串（schema 有 minLength: 1）", () => {
    const page = toSinglePage(pageItem({ slug: "" }));

    expect(toPageUpdateArgs(page, "x").slug).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/service/page-mapping.test.ts`
Expected: FAIL —— `Cannot find module '../../src/service/page-mapping'`

- [ ] **Step 3: 在 `post-mapping.ts` 里抽出共有基类**

在 `src/service/post-mapping.ts` 的 `McpPostItem` **之前**插入：

```ts
/**
 * 文章与独立页面**共有**的扁平字段。抽出来是因为两种类型的差异只在
 * 「多/少哪几个字段」，而 `name` / `title` / `slug` / `published` / `publishRequested` /
 * `recycled` / `visible` / `permalink` 这一批是逐字相同的。
 *
 * 不抽的话，`page-mapping.ts` 会把它们再抄一遍 —— 而两份声明必然在某次服务端改动后分叉，
 * 表现是「文章读得到、页面读不到」。
 *
 * ⚠️ 两条 `required` 契约**不同**，别把这里当成一份完整契约：
 * `halo_list_posts` 的 item required 是 `["published","publishRequested","recycled","categories","tags"]`，
 * 而 `halo_list_single_pages` 的是 `["published","publishRequested","recycled"]`（没有 categories/tags）。
 */
export interface McpContentItemBase {
  name?: string;
  title?: string;
  slug?: string;
  excerpt?: string;
  published?: boolean;
  publishRequested?: boolean;
  recycled?: boolean;
  visible?: "PUBLIC" | "INTERNAL" | "PRIVATE";
  permalink?: string;
}
```

然后把 `McpPostItem` 改成继承它，**删掉重复声明的那些字段**：

```ts
export interface McpPostItem extends McpContentItemBase {
  excerptRaw?: string;
  autoGenerateExcerpt?: boolean;
  cover?: string;
  template?: string;
  pinned?: boolean;
  priority?: number;
  publishTime?: string;
  allowComment?: boolean;
  categories?: string[];
  tags?: string[];
}
```

⚠️ **这一步会动到 `toPost()` 的读取点**，但**不改行为**：`toPost` 读的是 `item.name` / `item.title`
这些**继承来的**字段，TypeScript 照样解析得到。跑 `pnpm test` 确认**既有测试全绿**（357 个）——
若有一条变红，说明基类少声明了某个字段。

- [ ] **Step 4: 写 `page-mapping.ts`**

```ts
// src/service/page-mapping.ts
import type { SinglePage } from "@halo-dev/api-client";
import type { McpContentItemBase } from "./post-mapping";

/**
 * 独立页面的**扁平**表示。
 *
 * 字段逐字取自 2026-10-05 对真实站点 `tools/list` 的核对（`halo-mcp-server` 1.2.0）：
 * `halo_list_single_pages` / `halo_get_single_page` / `halo_create_single_page` /
 * `halo_update_single_page` 的 outputSchema.properties 列的是同一套。
 *
 * **页面比文章少 9 个字段**：`categories` / `tags` / `pinned` / `priority` / `publishTime` /
 * `template` / `cover` / `autoGenerateExcerpt` / `excerptRaw`。这不是「服务端没回」，
 * 是**页面这个资源本来就没有这些概念** —— 所以本类型里一个都不能有，
 * 有的话 `toSinglePage` 会把它映射进 `spec`，而 `toPageUpdateArgs` 又会把它传回服务端，
 * 被 `additionalProperties: false` 拒绝。
 *
 * 与 `McpPostItem` 一样**只声明服务层真正消费的字段**：多声明就是一份要跟着服务端走的契约。
 */
export interface McpSinglePageItem extends McpContentItemBase {
  headSnapshot?: string;
  releaseSnapshot?: string;
  baseSnapshot?: string;
  version?: number;
  creationTimestamp?: string;
  updateTimestamp?: string;
}

export interface McpGetSinglePageResult {
  item: McpSinglePageItem;
  content: { snapshotName?: string | null; rawType?: string | null; raw?: string | null };
  /** ⚠️ 服务端可能截断长正文；为 true 时绝不能把内容当完整页面使用 */
  truncated?: boolean;
}

/**
 * 把 MCP 的扁平页面表示还原成领域模型 `SinglePage`，让既有消费点无需改动。
 *
 * **只填页面真有的字段** —— 与 `toPost` 的关键差别就在这里：`toPost` 会把 9 个文章字段
 * 全部填上（缺的用默认值），而页面填了就会被 `toPageUpdateArgs` 传出去、被 schema 拒绝。
 * 所以这里**不补任何文章独有的字段**。
 */
export function toSinglePage(item: McpSinglePageItem): SinglePage {
  return {
    apiVersion: "content.halo.run/v1alpha1",
    kind: "SinglePage",
    metadata: { name: item.name ?? "", annotations: {} },
    spec: {
      title: item.title ?? "",
      slug: item.slug ?? "",
      visible: item.visible ?? "PUBLIC",
      // 与 `toPost` 同一条理由：必须取 `publishRequested`，不能取 `published`，
      // 也不能写死 false —— 回写会把它写进 `frontmatter.halo.publish`，而下次发布读它决定
      // 要不要调发布状态工具。恒为 false 会让「发布一次」变成「把已发布的页面撤回草稿」。
      publish: item.publishRequested ?? false,
      excerpt: {
        autoGenerate: true,
        raw: item.excerpt ?? "",
      },
    },
  } as SinglePage;
}

/**
 * 把领域模型投影成 `halo_create_single_page` 的入参。
 *
 * **入参集合恰好是 schema 允许的 7 个键**（schema 是 `additionalProperties: false`，
 * 多传一个会被服务端拒绝）。实测 `required: ["name","title","raw"]`。
 *
 * `rawType` 必须显式传 `"markdown"`：schema 的默认值是 **`"html"`**，漏传会把 Markdown
 * 当 HTML 存，站点渲染错乱而本地看不出任何异常 —— 与文章那条硬约束同源。
 */
export function toPageCreateArgs(page: SinglePage, raw: string): Record<string, unknown> {
  return {
    ...toPageUpdateArgs(page, raw),
    // 新建时默认推草稿；是否发布由随后的 set_single_page_publish_state 决定
    publish: false,
  };
}

/** 把领域模型投影成 `halo_update_single_page` 的入参。注意该工具**没有** `publish`。 */
export function toPageUpdateArgs(page: SinglePage, raw: string): Record<string, unknown> {
  return {
    name: page.metadata.name,
    title: page.spec.title,
    // `|| undefined` 而不是空串：schema 的 `slug` 有 `minLength: 1`，空串会被拒绝。
    // 传 `undefined` 时 JSON.stringify 会**整个丢掉这个键**，服务端就用它自己的默认值。
    slug: page.spec.slug || undefined,
    raw,
    rawType: "markdown",
    visible: page.spec.visible,
    allowComment: true,
  };
}
```

⚠️ **`allowComment` 写死 `true` 是刻意的**：页面的 `spec` 上没有这个字段（MCP 的
`halo_create_single_page` 收它，但 `halo_get_single_page` 不回它），所以本地无从得知远端值。
写死 `true` 与上游行为一致（新建默认允许评论）。**不要**把它做成 frontmatter 可配的 ——
那会引入一个「读不回来」的字段，而 1-B 的教训正是「写出去读不回来的字段会静默漂移」。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test tests/service/page-mapping.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 6: 跑全量测试，确认抽基类没有破坏既有行为**

Run: `pnpm test`
Expected: PASS（357 + 新增）

- [ ] **Step 7: 提交**

```bash
git add src/service/post-mapping.ts src/service/page-mapping.ts tests/service/page-mapping.test.ts
git commit -m "feat: 独立页面的映射层，抽出两种内容类型共有的扁平基类"
```

---

## Task 3: 通用翻页取数器

**Files:**
- Create: `src/pagination.ts`
- Test: `tests/pagination.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface PagedResult<T> { items: T[]; page: number; size: number; total: number; totalPages: number; hasNext: boolean }`
  - `interface FetchAllPagesOptions<T> { pageSize: number; maxPages?: number }`
  - `async function fetchAllPages<T>(fetchPage: (page: number, size: number) => Promise<PagedResult<T>>, options: FetchAllPagesOptions<T>): Promise<{ items: T[]; truncated: boolean }>`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/pagination.test.ts
import { describe, expect, test, rs } from "@rstest/core";
import { fetchAllPages } from "../src/pagination";

function paged<T>(items: T[], page: number, total: number, size: number) {
  const totalPages = Math.ceil(total / size);
  return { items, page, size, total, totalPages, hasNext: page < totalPages };
}

describe("fetchAllPages", () => {
  test("一页就够时只调一次", async () => {
    const fetchPage = rs.fn(async (page: number, size: number) => paged(["a", "b"], page, 2, size));
    const result = await fetchAllPages(fetchPage, { pageSize: 100 });

    expect(result.items).toEqual(["a", "b"]);
    expect(result.truncated).toBe(false);
    expect(fetchPage.mock.calls).toHaveLength(1);
  });

  test("按 hasNext 翻完所有页，结果按页序拼接", async () => {
    // 250 条、每页 100 → 3 页
    const all = Array.from({ length: 250 }, (_, i) => i);
    const fetchPage = rs.fn(async (page: number, size: number) => {
      const start = (page - 1) * size;
      return paged(all.slice(start, start + size), page, all.length, size);
    });

    const result = await fetchAllPages(fetchPage, { pageSize: 100 });

    expect(result.items).toEqual(all);
    expect(result.truncated).toBe(false);
    expect(fetchPage.mock.calls).toHaveLength(3);
  });

  test("hasNext 为真但 items 为空时**必须停下**，否则会无限循环", async () => {
    // 服务端自相矛盾的响应：说还有下一页，却一页都不给。
    // 不挡这一条的话循环永远出不来 —— 而这是一个**会挂住 Obsidian 主线程**的失败模式。
    let calls = 0;
    const fetchPage = rs.fn(async (page: number, size: number) => {
      calls++;
      return { items: [], page, size, total: 999, totalPages: 999, hasNext: true };
    });

    const result = await fetchAllPages(fetchPage, { pageSize: 100 });

    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(true);
    // 第一次拿到空 items 就该停，不该有第二次
    expect(calls).toBe(1);
  });

  test("超过 maxPages 时停下并标记 truncated", async () => {
    const fetchPage = rs.fn(async (page: number, size: number) => paged([page], page, 100000, size));

    const result = await fetchAllPages(fetchPage, { pageSize: 100, maxPages: 3 });

    expect(result.items).toEqual([1, 2, 3]);
    expect(result.truncated).toBe(true);
    expect(fetchPage.mock.calls).toHaveLength(3);
  });

  test("页号从 1 开始（schema 的 minimum 就是 1）", async () => {
    const seen: number[] = [];
    const fetchPage = rs.fn(async (page: number, size: number) => {
      seen.push(page);
      return paged([page], page, 150, size);
    });

    await fetchAllPages(fetchPage, { pageSize: 100 });

    expect(seen).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/pagination.test.ts`
Expected: FAIL —— `Cannot find module '../src/pagination'`

- [ ] **Step 3: 写实现**

```ts
// src/pagination.ts

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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test tests/pagination.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/pagination.ts tests/pagination.test.ts
git commit -m "feat: 通用翻页取数器，带两条终止保证"
```

---

## Task 4: 服务层分页收口

**Files:**
- Modify: `src/service/index.ts`（`getCategories` / `getTags`）
- Modify: `src/post-selection-model.ts`（改用翻页，删掉截断提示）
- Test: `tests/service/index.test.ts`, `tests/post-selection-model.test.ts`

**Interfaces:**
- Consumes: `fetchAllPages`（Task 3）
- Produces: `getCategories()` / `getTags()` 的签名**不变**（仍返回 `McpCategoryItem[]` / `McpTagItem[]`）；`fetchSelectablePosts(client)` 的签名**不变**

- [ ] **Step 1: 写失败的测试**

在 `tests/service/index.test.ts` 里追加：

```ts
test("分类超过一页时会翻页取全，而不是静默漏掉后面的", async () => {
  // 站点真实规模是 8 个分类，但契约上 size 上限 100 —— 一旦超过就会漏。
  // 这条用例用 250 个来钉住「翻页真的发生了」。
  const all = Array.from({ length: 250 }, (_, i) => ({
    name: `category-${i}`,
    displayName: `分类 ${i}`,
  }));

  const { client, calls } = createFakeClient((name, args) => {
    if (name !== "halo_list_categories") {
      return {};
    }
    const page = Number(args.page ?? 1);
    const size = Number(args.size ?? 20);
    const start = (page - 1) * size;
    return {
      items: all.slice(start, start + size),
      page,
      size,
      total: all.length,
      totalPages: Math.ceil(all.length / size),
      hasNext: page < Math.ceil(all.length / size),
    };
  });

  const service = new HaloService(app, createSettings(), site, client);
  const categories = await service.getCategories();

  expect(categories).toHaveLength(250);
  expect(categories[249].displayName).toBe("分类 249");
  // 3 页 → 3 次调用
  expect(calls.filter((call) => call.name === "halo_list_categories")).toHaveLength(3);
});
```

在 `tests/post-selection-model.test.ts` 里**改**既有用例：把「`hasNext` 为真时弹截断提示」
改成「翻页取全，不弹提示」：

```ts
test("列表超过一页时翻页取全，**不再**提示列表不完整", async () => {
  // 改动前：只取第一页 + 弹 `post_selection_modal.notice_truncated`。
  // 现在：翻完所有页。提示随之删除 —— 留着它会在**列表已经完整**时谎报不完整。
  const all = Array.from({ length: 150 }, (_, i) => ({ name: `post-${i}`, title: `文章 ${i}` }));
  const { client, calls } = createFakeClient((name, args) => {
    const page = Number(args.page ?? 1);
    const size = Number(args.size ?? 20);
    const start = (page - 1) * size;
    return {
      items: all.slice(start, start + size),
      page,
      size,
      total: all.length,
      totalPages: Math.ceil(all.length / size),
      hasNext: page < Math.ceil(all.length / size),
    };
  });

  const posts = await fetchSelectablePosts(client);

  expect(posts).toHaveLength(150);
  expect(calls).toHaveLength(2);
  expect(capturedNotices()).not.toContain(i18next.t("post_selection_modal.notice_truncated", { size: LIST_PAGE_SIZE }));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/service/index.test.ts tests/post-selection-model.test.ts`
Expected: FAIL —— `getCategories` 只调一次、返回 100 条；拉取列表只调一次、返回 100 条

- [ ] **Step 3: 改 `getCategories` / `getTags`**

```ts
  /**
   * 列出站点分类（扁平表示，见 `post-mapping.ts`）。
   *
   * **翻页取全**。此前写死 `size: 100`（schema 上限）且**没有任何提示** —— 站点上分类一旦
   * 超过 100，后面的会被静默漏掉，而「静默」正是本阶段反复处理的那一类问题：
   * 用户看不到某几个分类，会以为它们不存在，然后重新建一遍。
   *
   * 触顶（`fetchAllPages` 的 `maxPages`）时**必须提示**，不能静默截断。
   */
  public async getCategories(): Promise<McpCategoryItem[]> {
    const { items, truncated } = await fetchAllPages<McpCategoryItem>(
      async (page, size) =>
        await this.client.callToolJson<{ items?: McpCategoryItem[] } & PagedResult<McpCategoryItem>>(
          "halo_list_categories",
          { page, size },
        ),
      { pageSize: LIST_PAGE_SIZE },
    );

    if (truncated) {
      new Notice(i18next.t("service.notice_list_truncated", { what: i18next.t("service.what_categories") }));
    }

    return items;
  }

  /** 列出站点标签。翻页与提示的处置同 `getCategories`。 */
  public async getTags(): Promise<McpTagItem[]> {
    const { items, truncated } = await fetchAllPages<McpTagItem>(
      async (page, size) =>
        await this.client.callToolJson<{ items?: McpTagItem[] } & PagedResult<McpTagItem>>("halo_list_tags", {
          page,
          size,
        }),
      { pageSize: LIST_PAGE_SIZE },
    );

    if (truncated) {
      new Notice(i18next.t("service.notice_list_truncated", { what: i18next.t("service.what_tags") }));
    }

    return items;
  }
```

在 `src/service/index.ts` 顶部加 import：

```ts
import { type PagedResult, fetchAllPages } from "../pagination";
```

⚠️ **`LIST_PAGE_SIZE` 现在有两个来源**：`post-selection-model.ts` 导出它，而服务层也要用。
**不要**从 `post-selection-model.ts` import 进服务层 —— 那个模块 import 了 `HaloPlugin`，
会把 `main.ts` 拖进服务层的依赖图。把常量移到 `src/pagination.ts` 并**在那里导出**：

```ts
/**
 * 列表工具每页取多少。**100 是 schema 的 `maximum`**，不是随手取的整数 ——
 * 传 101 会被服务端拒绝。（实测自 `halo_list_posts` / `halo_list_categories` 等工具的 inputSchema。）
 */
export const LIST_PAGE_SIZE = 100;
```

然后 `post-selection-model.ts` 改成 `export { LIST_PAGE_SIZE } from "./pagination";` 以保住既有 import 路径。

- [ ] **Step 4: 改 `fetchSelectablePosts`**

```ts
export async function fetchSelectablePosts(client: McpClient): Promise<SelectablePost[]> {
  let result: FetchAllPagesResult<McpPostItem>;

  try {
    // 翻页取全。此前只取一页、在 `hasNext` 为真时弹一句「还有文章没有列出来」——
    // 那句提示现在**已删除**：列表不再会不完整，留着它会在列表**完整**时谎报不完整。
    result = await fetchAllPages<McpPostItem>(
      async (page, size) =>
        await client.callToolJson<PagedResult<McpPostItem>>("halo_list_posts", { page, size }),
      { pageSize: LIST_PAGE_SIZE },
    );
  } catch (error) {
    new Notice(renderErrorMessage(error));
    return [];
  }

  if (result.truncated) {
    // 只有**触顶**（maxPages）才提示 —— 那时列表确实不完整
    new Notice(i18next.t("post_selection_modal.notice_truncated", { size: LIST_PAGE_SIZE * 20 }));
  }

  return toSelectablePosts(result.items);
}
```

`PostListResult` 接口**删掉**（改用 `PagedResult<McpPostItem>`），并把 `hasNext` 那段注释一并删除。

- [ ] **Step 5: 加三语文案**

`src/i18n/locales/en.json` 的 `service` 组里加：

```json
"notice_list_truncated": "The {{what}} list is incomplete — only the first {{size}} were loaded.",
"what_categories": "category",
"what_tags": "tag"
```

`zh-cn.json`：

```json
"notice_list_truncated": "{{what}}列表不完整 —— 只加载了前 {{size}} 条。",
"what_categories": "分类",
"what_tags": "标签"
```

`zh-tw.json`：

```json
"notice_list_truncated": "{{what}}列表不完整 —— 只載入了前 {{size}} 條。",
"what_categories": "分類",
"what_tags": "標籤"
```

⚠️ 上面 `notice_list_truncated` 的文案里用了 `{{size}}`，但 Step 3 的调用**没有传 `size`**。
**两者必须对齐**：把文案里的 `{{size}}` 去掉，或把调用改成传 `size`。
**选后者**（信息更多），即调用写成：

```ts
new Notice(i18next.t("service.notice_list_truncated", { what: ..., size: LIST_PAGE_SIZE * 20 }));
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm test`
Expected: PASS（全量）

- [ ] **Step 7: 提交**

```bash
git add src/pagination.ts src/service/index.ts src/post-selection-model.ts \
  src/i18n/locales/en.json src/i18n/locales/zh-cn.json src/i18n/locales/zh-tw.json \
  tests/service/index.test.ts tests/post-selection-model.test.ts
git commit -m "feat: 分类/标签/拉取列表改为翻页取全，删掉会谎报的截断提示"
```

---

## Task 5: 独立页面的服务层

**Files:**
- Create: `src/service/page-service.ts`
- Test: `tests/service/page-service.test.ts`

**Interfaces:**
- Consumes: `CONTENT_TOOLSETS`（Task 1）、`toSinglePage` / `toPageCreateArgs` / `toPageUpdateArgs`（Task 2）
- Produces:
  - `class PageService`，构造签名 `(app: App, settings: HaloSetting, site: HaloSite, client?: McpClient)`
  - `getPage(name: string): Promise<{ page: SinglePage; content: Content }>`
  - `pushPage(file: TFile, options?: { publish?: boolean }): Promise<PublishResult>`
  - `pullPage(name: string): Promise<void>`
  - `setPagePublish(name: string, publish: boolean): Promise<void>`
  - `recyclePage(name: string): Promise<void>`
  - `restorePage(name: string): Promise<void>`
  - `getPages(): Promise<McpSinglePageItem[]>`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/service/page-service.test.ts
import { beforeAll, describe, expect, test } from "@rstest/core";
import { initializeI18n } from "../../src/i18n";
import PageService from "../../src/service/page-service";
import { McpError } from "../../src/transport/errors";
import { createFakeClient } from "../helpers/mcp-mock";
import { createFile, createMockApp, createSettings, TEST_SITE as site } from "../helpers/obsidian-mocks";

beforeAll(async () => {
  await initializeI18n("en");
});

function pageItem(overrides: Record<string, unknown> = {}) {
  return {
    name: "page-1",
    title: "关于",
    slug: "about",
    excerpt: "",
    published: false,
    publishRequested: false,
    recycled: false,
    visible: "PUBLIC",
    ...overrides,
  };
}

describe("PageService.pushPage", () => {
  test("新建走 halo_create_single_page，且**不**传文章独有的字段", async () => {
    const file = createFile("pages/about.md");
    const { app } = createMockApp("---\ntitle: 关于\n---\n正文", file, []);
    const { client, calls } = createFakeClient((name) => {
      if (name === "halo_get_single_page") {
        return { item: pageItem(), content: { snapshotName: "s", rawType: "markdown", raw: "正文" }, truncated: false };
      }
      return {};
    });

    const service = new PageService(app, createSettings(), site, client);
    const result = await service.pushPage(file);

    expect(result.ok).toBe(true);

    const created = calls.find((call) => call.name === "halo_create_single_page");
    expect(created).toBeDefined();
    expect(created?.method).toBe("callToolVoid");
    expect(created?.args.rawType).toBe("markdown");
    expect(created?.args).not.toHaveProperty("categories");
    expect(created?.args).not.toHaveProperty("tags");
    expect(created?.args).not.toHaveProperty("pinned");
  });

  test("已存在 halo.name 时走 halo_update_single_page", async () => {
    const file = createFile("pages/about.md");
    const { app } = createMockApp("---\nhalo:\n  name: page-1\n---\n正文", file, []);
    const { client, calls } = createFakeClient((name) => {
      if (name === "halo_get_single_page") {
        return { item: pageItem(), content: { snapshotName: "s", rawType: "markdown", raw: "正文" }, truncated: false };
      }
      return {};
    });

    const service = new PageService(app, createSettings(), site, client);
    await service.pushPage(file);

    expect(calls.some((call) => call.name === "halo_update_single_page")).toBe(true);
    expect(calls.some((call) => call.name === "halo_create_single_page")).toBe(false);
  });

  test("truncated 为真时**抛错**，绝不把截断正文当完整页面", async () => {
    const file = createFile("pages/about.md");
    const { app } = createMockApp("---\nhalo:\n  name: page-1\n---\n正文", file, []);
    const { client } = createFakeClient(() => ({
      item: pageItem(),
      content: { snapshotName: "s", rawType: "markdown", raw: "截断的" },
      truncated: true,
    }));

    const service = new PageService(app, createSettings(), site, client);

    await expect(service.pushPage(file)).resolves.toMatchObject({ ok: false });
  });

  test("frontmatter 的 halo.site 与目标站点不一致时中止，且**一个写工具都不调**", async () => {
    const file = createFile("pages/about.md");
    const { app } = createMockApp("---\nhalo:\n  site: https://other.example.com\n---\n正文", file, []);
    const { client, calls } = createFakeClient(() => ({}));

    const service = new PageService(app, createSettings(), site, client);
    const result = await service.pushPage(file);

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("PageService 的回收与恢复", () => {
  test("recyclePage / restorePage 走页面专属工具（不是文章的）", async () => {
    const { app } = createMockApp("", createFile("a.md"), []);
    const { client, calls } = createFakeClient(() => ({}));
    const service = new PageService(app, createSettings(), site, client);

    await service.recyclePage("page-1");
    await service.restorePage("page-1");

    expect(calls.map((call) => call.name)).toEqual(["halo_recycle_single_page", "halo_restore_single_page"]);
    expect(calls.every((call) => call.method === "callToolVoid")).toBe(true);
  });

  test("setPagePublish 走 halo_set_single_page_publish_state", async () => {
    const { app } = createMockApp("", createFile("a.md"), []);
    const { client, calls } = createFakeClient(() => ({}));
    const service = new PageService(app, createSettings(), site, client);

    await service.setPagePublish("page-1", true);

    expect(calls[0].name).toBe("halo_set_single_page_publish_state");
    expect(calls[0].args).toEqual({ name: "page-1", publish: true });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/service/page-service.test.ts`
Expected: FAIL —— `Cannot find module '../../src/service/page-service'`

- [ ] **Step 3: 写实现**

`HaloService` 的 `withPublishRetry` / `sleep` / `bodyOf` / `report` / `publishFailureMessage` /
`readFailureMessage` 都是 `private`。**先做一次纯重构**把它们提到一个可复用的基类上，
**不改任何行为**：

在 `src/service/index.ts` 里新建并导出 `HaloServiceBase`，把上述 5 个方法与
`protected readonly app/settings/site/client` 搬进去，`HaloService extends HaloServiceBase`。
跑全量测试确认 357 个仍全绿 —— 这是纯重构，任何一条变红都说明搬错了。

然后写 `page-service.ts`：

```ts
// src/service/page-service.ts
import type { Content, SinglePage } from "@halo-dev/api-client";
import i18next from "i18next";
import { type App, Notice, type TFile } from "obsidian";
import { CONTENT_TOOLSETS } from "../content-kind";
import { renderErrorMessage } from "../i18n/error-message";
import { type HaloSetting, type HaloSite, isSameSiteUrl } from "../settings";
import { McpError } from "../transport/errors";
import type { McpClient } from "../transport/mcp-client";
import { type HaloPostFrontmatter, applyPostFrontmatter } from "./local-content";
import { HaloServiceBase, type PublishResult } from "./index";
import {
  type McpGetSinglePageResult,
  type McpSinglePageItem,
  toPageCreateArgs,
  toPageUpdateArgs,
  toSinglePage,
} from "./page-mapping";

/**
 * 独立页面的编排。
 *
 * **与 `HaloService` 共用 `HaloServiceBase` 的重试与收尾读逻辑**，而不是各写一份 ——
 * 那些逻辑（`withPublishRetry` 的 3 次 500ms 退避、`refreshPostAfterWrite` 的「回读失败
 * 就沿用本地构造」）是 1-A 花了整轮才调对的，复制一份必然在某次改动后分叉。
 *
 * 与文章路径的**实质差异只有三处**：
 * ① 工具名换一套（`CONTENT_TOOLSETS.page`）；
 * ② 入参只有 7 个键（页面没有分类/标签/置顶/排序/定时/模板）；
 * ③ frontmatter 只认 `halo.site` / `halo.name` / `halo.publish` 三个 halo 键 ——
 *    1-B 开放的 6 个元数据字段**对页面没有意义**，写了也不该报错，只是被忽略。
 */
class PageService extends HaloServiceBase {
  private readonly tools = CONTENT_TOOLSETS.page;

  /** 读一个页面。与 `HaloService.getPost` 同构：`truncated` 为真即抛。 */
  public async getPage(name: string): Promise<{ page: SinglePage; content: Content }> {
    const result = await this.client.callToolJson<McpGetSinglePageResult>(this.tools.get, {
      name,
      version: "HEAD",
      format: "RAW",
    });

    if (result.truncated) {
      // 绝不能把截断的正文当完整页面写进本地文件 —— 那是静默损坏用户的笔记
      throw new McpError("unknown", { tool: this.tools.get }, `content truncated: ${name}`);
    }

    return {
      page: toSinglePage(result.item),
      content: { content: "", raw: result.content.raw ?? "", rawType: result.content.rawType ?? "markdown" } as Content,
    };
  }

  /** 列出全部页面（翻页取全）。供选择器与「按名字找页面」用。 */
  public async getPages(): Promise<McpSinglePageItem[]> {
    const { items, truncated } = await fetchAllPages<McpSinglePageItem>(
      async (page, size) =>
        await this.client.callToolJson<PagedResult<McpSinglePageItem>>(this.tools.list, { page, size }),
      { pageSize: LIST_PAGE_SIZE },
    );

    if (truncated) {
      new Notice(i18next.t("service.notice_list_truncated", { what: i18next.t("service.what_pages"), size: LIST_PAGE_SIZE * 20 }));
    }

    return items;
  }

  public async setPagePublish(name: string, publish: boolean): Promise<void> {
    // 走 callToolVoid：本工具最可能回一句确认文案，用 callToolJson 会在写成功后抛错
    await this.client.callToolVoid(this.tools.setPublish, { name, publish });
  }

  public async recyclePage(name: string): Promise<void> {
    await this.client.callToolVoid(this.tools.recycle, { name });
  }

  public async restorePage(name: string): Promise<void> {
    await this.client.callToolVoid(this.tools.restore, { name });
  }

  /**
   * 把一篇笔记推成独立页面（新建或更新）。
   *
   * 与 `HaloService.publishPost` 的差别：**没有规划/预览/图片上传**。
   * 页面通常是「关于」「友链」这类短文档，图片上传与批量预览对它的收益远小于复杂度 ——
   * 真需要传图的页面，用户可以先用 `Halo: 上传图片` 那条命令。
   */
  public async pushPage(file: TFile, options: { publish?: boolean } = {}): Promise<PublishResult> {
    const markdown = await this.app.vault.read(file);
    const matterData = this.app.metadataCache.getFileCache(file)?.frontmatter as HaloPostFrontmatter | undefined;

    if (matterData?.halo?.site && !isSameSiteUrl(matterData.halo.site, this.site.url)) {
      return { ok: false, reason: i18next.t("service.error_site_not_match") };
    }

    // 归一化掉显式空串：`halo.name: ""` 的语义是「还没发布过」，与文章路径同一条判据
    const remoteName = matterData?.halo?.name || undefined;

    try {
      const basis = remoteName ? (await this.getPage(remoteName)).page : createEmptyPage();
      const raw = this.bodyOf(markdown, file);

      // 复用同一份 frontmatter 应用逻辑：它只认 title / slug / excerpt / cover / categories /
      // tags 与 haloFields，而页面没有后四者 —— 传 undefined 即可，函数内部有真值判断。
      const page = applyPostFrontmatter(basis, {
        activeFile: file,
        haloFields: undefined,
        matterData,
        useActiveFileDefaults: !remoteName,
      }) as unknown as SinglePage;

      await this.withPublishRetry(async (attempt) => {
        if (remoteName) {
          const target = attempt === 0 ? page : toSinglePage((await this.getPage(remoteName)).page as never);
          await this.client.callToolVoid(this.tools.update, toPageUpdateArgs(target, raw));
        } else {
          page.metadata.name = randomUUID();
          await this.client.callToolVoid(this.tools.create, toPageCreateArgs(page, raw));
        }

        const publish = options.publish ?? matterData?.halo?.publish ?? this.settings.publishByDefault;
        await this.setPagePublish(page.metadata.name, publish);
      });

      // 回读拿服务端归一化过的 slug，再回写笔记 —— 与文章路径同一条收尾
      await this.writeBack(file, page, remoteName ? undefined : page.metadata.name);
      new Notice(i18next.t("service.notice_push_page_success"));
      return { ok: true };
    } catch (error) {
      const reason = this.publishFailureMessage(error);
      new Notice(reason);
      return { ok: false, reason };
    }
  }

  /** 拉一个页面到本地，建一篇新笔记 */
  public async pullPage(name: string): Promise<void> {
    let result: { page: SinglePage; content: Content };

    try {
      result = await this.getPage(name);
    } catch (error) {
      new Notice(renderErrorMessage(error, "service.error_post_not_found"));
      return;
    }

    const file = await this.app.vault.create(`${result.page.spec.title}.md`, result.content.raw);
    this.app.workspace.getLeaf().openFile(file);

    this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.title = result.page.spec.title;
      frontmatter.slug = result.page.spec.slug;
      frontmatter.halo = {
        site: this.site.url,
        // ⚠️ 是**入参** name，不是 `page.metadata.name` —— 理由同 `HaloService.pullPost`
        name,
        publish: result.page.spec.publish,
      };
    });
  }
}

/** 新建页面的底稿。字段集**只含页面真有的那些** —— 多一个就会被 schema 拒绝 */
function createEmptyPage(): SinglePage {
  return {
    apiVersion: "content.halo.run/v1alpha1",
    kind: "SinglePage",
    metadata: { annotations: {}, name: "" },
    spec: { title: "", slug: "", visible: "PUBLIC", publish: false, excerpt: { autoGenerate: true, raw: "" } },
  } as SinglePage;
}

export default PageService;
```

⚠️ **上面 `pushPage` 里有一处刻意留下的不完整**：`this.writeBack(...)` 与
`randomUUID` / `fetchAllPages` / `PagedResult` / `LIST_PAGE_SIZE` / `HaloServiceBase` 的 import
没有给出。**实施者必须自己补齐**，并且：

- `writeBack` **不要**新写一个方法 —— 把 `HaloService` 里那段
  `processFrontMatter + applyPostToFrontmatter` 提到 `HaloServiceBase` 上（纯重构），
  两个子类共用。**这是本任务最容易走偏的一处**：写第二个回写实现就是 Global Constraint 1 说的分叉。
- `applyPostFrontmatter` 的返回类型是 `Post`，而页面是 `SinglePage`。上面那个
  `as unknown as SinglePage` 断言**是错的** —— 它会掩盖「函数内部填了页面没有的字段」这件事。
  **正确做法**：给 `applyPostFrontmatter` 加一个泛型参数
  `applyPostFrontmatter<T extends Post | SinglePage>(post: T, options): T`，
  并让它在页面路径上**跳过** `categories` / `tags` 的赋值。这需要改 `local-content.ts`，
  **本任务允许且必须做这个改动**。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test tests/service/page-service.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 5: 跑全量测试，确认基类抽取没有破坏文章路径**

Run: `pnpm test`
Expected: PASS（全量）

- [ ] **Step 6: 提交**

```bash
git add src/service/index.ts src/service/page-service.ts src/service/local-content.ts \
  tests/service/page-service.test.ts
git commit -m "feat: 独立页面服务层，与文章路径共用重试与回写基类"
```

---

## Task 6: 独立页面命令与选择器

**Files:**
- Create: `src/page-selection-model.ts`
- Modify: `src/main.ts`
- Modify: `src/i18n/locales/{en,zh-cn,zh-tw}.json`
- Test: `tests/page-selection-model.test.ts`, `tests/main.test.ts`

**Interfaces:**
- Consumes: `PageService`（Task 5）
- Produces: 3 条命令 —— `push-page` / `pull-page` / `manage-pages`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/page-selection-model.test.ts
import { describe, expect, test } from "@rstest/core";
import { toSelectablePages } from "../src/page-selection-model";

describe("toSelectablePages", () => {
  test("剔除缺 name 的项（按下去必然失败）", () => {
    const pages = toSelectablePages([
      { name: "page-1", title: "关于", slug: "about" },
      { title: "没有名字", slug: "x" },
    ]);

    expect(pages).toHaveLength(1);
    expect(pages[0].name).toBe("page-1");
  });

  test("缺 title 时回落成 name，避免一行空白", () => {
    const pages = toSelectablePages([{ name: "page-1", slug: "about" }]);

    expect(pages[0].title).toBe("page-1");
  });

  test("缺 slug 时回落成空串（它不是标识，只是副标题）", () => {
    const pages = toSelectablePages([{ name: "page-1", title: "关于" }]);

    expect(pages[0].slug).toBe("");
  });
});
```

在 `tests/main.test.ts` 的 `Internals` 类型里加 `pushPageCommand(): Promise<void>` /
`pullPageCommand(): Promise<void>`，并加一条：

```ts
test("push-page 命令在没有活动文件时静默返回，不弹任何提示", async () => {
  const { plugin } = makePlugin(createSettings({ skipPreviewOnPublish: true }));
  (plugin.app as { workspace: { activeEditor: unknown } }).workspace.activeEditor = null;

  await plugin.pushPageCommand();

  expect(capturedNotices()).toHaveLength(0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/page-selection-model.test.ts tests/main.test.ts`
Expected: FAIL —— `Cannot find module '../src/page-selection-model'` / `plugin.pushPageCommand is not a function`

- [ ] **Step 3: 写 `page-selection-model.ts`**

与 `post-selection-model.ts` 同构，**但取数走 `PageService.getPages()` 而不是直接造 `McpClient`**
（页面列表要翻页，而翻页逻辑已经在服务层里了）。

```ts
// src/page-selection-model.ts
import i18next from "i18next";
import { Modal, Setting } from "obsidian";
import type HaloPlugin from "./main";
import type { McpSinglePageItem } from "./service/page-mapping";
import PageService from "./service/page-service";
import type { HaloSite } from "./settings";

/** 选择器需要的最小字段集。理由同 `post-selection-model.ts` 的 `SelectablePost` */
export interface SelectablePage {
  /** `metadata.name` —— 拉取时唯一的标识。schema 未把它列为必需，缺失的项已在映射时剔除。 */
  name: string;
  /** 列表里显示的标题。缺 `title` 时回落成 `name`，否则会出现一行空白。 */
  title: string;
  /** 列表里的副标题，单纯给用户辨认用，可以为空串。 */
  slug: string;
}

/**
 * 扁平列表项 → 选择器条目。抽成纯函数，好让这层映射能被直接测到（无需 UI 脚手架）。
 *
 * 三条规范化都源自 schema 的事实：`halo_list_single_pages` 的 item `required` 只有
 * `["published", "publishRequested", "recycled"]` —— **`name` / `title` / `slug` 都不在其中**。
 * 与 `toSelectablePosts` 逐字同构，**但刻意不复用同一个函数**：两个函数的入参类型不同
 * （`McpPostItem` vs `McpSinglePageItem`），强行合一会让签名退化成 `{ name?: string }` 这类
 * 结构类型，从而失去「文章项与页面项的字段集不同」这条信息。
 */
export function toSelectablePages(items: McpSinglePageItem[]): SelectablePage[] {
  const pages: SelectablePage[] = [];

  for (const item of items) {
    if (!item.name) {
      continue;
    }

    pages.push({
      name: item.name,
      title: item.title || item.name,
      slug: item.slug ?? "",
    });
  }

  return pages;
}

export function openPageSelectionModal(plugin: HaloPlugin, site: HaloSite): Promise<SelectablePage> {
  return new Promise<SelectablePage>((resolve) => {
    new PageSelectionModal(plugin, site, resolve).open();
  });
}

class PageSelectionModal extends Modal {
  private readonly service: PageService;

  constructor(
    private readonly plugin: HaloPlugin,
    private readonly site: HaloSite,
    private readonly onSelect: (page: SelectablePage) => void,
  ) {
    super(plugin.app);
    this.service = new PageService(plugin.app, plugin.settings, site);
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: i18next.t("page_selection_modal.title") });

    // `getPages` 的契约是「不抛」：失败时它自己弹提示并给空数组（与 `fetchSelectablePosts` 同款）
    this.service
      .getPages()
      .then((items) => {
        for (const page of toSelectablePages(items)) {
          new Setting(contentEl)
            .setName(page.title)
            .setDesc(page.slug)
            .addButton((button) =>
              button.setButtonText(i18next.t("page_selection_modal.button_pull")).onClick(() => {
                this.onSelect(page);
                this.close();
              }),
            );
        }
      })
      .finally(() => {
        new Setting(contentEl).addButton((button) =>
          button.setButtonText(i18next.t("common.button_close")).onClick(() => this.close()),
        );
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}
```

⚠️ **`getPages()` 的契约目前是「会抛」**（它没有 try/catch）。上面那句注释说它「不抛」是**假的**。
**必须二选一**：要么给 `getPages()` 加 try/catch（与 `fetchSelectablePosts` 一致，弹提示 + 返回 `[]`），
要么在这里挂 `.catch`。**选前者** —— 让两个取数函数的契约一致，否则调用方每次都得先看一眼
「这个函数抛不抛」。改完把上面那句注释改成事实。

- [ ] **Step 4: 在 `main.ts` 注册三条命令**

```ts
    this.addCommand({
      id: "push-page",
      name: i18next.t("command.push_page.name"),
      callback: async () => {
        await this.pushPageCommand();
      },
    });

    this.addCommand({
      id: "pull-page",
      name: i18next.t("command.pull_page.name"),
      callback: async () => {
        await this.pullPageCommand();
      },
    });

    this.addCommand({
      id: "manage-pages",
      name: i18next.t("command.manage_pages.name"),
      callback: async () => {
        await this.managePagesCommand();
      },
    });
```

并加三个私有方法：

```ts
  /** `push-page` 的入口：把当前笔记推成独立页面 */
  private async pushPageCommand(): Promise<void> {
    const { activeEditor } = this.app.workspace;

    if (!activeEditor?.file) {
      return;
    }

    const resolution = this.resolveSiteFor(activeEditor.file);
    const site = await this.siteForResolution(resolution);

    if (!site) {
      return;
    }

    const service = new PageService(this.app, this.settings, site);
    await service.pushPage(activeEditor.file);
  }

  /** `pull-page` 的入口：从站点拉一个页面到本地 */
  private async pullPageCommand(): Promise<void> {
    const site = await this.pickSiteForPull("command.pull_page.error_no_sites");

    if (!site) {
      return;
    }

    const page = await openPageSelectionModal(this, site);
    const service = new PageService(this.app, this.settings, site);
    await service.pullPage(page.name);
  }

  /**
   * `manage-pages` 的入口：列出站点上的全部页面，逐行给出「打开」与「回收/恢复」。
   *
   * 与「拉取」分成两条命令而不是加个开关：拉取是**单向**的（站点 → 本地），
   * 而这条是**双向**的（还要能回收与恢复）。合成一条的话，「拉取」这个动作会被
   * 一个它不需要的「回收」按钮陪着，而回收是不可逆的。
   */
  private async managePagesCommand(): Promise<void> {
    const site = await this.pickSiteForPull("command.manage_pages.error_no_sites");

    if (!site) {
      return;
    }

    new PageManagerModal(this, site).open();
  }

  /**
   * 拉取类命令共用的站点选择。
   *
   * 抽出来是因为「拉取文章」「拉取页面」「管理页面」三条命令面对的是**同一个**问题：
   * 它们都作用于**远端**，手上没有本地文件，所以走不了 `resolveSite`（那个要 `file.path`）。
   * 处置与改动前的 `pull-post` 一致：单站点直取，多站点弹窗。
   */
  private async pickSiteForPull(noSitesKey: string): Promise<HaloSite | undefined> {
    if (this.settings.sites.length === 0) {
      new Notice(i18next.t(noSitesKey));
      return undefined;
    }

    if (this.settings.sites.length === 1) {
      return this.settings.sites[0];
    }

    return openSiteSelectionModal(this);
  }
```

⚠️ `PageManagerModal` 在本任务里**不实现** —— 它属于 Task 12 的回收站弹窗家族。
本任务先让 `managePagesCommand` 弹一条 `Notice` 说明「尚未实现」，并在 Task 12 里替换掉。
**这是一处刻意的中间态**，写进提交信息里。

- [ ] **Step 5: 加三语文案**

`command` 组加（三语同步）：

| key | en | zh-cn | zh-tw |
|---|---|---|---|
| `push_page.name` | `Halo: Push as page` | `Halo: 推为独立页面` | `Halo: 推為獨立頁面` |
| `pull_page.name` | `Halo: Pull page` | `Halo: 拉取独立页面` | `Halo: 拉取獨立頁面` |
| `manage_pages.name` | `Halo: Manage pages` | `Halo: 管理独立页面` | `Halo: 管理獨立頁面` |
| `pull_page.error_no_sites` | `No sites configured` | `还没有配置站点` | `還沒有設定站點` |
| `manage_pages.error_no_sites` | `No sites configured` | `还没有配置站点` | `還沒有設定站點` |
| `manage_pages.notice_not_implemented` | `Not implemented yet` | `尚未实现` | `尚未實作` |

`page_selection_modal` 组加：`title` / `button_pull`（三语同步）。

`service` 组加：`notice_push_page_success` / `what_pages`（三语同步）。

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/main.ts src/page-selection-model.ts src/i18n/locales/en.json \
  src/i18n/locales/zh-cn.json src/i18n/locales/zh-tw.json \
  tests/page-selection-model.test.ts tests/main.test.ts
git commit -m "feat: 独立页面三条命令与拉取选择器（管理页面弹窗留待 Task 12）"
```

---

## Task 7: 查重的纯数据层

**Files:**
- Create: `src/search-preview.ts`
- Test: `tests/search-preview.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface McpSearchItem`
  - `interface SearchResult { name: string; type: "POST" | "SINGLE_PAGE"; title: string; excerpt: string; permalink: string; published: boolean; recycled: boolean }`
  - `function stripHighlight(text: string): string`
  - `function toSearchResults(items: McpSearchItem[]): SearchResult[]`
  - `async function searchContent(client: McpClient, query: string): Promise<SearchResult[]>`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/search-preview.test.ts
import { describe, expect, test } from "@rstest/core";
import { type McpSearchItem, stripHighlight, toSearchResults } from "../src/search-preview";

describe("stripHighlight", () => {
  test("去掉服务端加的高亮标签", () => {
    // 实测：站点返回的 title 里真的带 <B> —— 三条结果全带。
    // 不清理的话，弹窗里会显示成「我用 <B>Halo</B> 写了一个插件」。
    expect(stripHighlight("因为喜欢开源，我用 <B>Halo</B> 写了一个插件")).toBe("因为喜欢开源，我用 Halo 写了一个插件");
  });

  test("大小写不敏感（服务端可能回 <b>）", () => {
    expect(stripHighlight("a <b>x</b> b")).toBe("a x b");
  });

  test("只去 B 标签，**不动**正文里合法的尖括号", () => {
    // 过度清理会把用户正文里的 `<div>` 也吃掉 —— 那是**误命中**方向，
    // 与「没清理干净」是同一个判据的两个方向，必须都测。
    expect(stripHighlight("用 <div> 包起来")).toBe("用 <div> 包起来");
    expect(stripHighlight("a <br> b")).toBe("a <br> b");
  });

  test("没有标签时原样返回（不改变空白）", () => {
    expect(stripHighlight("普通标题")).toBe("普通标题");
  });
});

describe("toSearchResults", () => {
  function item(overrides: Partial<McpSearchItem> = {}): McpSearchItem {
    return {
      type: "POST",
      name: "01a01fad-96e1-704d-88e2-d0df96c3b0b7",
      title: "因为喜欢开源，我用 <B>Halo</B> 写了一个插件",
      excerpt: "作者因热爱开源…",
      published: true,
      recycled: false,
      exposed: true,
      categories: [],
      tags: [],
      permalink: "/archives/halo-dark-mode-plugin2",
      ...overrides,
    };
  }

  test("标题与摘要都清理高亮标签", () => {
    const [result] = toSearchResults([item()]);

    expect(result.title).toBe("因为喜欢开源，我用 Halo 写了一个插件");
    expect(result.title).not.toContain("<B>");
  });

  test("剔除缺 name 的项（没法定位到具体文章）", () => {
    expect(toSearchResults([item({ name: undefined })])).toHaveLength(0);
  });

  test("保留 type，让弹窗能区分文章与页面", () => {
    const [post, page] = toSearchResults([item(), item({ type: "SINGLE_PAGE", name: "p1" })]);

    expect(post.type).toBe("POST");
    expect(page.type).toBe("SINGLE_PAGE");
  });

  test("permalink 缺省时回落空串（它不是标识，只是「打开」按钮的地址）", () => {
    expect(toSearchResults([item({ permalink: undefined })])[0].permalink).toBe("");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/search-preview.test.ts`
Expected: FAIL —— `Cannot find module '../src/search-preview'`

- [ ] **Step 3: 写实现**

```ts
// src/search-preview.ts
import i18next from "i18next";
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
 * `"因为喜欢开源，我用 <B>Halo</B> 写了一个插件并发布到了应用市场"` —— 三条结果全带。
 * 不清理的话，Obsidian 的 `Setting.setName()` 按 textContent 渲染，用户看到的就是
 * 字面的 `<B>` 与 `</B>`。
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
```

⚠️ **`limit: 50` 是 schema 的 `maximum`**（实测 `{"minimum":1,"default":10,"maximum":50}`）。
传 51 会被服务端拒绝。**不要**把它写成 100 —— 那是列表工具的 `size` 上限，不是这个的。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test tests/search-preview.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/search-preview.ts tests/search-preview.test.ts
git commit -m "feat: 查重的纯数据层，清理服务端加的高亮标签"
```

---

## Task 8: 查重命令与弹窗

**Files:**
- Create: `src/search-modal.ts`
- Modify: `src/main.ts`, `src/i18n/locales/{en,zh-cn,zh-tw}.json`
- Test: `tests/main.test.ts`

**Interfaces:**
- Consumes: `searchContent` / `SearchResult`（Task 7）
- Produces: 命令 `search-content`

- [ ] **Step 1: 写失败的测试**

在 `tests/main.test.ts` 的 `Internals` 里加 `searchContentCommand(): Promise<void>`：

```ts
test("search-content 命令在用户取消输入时静默返回，不打 MCP", async () => {
  const { plugin } = makePlugin();
  // `tests/setup.ts` 的 Modal 是空壳，输入弹窗永不 resolve —— 这里只断言
  // 「没有活动文件时不会去建 client」，那是本命令唯一的早退分支。
  (plugin.app as { workspace: { activeEditor: unknown } }).workspace.activeEditor = null;

  await plugin.searchContentCommand();

  expect(capturedNotices()).toHaveLength(0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/main.test.ts`
Expected: FAIL —— `plugin.searchContentCommand is not a function`

- [ ] **Step 3: 写 `search-modal.ts`**

```ts
// src/search-modal.ts
import i18next from "i18next";
import { Modal, Setting } from "obsidian";
import type HaloPlugin from "./main";
import type { SearchResult } from "./search-preview";
import type { HaloSite } from "./settings";

/**
 * 查重结果列表。
 *
 * 用弹窗而不是 `Notice`：结果可能有几十条，而 `Notice` 几秒就消失且不可复制 ——
 * 用户此刻要的是「逐条看、逐条点开」，那是 Notice 做不到的。
 */
export class SearchResultsModal extends Modal {
  constructor(
    private readonly plugin: HaloPlugin,
    private readonly site: HaloSite,
    private readonly query: string,
    private readonly results: SearchResult[],
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: i18next.t("search_modal.title", { query: this.query }) });

    if (this.results.length === 0) {
      // 「什么都没找到」是一条**结论**，不是一片空白 —— 用户跑了查重却看到空弹窗，
      // 会怀疑是插件坏了。写清「没有匹配」才算把这次操作答完。
      contentEl.createEl("p", { text: i18next.t("search_modal.empty") });
    }

    for (const result of this.results) {
      const setting = new Setting(contentEl)
        .setName(result.title)
        // 摘要可能很长，截断到 200 字符：弹窗不是阅读器，用户点开才是。
        .setDesc(result.excerpt.slice(0, 200))
        // 类型与状态放在一起：一篇文章与一个页面同名时，用户必须能分辨点开的是哪个
        .setClass?.("halo-search-row") ?? setting;

      setting.addExtraButton((button) =>
        button
          .setIcon(result.type === "POST" ? "lucide-file-text" : "lucide-file")
          .setTooltip(i18next.t(`search_modal.type_${result.type}`)),
      );

      if (!result.published) {
        setting.addExtraButton((button) =>
          button.setIcon("lucide-pencil").setTooltip(i18next.t("search_modal.badge_draft")),
        );
      }

      if (result.permalink) {
        setting.addButton((button) =>
          button.setButtonText(i18next.t("search_modal.button_open")).onClick(() => {
            // 用系统浏览器打开站点上的那一篇。**不**在 Obsidian 内部打开 ——
            // 查重的目的是「看看是不是已经写过」，而站点上那份才是权威的已发布版本。
            window.open(`${this.site.url.replace(/\/+$/, "")}${result.permalink}`, "_blank");
          }),
        );
      }
    }

    new Setting(contentEl).addButton((button) =>
      button.setButtonText(i18next.t("common.button_close")).onClick(() => this.close()),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

⚠️ 上面 `setClass?.("halo-search-row") ?? setting` 这一行是**错的写法** ——
`Setting` 没有 `setClass`，而 `?.` 会让类型检查也放过它。**删掉那一行**，
`const setting = new Setting(contentEl).setName(...).setDesc(...)` 就够了。

- [ ] **Step 4: 在 `main.ts` 注册命令**

```ts
    this.addCommand({
      id: "search-content",
      name: i18next.t("command.search_content.name"),
      callback: async () => {
        await this.searchContentCommand();
      },
    });
```

```ts
  /**
   * `search-content` 的入口：问一句关键词，把站点上的命中列出来。
   *
   * 默认值取当前笔记的 basename：查重最常见的用法是「我刚写了一篇，站点上是不是已经有了」，
   * 而那时用户正开着那篇笔记。预填省掉一次手打，用户仍可改成任意关键词。
   */
  private async searchContentCommand(): Promise<void> {
    const { activeEditor } = this.app.workspace;
    const defaultQuery = activeEditor?.file?.basename ?? "";

    const query = await promptForQuery(this.app, defaultQuery);

    if (!query) {
      return;
    }

    const site = await this.pickSiteForPull("command.search_content.error_no_sites");

    if (!site) {
      return;
    }

    const client = new McpClient({ endpoint: mcpEndpointOf(site), token: site.mcpToken });
    const results = await searchContent(client, query);

    new SearchResultsModal(this, site, query, results).open();
  }
```

`promptForQuery` 是一个小输入弹窗，放在 `src/search-modal.ts` 里导出：

```ts
/**
 * 问一个关键词。取消时返回 `undefined`（**不是空串** —— 空串是「查一个空关键词」，
 * 而服务端的 `query` 有 `minLength: 1`，会被拒绝）。
 */
export function promptForQuery(app: App, defaultValue: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    new QueryPromptModal(app, defaultValue, resolve).open();
  });
}

class QueryPromptModal extends Modal {
  private value: string;

  constructor(
    app: App,
    defaultValue: string,
    private readonly onDecide: (query: string | undefined) => void,
  ) {
    super(app);
    this.value = defaultValue;
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: i18next.t("search_modal.prompt_title") });

    new Setting(contentEl)
      .setName(i18next.t("search_modal.prompt_label"))
      .addText((text) =>
        text.setValue(this.value).onChange((value) => {
          this.value = value.trim();
        }),
      );

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(i18next.t("common.button_cancel")).onClick(() => {
          this.onDecide(undefined);
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText(i18next.t("search_modal.button_search"))
          .setCta()
          .onClick(() => {
            this.onDecide(this.value || undefined);
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

- [ ] **Step 5: 加三语文案**

`command` 组：`search_content.name`（`Halo: Search site content` / `Halo: 查重（搜索线上内容）` /
`Halo: 查重（搜尋線上內容）`）、`search_content.error_no_sites`。

`search_modal` 组：`title`（带 `{{query}}`）、`empty`、`type_POST`、`type_SINGLE_PAGE`、
`badge_draft`、`button_open`、`prompt_title`、`prompt_label`、`button_search`。

⚠️ **`Setting.addExtraButton` 的 `setTooltip` 在 `tests/setup.ts` 的 `Button` 桩上不存在。**
要么给桩加上 `setTooltip(): this { return this; }`，要么别用它。**选前者** ——
tooltip 是这里唯一能表达「这个图标是什么意思」的地方，去掉它等于让两个图标变成哑的。
在 `tests/setup.ts` 的 `class Button` 里加：

```ts
    setTooltip(): this {
      return this;
    }
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/main.ts src/search-modal.ts src/i18n/locales/en.json \
  src/i18n/locales/zh-cn.json src/i18n/locales/zh-tw.json tests/main.test.ts tests/setup.ts
git commit -m "feat: 查重命令与结果弹窗"
```

---

## Task 9: 附件的纯数据层

**Files:**
- Create: `src/attachment-model.ts`
- Test: `tests/attachment-model.test.ts`

**Interfaces:**
- Consumes: `fetchAllPages` / `LIST_PAGE_SIZE` / `PagedResult`（Task 3）
- Produces:
  - `interface McpAttachmentItem`
  - `interface AttachmentItem { name: string; displayName: string; mediaType: string; size: number; permalink: string; version: number; isImage: boolean }`
  - `function toAttachmentItems(items: McpAttachmentItem[]): AttachmentItem[]`
  - `function formatBytes(bytes: number): string`
  - `async function fetchAttachments(client: McpClient): Promise<{ items: AttachmentItem[]; truncated: boolean }>`
  - `async function deleteAttachment(client: McpClient, item: AttachmentItem): Promise<void>`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/attachment-model.test.ts
import { describe, expect, test } from "@rstest/core";
import {
  type McpAttachmentItem,
  formatBytes,
  toAttachmentItems,
} from "../src/attachment-model";

function attachment(overrides: Partial<McpAttachmentItem> = {}): McpAttachmentItem {
  return {
    name: "2e475d53-43f6-489a-9958-f1b14610d655",
    displayName: "QQ20261004-204734.webp",
    groupName: "attachment-group-ypunokwu",
    policyName: "default-policy",
    ownerName: "liuhangyv",
    mediaType: "image/webp",
    size: 43224,
    permalink: "/upload/QQ20261004-204734.webp",
    version: 1,
    ...overrides,
  };
}

describe("toAttachmentItems", () => {
  test("剔除缺 name 的项（删除时 name 是必填入参）", () => {
    expect(toAttachmentItems([attachment({ name: undefined })])).toHaveLength(0);
  });

  test("缺 displayName 时回落成 name，避免一行空白", () => {
    expect(toAttachmentItems([attachment({ displayName: undefined })])[0].displayName).toBe(
      "2e475d53-43f6-489a-9958-f1b14610d655",
    );
  });

  test("缺 version 时回落成 0 —— 删除接口的 expectedVersion 是必填的", () => {
    // ⚠️ 回落成 0 是**有代价**的：服务端会用一个错的版本号去删，多半被拒。
    // 但比 `undefined` 好 —— 后者会被 JSON.stringify 丢掉，服务端报「缺 expectedVersion」，
    // 用户看到的是「参数错误」而不是「这个附件的版本号读不出来」。
    expect(toAttachmentItems([attachment({ version: undefined })])[0].version).toBe(0);
  });

  test("isImage 按 mediaType 判断，而不是按扩展名", () => {
    // 按扩展名判会漏掉 `.webp` 之外的图片类型，也会把 `.svg` 之外的当图片。
    // mediaType 是服务端探测出来的，比文件名可信。
    expect(toAttachmentItems([attachment({ mediaType: "image/png" })])[0].isImage).toBe(true);
    expect(toAttachmentItems([attachment({ mediaType: "application/pdf" })])[0].isImage).toBe(false);
    expect(toAttachmentItems([attachment({ mediaType: undefined })])[0].isImage).toBe(false);
  });

  test("permalink 缺省时回落空串（它不是标识，只是「复制链接」的内容）", () => {
    expect(toAttachmentItems([attachment({ permalink: undefined })])[0].permalink).toBe("");
  });
});

describe("formatBytes", () => {
  test("按 1024 进制换算，保留一位小数", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(43224)).toBe("42.2 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/attachment-model.test.ts`
Expected: FAIL —— `Cannot find module '../src/attachment-model'`

- [ ] **Step 3: 写实现**

```ts
// src/attachment-model.ts
import { type PagedResult, LIST_PAGE_SIZE, fetchAllPages } from "./pagination";
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
 */
export async function fetchAttachments(
  client: McpClient,
): Promise<{ items: AttachmentItem[]; truncated: boolean }> {
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test tests/attachment-model.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/attachment-model.ts tests/attachment-model.test.ts
git commit -m "feat: 附件的纯数据层，翻页取全并带 expectedVersion"
```

---

## Task 10: 附件命令与弹窗

**Files:**
- Create: `src/attachment-modal.ts`
- Modify: `src/main.ts`, `src/i18n/locales/{en,zh-cn,zh-tw}.json`
- Test: `tests/main.test.ts`

**Interfaces:**
- Consumes: `fetchAttachments` / `deleteAttachment` / `AttachmentItem` / `formatBytes`（Task 9）
- Produces: 命令 `manage-attachments`

- [ ] **Step 1: 写失败的测试**

在 `tests/main.test.ts` 的 `Internals` 里加 `manageAttachmentsCommand(): Promise<void>`：

```ts
test("manage-attachments 命令在没有站点时弹提示并返回", async () => {
  const { plugin } = makePlugin(createSettings({ sites: [] }));

  await plugin.manageAttachmentsCommand();

  expect(capturedNotices()).toHaveLength(1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/main.test.ts`
Expected: FAIL —— `plugin.manageAttachmentsCommand is not a function`

- [ ] **Step 3: 写 `attachment-modal.ts`**

```ts
// src/attachment-modal.ts
import i18next from "i18next";
import { Modal, Notice, Setting } from "obsidian";
import { type AttachmentItem, deleteAttachment, fetchAttachments, formatBytes } from "./attachment-model";
import { renderErrorMessage } from "./i18n/error-message";
import type HaloPlugin from "./main";
import { type HaloSite, mcpEndpointOf } from "./settings";
import { McpClient } from "./transport/mcp-client";

/**
 * 附件管理。
 *
 * **本阶段只做三件事**：列出、复制链接、删除。不做上传（已有 `Halo: 上传图片` 那条命令
 * 从笔记里扫描并上传）、不做重命名、不做移动分组 —— 那些是 Halo 后台的活，
 * 而插件这边「够得着」的收益远小于复杂度。
 *
 * ⚠️ **删除是不可逆的**（`halo_delete_attachment` 走的是 finalizer 清理流程，
 * 没有回收站）。所以每一行都要**二次确认**，且确认文案里点名文件名与大小 ——
 * 用户要能确认自己删的是哪一个。
 */
export class AttachmentManagerModal extends Modal {
  private readonly client: McpClient;
  private items: AttachmentItem[] = [];
  private truncated = false;

  constructor(
    private readonly plugin: HaloPlugin,
    private readonly site: HaloSite,
  ) {
    super(plugin.app);
    this.client = new McpClient({ endpoint: mcpEndpointOf(site), token: site.mcpToken });
  }

  onOpen(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;

    contentEl.empty();
    contentEl.createEl("h2", { text: i18next.t("attachment_modal.title") });

    try {
      const result = await fetchAttachments(this.client);
      this.items = result.items;
      this.truncated = result.truncated;
    } catch (error) {
      // 取数失败**不抛**：命令入口不该把异常放给 Obsidian（它只会记进控制台）
      new Notice(renderErrorMessage(error));
      this.items = [];
    }

    if (this.items.length === 0) {
      contentEl.createEl("p", { text: i18next.t("attachment_modal.empty") });
    }

    if (this.truncated) {
      // 触顶时才提示 —— 与「列表不完整」同一条纪律：静默截断是本阶段反复处理的那类问题
      contentEl.createEl("p", { text: i18next.t("attachment_modal.notice_truncated") });
    }

    for (const item of this.items) {
      const setting = new Setting(contentEl)
        .setName(item.displayName)
        .setDesc(`${item.mediaType || i18next.t("attachment_modal.unknown_type")} · ${formatBytes(item.size)}`);

      if (item.permalink) {
        setting.addButton((button) =>
          button.setButtonText(i18next.t("attachment_modal.button_copy_link")).onClick(async () => {
            // 复制**绝对** URL：相对路径粘到别处没有意义
            await navigator.clipboard.writeText(`${this.site.url.replace(/\/+$/, "")}${item.permalink}`);
            new Notice(i18next.t("attachment_modal.notice_link_copied"));
          }),
        );
      }

      setting.addButton((button) =>
        button
          .setButtonText(i18next.t("attachment_modal.button_delete"))
          .setWarning()
          .onClick(async () => {
            const confirmed = await confirmDelete(this.plugin, item);

            if (!confirmed) {
              return;
            }

            try {
              await deleteAttachment(this.client, item);
              new Notice(i18next.t("attachment_modal.notice_deleted", { name: item.displayName }));
              await this.render();
            } catch (error) {
              new Notice(renderErrorMessage(error));
            }
          }),
      );
    }

    new Setting(contentEl).addButton((button) =>
      button.setButtonText(i18next.t("common.button_close")).onClick(() => this.close()),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 删除前的二次确认。确认文案里点名文件名与大小 —— 用户要能确认自己删的是哪一个 */
function confirmDelete(plugin: HaloPlugin, item: AttachmentItem): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmDeleteModal(plugin, item, resolve).open();
  });
}

class ConfirmDeleteModal extends Modal {
  constructor(
    plugin: HaloPlugin,
    private readonly item: AttachmentItem,
    private readonly onDecide: (confirmed: boolean) => void,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: i18next.t("attachment_modal.confirm_title") });
    contentEl.createEl("p", {
      text: i18next.t("attachment_modal.confirm_body", {
        name: this.item.displayName,
        size: formatBytes(this.item.size),
      }),
    });
    // 说清「不可逆」是必须的：附件没有回收站，删了就没了
    contentEl.createEl("p", { text: i18next.t("attachment_modal.confirm_irreversible") });

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(i18next.t("common.button_cancel")).onClick(() => {
          this.onDecide(false);
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText(i18next.t("attachment_modal.button_delete"))
          .setWarning()
          .onClick(() => {
            this.onDecide(true);
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

⚠️ **`Button.setWarning()` 在 `tests/setup.ts` 的桩上不存在。** 加进桩里：

```ts
    setWarning(): this {
      return this;
    }
```

- [ ] **Step 4: 在 `main.ts` 注册命令**

```ts
    this.addCommand({
      id: "manage-attachments",
      name: i18next.t("command.manage_attachments.name"),
      callback: async () => {
        await this.manageAttachmentsCommand();
      },
    });
```

```ts
  /**
   * `manage-attachments` 的入口。
   *
   * 与拉取类命令共用 `pickSiteForPull`：它同样作用于**远端**、手上没有本地文件。
   */
  private async manageAttachmentsCommand(): Promise<void> {
    const site = await this.pickSiteForPull("command.manage_attachments.error_no_sites");

    if (!site) {
      return;
    }

    new AttachmentManagerModal(this, site).open();
  }
```

- [ ] **Step 5: 加三语文案**

`command` 组：`manage_attachments.name`、`manage_attachments.error_no_sites`。

`attachment_modal` 组：`title`、`empty`、`unknown_type`、`notice_truncated`、
`button_copy_link`、`notice_link_copied`、`button_delete`、`notice_deleted`（带 `{{name}}`）、
`confirm_title`、`confirm_body`（带 `{{name}}` / `{{size}}`）、`confirm_irreversible`。

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/main.ts src/attachment-modal.ts src/i18n/locales/en.json \
  src/i18n/locales/zh-cn.json src/i18n/locales/zh-tw.json tests/main.test.ts tests/setup.ts
git commit -m "feat: 附件管理命令与弹窗，删除带二次确认"
```

---

## Task 11: 回收站的纯数据层

**Files:**
- Create: `src/recycle-model.ts`
- Test: `tests/recycle-model.test.ts`

**Interfaces:**
- Consumes: `fetchAllPages` / `LIST_PAGE_SIZE` / `PagedResult`（Task 3）
- Produces:
  - `type RecycleKind = "post" | "page"`
  - `interface RecycledItem { kind: RecycleKind; name: string; title: string; permalink: string; type: "POST" | "SINGLE_PAGE" }`
  - `async function fetchRecycled(client: McpClient, kind: RecycleKind): Promise<{ items: RecycledItem[]; truncated: boolean }>`
  - `async function restoreRecycled(client: McpClient, item: RecycledItem): Promise<void>`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/recycle-model.test.ts
import { describe, expect, test } from "@rstest/core";
import { type McpRecycledPostItem, toRecycledItems } from "../src/recycle-model";

function recycledPost(overrides: Partial<McpRecycledPostItem> = {}): McpRecycledPostItem {
  return {
    name: "019f...",
    title: "AGENTS",
    slug: "agents",
    published: false,
    publishRequested: false,
    recycled: true,
    visible: "PUBLIC",
    categories: [],
    tags: [],
    ...overrides,
  };
}

describe("toRecycledItems", () => {
  test("剔除缺 name 的项（恢复时 name 是必填入参）", () => {
    expect(toRecycledItems([recycledPost({ name: undefined })], "post")).toHaveLength(0);
  });

  test("缺 title 时回落成 name，避免一行空白", () => {
    expect(toRecycledItems([recycledPost({ title: undefined })], "post")[0].title).toBe("019f...");
  });

  test("kind 决定 type 字段，弹窗据此显示「文章 / 页面」", () => {
    expect(toRecycledItems([recycledPost()], "post")[0].type).toBe("POST");
    expect(toRecycledItems([recycledPost()], "page")[0].type).toBe("SINGLE_PAGE");
  });

  test("permalink 缺省时回落空串", () => {
    expect(toRecycledItems([recycledPost({ permalink: undefined })], "post")[0].permalink).toBe("");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/recycle-model.test.ts`
Expected: FAIL —— `Cannot find module '../src/recycle-model'`

- [ ] **Step 3: 写实现**

```ts
// src/recycle-model.ts
import { type PagedResult, LIST_PAGE_SIZE, fetchAllPages } from "./pagination";
import type { McpClient } from "./transport/mcp-client";
import { CONTENT_TOOLSETS } from "./content-kind";

/** 回收站里的内容类型。与 `ContentKind` 同形，但**刻意分开** —— 见下 */
export type RecycleKind = "post" | "page";

/**
 * 回收站列表项。
 *
 * 文章与页面在回收站里的**字段集不同**（页面没有 categories / tags），
 * 所以这里只声明两者**共有**的那些 —— 消费方只用到 `name` / `title` / `permalink`，
 * 多声明就是一份要跟着服务端走的契约。
 *
 * ⚠️ 与 `McpPostItem` 刻意**不复用**：那个类型声明了 categories / tags 等一堆
 * 回收站用不到的字段，而复用会让「回收站项比文章项少字段」这件事从类型里消失。
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
  type: "POST" | "SINGLE_PAGE";
}

/**
 * 扁平列表项 → 回收站条目。
 *
 * 剔除缺 `name` 的项：`name` 是恢复时唯一的定位依据（`halo_restore_post` 的
 * `required` 就是 `["name"]`），缺了它那一行按「恢复」必然失败。
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
 * 取某一类内容在回收站里的全部条目。
 *
 * **必须翻页**：站点实测回收站里有 **4 篇文章 + 1 个页面**，一页够用 ——
 * 但「一页够用」是**当前数据规模**的事实，不是契约。`fetchAllPages` 的代价是
 * 多一次请求，而漏掉一篇的表现是「用户以为回收站是空的」。
 *
 * `recycled: true` 是**显式传**的：schema 的默认值是 `false`（不查回收站），
 * 漏传会让这个函数返回**全部文章**，而用户以为自己在看回收站。
 */
export async function fetchRecycled(
  client: McpClient,
  kind: RecycleKind,
): Promise<{ items: RecycledItem[]; truncated: boolean }> {
  const { items, truncated } = await fetchAllPages<McpRecycledPostItem>(
    async (page, size) =>
      await client.callToolJson<PagedResult<McpRecycledPostItem>>(CONTENT_TOOLSETS[kind].list, {
        page,
        size,
        recycled: true,
      }),
    { pageSize: LIST_PAGE_SIZE },
  );

  return { items: toRecycledItems(items, kind), truncated };
}

/**
 * 把一条内容从回收站恢复。
 *
 * 走 `callToolVoid`：恢复工具最可能回一句确认文案。
 * 工具名由 `kind` 决定 —— 文章与页面是**两个不同的工具**，用错会把页面当文章恢复。
 */
export async function restoreRecycled(client: McpClient, item: RecycledItem): Promise<void> {
  await client.callToolVoid(CONTENT_TOOLSETS[item.kind].restore, { name: item.name });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test tests/recycle-model.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/recycle-model.ts tests/recycle-model.test.ts
git commit -m "feat: 回收站的纯数据层，翻页取全并显式传 recycled:true"
```

---

## Task 12: 回收站命令与弹窗（并替换 Task 6 的占位）

**Files:**
- Create: `src/recycle-modal.ts`
- Modify: `src/main.ts`, `src/i18n/locales/{en,zh-cn,zh-tw}.json`
- Test: `tests/main.test.ts`

**Interfaces:**
- Consumes: `fetchRecycled` / `restoreRecycled` / `RecycledItem`（Task 11）
- Produces: 命令 `recycle-post` / `recycle-page`；`PageManagerModal`（替换 Task 6 的占位）

- [ ] **Step 1: 写失败的测试**

在 `tests/main.test.ts` 的 `Internals` 里加 `recycleContentCommand(kind: "post" | "page"): Promise<void>`：

```ts
test("recycle-content 命令在没有站点时弹提示并返回", async () => {
  const { plugin } = makePlugin(createSettings({ sites: [] }));

  await plugin.recycleContentCommand("post");

  expect(capturedNotices()).toHaveLength(1);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/main.test.ts`
Expected: FAIL —— `plugin.recycleContentCommand is not a function`

- [ ] **Step 3: 写 `recycle-modal.ts`**

```ts
// src/recycle-modal.ts
import i18next from "i18next";
import { Modal, Notice, Setting } from "obsidian";
import { renderErrorMessage } from "./i18n/error-message";
import type HaloPlugin from "./main";
import { type RecycleKind, type RecycledItem, fetchRecycled, restoreRecycled } from "./recycle-model";
import { type HaloSite, mcpEndpointOf } from "./settings";
import { McpClient } from "./transport/mcp-client";

/**
 * 回收站。
 *
 * **只做「列出 + 恢复」**，不做「移入回收站」—— 移入回收站的对象是**本地笔记对应的远端文章**，
 * 而那个动作已经由 `Halo: 批量撤回` 之外的路径覆盖不了：撤回是「退回草稿」，
 * 与「移入回收站」是两件不同的事。本阶段先把「能看到、能捞回来」做出来 ——
 * 那是回收站存在的主要用途（误删恢复）。
 *
 * ⚠️ **恢复是不可逆的**（恢复之后要再删得重新移入回收站），但代价远小于删除，
 * 所以**不做二次确认** —— 二次确认留给真正不可逆的操作（附件删除）。
 */
export class RecycleBinModal extends Modal {
  private readonly client: McpClient;
  private items: RecycledItem[] = [];
  private truncated = false;

  constructor(
    private readonly plugin: HaloPlugin,
    private readonly site: HaloSite,
    private readonly kind: RecycleKind,
  ) {
    super(plugin.app);
    this.client = new McpClient({ endpoint: mcpEndpointOf(site), token: site.mcpToken });
  }

  onOpen(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;

    contentEl.empty();
    contentEl.createEl("h2", { text: i18next.t(`recycle_modal.title_${this.kind}`) });

    try {
      const result = await fetchRecycled(this.client, this.kind);
      this.items = result.items;
      this.truncated = result.truncated;
    } catch (error) {
      new Notice(renderErrorMessage(error));
      this.items = [];
    }

    if (this.items.length === 0) {
      contentEl.createEl("p", { text: i18next.t("recycle_modal.empty") });
    }

    if (this.truncated) {
      contentEl.createEl("p", { text: i18next.t("recycle_modal.notice_truncated") });
    }

    for (const item of this.items) {
      const setting = new Setting(contentEl).setName(item.title).setDesc(item.permalink);

      setting.addButton((button) =>
        button.setButtonText(i18next.t("recycle_modal.button_restore")).onClick(async () => {
          try {
            await restoreRecycled(this.client, item);
            new Notice(i18next.t("recycle_modal.notice_restored", { title: item.title }));
            await this.render();
          } catch (error) {
            new Notice(renderErrorMessage(error));
          }
        }),
      );
    }

    new Setting(contentEl).addButton((button) =>
      button.setButtonText(i18next.t("common.button_close")).onClick(() => this.close()),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

- [ ] **Step 4: 写 `PageManagerModal` 并替换 Task 6 的占位**

把 `PageManagerModal` 加进 `src/recycle-modal.ts`（它复用同一个 `RecycleBinModal` 家族，
放一起比新开一个文件更省事）：

```ts
/**
 * 「管理独立页面」：列出站点上的**全部页面**（含已回收的），逐行给出「打开」与「回收」。
 *
 * 与 `RecycleBinModal` 分成两个弹窗：那个只看**回收站里的**，这个看**全部**。
 * 合成一个的话，「回收站」这个入口会列出 11 个页面而其中 10 个不在回收站里。
 */
export class PageManagerModal extends Modal {
  private readonly client: McpClient;

  constructor(
    private readonly plugin: HaloPlugin,
    private readonly site: HaloSite,
  ) {
    super(plugin.app);
    this.client = new McpClient({ endpoint: mcpEndpointOf(site), token: site.mcpToken });
  }

  onOpen(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;

    contentEl.empty();
    contentEl.createEl("h2", { text: i18next.t("page_manager_modal.title") });

    // 复用回收站的取数（`recycled: false` 那一档）—— 见下面的 `fetchActivePages`
    let items: RecycledItem[] = [];

    try {
      items = await fetchActivePages(this.client);
    } catch (error) {
      new Notice(renderErrorMessage(error));
    }

    if (items.length === 0) {
      contentEl.createEl("p", { text: i18next.t("page_manager_modal.empty") });
    }

    for (const item of items) {
      const setting = new Setting(contentEl).setName(item.title).setDesc(item.permalink);

      setting.addButton((button) =>
        button.setButtonText(i18next.t("page_manager_modal.button_recycle")).onClick(async () => {
          try {
            // 回收页面走的是 `CONTENT_TOOLSETS.page.recycle`，**不是** `restore`
            await this.client.callToolVoid(CONTENT_TOOLSETS.page.recycle, { name: item.name });
            new Notice(i18next.t("page_manager_modal.notice_recycled", { title: item.title }));
            await this.render();
          } catch (error) {
            new Notice(renderErrorMessage(error));
          }
        }),
      );
    }

    new Setting(contentEl).addButton((button) =>
      button.setButtonText(i18next.t("common.button_close")).onClick(() => this.close()),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

`fetchActivePages` 加进 `src/recycle-model.ts`：

```ts
/**
 * 取**不在回收站**的页面。
 *
 * 与 `fetchRecycled` 是同一个取数、只差 `recycled` 那一档 —— 抽成一个带参数的函数
 * 而不是两份实现：`recycled` 传错的表现是「管理页面」列出回收站里的，
 * 而「回收站」列出全部，两个弹窗的内容正好对调。
 */
export async function fetchPagesByRecycled(
  client: McpClient,
  recycled: boolean,
): Promise<RecycledItem[]> {
  const { items } = await fetchAllPages<McpRecycledPostItem>(
    async (page, size) =>
      await client.callToolJson<PagedResult<McpRecycledPostItem>>(CONTENT_TOOLSETS.page.list, {
        page,
        size,
        recycled,
      }),
    { pageSize: LIST_PAGE_SIZE },
  );

  return toRecycledItems(items, "page");
}

/** `fetchPagesByRecycled(client, false)` 的别名 —— 名字说明用途，调用点读起来更清楚 */
export function fetchActivePages(client: McpClient): Promise<RecycledItem[]> {
  return fetchPagesByRecycled(client, false);
}
```

并把 `fetchRecycled` 改成调用它（**去掉重复的取数实现**）：

```ts
export async function fetchRecycled(
  client: McpClient,
  kind: RecycleKind,
): Promise<{ items: RecycledItem[]; truncated: boolean }> {
  const { items, truncated } = await fetchAllPages<McpRecycledPostItem>(
    async (page, size) =>
      await client.callToolJson<PagedResult<McpRecycledPostItem>>(CONTENT_TOOLSETS[kind].list, {
        page,
        size,
        recycled: true,
      }),
    { pageSize: LIST_PAGE_SIZE },
  );

  return { items: toRecycledItems(items, kind), truncated };
}
```

⚠️ 上面这段**与改动前一样**，没有去掉重复。**实施者要自己判断**：`fetchPagesByRecycled`
与 `fetchRecycled` 的差别只有 `recycled` 那一档与 `kind`。**正确的收口**是让
`fetchRecycled` 也走 `fetchPagesByRecycled` 的泛化版本。**不要**留下两份几乎一样的取数 ——
那正是 Global Constraint 1 说的分叉。给出一个可行的签名：

```ts
async function fetchByKind(
  client: McpClient,
  kind: RecycleKind,
  recycled: boolean,
): Promise<{ items: RecycledItem[]; truncated: boolean }>
```

`fetchRecycled` = `fetchByKind(client, kind, true)`；`fetchPagesByRecycled` = `fetchByKind(client, "page", recycled)`。

- [ ] **Step 5: 在 `main.ts` 注册命令并替换占位**

```ts
    this.addCommand({
      id: "recycle-post",
      name: i18next.t("command.recycle_post.name"),
      callback: async () => {
        await this.recycleContentCommand("post");
      },
    });

    this.addCommand({
      id: "recycle-page",
      name: i18next.t("command.recycle_page.name"),
      callback: async () => {
        await this.recycleContentCommand("page");
      },
    });
```

```ts
  /** 回收站入口。两条命令只在 `kind` 上分档 —— 与三个批量命令同一取舍 */
  private async recycleContentCommand(kind: RecycleKind): Promise<void> {
    const site = await this.pickSiteForPull(
      kind === "post" ? "command.recycle_post.error_no_sites" : "command.recycle_page.error_no_sites",
    );

    if (!site) {
      return;
    }

    new RecycleBinModal(this, site, kind).open();
  }
```

并把 Task 6 里 `managePagesCommand` 的占位 `Notice` 换成：

```ts
    new PageManagerModal(this, site).open();
```

同时**删掉** `command.manage_pages.notice_not_implemented` 这个键（三语都删）。

- [ ] **Step 6: 加三语文案**

`command` 组：`recycle_post.name`、`recycle_page.name`、`recycle_post.error_no_sites`、
`recycle_page.error_no_sites`。

`recycle_modal` 组：`title_post`、`title_page`、`empty`、`notice_truncated`、
`button_restore`、`notice_restored`（带 `{{title}}`）。

`page_manager_modal` 组：`title`、`empty`、`button_recycle`、`notice_recycled`（带 `{{title}}`）。

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/main.ts src/recycle-modal.ts src/recycle-model.ts src/i18n/locales/en.json \
  src/i18n/locales/zh-cn.json src/i18n/locales/zh-tw.json tests/main.test.ts
git commit -m "feat: 回收站两条命令与弹窗，替换管理页面的占位"
```

---

## Task 13: 批量汇总的逐条跳过原因

**Files:**
- Modify: `src/batch-publish.ts`, `src/batch-confirm-modal.ts`, `src/i18n/locales/{en,zh-cn,zh-tw}.json`
- Test: `tests/batch-publish.test.ts`, `tests/batch-confirm-modal.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `BatchRunSummary` 增加 `skipped: BatchSkip[]`

- [ ] **Step 1: 写失败的测试**

在 `tests/batch-publish.test.ts` 里追加：

```ts
test("汇总里带上逐条跳过原因，而不是只有一个数字", async () => {
  // 1-B 的终审把这一条留成了开放项：末尾汇总里「执行前跳过」只有一个数字，
  // 逐条原因只在确认弹窗里 —— 而用户跑完之后手上只有汇总。
  const plan: BatchPlan = {
    action: "draft",
    groups: [],
    skipped: [
      { path: "notes/a.md", key: "batch.skip_needs_choice" },
      { path: "notes/b.md", key: "batch.skip_not_published" },
    ],
  };

  const summary = await runBatch(plan, new Set(["notes/c.md"]), () => serviceStub);

  expect(summary.skippedCount).toBe(2);
  expect(summary.skipped).toHaveLength(2);
  expect(summary.skipped[0].path).toBe("notes/a.md");
  expect(summary.skipped[1].key).toBe("batch.skip_not_published");
});
```

在 `tests/batch-confirm-modal.test.ts` 里追加一条渲染断言（照抄既有用例的 `contentEl` 桩写法）：

```ts
test("末尾汇总逐条列出跳过原因，而不只报数字", () => {
  const texts: string[] = [];
  const modal = new BatchSummaryModal(pluginStub, {
    action: "draft",
    results: [],
    successCount: 0,
    failureCount: 0,
    skippedCount: 2,
    skipped: [
      { path: "notes/a.md", key: "batch.skip_needs_choice" },
      { path: "notes/b.md", key: "batch.skip_not_published" },
    ],
  });

  (modal as unknown as { contentEl: { createEl: (tag: string, o: { text?: string }) => void } }).contentEl = {
    createEl: (_tag: string, options: { text?: string }) => {
      if (options.text) {
        texts.push(options.text);
      }
    },
  };

  modal.onOpen();

  expect(texts.some((text) => text.includes("notes/a.md"))).toBe(true);
  expect(texts.some((text) => text.includes("notes/b.md"))).toBe(true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/batch-publish.test.ts tests/batch-confirm-modal.test.ts`
Expected: FAIL —— `summary.skipped` 是 `undefined`

- [ ] **Step 3: 改 `batch-publish.ts`**

`BatchRunSummary` 加字段：

```ts
export interface BatchRunSummary {
  action: BatchAction;
  results: BatchItemResult[];
  successCount: number;
  failureCount: number;
  skippedCount: number;
  /**
   * **执行前**被排除的笔记，**逐条带原因**。
   *
   * 与 `skippedCount` 并存而不是取代它：数字是给「一眼看总量」用的，
   * 清单是给「逐条处理」用的，两件事都要。
   *
   * 1-B 的终审把「汇总里只有数字、没有原因」留成了开放项 —— 用户跑完批量之后
   * 手上只有汇总，而那时他恰恰需要知道**是哪几篇没进去、为什么**。
   */
  skipped: BatchSkip[];
}
```

`runBatch` 的两处 `return` 都补上 `skipped: plan.skipped`：

```ts
  if (selected.size === 0) {
    return {
      action: plan.action,
      results: [],
      successCount: 0,
      failureCount: 0,
      skippedCount: plan.skipped.length,
      skipped: plan.skipped,
    };
  }
```

```ts
  return {
    action: plan.action,
    results,
    successCount: results.filter((item) => item.ok).length,
    failureCount: results.filter((item) => !item.ok).length,
    skippedCount: plan.skipped.length,
    skipped: plan.skipped,
  };
```

- [ ] **Step 4: 改 `batch-confirm-modal.ts` 的汇总渲染**

在 `BatchSummaryModal.onOpen()` 里，失败项那一段**之后**加：

```ts
    // 跳过项**逐条带原因**。与失败项分成两段而不是合成一段：失败是「跑了但炸了」，
    // 跳过是「压根没让它跑」，用户要做的处置完全不同（前者去站点上确认状态，
    // 后者去改配置或补发布）。
    if (this.summary.skipped.length > 0) {
      contentEl.createEl("h3", { text: i18next.t("batch.summary_skipped_title", { count: this.summary.skipped.length }) });

      for (const skip of this.summary.skipped) {
        contentEl.createEl("div", { text: `${skip.path} —— ${i18next.t(skip.key, skip.params)}` });
      }
    }
```

- [ ] **Step 5: 加三语文案**

`batch` 组加 `summary_skipped_title`（带 `{{count}}`）：

| en | zh-cn | zh-tw |
|---|---|---|
| `Skipped before running ({{count}})` | `执行前跳过（{{count}}）` | `執行前跳過（{{count}}）` |

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/batch-publish.ts src/batch-confirm-modal.ts src/i18n/locales/en.json \
  src/i18n/locales/zh-cn.json src/i18n/locales/zh-tw.json \
  tests/batch-publish.test.ts tests/batch-confirm-modal.test.ts
git commit -m "feat: 批量汇总逐条列出跳过原因，收掉 1-B 的开放项"
```

---

## Task 14: 文档收口与两个产品语义

**Files:**
- Modify: `README.md`, `README.zh-CN.md`, `CLAUDE.md`, `docs/e2e-manual-checklist.md`
- Test: 无（本任务不写代码）

**Interfaces:**
- Consumes: 全部前序任务的产出
- Produces: 四份文档与实现一致

- [ ] **Step 1: 核对 `CLAUDE.md` 的命令表与架构表**

- 在「常用命令」附近的命令列表里补上本阶段新增的 **6 条命令**：
  `push-page` / `pull-page` / `manage-pages` / `search-content` / `manage-attachments` /
  `recycle-post` / `recycle-page`（**7 条**，数一遍）。
- 在「业务层」的文件表里补上新增的模块：`content-kind.ts` / `pagination.ts` /
  `service/page-mapping.ts` / `service/page-service.ts` / `page-selection-model.ts` /
  `search-preview.ts` / `search-modal.ts` / `attachment-model.ts` / `attachment-modal.ts` /
  `recycle-model.ts` / `recycle-modal.ts`（**11 个**，数一遍）。
- **`REQUIRED_TOOLS` 那句「这 13 项」必须改成 23** —— 它在 `CLAUDE.md` 的「站点侧前置条件」
  一节里，与 `src/mcp-self-check.ts` 的注释是**两处**，都要改。

- [ ] **Step 2: 核对两个产品语义的文档是否如实**

这两条**代码不改**（用户 2026-10-05 已拍板），文档必须**如实且完整**地描述：

1. **批量撤回不写回本地 `halo.publish`** —— `CLAUDE.md` 的批量操作一节已写明，
   核对它是否仍然准确（Task 13 改了 `BatchRunSummary`，那段描述里若有涉及要同步）。
2. **三个批量命令都不看笔记里的 `halo.publish`** —— 同上。

⚠️ **这两条是「文档即交付物」**：代码行为不变，所以文档若写错，用户会按错的理解去操作。
核对时**逐字读一遍**，不要只看有没有那一段。

- [ ] **Step 3: 追加 `docs/e2e-manual-checklist.md` 的阶段 2 条目**

追加 **8 项**（编号接在现有的 13 之后，从 14 开始）。每项仍是三段
（**做什么 → 预期看到什么 → 若不符，最可能的错在哪**）。八项是：

14. **查重能查到草稿**：写一个只存在于站点的草稿关键词，跑查重 → 应能查到它。
15. **查重的标题不显示 `<B>`**：查一个常见词 → 结果标题里**不该**出现字面的 `<B>`。
16. **独立页面推上去是页面不是文章**：推一篇笔记 → 站点后台「页面」里出现它，「文章」里**没有**。
17. **独立页面的 frontmatter 只有三个 halo 键**：推完之后看笔记 → `halo` 下只有
    `site` / `name` / `publish`，**没有** `visible` / `pinned` 等 6 个字段。
18. **附件列表超过一页时是完整的**：打开附件管理 → 总数应与站点后台的附件数**一致**
    （当前是 264）。
19. **删除附件有二次确认，且确认文案点名文件**：点删除 → 弹出确认，文案里有文件名与大小。
20. **回收站能列出并恢复**：打开回收站 → 应看到**当前站点上真实存在的**那几篇
    （2026-10-05 实测是 4 篇文章 + 1 个页面）；恢复一篇 → 它从回收站消失。
21. **批量汇总逐条列出跳过原因**：跑一次批量，其中至少有一篇没有 `halo.name` →
    末尾汇总里应**逐条**列出那一篇与原因，而不只是一个数字。

- [ ] **Step 4: 更新 `README.md` / `README.zh-CN.md`**

两份都要加：新命令清单、附件删除**不可逆**的警告、以及「查重会查到草稿」这一条
（用户可能以为它只查已发布的）。

⚠️ **`README.zh-CN.md` 与 `README.md` 的结构此前不一致过**（1-B 的记录里提到
`README.zh-CN.md` 曾缺整个 MCP 章节）。**加完之后逐节对一遍**，确认两份的章节名与顺序一致。

- [ ] **Step 5: 提交**

```bash
git add README.md README.zh-CN.md CLAUDE.md docs/e2e-manual-checklist.md
git commit -m "docs: 阶段 2 的命令、契约与手工清单"
```

---

## Task 15: 全阶段自审

**Files:**
- 无新增
- Test: 全量

- [ ] **Step 1: 三语键数必须相等**

```bash
node -e "
const fs=require('fs');
const counts={};
for (const f of ['en','zh-cn','zh-tw']) {
  const d=JSON.parse(fs.readFileSync('src/i18n/locales/'+f+'.json','utf8'));
  const flat=[];
  const walk=(o,p)=>{for(const k of Object.keys(o)){const v=o[k];const q=p?p+'.'+k:k;if(v&&typeof v==='object')walk(v,q);else flat.push(q);}};
  walk(d,'');
  counts[f]=flat;
}
const [a,b,c]=[counts['en'],counts['zh-cn'],counts['zh-tw']];
console.log('en/zh-cn/zh-tw:', a.length, b.length, c.length);
const missing=(x,y,name)=>x.filter(k=>!y.includes(k)).map(k=>name+' 缺: '+k);
console.log([...missing(a,b,'zh-cn'),...missing(b,a,'en'),...missing(a,c,'zh-tw'),...missing(c,a,'en')].join('\n')||'键集一致');
"
```

Expected: 三个数字相等，且输出「键集一致」。

- [ ] **Step 2: 全量测试与构建**

```bash
pnpm test
pnpm build
```

Expected: 全部通过；`main.js` 生成成功。**记录测试总数与 `main.js` 字节数**，写进提交信息。

- [ ] **Step 3: 类型检查**

```bash
npx tsc --noEmit -p tsconfig.json 2>&1 | grep "^src/" | head -20
```

Expected: **只有既有的 4 条 `@halo-dev/api-client` TS2307**（`moduleResolution: "node"`
忽略 `exports`，该包解析不了）。**多出一条都是本阶段引入的**，必须修。

- [ ] **Step 4: 确认没有死引用**

```bash
grep -rn "utils/markdown\|utils/yaml" src tests
grep -rn "notice_not_implemented" src tests
```

Expected: 两条都**零命中**（第一条本就零命中；第二条是 Task 12 删掉的占位键）。

- [ ] **Step 5: 确认没有密钥泄漏**

```bash
grep -rn "hmcp_" --include="*.ts" --include="*.json" --include="*.md" . \
  --exclude-dir=node_modules --exclude-dir=.git
```

Expected: 只命中**文档里作为前缀说明**的那几处（`hmcp_` 后面不跟实际值）。
**任何一处后面跟着一串字符的都是泄漏**，必须立刻删掉并轮换密钥。

⚠️ **聚合计数不是发现**：1-B 的记录里，一次密钥扫描报了 7 处命中，全部是散文里的字面前缀
`hmcp_`。**逐条看内容**，不要只看数量。

- [ ] **Step 6: 提交（若有改动）**

```bash
git add <逐个文件名>
git commit -m "chore: 阶段 2 自审（三语键数 N/N/N，测试 M passed，main.js X 字节）"
```

---

## 收尾：交回用户的三件事

本计划完成后，以下三件**不在本计划的范围内**，必须如实报告：

1. **两个死模块的删除**（`src/utils/markdown.ts`、`src/utils/yaml.ts`）与它们拖着的
   四个依赖（`markdown-it` / `markdown-it-anchor` / `gray-matter` / `js-yaml`）。
   **全局规则要求删除需用户书面同意**，所以本阶段只报告、不删。
2. **`main.js` 在真实 Obsidian 里能否加载** —— 自动化只能验「构建成功」，验不了「加载成功」。
3. **`docs/e2e-manual-checklist.md` 的 21 项手工清单**（1-B 的 13 项 + 本阶段的 8 项）。
   **这是本阶段最大的验证缺口**：`tests/setup.ts` 把整个 `obsidian` 模块 mock 掉了，
   「插件在真机上确实可用」没有任何自动证据。

另外两条**已知的、刻意留下的**缺口，也要报告：

4. **`src/utils/id.ts` 的 `randomUUID()` 是手写实现**（用 `Math.random`，不走 `crypto`），
   用于生成新文章的 resource name 与 multipart boundary。**本阶段没有加固它** ——
   它的影响面比 `generateResourceName` 更大（后者已经用了 `crypto.getRandomValues`），
   值得单独决策。
5. **`halo_upload_attachment_from_url` 没有被接入**（spec 附录 A 把它列为「不使用」）。
   本阶段维持该决定 —— 它的用途是「把远程图片转存到自己的站点」，而插件这边
   「够得着」的场景（笔记里的远程图片）会引入「哪些该转存、哪些不该」的判断，
   而那是一个产品决策，不是技术缺口。
