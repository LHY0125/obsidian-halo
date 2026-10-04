# 阶段 1-B：元数据字段开放、站点路由、发布预览与批量操作 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **⚠️ 关于本文件里的代码与文案清单（后续追加，非计划当时的内容）**：本文件的代码块、函数清单与
> 三语文案都是**规划当时的字面量**。实现与后续修复轮改过若干处，因此这些清单**可能已与交付代码分叉**
>（已知的例子：`renderSummary()` 的改写提示门控、`planBatch()` 对 `unpublish` 的分支、
> 三语 `settings.siteRouting` 的三句文案）。**以 `src/` 为准**，本节不再逐处加注记。

**Goal:** 把 Halo Post 上另外 6 个元数据字段开放到 frontmatter 双向读写，加上按路径 glob 的站点路由、发布前预览确认、以及批量推草稿 / 发布 / 撤回。

**Architecture:** 阶段 1-A 已经把发布链路整体切到 MCP，并把「MCP 的扁平表示 ↔ 领域模型」的适配收在 `service/post-mapping.ts`。1-A 的副产品是 `toUpdateArgs()` / `toCreateArgs()` **已经**在传这 6 个字段、`toPost()` **已经**在把它们读回来 —— 也就是说 **MCP 线上的一侧 1-A 已经做完了**，1-B 只需要补**本地 frontmatter 这一侧**。本计划的重心因此全部落在三处：① 本地 frontmatter 的读写契约（`src/frontmatter-map.ts`）；② 站点解析（`src/site-routing.ts`）；③ 交互面（预览弹窗、批量确认与执行）。

**Tech Stack:** TypeScript 5.1.6 / Rslib / rstest（`globals: false`）/ Biome / pnpm。**不新增任何运行时依赖** —— glob 匹配、校验、聚合全部手写在纯函数里。

**Spec:** `docs/superpowers/specs/2026-10-03-obsidian-halo-mcp-reshape-design.md`
（覆盖 G1 元数据字段开放、G2 发布状态机与批量操作、G3 多站点路由与新建确认；G4 已在 1-A 用配置迁移落地。）

**前一阶段的实现记录（读它有收益）：** `docs/superpowers/plans/2026-10-03-mcp-pipeline-cutover.md`
**前一阶段的过程账本（含 R15–R49 全部裁定与代价）：** `.superpowers/sdd/2026-10-03-mcp-pipeline-cutover/progress.md`

---

## Global Constraints

以下每一条对**每个任务**都生效。违反其中任何一条，任务都不算完成。

### 来自本阶段的第一性约束（前三条是本计划的核心，务必逐字读完）

1. **`null` 与「键不存在」同义；`false` / `0` / `""` 是显式值。**

   - 「写了吗」的判据是 **`value !== undefined && value !== null`**，不是真假判断。
   - 对 `pinned` / `allowComment` / `priority` / `template` 用真假判断，会把 `pinned: false`
     变成「跟随远端」—— 用户在本地取消置顶后发布，站上仍是置顶的，**而回写还会把 `true`
     写回他的笔记**，他连"我明明改过"都找不到痕迹。
   - YAML 里 `visible:` 这种空值自然解析成 `null`，所以「写成空值」与「删掉这一行」同义，
     都表示「跟随远端」。这是刻意的：报错会逼用户改一行他并没有写错的配置。
   - **`publishTime` 是唯一的例外**：`""`（空字符串）是**合法值**，语义是「立即发布」。
     要清空一个已有的定时发布，必须写 `publishTime: ""`，**删掉那一行只会让它继续跟随远端**。
     这条要在 README 与设置项说明里写出来。
2. **回写进 frontmatter 的必须是「本次生效的值」，不是「本地构造的值」。**
   这是 1-A 的 I1（写后回读失败时 `frontmatter.halo.publish` 写回陈旧值，下次发布把已发布的
   文章静默退回草稿）的教训，已由 `intendedPublish` 修掉。本阶段的 6 个新字段走的是同一条链，
   所以**回写一律从 `post.spec` 取值**，而 `post.spec` 是 `applyPostFrontmatter` + `refreshPostAfterWrite`
   之后的产物。任何「从 `matterData` 或从本地字面量回写」的写法都是重犯 I1。
3. **没有第二个真值来源。**

   - 6 个字段的校验只有一处（`parseHaloPostFields`），落地只消费它的产物；
   - 站点解析只有一处（`resolveSite` + `main.ts` 的一层薄胶水），发布与上传图片**共用**；
   - frontmatter 回写只有一处（`applyPostToFrontmatter`），发布 / 更新 / 拉取**共用**。
   - 判断标准：同一件事出现两份实现时，它们必然会在某次改动后分叉，而分叉的表现是
     「A 路径对了、B 路径没跟上」—— 1-A 的最终审查把这一类记作最贵的缺陷来源。

### 来自 spec 与 1-A 的既有约束

4. **不新增运行时依赖。** `package.json` 的 `dependencies` 本计划一个字都不改。
5. **i18n 三语必须同步。** `src/i18n/locales/{en,zh-cn,zh-tw}.json` 三个文件的键**逐一对应**，
   键数与键路径都一致；漏一个，切到那个语言就显示原始键名。
6. **代码注释用中文。** 注释写「为什么」，不写「是什么」。
7. **新文件写成 LF**（`.editorconfig` 与 `biome.json` 都要求 LF）。既有文件不要跑全量
   `biome check --write`：本仓库 `core.autocrlf=true` 且无 `.gitattributes`，全量格式化会产生
   与本次改动无关的 diff。
8. **绝不 `git add -A` / `git add .`**：逐名 stage。工作区里 `src/i18n/index.ts`、`src/icons.ts`、
   `src/site-selection-modal.ts`、`src/sites-modal.ts`、`src/utils/id.ts`、`src/utils/markdown.ts`、
   `src/utils/yaml.ts` 这 7 个文件的 ` M` 是 `autocrlf` 的状态噪声（`git diff --numstat` 为空），
   混进去会让提交带上不该有的东西。
9. **`data.json` 与 `.superpowers/` 永不入库**（`.gitignore` 已覆盖，但 stage 时别手滑）。
10. **绝不把 `hmcp_` 密钥或 PAT 写进任何文件、报告、提交信息。**
11. **未经用户书面同意不得删除任何文件**（用户全局规则，优先级高于任何 skill 的清理步骤）。

### MCP 协议硬约束（写错只会得到「400 空体」或「看着成功其实写错」，极难反查）

12. `Accept` 必须同时含 `text/event-stream`；必须先 `initialize`；无 session。
13. **`tools/call` 的工具级失败是 HTTP 200 + `result.isError: true`**，不是 4xx。
14. **`rawType` 必须显式传 `"markdown"`**（schema 默认 `"html"`，漏传会把 Markdown 当 HTML 存）。
15. **`publishTime` 空值传 `null`，不能传空字符串**（schema 是 `["string","null"]` + `format: date-time`）。
16. **`, `halo_get_post`的`truncated` 为 true 必须抛错**，不能把截断正文写进本地文件。
17. **写路径用 `callToolVoid`，读路径用 `callToolJson`**（理由见 `CLAUDE.md`：写路径不消费返回体）。

### 本仓库特有的坑

18. **`@halo-dev/api-client` 只当类型用，且它解析不了**（`moduleResolution: "node"` 忽略 `exports`），
    所以 tsc 眼里 `Post` / `Content` 是 `any` —— **字段名写错 tsc 不会报**。
    凡是新声明一个要落进 `Post.spec` 的字段名，**必须有一条断言它真的落进去了的测试**。
19. **`pnpm check` 只扫 `src/`**，`tests/` 的 lint 问题看不见。
20. **逐字比较文件内容时必须用 `git show HEAD:<file>`**，不能用工作区 —— 工作区是 CRLF、仓库存 LF，
    直接比会得到假失败。
21. **测试里 `requestUrl` 是被 mock 掉的裸 `rs.fn()`**，`tests/setup.ts` 整体 mock 了 `obsidian`。
    服务层测试的既定做法是注入假 `McpClient`（`tests/helpers/mcp-mock.ts` 的 `createFakeClient`），
    断言「调了哪个工具、传了什么参数、走的哪个入口」。

---

## File Structure


| 文件                           | 状态     | 唯一职责                                                                                                        |
| -------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/frontmatter-map.ts`       | **新增** | frontmatter`halo:` 下 6 个元数据字段的校验（`parseHaloPostFields`）与两个方向的落地（`applyPostToFrontmatter`） |
| `src/glob.ts`                  | **新增** | **零依赖叶子模块**：`SiteRoutingRule` 类型、`normalizeRulePattern`、`matchGlob`。它不 import 任何项目内模块，所以谁都能安全 import 它 |
| `src/site-routing.ts`          | **新增** | 站点解析决策（`resolveSite`）。再导出 `glob.ts` 的三个符号，让调用方只需认一个入口                          |
| `src/site-routing-modal.ts`    | **新增** | 单条路由规则的编辑弹窗（模式 + 站点）                                                                           |
| `src/publish-preview.ts`       | **新增** | 预览数据的纯构造（`buildPublishPreview`）+ 预览弹窗                                                             |
| `src/batch-publish.ts`         | **新增** | 批量候选收集、聚合计划、执行循环 —— 纯逻辑，UI 无关                                                           |
| `src/batch-confirm-modal.ts`   | **新增** | 批量聚合确认弹窗与末尾汇总弹窗                                                                                  |
| `src/service/local-content.ts` | 修改     | `HaloPostFrontmatter` 类型扩展 6 键；`applyPostFrontmatter` 接收已校验字段                                      |
| `src/service/index.ts`         | 修改     | `publishPost` 拆成规划/执行；6 字段接线；三处回写改调 `applyPostToFrontmatter`                                  |
| `src/service/image-upload.ts`  | 修改     | `uploadImages` 接受显式 `file`；新增只读的 `summarizeLocalImages`                                               |
| `src/settings.ts`              | 修改     | `siteRouting` 设置项与迁移；规则表 UI；`skipPreviewOnPublish`                                                   |
| `src/main.ts`                  | 修改     | 站点解析统一入口；三个批量命令；预览接线                                                                        |
| `src/i18n/locales/*.json`      | 修改     | 三语同步新增键                                                                                                  |
| `README.md` / `CLAUDE.md`      | 修改     | 新能力、`publishTime` 空串语义、路由规则说明                                                                    |

**为什么 `frontmatter-map.ts` 放在 `src/` 根而不是 `src/service/`：** spec §4.1 的目录树把它画在根。
放根还有一个实际好处 —— 它只依赖 `@halo-dev/api-client` 的类型，而 `service/local-content.ts` 反过来
要 import 它的 `HaloPostFields`。放根使依赖方向单一（`service/ → frontmatter-map.ts`），不会成环。

---

## Task 1：`frontmatter-map.ts` —— 6 个元数据字段的校验与落地

这是本阶段的地基。它把「frontmatter 里写了什么」变成「一组**已校验、且只含写了的键**的字段」，
后面的每条路径都消费这个产物。

**Files:**

- Create: `src/frontmatter-map.ts`
- Modify: `src/service/local-content.ts`（`HaloPostFrontmatter` 扩展 + `applyPostFrontmatter` 接收入参）
- Test: `tests/frontmatter-map.test.ts`（新建）、`tests/service/local-content.test.ts`（追加）

**Interfaces:**

- Consumes: `Post`（类型，来自 `@halo-dev/api-client`）
- Produces:
  - `type PostVisible = "PUBLIC" | "INTERNAL" | "PRIVATE"`
  - `interface HaloPostFields { visible?: PostVisible; pinned?: boolean; priority?: number; publishTime?: string; allowComment?: boolean; template?: string }`
  - `type HaloFieldsResult = { ok: true; fields: HaloPostFields } | { ok: false; key: string; params: Record<string, string> }`
  - `function parseHaloPostFields(halo: unknown): HaloFieldsResult`
  - `ApplyPostFrontmatterOptions` 新增可选字段 `haloFields?: HaloPostFields`

---

- [ ]  **Step 1：先写失败的表驱动测试**

新建 `tests/frontmatter-map.test.ts`：

```ts
import { describe, expect, it } from "@rstest/core";
import { parseHaloPostFields } from "src/frontmatter-map";

describe("parseHaloPostFields —— 缺席语义", () => {
  it("halo 整个缺席时给空对象（等于「一个字段都不要动」）", () => {
    expect(parseHaloPostFields(undefined)).toEqual({ ok: true, fields: {} });
  });

  it("halo 写成非对象时按缺席处理，不抛错", () => {
    // 老笔记里有人把 halo 写成一行字符串是可能的；这里唯一要做的判断是
    // 「有没有要跟随的字段」，为它抛错会连笔记都打不开。
    expect(parseHaloPostFields("x")).toEqual({ ok: true, fields: {} });
    expect(parseHaloPostFields([])).toEqual({ ok: true, fields: {} });
    expect(parseHaloPostFields(42)).toEqual({ ok: true, fields: {} });
  });

  it("键写了但值是 null（YAML 的 `visible:`）时按缺席处理", () => {
    expect(parseHaloPostFields({ visible: null, pinned: null, publishTime: null })).toEqual({ ok: true, fields: {} });
  });

  it("不认识的键被忽略，已知键照常解析", () => {
    expect(parseHaloPostFields({ somethingElse: 1, pinned: true })).toEqual({ ok: true, fields: { pinned: true } });
  });
});

describe("parseHaloPostFields —— 假值必须留存", () => {
  // 这四条钉的是同一个契约：`false` / `0` / `""` 是**用户写下的显式值**，不是「没写」。
  // 用真假判断实现这一层，会让 `pinned: false` 退化成「跟随远端」—— 用户在本地取消置顶后
  // 发布，站上仍然置顶，而回写还会把 true 写回他的笔记。
  it.each([
    ["pinned", false],
    ["allowComment", false],
    ["priority", 0],
    ["template", ""],
  ] as [string, unknown][])("%s 的显式假值被保留", (field, value) => {
    const result = parseHaloPostFields({ [field]: value });
    expect(result).toEqual({ ok: true, fields: { [field]: value } });
  });

  it("publishTime 的空串是合法值（语义是「立即发布」），不做日期解析", () => {
    // Date.parse("") 是 NaN。若不在空串上短路，这个**契约规定的合法值**会被判成非法。
    expect(parseHaloPostFields({ publishTime: "" })).toEqual({ ok: true, fields: { publishTime: "" } });
  });
});

describe("parseHaloPostFields —— visible 枚举", () => {
  it.each(["PUBLIC", "INTERNAL", "PRIVATE"])("%s 通过", (value) => {
    expect(parseHaloPostFields({ visible: value })).toEqual({ ok: true, fields: { visible: value } });
  });

  it("两端空白被吃掉（YAML 里写成 \" PUBLIC \" 是手滑）", () => {
    expect(parseHaloPostFields({ visible: " PUBLIC " })).toEqual({ ok: true, fields: { visible: "PUBLIC" } });
  });

  it("大小写不对时**报错**并带上原值", () => {
    expect(parseHaloPostFields({ visible: "public" })).toEqual({
      ok: false,
      key: "frontmatter.error_visible",
      params: { value: "public" },
    });
  });

  it("非字符串时报错，且不把对象渲染成 [object Object]", () => {
    expect(parseHaloPostFields({ visible: 1 })).toEqual({
      ok: false,
      key: "frontmatter.error_visible",
      params: { value: "1" },
    });
    expect(parseHaloPostFields({ visible: { a: 1 } })).toEqual({
      ok: false,
      key: "frontmatter.error_visible",
      params: { value: '{"a":1}' },
    });
  });
});

describe("parseHaloPostFields —— 类型校验", () => {
  it.each(["pinned", "allowComment"])("%s 只接受布尔值，字符串 \"true\" 不接受", (field) => {
    // YAML 里加引号就是字符串。悄悄强转会把用户的书写错误掩盖成「有效配置」，
    // 而他下次看到回写结果时会以为是插件改了他的值。
    expect(parseHaloPostFields({ [field]: "true" })).toEqual({
      ok: false,
      key: "frontmatter.error_boolean",
      params: { field, value: "true" },
    });
  });

  it("priority 只接受整数", () => {
    expect(parseHaloPostFields({ priority: 3 })).toEqual({ ok: true, fields: { priority: 3 } });
    expect(parseHaloPostFields({ priority: "3" })).toEqual({
      ok: false,
      key: "frontmatter.error_integer",
      params: { field: "priority", value: "3" },
    });
    expect(parseHaloPostFields({ priority: 1.5 })).toEqual({
      ok: false,
      key: "frontmatter.error_integer",
      params: { field: "priority", value: "1.5" },
    });
  });

  it("template 只接受字符串", () => {
    expect(parseHaloPostFields({ template: "custom" })).toEqual({ ok: true, fields: { template: "custom" } });
    expect(parseHaloPostFields({ template: 7 })).toEqual({
      ok: false,
      key: "frontmatter.error_string",
      params: { field: "template", value: "7" },
    });
  });

  it("publishTime 非字符串时按字符串类错误报", () => {
    expect(parseHaloPostFields({ publishTime: 20261006 })).toEqual({
      ok: false,
      key: "frontmatter.error_string",
      params: { field: "publishTime", value: "20261006" },
    });
  });
});

describe("parseHaloPostFields —— publishTime 取值", () => {
  it.each([
    "2026-10-06T10:00:00+08:00",
    "2026-10-06T02:00:00.000Z",
    "2026-10-06 10:00",
  ])("%s 被接受", (value) => {
    expect(parseHaloPostFields({ publishTime: value })).toEqual({ ok: true, fields: { publishTime: value } });
  });

  it("解析不出时间的字符串被拒绝", () => {
    // 校验刻意宽松（Date.parse 认的就算数）：目标是拦住「明天」「下周三」这类
    // 一眼就不是机器时间的值，而不是当 RFC 3339 的守门员 —— 那会拒掉服务端本来能接受的写法。
    expect(parseHaloPostFields({ publishTime: "明天" })).toEqual({
      ok: false,
      key: "frontmatter.error_publish_time",
      params: { value: "明天" },
    });
  });
});

describe("parseHaloPostFields —— 多个非法字段时的确定性", () => {
  it("按固定顺序报第一个（visible → pinned → allowComment → priority → publishTime → template）", () => {
    // 顺序固定是为了让错误可复现：两个字段都写错时，用户改完第一个能立刻看到第二个，
    // 而不是每次启动都随机看到一个。
    expect(parseHaloPostFields({ publishTime: "明天", visible: "public" })).toEqual({
      ok: false,
      key: "frontmatter.error_visible",
      params: { value: "public" },
    });
  });
});
```

- [ ]  **Step 2：跑测试确认它失败**

```bash
pnpm test tests/frontmatter-map.test.ts
```

预期：FAIL，`Failed to resolve import "src/frontmatter-map"`（文件还不存在）。

- [ ]  **Step 3：写实现**

新建 `src/frontmatter-map.ts`：

```ts
import type { Post } from "@halo-dev/api-client";

/** `halo.visible` 的三个合法取值，与 Halo Post 的 schema 一致 */
export type PostVisible = "PUBLIC" | "INTERNAL" | "PRIVATE";

const VISIBLE_VALUES: readonly string[] = ["PUBLIC", "INTERNAL", "PRIVATE"];

/**
 * frontmatter `halo:` 下 6 个元数据字段的**已校验**形态。
 *
 * 这 6 个键名与 `Post.spec` 上的同名键逐一对应 —— `applyPostFrontmatter` 直接把它展开进 `spec`。
 * 代价是 **tsc 看不见名字写错**（`@halo-dev/api-client` 解析不了，`Post` 退化成 `any`，见 CLAUDE.md），
 * 所以 `tests/service/local-content.test.ts` 里每个字段都必须有一条「真的落进 spec 了」的断言。
 *
 * **稀疏是契约**：只有 frontmatter 真正写了的键才会出现在这个对象上。展开时「没这个键」
 * 就等于「不改动」，这正是 spec 要求的「没写就跟随远端」。
 */
export interface HaloPostFields {
  visible?: PostVisible;
  pinned?: boolean;
  priority?: number;
  publishTime?: string;
  allowComment?: boolean;
  template?: string;
}

/**
 * 校验结果。失败时**只给 i18n 键与参数，不渲染文案** —— 本模块是纯函数，
 * 按 `transport/errors.ts` 已确立的分层，依赖 i18next 的渲染放在 UI 侧。
 */
export type HaloFieldsResult = { ok: true; fields: HaloPostFields } | { ok: false; key: string; params: Record<string, string> };

/**
 * 把 frontmatter 里的原值转成给用户看的文本。
 *
 * 对象/数组走 JSON：`String({})` 得到的是 `[object Object]`，而报错必须能让用户对上他写的那一行。
 */
function formatValue(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return String(value);
  }

  return JSON.stringify(value) ?? String(value);
}

/**
 * 「写了吗」的判据。**`null` 与缺键同义** —— YAML 里 `visible:` 这种空值自然解析成 null，
 * 而把它判成「写错了」会逼用户去改一行他并没有写错的配置。
 */
function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * 把 frontmatter 的 `halo` 对象校验成一组可落地的字段。
 *
 * 入参取 `unknown` 而不是 `HaloPostFrontmatter`：本模块不该依赖 `service/`，
 * 而 `halo` 在运行时本来就可能是任何东西（笔记是人手写的）。
 *
 * 校验的收益集中在**一处**：`visible` 写成 `public`（小写）时服务端若原样接受，
 * 前台会静默变成默认可见性；若拒绝，用户只拿到一句「发布失败」+ 服务端原文。
 * 两种都不如本地直接说清「哪一行、写了什么、该写什么」。
 */
export function parseHaloPostFields(halo: unknown): HaloFieldsResult {
  const fields: HaloPostFields = {};

  if (typeof halo !== "object" || halo === null || Array.isArray(halo)) {
    return { ok: true, fields };
  }

  const source = halo as Record<string, unknown>;

  const visible = source.visible;

  if (isPresent(visible)) {
    const trimmed = typeof visible === "string" ? visible.trim() : undefined;

    if (trimmed === undefined || !VISIBLE_VALUES.includes(trimmed)) {
      return { ok: false, key: "frontmatter.error_visible", params: { value: formatValue(visible) } };
    }

    fields.visible = trimmed as PostVisible;
  }

  for (const field of ["pinned", "allowComment"] as const) {
    const value = source[field];

    if (!isPresent(value)) {
      continue;
    }

    if (typeof value !== "boolean") {
      return { ok: false, key: "frontmatter.error_boolean", params: { field, value: formatValue(value) } };
    }

    fields[field] = value;
  }

  const priority = source.priority;

  if (isPresent(priority)) {
    if (typeof priority !== "number" || !Number.isInteger(priority)) {
      return { ok: false, key: "frontmatter.error_integer", params: { field: "priority", value: formatValue(priority) } };
    }

    fields.priority = priority;
  }

  const publishTime = source.publishTime;

  if (isPresent(publishTime)) {
    if (typeof publishTime !== "string") {
      return {
        ok: false,
        key: "frontmatter.error_string",
        params: { field: "publishTime", value: formatValue(publishTime) },
      };
    }

    const trimmed = publishTime.trim();

    // 空串是**合法值**，语义是「立即发布」（spec §5.1）。必须在这里短路：
    // `Date.parse("")` 是 NaN，不短路会把这个契约规定的合法值判成非法。
    if (trimmed !== "" && Number.isNaN(Date.parse(trimmed))) {
      return { ok: false, key: "frontmatter.error_publish_time", params: { value: formatValue(publishTime) } };
    }

    fields.publishTime = trimmed;
  }

  const template = source.template;

  if (isPresent(template)) {
    if (typeof template !== "string") {
      return { ok: false, key: "frontmatter.error_string", params: { field: "template", value: formatValue(template) } };
    }

    fields.template = template.trim();
  }

  return { ok: true, fields };
}
```

- [ ]  **Step 4：跑测试确认全绿**

```bash
pnpm test tests/frontmatter-map.test.ts
```

- [ ]  **Step 5：把 6 个键加进 `HaloPostFrontmatter`**

修改 `src/service/local-content.ts`，在 `HaloPostFrontmatter` 的 `halo` 里补上 6 个键（**只加类型，
这一阶段不读它们** —— 读取走 `parseHaloPostFields`）：

```ts
import type { HaloPostFields } from "../frontmatter-map";

export interface HaloPostFrontmatter {
  title?: string;
  slug?: string;
  excerpt?: string;
  cover?: string;
  categories?: string[];
  tags?: string[];
  halo?: {
    site?: string;
    name?: string;
    publish?: boolean;
    /**
     * 这 6 个键**声明在这里只为让读者知道它们合法**：读取一律走 `parseHaloPostFields()`
     * （那才有校验与「在不在」语义），本文件不直接读它们。
     */
    visible?: HaloPostFields["visible"];
    pinned?: HaloPostFields["pinned"];
    priority?: HaloPostFields["priority"];
    publishTime?: HaloPostFields["publishTime"];
    allowComment?: HaloPostFields["allowComment"];
    template?: HaloPostFields["template"];
  };
}
```

- [ ]  **Step 6：写 `applyPostFrontmatter` 落地的失败测试**

追加到 `tests/service/local-content.test.ts`。**这个 describe 里逐字段的断言是本计划唯一的
「字段名写错」守卫**（tsc 在同名文件上集体失明，见 Global Constraints #18）：

```ts
import type { Post } from "@halo-dev/api-client";
import type { TFile } from "obsidian";
import { applyPostFrontmatter } from "src/service/local-content";

describe("applyPostFrontmatter —— 6 个元数据字段", () => {
  const activeFile = { basename: "笔记", path: "a.md" } as TFile;

  /** 模拟「从服务端读回来的那一篇」：每个字段都有一个与默认值不同的初值，好让覆盖可见 */
  function remotePost(): Post {
    return {
      metadata: { annotations: {} },
      spec: {
        title: "远端标题",
        slug: "remote-slug",
        cover: "",
        template: "remote-template",
        pinned: true,
        priority: 7,
        publishTime: "2026-01-01T00:00:00.000Z",
        allowComment: true,
        visible: "INTERNAL",
        publish: true,
        categories: [],
        tags: [],
        htmlMetas: [],
        excerpt: { autoGenerate: true, raw: "" },
      },
    } as unknown as Post;
  }

  it("不传 haloFields 时一个元数据字段都不动 —— 「没写就跟随远端」", () => {
    const next = applyPostFrontmatter(remotePost(), { activeFile, matterData: {}, useActiveFileDefaults: false });

    expect(next.spec.visible).toBe("INTERNAL");
    expect(next.spec.pinned).toBe(true);
    expect(next.spec.priority).toBe(7);
    expect(next.spec.publishTime).toBe("2026-01-01T00:00:00.000Z");
    expect(next.spec.template).toBe("remote-template");
  });

  it("显式假值覆盖远端的真值（这是真假判断实现会漏掉的那条）", () => {
    const next = applyPostFrontmatter(remotePost(), {
      activeFile,
      matterData: {},
      haloFields: { pinned: false, priority: 0, allowComment: false },
      useActiveFileDefaults: false,
    });

    expect(next.spec.pinned).toBe(false);
    expect(next.spec.priority).toBe(0);
    expect(next.spec.allowComment).toBe(false);
  });

  it("6 个字段逐一落进 spec（名字写错时这里会红）", () => {
    const next = applyPostFrontmatter(remotePost(), {
      activeFile,
      matterData: {},
      haloFields: {
        visible: "PRIVATE",
        pinned: false,
        priority: 3,
        publishTime: "2026-10-06T10:00:00+08:00",
        allowComment: false,
        template: "custom",
      },
      useActiveFileDefaults: false,
    });

    expect(next.spec.visible).toBe("PRIVATE");
    expect(next.spec.pinned).toBe(false);
    expect(next.spec.priority).toBe(3);
    expect(next.spec.publishTime).toBe("2026-10-06T10:00:00+08:00");
    expect(next.spec.allowComment).toBe(false);
    expect(next.spec.template).toBe("custom");
  });

  it("不就地改动入参对象", () => {
    const post = remotePost();
    applyPostFrontmatter(post, {
      activeFile,
      matterData: {},
      haloFields: { pinned: false },
      useActiveFileDefaults: false,
    });

    expect(post.spec.pinned).toBe(true);
  });
});
```

- [ ]  **Step 7：跑测试确认它失败**

```bash
pnpm test tests/service/local-content.test.ts
```

预期：前两条 FAIL（`haloFields` 还不是合法选项 / 值没被覆盖），后两条也可能失败。

- [ ]  **Step 8：实现落地**

修改 `src/service/local-content.ts` 的 `ApplyPostFrontmatterOptions` 与 `applyPostFrontmatter`：

```ts
export interface ApplyPostFrontmatterOptions {
  activeFile: TFile;
  categoryNames?: string[];
  matterData?: HaloPostFrontmatter;
  tagNames?: string[];
  useActiveFileDefaults: boolean;
  /**
   * 已校验的 6 个元数据字段（`parseHaloPostFields()` 的产物），直接展开进 `spec`。
   *
   * 刻意传**已校验的稀疏对象**，而不是让本函数自己去读 `matterData.halo`：校验与落地各读一遍
   * 同一批键，两处判断一旦分叉，就会出现「校验放行的值落不下去」或「没校验的值落下去」——
   * 而后者会往服务端送一个 schema 之外的值。让「校验的产物」成为唯一入口，分叉就不可能发生。
   */
  haloFields?: HaloPostFields;
}
```

```ts
export function applyPostFrontmatter(post: Post, options: ApplyPostFrontmatterOptions): Post {
  const { activeFile, categoryNames, haloFields, matterData, tagNames, useActiveFileDefaults } = options;
  const nextPost: Post = {
    ...post,
    metadata: {
      ...post.metadata,
      annotations: {
        ...post.metadata.annotations,
      },
    },
    spec: {
      ...post.spec,
      // 稀疏展开：只有 frontmatter 写了的键才在 haloFields 上，所以「没这个键」= 保留远端值。
      // 这一行就是 spec「没写就跟随远端，而不是覆盖成 0/false」的全部实现。
      ...haloFields,
      categories: [...(post.spec.categories || [])],
      excerpt: {
        ...post.spec.excerpt,
      },
      htmlMetas: [...(post.spec.htmlMetas || [])],
      tags: [...(post.spec.tags || [])],
    },
  };

  // …以下原有 6 个字段的处理一字不动（title / slug / excerpt / cover / categories / tags）…

  return nextPost;
}
```

- [ ]  **Step 9：跑测试确认全绿**

```bash
pnpm test tests/service/local-content.test.ts tests/frontmatter-map.test.ts
```

- [ ]  **Step 10：加三语文案**

三个 locale 文件同步加同一个 `frontmatter` 命名空间。`src/i18n/locales/zh-cn.json`：

```json
  "frontmatter": {
    "error_visible": "「halo.visible」的值「{{value}}」不合法：只能是 PUBLIC、INTERNAL 或 PRIVATE 之一。",
    "error_boolean": "「halo.{{field}}」的值「{{value}}」不合法：必须是不加引号的 true 或 false。",
    "error_integer": "「halo.{{field}}」的值「{{value}}」不合法：必须是一个整数。",
    "error_string": "「halo.{{field}}」的值「{{value}}」不合法：必须是一个字符串。",
    "error_publish_time": "「halo.publishTime」的值「{{value}}」不是能识别的时间。请写成 RFC 3339 格式（如 2026-10-06T10:00:00+08:00）；要立即发布请写空串 \"\"。"
  },
```

`en.json`：

```json
  "frontmatter": {
    "error_visible": "The value \"{{value}}\" of `halo.visible` is invalid: it must be one of PUBLIC, INTERNAL, PRIVATE.",
    "error_boolean": "The value \"{{value}}\" of `halo.{{field}}` is invalid: it must be an unquoted true or false.",
    "error_integer": "The value \"{{value}}\" of `halo.{{field}}` is invalid: it must be an integer.",
    "error_string": "The value \"{{value}}\" of `halo.{{field}}` is invalid: it must be a string.",
    "error_publish_time": "The value \"{{value}}\" of `halo.publishTime` is not a recognizable time. Use RFC 3339 (e.g. 2026-10-06T10:00:00+08:00); use an empty string \"\" to publish immediately."
  },
```

`zh-tw.json`：与 `zh-cn.json` 逐键对应（繁体）。

- [ ]  **Step 11：核对三语键数一致**

```bash
node -e "
const fs=require('fs');
const keys=(o,p='')=>Object.entries(o).flatMap(([k,v])=>typeof v==='object'&&v!==null?keys(v,p+k+'.'):[p+k]);
const sets=['en','zh-cn','zh-tw'].map(l=>new Set(keys(JSON.parse(fs.readFileSync('src/i18n/locales/'+l+'.json','utf8')))));
console.log('键数:', sets.map(s=>s.size).join(' / '));
for (const [i,a] of sets.entries()) for (const [j,b] of sets.entries()) {
  const d=[...a].filter(k=>!b.has(k));
  if (d.length) console.log(\`\${['en','zh-cn','zh-tw'][i]} 缺于 \${['en','zh-cn','zh-tw'][j]}:\`, d);
}
"
```

预期：三个数字相同，且没有任何差集输出。

- [ ]  **Step 12：提交**

```bash
git add src/frontmatter-map.ts src/service/local-content.ts \
        src/i18n/locales/en.json src/i18n/locales/zh-cn.json src/i18n/locales/zh-tw.json \
        tests/frontmatter-map.test.ts tests/service/local-content.test.ts
git commit -m "feat(frontmatter): 6 个元数据字段的校验与落地（稀疏语义：没写就跟随远端）"
```

---

## Task 2：三处 frontmatter 回写收敛为 `applyPostToFrontmatter`

发布 / 更新 / 拉取三条路径各有一段近乎逐字相同的回写代码。Task 3 要往里面加 6 个字段，
如果不先收口，就得在三个地方各加一遍 —— 漏一个的表现是「拉取回来的笔记丢了这 6 个字段，
下次发布又按远端重算」，用户看不出任何异常。

**这一任务的行为必须逐字不变**，既有测试（尤其是 `tests/service/index.test.ts` 里
对 `written?.title` / `halo.name` 的断言）就是判据。

**Files:**

- Modify: `src/frontmatter-map.ts`（新增 `applyPostToFrontmatter`）
- Modify: `src/service/index.ts:274-296`（`publishPost`）、`:544-562`（`updatePost`）、`:605-621`（`pullPost`）
- Test: `tests/frontmatter-map.test.ts`（追加）、`tests/service/index.test.ts`（追加一条判别器）

**Interfaces:**

- Consumes: `Post`（类型）、`HaloPostFields`（Task 1）
- Produces:
  - `interface PostToFrontmatterOptions { siteUrl: string; name: string; categoryNames?: string[]; tagNames?: string[] }`
  - `function applyPostToFrontmatter(frontmatter: Record<string, unknown>, post: Post, options: PostToFrontmatterOptions): void`

---

- [ ]  **Step 1：确认三处回写现在确实是同一段代码**

```bash
node -e "
const t=require('fs').readFileSync('src/service/index.ts','utf8').split('\n');
for (const [a,b] of [[273,296],[543,562],[604,621]]) console.log('--- '+a+'..'+b+' ---\n'+t.slice(a-1,b).join('\n'));
"
```

预期：三段只在「取 `spec` 的来源对象」与「`halo.name` 给什么」上有差别。

- [ ]  **Step 2：写失败测试**

追加到 `tests/frontmatter-map.test.ts`：

```ts
import { applyPostToFrontmatter } from "src/frontmatter-map";

function makePost(): Post {
  return {
    metadata: { name: "post-1", annotations: {} },
    spec: {
      title: "标题",
      slug: "slug",
      cover: "/upload/a.webp",
      excerpt: { autoGenerate: false, raw: "摘要" },
      categories: ["category-1"],
      tags: ["tag-1"],
      publish: true,
    },
  } as unknown as Post;
}

describe("applyPostToFrontmatter", () => {
  it("写入 4 个元数据字段与 halo 块", () => {
    const frontmatter: Record<string, unknown> = {};

    applyPostToFrontmatter(frontmatter, makePost(), {
      siteUrl: "https://blog.example.com",
      name: "post-1",
      categoryNames: ["技术思考"],
      tagNames: ["Halo"],
    });

    expect(frontmatter).toEqual({
      title: "标题",
      slug: "slug",
      cover: "/upload/a.webp",
      excerpt: "摘要",
      categories: ["技术思考"],
      tags: ["Halo"],
      halo: { site: "https://blog.example.com", name: "post-1", publish: true },
    });
  });

  it("excerpt 由服务端自动生成时写 undefined（等于不写这个键）", () => {
    const post = makePost();
    post.spec.excerpt = { autoGenerate: true, raw: "" };
    const frontmatter: Record<string, unknown> = { excerpt: "旧的摘要" };

    applyPostToFrontmatter(frontmatter, post, { siteUrl: "https://blog.example.com", name: "post-1" });

    expect(frontmatter.excerpt).toBeUndefined();
  });

  it("显示名解析失败（undefined）时跳过该字段，保持笔记原值", () => {
    // 落回 spec 里的 metadata.name（`category-sc9pomuo`）看着像「不丢信息」，
    // 实际会在下次发布时被当成新的显示名建到站点上 —— 垃圾分类永久留存。
    const frontmatter: Record<string, unknown> = { categories: ["旧分类"], tags: ["旧标签"] };

    applyPostToFrontmatter(frontmatter, makePost(), { siteUrl: "https://blog.example.com", name: "post-1" });

    expect(frontmatter.categories).toEqual(["旧分类"]);
    expect(frontmatter.tags).toEqual(["旧标签"]);
  });

  it("解析结果是空数组时**跳过**该字段（保持笔记原值）", () => {
    // `[]` 有两种来源且不可分辨：这篇确实没有分类、或这篇的分类一个都没解析出来。
    // 后者写 `[]` 会把笔记里现有的分类静默清空，所以只能保守跳过。
    // 这条同时也钉住「重构没改行为」——改动前三份代码用的就是真值判断。
    const frontmatter: Record<string, unknown> = { categories: ["旧分类"] };

    applyPostToFrontmatter(frontmatter, makePost(), {
      siteUrl: "https://blog.example.com",
      name: "post-1",
      categoryNames: [],
    });

    expect(frontmatter.categories).toEqual(["旧分类"]);
  });

  it("halo.name 取 options.name，不取 post.metadata.name", () => {
    // 拉取路径必须传调用方的入参 name：toPost() 在服务端没回 name 时给的是空串，
    // 写进去会让下次发布认不出这篇已发布的笔记，**再建一篇重复文章**。
    const frontmatter: Record<string, unknown> = {};

    applyPostToFrontmatter(frontmatter, makePost(), { siteUrl: "https://blog.example.com", name: "requested-name" });

    expect((frontmatter.halo as { name: string }).name).toBe("requested-name");
  });
});
```

- [ ]  **Step 3：跑测试确认失败**

```bash
pnpm test tests/frontmatter-map.test.ts
```

预期：FAIL，`applyPostToFrontmatter is not a function`。

- [ ]  **Step 4：实现**

追加到 `src/frontmatter-map.ts`：

```ts
export interface PostToFrontmatterOptions {
  /** 写入 `halo.site` 的站点 URL */
  siteUrl: string;
  /**
   * 写入 `halo.name` 的值。**必须由调用方显式给**。
   *
   * 拉取路径要传的是**入参 name**，不是 `post.metadata.name`：`toPost()` 在服务端没回 `name` 时
   * 填的是空串，那会把 `halo.name` 写成 `""` —— 下次发布读不到它，于是**再建一篇重复文章**，
   * 而用户看到的是「发布成功」。把「给什么」变成调用方的显式决定，是让这个差异不会被顺手抹平的唯一办法。
   */
  name: string;
  /** 分类显示名。`undefined` = **没解析出来**，跳过该字段（保持笔记原值）；`[]` = 确实没有 */
  categoryNames?: string[];
  tagNames?: string[];
}

/**
 * 把一篇（服务端归一化之后的）Post 回写进 frontmatter。
 *
 * 三条路径（发布 / 更新 / 拉取）共用这一份实现。此前它们各写一遍、只差几个词，
 * 而本阶段要往里面加 6 个字段 —— 三份实现必然漏掉其中一处，表现是「拉取回来的笔记
 * 丢了这些字段」，本地完全看不出异常。
 *
 * **取值一律来自 `post.spec`**，那是 `applyPostFrontmatter` + 服务端回读之后的产物。
 * 从 `matterData` 或本地字面量回写会重犯 1-A 的 I1（把陈旧值写进 frontmatter，
 * 下次发布据此静默改掉远端状态）。
 */
export function applyPostToFrontmatter(
  frontmatter: Record<string, unknown>,
  post: Post,
  options: PostToFrontmatterOptions,
): void {
  frontmatter.title = post.spec.title;
  frontmatter.slug = post.spec.slug;
  frontmatter.cover = post.spec.cover;
  frontmatter.excerpt = post.spec.excerpt.autoGenerate ? undefined : post.spec.excerpt.raw;

  // 分类/标签承载的是**显示名**，消费方 `getCategoryNames()` / `getTagNames()` 按 displayName
  // 精确匹配。用**真值判断**而不是 `!== undefined` —— 这一条与原有的三份代码逐字一致，
  // 而它是有理由的：`getCategoryDisplayNames()` 返回 `[]` 有两种来源，
  // ① 这篇确实没有分类；② 这篇有 N 个分类但**一个都没解析出来**
  //（`map(...).filter(Boolean)` 会把解析不到的项整个滤掉）。② 之下写 `[]` 等于
  // **把笔记里现有的分类静默清空**。两种来源在 `[]` 上不可分辨，所以只能保守地跳过。
  //
  // `undefined`（入参缺席）与 `[]` 在这条判据下**都是跳过**，行为与改动前完全一致。
  if (options.categoryNames) {
    frontmatter.categories = options.categoryNames;
  }

  if (options.tagNames) {
    frontmatter.tags = options.tagNames;
  }

  frontmatter.halo = {
    site: options.siteUrl,
    name: options.name,
    publish: post.spec.publish,
  };
}
```

- [ ]  **Step 5：跑新测试确认全绿**

```bash
pnpm test tests/frontmatter-map.test.ts
```

- [ ]  **Step 6：跑既有测试，确认这三处回写的行为一字未变**

```bash
pnpm test tests/service/index.test.ts
```

预期：**全绿，一条断言都不改**。这一整个任务（Task 2）是纯重构，任何一条既有断言变红都说明
收口改错了语义 —— 停下来比对改动前后的三段代码，不要动测试。

> ⚠️ 特别留意 `categories` / `tags` 那两行。它们用**真值判断**，不是 `!== undefined`：
> 这不是我忘了统一风格，而是那份差异必须保留（理由见实现里的注释）。
> 一个「顺手统一成 `!== undefined`」的改动会让 `getCategoryDisplayNames()` 在
> 「分类一个都没解析出来」时返回的 `[]` 写进笔记，**把用户现有的分类静默清空**。
> 实现里那条注释就是为拦住这个改动而写的，别删。

- [ ]  **Step 7：把三处调用点改成调用它**

修改 `src/service/index.ts`：

```ts
import { applyPostToFrontmatter, parseHaloPostFields } from "../frontmatter-map";
```

`publishPost`：把原来那整段 `this.app.fileManager.processFrontMatter(activeFile, (frontmatter) => { … })`
**连回调体一起**换成：

```ts
    this.app.fileManager.processFrontMatter(activeFile, (frontmatter) => {
      applyPostToFrontmatter(frontmatter, params, {
        siteUrl: this.site.url,
        name: params.metadata.name,
        categoryNames: postCategories,
        tagNames: postTags,
      });
    });
```

`updatePost`：同样整段换成

```ts
    this.app.fileManager.processFrontMatter(activeEditor.file, (frontmatter) => {
      applyPostToFrontmatter(frontmatter, post.post, {
        siteUrl: this.site.url,
        name: post.post.metadata.name,
        categoryNames: postCategories,
        tagNames: postTags,
      });
    });
```

`pullPost`：同样整段换成

```ts
    this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      applyPostToFrontmatter(frontmatter, post.post, {
        siteUrl: this.site.url,
        // ⚠️ 是**入参** name，不是 post.post.metadata.name —— 理由见 PostToFrontmatterOptions.name
        name,
        categoryNames: postCategories,
        tagNames: postTags,
      });
    });
```

同时删掉 `publishPost` / `updatePost` / `pullPost` 里原本那三段逐字段赋值，以及三段上方各自
关于「为什么解析失败要跳过」的注释 —— 那些理由已经搬到 `applyPostToFrontmatter` 里了。
`publishPost` 上方那段关于 `intendedPublish` 的注释**保留不动**（它讲的是另一件事）。

- [ ]  **Step 8：加一条判别器，钉住「拉取路径用的是入参 name」**

追加到 `tests/service/index.test.ts` 的 `pullPost` 相关 describe：

```ts
  test("服务端返回的 item 没带 name 时，halo.name 仍写成请求时用的那个 name", async () => {
    // 判别器：把 pullPost 里那个 `name,` 换成 `name: post.post.metadata.name`
    // （一个看起来更"整洁"的写法）就会红 —— 而既有那条用例**不会**红：它的 fixture 里
    // item 是带着 name 的，两种写法结果相同。
    // 红掉之后的表现才是重点：halo.name 变成 ""，下次发布读不到它，于是**再建一篇重复文章**，
    // 而用户两次都看到「发布成功」。
    const note = createFile("post.md");
    const { app, fileManager } = createMockApp("", note, []);
    const { client } = createFakeClient((name) => {
      if (name !== "halo_get_post") {
        throw new Error(`Unexpected tool: ${name}`);
      }

      // `remoteItem` 的 overrides 是展开覆盖，传 `undefined` 就能真的把 name 抹掉。
      // 这不是人为构造：`halo_get_post` 的 outputSchema 里 name **不是** required 字段。
      return { item: remoteItem("placeholder", { name: undefined }), content: { raw: "" } };
    });

    let written: Record<string, unknown> | undefined;
    fileManager.processFrontMatter.mockImplementation(
      (_file: unknown, callback: (frontmatter: Record<string, unknown>) => void) => {
        written = {};
        callback(written);
      },
    );

    await new HaloService(app, createSettings(), site, client).pullPost("post-1");

    expect((written?.halo as { name?: string } | undefined)?.name).toBe("post-1");
  });
```

- [ ]  **Step 9：确认判别器真的会红**

把 `pullPost` 里那一行的 `name,` 临时改成 `name: post.post.metadata.name,`，
`pnpm test tests/service/index.test.ts` → 上面那条应当 FAIL。
**改回来**（用 `git show HEAD:src/service/index.ts` 比对确认恢复）。

- [ ]  **Step 10：跑全套 + 构建**

```bash
pnpm test && pnpm build
```

- [ ]  **Step 11：提交**

```bash
git add src/frontmatter-map.ts src/service/index.ts tests/frontmatter-map.test.ts tests/service/index.test.ts
git commit -m "refactor(frontmatter): 三条路径的回写收敛为 applyPostToFrontmatter"
```

---

## Task 3：6 个字段贯通发布 / 更新 / 拉取三条路径

**Files:**

- Modify: `src/frontmatter-map.ts`（`applyPostToFrontmatter` 写 `halo` 块时带上 6 键）
- Modify: `src/service/index.ts`（`publishPost` 里解析并消费 `parseHaloPostFields`）
- Test: `tests/frontmatter-map.test.ts`、`tests/service/index.test.ts`

**Interfaces:**

- Consumes: `parseHaloPostFields` / `applyPostToFrontmatter`（Task 1、Task 2）
- Produces: 无新导出 —— 本任务是把 Task 1、Task 2 的产物接上

---

- [ ]  **Step 1：写回写方向的失败测试**

追加到 `tests/frontmatter-map.test.ts`：

```ts
  it("halo 块带上 6 个元数据字段（值取自 post.spec，不是本地字面量）", () => {
    const post = makePost();
    Object.assign(post.spec, {
      visible: "INTERNAL",
      pinned: true,
      priority: 3,
      publishTime: "2026-10-06T10:00:00+08:00",
      allowComment: false,
      template: "custom",
    });
    const frontmatter: Record<string, unknown> = {};

    applyPostToFrontmatter(frontmatter, post, { siteUrl: "https://blog.example.com", name: "post-1" });

    expect(frontmatter.halo).toEqual({
      site: "https://blog.example.com",
      name: "post-1",
      publish: true,
      visible: "INTERNAL",
      pinned: true,
      priority: 3,
      publishTime: "2026-10-06T10:00:00+08:00",
      allowComment: false,
      template: "custom",
    });
  });
```

- [ ]  **Step 2：跑测试确认失败**

```bash
pnpm test tests/frontmatter-map.test.ts
```

预期：FAIL，`halo` 里只有 3 个键。

- [ ]  **Step 3：实现回写**

把 `applyPostToFrontmatter` 末尾的 `frontmatter.halo = {…}` 扩成：

```ts
  // 6 个元数据字段也写回去 —— 与上面 4 个字段同理：让笔记成为远端的忠实镜像，
  // 下次发布才是幂等的，用户也才能在本地看见并编辑这些值。
  // 取值一律来自 `post.spec`（服务端归一化之后的产物），不来自 matterData 或本地字面量。
  frontmatter.halo = {
    site: options.siteUrl,
    name: options.name,
    publish: post.spec.publish,
    visible: post.spec.visible,
    pinned: post.spec.pinned,
    priority: post.spec.priority,
    publishTime: post.spec.publishTime,
    allowComment: post.spec.allowComment,
    template: post.spec.template,
  };
```

- [ ]  **Step 4：跑测试确认全绿**

```bash
pnpm test tests/frontmatter-map.test.ts
```

- [ ]  **Step 5：写发布路径接线的失败测试**

追加到 `tests/service/index.test.ts`。这些用例的形态照抄同文件里既有的
「frontmatter 有 publish: true 时调 halo_set_post_publish_state」那一组，
脚手架用本文件**已有**的 `createMockApp()` / `createSettings()` / `fakeService()` / `capturedNotices()`
（`fakeService()` 是本文件顶部那个统一假客户端，`onWrite` 钩子能拿到写工具的参数）：

```ts
  test("frontmatter 的 halo.visible 被送进写工具的参数", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    let writtenArgs: Record<string, unknown> | undefined;
    const { client } = fakeService({ onWrite: (_name, args) => (writtenArgs = args) });
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { visible: "INTERNAL" } },
    }));

    await new HaloService(app, createSettings(), site, client).publishPost();

    expect(writtenArgs?.visible).toBe("INTERNAL");
  });

  test("显式 false 不被默认值翻盘：halo.pinned: false 送出 pinned: false", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    let writtenArgs: Record<string, unknown> | undefined;
    const { client } = fakeService({ onWrite: (_name, args) => (writtenArgs = args) });
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { pinned: false } },
    }));

    await new HaloService(app, createSettings(), site, client).publishPost();

    expect(writtenArgs?.pinned).toBe(false);
  });

  test("更新分支同样消费 halo.* 字段", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    let writtenArgs: Record<string, unknown> | undefined;
    const { client, calls } = fakeService({ onWrite: (_name, args) => (writtenArgs = args) });
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { name: "post-1", priority: 9 } },
    }));

    await new HaloService(app, createSettings(), site, client).publishPost();

    // 走的是更新分支（有 halo.name），参数走 halo_update_post
    expect(calls.some((call) => call.name === "halo_update_post")).toBe(true);
    expect(writtenArgs?.priority).toBe(9);
  });

  test("halo.publishTime 为空串时送 null，不是空字符串", async () => {
    // schema 是 ["string","null"] + format: date-time —— 空字符串会被服务端拒绝
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    let writtenArgs: Record<string, unknown> | undefined;
    const { client } = fakeService({ onWrite: (_name, args) => (writtenArgs = args) });
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { publishTime: "" } },
    }));

    await new HaloService(app, createSettings(), site, client).publishPost();

    expect(writtenArgs?.publishTime).toBeNull();
  });

  test("halo.visible 非法时**中止发布**，一个写工具都不调，并报出具体原因", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    const { client, calls } = fakeService();
    const notices = capturedNotices();
    const seen = notices.length;
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { visible: "public" } },
    }));

    await new HaloService(app, createSettings(), site, client).publishPost();

    // 一个 MCP 工具都不该被调到 —— 校验必须发生在分类/标签解析（会真的建分类）之前
    expect(calls).toEqual([]);
    expect(notices.slice(seen)).toHaveLength(1);
    expect(notices[seen]).toContain("public");
  });
```

> **两条关于既有测试脚手架的提醒（预检时核过，别再自己摸）：**
>
> 1. **`site` 是本文件顶部的常量**（`import { … TEST_SITE as site } from "../helpers/obsidian-mocks"`），
>    可以直接用。**`note` 不是** —— 每个用例自己 `const note = createFile("post.md");` 造一个，
>    上面每条测试的第一行就是它。别写成裸 `note` 然后以为它在作用域里。
> 2. **`publishPost()` 是刻意不带参数的**：本任务执行时它的签名还是 `publishPost(options = {})`，
>    文件从 `app.workspace.activeEditor` 取（`createMockApp` 已把 `activeFile` 设成了 activeEditor）。
>    **Task 7 会把签名改成 `publishPost(file, options)`，届时这批调用要跟着补上文件参数** ——
>    这是计划里写明的步骤，不是遗漏。现在写成 `publishPost(note)` 会让 `note` 被当成 options
>    传进去，靠巧合通过（`options.markdown` 恰好是 undefined，回落读 activeEditor），
>    而那份巧合一旦不成立就会静默走错分支。
>
> `fakeService()` 的 `onWrite` 钩子在创建分支与更新分支上都会被调用，所以上面几条不需要分别写两遍。

- [ ]  **Step 6：跑测试确认失败**

```bash
pnpm test tests/service/index.test.ts
```

预期：前 4 条 FAIL（参数里没有这些字段），第 5 条 FAIL（发布照常跑完）。

- [ ]  **Step 7：接线**

修改 `src/service/index.ts` 的 `publishPost`。在**分类/标签解析之前**插入校验：

```ts
    const raw = frontmatterPosition ? md.slice(frontmatterPosition?.end.offset) : md;

    // check site url
    if (matterData?.halo?.site && !isSameSiteUrl(matterData.halo.site, this.site.url)) {
      new Notice(i18next.t("service.error_site_not_match"));
      return;
    }

    // 6 个元数据字段的校验放在**最前面**，理由是它必须早于任何副作用：
    // 分类/标签解析会真的在站点上建分类（`getCategoryNames`），一旦走到那一步再报"字段写错了"，
    // 站点上已经留下了新建的标签，而文章没发出去 —— 用户看到的是"发布失败"和一堆新标签。
    const haloFields = parseHaloPostFields(matterData?.halo);

    if (!haloFields.ok) {
      new Notice(i18next.t(haloFields.key, haloFields.params));
      return;
    }

    // 分类/标签的解析发生在**写入之前**：…（原有注释保留）
```

然后在两个分支的 `applyPostFrontmatter` 调用里各加一行 `haloFields: haloFields.fields,`：
更新分支（`useActiveFileDefaults: false`）与新建分支（`useActiveFileDefaults: true`）。

`updatePost` / `pullPost` **不做校验** —— 它们的 6 个字段是从服务端读回来的，服务端给出的值
必然是 schema 内的合法值，本地再校验一遍是多余的守门；而回写方向（Task 3 Step 3）已经覆盖了
「让用户看得见这些值」这个目的。

- [ ]  **Step 8：跑测试确认全绿**

```bash
pnpm test
```

- [ ]  **Step 9：加一条「回写不使用本地字面量」的判别器**

这是 Global Constraint #2 在本任务的落点，也是 1-A 的 I1 在新字段上的对应物。
追加到 `tests/service/index.test.ts`：

```ts
  test("回写 halo.publishTime 用的是服务端归一化后的值，不是本地送出去的那个", async () => {
    // 判别器：把回写改成从 `matterData.halo.publishTime` 取值就会红。
    // 本地送的是 "2026-10-06 10:00"（服务端会归一成带时区的形式），
    // 若回写用了本地值，笔记里留下的是一个服务端并不认可原样的字符串 —— 下次发布再送一遍，
    // 而用户在站点前台看到的时间与笔记里写的不一致。
    const note = createFile("posts/post.md");
    const { app, fileManager, metadataCache } = createMockApp("local markdown", note, []);
    const { client } = fakeService({
      // 服务端归一化后的形态与本地写的不同
      itemFor: (name) => remoteItem(name, { publishTime: "2026-10-06T10:00:00.000Z" }),
    });
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { name: "post-1", publishTime: "2026-10-06 10:00" } },
    }));

    let written: Record<string, unknown> | undefined;
    fileManager.processFrontMatter.mockImplementation(
      (_file: unknown, callback: (frontmatter: Record<string, unknown>) => void) => {
        written = {};
        callback(written);
      },
    );

    await new HaloService(app, createSettings(), site, client).publishPost();

    expect((written?.halo as { publishTime?: string } | undefined)?.publishTime).toBe("2026-10-06T10:00:00.000Z");
  });
```

- [ ]  **Step 10：确认判别器会红**

把回写临时改成写 `matterData.halo.publishTime`，跑该文件，确认上面这条 FAIL，然后改回来
（用 `git show HEAD:src/service/index.ts` 逐字比对确认恢复）。

- [ ]  **Step 11：跑全套 + 构建 + 提交**

```bash
pnpm test && pnpm build
git add src/frontmatter-map.ts src/service/index.ts tests/frontmatter-map.test.ts tests/service/index.test.ts
git commit -m "feat(frontmatter): 6 个元数据字段贯通发布/更新/拉取"
```

---

## Task 4：`src/glob.ts` + `src/site-routing.ts` —— glob 匹配与站点解析（纯函数）

**为什么是两个文件而不是一个（预检发现的真缺陷，务必读懂再动手）**：
`settings.ts` 需要 `SiteRoutingRule` 类型与 `matchGlob`（设置面板要显示每条规则命中多少篇），
而 `site-routing.ts` 需要 `settings.ts` 的 `isSameSiteUrl` / `normalizeSiteUrl`。
一个文件装全部就构成 **`settings.ts ⇄ site-routing.ts` 的真循环 import** ——
这是 rslib/rspack 打包时的真实风险，也违反本计划的 Global Constraint #3（依赖方向单一）。

解法是把**不依赖任何东西**的那部分抽成叶子模块 `src/glob.ts`：

```
glob.ts         （零 import，叶子）
   ↑
site-routing.ts （import glob + settings）
   ↑
settings.ts     （import glob，**不** import site-routing）
```

`site-routing.ts` **再导出** `glob.ts` 的三个符号（`export { … } from "./glob"`），
这样所有 `from "src/site-routing"` 的调用点（含测试）**一字不用改**。
再导出不是第二份实现，不违反「单一实现」。

**Files:**

- Create: `src/glob.ts`
- Create: `src/site-routing.ts`
- Test: `tests/site-routing.test.ts`（一个测试文件吃两个模块 —— 它们是一件事的两半，分开测只会让读者来回跳）

**Interfaces:**

- Consumes: `HaloSite`、`isSameSiteUrl`、`normalizeSiteUrl`（`src/settings.ts`）—— **只有 `site-routing.ts` 消费**
- Produces（`src/glob.ts` 定义，`src/site-routing.ts` 再导出全部四个）：
  - `interface SiteRoutingRule { pattern: string; site: string }`
  - `function normalizeRulePattern(pattern: string): string`
  - `function matchGlob(pattern: string, filePath: string): boolean`
  - `function resolveSite(sites: HaloSite[], rules: SiteRoutingRule[], filePath: string, frontmatterUrl?: string): SiteResolution`
  - `type SiteResolution = { kind: "resolved"; site: HaloSite; source: "frontmatter" | "rule" | "default" | "single"; pattern?: string } | { kind: "needs-choice" } | { kind: "no-sites" } | { kind: "unknown-site"; url: string } | { kind: "unknown-rule-site"; url: string; pattern: string }`

---

- [ ]  **Step 1：写失败的测试**

新建 `tests/site-routing.test.ts`：

```ts
import { describe, expect, it } from "@rstest/core";
import { matchGlob, normalizeRulePattern, resolveSite } from "src/site-routing";
import type { HaloSite } from "src/settings";

function site(url: string, name = url, isDefault = false): HaloSite {
  return { name, url, token: "", mcpToken: "", default: isDefault };
}

describe("matchGlob", () => {
  it.each([
    // [模式, 路径, 期望]
    ["博客/*", "博客/a.md", true],
    ["博客/*", "博客/子目录/a.md", false], // `*` 不跨 `/` —— 这是 glob 的通行语义
    ["博客/**", "博客/a.md", true],
    ["博客/**", "博客/子目录/更深/a.md", true],
    ["**/*.md", "a.md", true], // `**/` 要能匹配「零层目录」
    ["**/*.md", "x/y/a.md", true],
    ["**/*.md", "x/y/a.txt", false],
    ["博客/?.md", "博客/a.md", true],
    ["博客/?.md", "博客/ab.md", false],
    ["a.md", "a.md", true],
    ["a.md", "b/a.md", false], // 模式永远是对**整条路径**匹配，不做后缀匹配
  ] as [string, string, boolean][])("%s 对 %s → %s", (pattern, path, expected) => {
    expect(matchGlob(pattern, path)).toBe(expected);
  });

  it("正则元字符按字面处理，不当作模式", () => {
    // 用户在库里有 `C++/` 这种目录名是常见的。若把 `+` 交给正则，它要么报错要么变成量词。
    expect(matchGlob("C++/**", "C++/a.md")).toBe(true);
    expect(matchGlob("a(1)/**", "a(1)/b.md")).toBe(true);
    expect(matchGlob("a.b/*", "axb/c.md")).toBe(false); // `.` 不能匹配任意字符
  });

  it("不区分大小写（Windows 上是文件系统本来就有的行为；命中不了时用户毫无线索）", () => {
    expect(matchGlob("Blog/**", "blog/a.md")).toBe(true);
    expect(matchGlob("blog/**", "Blog/A.md")).toBe(true);
  });

  it("空模式不匹配任何路径", () => {
    // 空模式若被编译成 `^$`，它什么都匹配不到 —— 但更糟的实现是把它当成 `**`。
    expect(matchGlob("", "a.md")).toBe(false);
    expect(matchGlob("   ", "a.md")).toBe(false);
  });
});

describe("normalizeRulePattern", () => {
  it("去掉首尾空白与开头的斜杠（用户会写 `/博客/**`）", () => {
    expect(normalizeRulePattern("  /博客/**  ")).toBe("博客/**");
  });

  it("反斜杠分隔符换成斜杠（vault 路径永远是斜杠，但用户从资源管理器复制来的是反斜杠）", () => {
    expect(normalizeRulePattern("博客\\**")).toBe("博客/**");
  });
});

describe("resolveSite —— 优先级", () => {
  const sites = [site("https://a.example.com", "A", true), site("https://b.example.com", "B")];

  it("frontmatter 的 halo.site 最高，压过规则表与默认站点", () => {
    const result = resolveSite(sites, [{ pattern: "**", site: "https://a.example.com" }], "x/y.md", "https://b.example.com");

    expect(result).toEqual({ kind: "resolved", site: sites[1], source: "frontmatter" });
  });

  it("frontmatter 指向一个没配置的站点时报错，**不静默改道**", () => {
    // 静默改用默认站点会把笔记发到另一个站上（可能已在别处存在同名文章）。
    // 报错是可恢复的，发错站不是。
    expect(resolveSite(sites, [], "x.md", "https://c.example.com")).toEqual({
      kind: "unknown-site",
      url: "https://c.example.com",
    });
  });

  it("规则表自上而下取首个命中", () => {
    const rules = [
      { pattern: "博客/日记/**", site: "https://b.example.com" },
      { pattern: "博客/**", site: "https://a.example.com" },
    ];

    expect(resolveSite(sites, rules, "博客/日记/1.md")).toEqual({
      kind: "resolved",
      site: sites[1],
      source: "rule",
      pattern: "博客/日记/**",
    });
    expect(resolveSite(sites, rules, "博客/技术/1.md")).toEqual({
      kind: "resolved",
      site: sites[0],
      source: "rule",
      pattern: "博客/**",
    });
  });

  it("首条命中的规则指向已删掉的站点时报错，不继续往下找", () => {
    // 继续往下找会把「规则写错了」变成「发到了另一个站」—— 用户改完规则前永远不会知道有问题。
    const rules = [
      { pattern: "博客/**", site: "https://deleted.example.com" },
      { pattern: "**", site: "https://a.example.com" },
    ];

    expect(resolveSite(sites, rules, "博客/1.md")).toEqual({
      kind: "unknown-rule-site",
      url: "https://deleted.example.com",
      pattern: "博客/**",
    });
  });

  it("都不命中时用默认站点", () => {
    expect(resolveSite(sites, [{ pattern: "别处/**", site: "https://b.example.com" }], "x.md")).toEqual({
      kind: "resolved",
      site: sites[0],
      source: "default",
    });
  });

  it("没有默认站点、只有一个站点时直接用它", () => {
    expect(resolveSite([site("https://a.example.com")], [], "x.md")).toEqual({
      kind: "resolved",
      site: { name: "https://a.example.com", url: "https://a.example.com", token: "", mcpToken: "", default: false },
      source: "single",
    });
  });

  it("多个站点、没有默认、规则也不命中时要求用户选", () => {
    expect(resolveSite([site("https://a.example.com"), site("https://b.example.com")], [], "x.md")).toEqual({
      kind: "needs-choice",
    });
  });

  it("一个站点都没配时给出专门的一档", () => {
    expect(resolveSite([], [], "x.md")).toEqual({ kind: "no-sites" });
  });

  it("站点 URL 比较走 isSameSiteUrl：尾斜杠的差异不算不同", () => {
    expect(resolveSite(sites, [], "x.md", "https://b.example.com/")).toEqual({
      kind: "resolved",
      site: sites[1],
      source: "frontmatter",
    });
  });

  it("空模式被跳过，不会变成「命中一切」", () => {
    const rules = [
      { pattern: "  ", site: "https://b.example.com" },
      { pattern: "**", site: "https://a.example.com" },
    ];

    expect(resolveSite(sites, rules, "x.md")).toEqual({
      kind: "resolved",
      site: sites[0],
      source: "rule",
      pattern: "**",
    });
  });
});
```

- [ ]  **Step 2：跑测试确认失败**

```bash
pnpm test tests/site-routing.test.ts
```

预期：FAIL，`Failed to resolve import "src/site-routing"`。

- [ ]  **Step 3：实现**

**先建叶子模块 `src/glob.ts`。** 它**一个项目内模块都不 import** —— 这正是本次拆分的全部意义。
如果你发现自己想往它里面加 import，说明拆错了，停下来报告。

```ts
/**
 * 一条路由规则：把某类路径的笔记送到某个站点。
 *
 * `site` 存的是**站点 URL**而不是站点名：`halo.site` 用的就是 URL，
 * 两处形态一致才能在 `resolveSite` 里共用 `isSameSiteUrl()` 比较（尾斜杠、大小写都不算差异）。
 */
export interface SiteRoutingRule {
  /** vault 库内相对路径的 glob，如 `博客/**`。支持 `*`（不跨 `/`）、`**`（跨 `/`）、`?`（单个非 `/` 字符） */
  pattern: string;
  site: string;
}

/** 把用户手写的模式规整成库内路径的形态：去空白、去开头斜杠、反斜杠换正斜杠 */
export function normalizeRulePattern(pattern: string): string {
  return pattern.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * glob → 正则。
 *
 * 只认 `*` / `**` / `?` 三个元字符，**其余一律按字面转义**。这样：
 * ① 用户在库里叫 `C++` 的目录能直接用，不会因为 `+` 被当量词而报错或匹配到别的东西；
 * ② 不存在「模式写错导致抛异常」这条路径 —— 编译永远不会失败。
 *
 * 大小写不敏感：用户在 Windows 上看到的目录名与实际大小写未必一致，而**没命中是没有提示的**
 * （规则往下走、最后落到默认站点）。宁可宽松地命中，也不要静默走错站点。
 */
function globToRegExp(pattern: string): RegExp {
  let source = "";

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];

    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index++;

        // `**/` 要能匹配「零层目录」，否则 `**/*.md` 匹配不到库根下的 `a.md` ——
        // 而用户写这个模式时想的显然是「所有笔记」，漏掉根目录是最难发现的错。
        if (pattern[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }

  return new RegExp(`^${source}$`, "i");
}

/** 模式是否匹配某条库内相对路径。空模式恒不匹配（绝不能退化成「命中一切」） */
export function matchGlob(pattern: string, filePath: string): boolean {
  const normalized = normalizeRulePattern(pattern);

  if (normalized === "") {
    return false;
  }

  return globToRegExp(normalized).test(filePath);
}
```

**再建** `src/site-routing.ts`。它 import 上面那个叶子与 `./settings`，并**再导出**叶子的公开面 ——
于是所有 `from "src/site-routing"` 的调用点（含测试）一字不用改。
**再导出不是第二份实现**：实现只有一份，在 `glob.ts` 里，这里只是一条转发。

```ts
import { type SiteRoutingRule, matchGlob, normalizeRulePattern } from "./glob";
import { type HaloSite, isSameSiteUrl, normalizeSiteUrl } from "./settings";

// 调用方（settings.ts 的设置面板、site-routing-modal.ts、main.ts、测试）只需认
// "src/site-routing" 一个入口。glob.ts 是内部实现细节，将来要换匹配算法只动那一处。
export { type SiteRoutingRule, matchGlob, normalizeRulePattern } from "./glob";

/**
 * 站点解析的结果。
 *
 * 刻意做成**带 kind 的联合**而不是 `HaloSite | undefined`：批量操作必须能分辨
 * 「这篇没有可用站点」的**具体原因**并逐条告诉用户，而 `undefined` 把这些原因全揉成了一团。
 * 这也是本阶段反复出现的那条立场 —— 失败要说得出是哪种失败。
 */
export type SiteResolution =
  | { kind: "resolved"; site: HaloSite; source: "frontmatter" | "rule" | "default" | "single"; pattern?: string }
  | { kind: "needs-choice" }
  | { kind: "no-sites" }
  | { kind: "unknown-site"; url: string }
  | { kind: "unknown-rule-site"; url: string; pattern: string };

/**
 * 决定一篇笔记发布到哪个站点。
 *
 * 优先级（用户 2026-10-03 裁定，与 `CLAUDE.md` 一直写着的那条一致）：
 * frontmatter 的 `halo.site` → 规则表自上而下首个命中 → 设置里的默认站点 → 唯一站点 → 让用户选。
 *
 * 两处「报错而不是继续往下找」是刻意的：`unknown-site` / `unknown-rule-site` 都表示
 * **用户的配置有问题**，而这两种情况下继续往下找的后果是把笔记发到**另一个站**上 ——
 * 那是不可恢复的（可能已在目标站建了同名文章），而报错只是让他去改一行配置。
 */
export function resolveSite(
  sites: HaloSite[],
  rules: SiteRoutingRule[],
  filePath: string,
  frontmatterUrl?: string,
): SiteResolution {
  if (sites.length === 0) {
    return { kind: "no-sites" };
  }

  if (frontmatterUrl) {
    const matched = sites.find((site) => isSameSiteUrl(site.url, frontmatterUrl));

    return matched ? { kind: "resolved", site: matched, source: "frontmatter" } : { kind: "unknown-site", url: frontmatterUrl };
  }

  for (const rule of rules) {
    if (!matchGlob(rule.pattern, filePath)) {
      continue;
    }

    const target = normalizeSiteUrl(rule.site);
    const matched = sites.find((site) => isSameSiteUrl(site.url, target));

    // 首个命中的规则指向一个已经不存在的站点 → 停下报错，不继续往下找（理由见函数注释）
    return matched
      ? { kind: "resolved", site: matched, source: "rule", pattern: normalizeRulePattern(rule.pattern) }
      : { kind: "unknown-rule-site", url: target, pattern: normalizeRulePattern(rule.pattern) };
  }

  const defaultSite = sites.find((site) => site.default);

  if (defaultSite) {
    return { kind: "resolved", site: defaultSite, source: "default" };
  }

  if (sites.length === 1) {
    return { kind: "resolved", site: sites[0], source: "single" };
  }

  return { kind: "needs-choice" };
}
```

- [ ]  **Step 4：跑测试确认全绿**

```bash
pnpm test tests/site-routing.test.ts
```

- [ ]  **Step 5：提交**

```bash
git add src/glob.ts src/site-routing.ts tests/site-routing.test.ts
git commit -m "feat(routing): 路径 glob 与站点解析（纯函数，四级优先级）"
```

---

## Task 5：设置项 `siteRouting` 与规则表 UI

**Files:**

- Modify: `src/settings.ts`（`HaloSetting` / `DEFAULT_SETTINGS` / `HaloSettingTab`）
- Create: `src/site-routing-modal.ts`
- Test: `tests/settings.test.ts`

**Interfaces:**

- Consumes: `SiteRoutingRule`、`normalizeRulePattern`（Task 4）
- Produces: `HaloSetting.siteRouting: SiteRoutingRule[]`（缺省 `[]`）

---

- [ ]  **Step 1：写失败测试**

追加到 `tests/settings.test.ts`：

```ts
describe("siteRouting 迁移", () => {
  it("老配置没有 siteRouting 时补成空数组，不抛错", () => {
    const { settings } = migrateSettings({ sites: [], publishByDefault: false });
    expect(settings.siteRouting).toEqual([]);
  });

  it("已有的规则被原样保留（顺序就是优先级，绝不能在迁移里重排或去重）", () => {
    const rules = [
      { pattern: "博客/日记/**", site: "https://a.example.com" },
      { pattern: "博客/**", site: "https://b.example.com" },
    ];
    const { settings } = migrateSettings({ siteRouting: rules });

    expect(settings.siteRouting).toEqual(rules);
  });

  it("用户把 siteRouting 写成了非数组（手改 data.json）时回落成空数组，不抛错", () => {
    // data.json 是用户能直接编辑的文件。抛出会让插件整个加载不了 —— 比丢一条规则严重得多。
    expect(migrateSettings({ siteRouting: "博客/**" }).settings.siteRouting).toEqual([]);
  });
});
```

- [ ]  **Step 2：跑测试确认失败**

```bash
pnpm test tests/settings.test.ts
```

- [ ]  **Step 3：实现设置项与迁移**

修改 `src/settings.ts`：

```ts
import { type SiteRoutingRule, normalizeRulePattern } from "./glob";

export interface HaloSetting {
  settingsVersion: number;
  sites: HaloSite[];
  publishByDefault: boolean;
  /**
   * 发布前是否跳过预览弹窗。默认 `false` = **显示预览**。
   *
   * 刻意不复用 `publishByDefault` 来承载这个语义：那个键名里有 "publish" 却管的是"发布还是草稿"，
   * 拿它同时表示"要不要弹窗"会让读者长期误读（spec §5.2 明确点名了这一点）。
   */
  skipPreviewOnPublish: boolean;
  /** 站点路由规则。**数组顺序就是优先级**（自上而下取首个命中），所以任何地方都不能重排 */
  siteRouting: SiteRoutingRule[];
  replaceImageLinks: boolean;
  imageUploadCache: Record<string, Record<string, ImageUploadCacheEntry>>;
}

export const DEFAULT_SETTINGS: HaloSetting = {
  settingsVersion: CURRENT_SETTINGS_VERSION,
  sites: [],
  publishByDefault: false,
  skipPreviewOnPublish: false,
  siteRouting: [],
  replaceImageLinks: true,
  imageUploadCache: {},
};
```

在 `migrateSettings` 里规整（**放在 `Object.assign` 之后、返回之前**）：

```ts
/**
 * 规整规则表：丢掉模式为空的行、把模式写成库内路径的形态。
 *
 * **绝不重排、绝不去重、绝不丢掉指向未知站点的行** —— 数组顺序就是优先级，
 * 而指向未知站点的行是用户要去修的东西（`resolveSite` 会明确报出来），悄悄删掉它
 * 等于把「规则写错了」变成「规则不见了」。
 */
function normalizeRoutingRules(raw: unknown): SiteRoutingRule[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((rule): rule is SiteRoutingRule => typeof rule === "object" && rule !== null)
    .map((rule) => ({
      pattern: normalizeRulePattern(String(rule.pattern ?? "")),
      site: String(rule.site ?? ""),
    }))
    .filter((rule) => rule.pattern !== "");
}
```

在返回的 `settings` 里加两行：

```ts
      siteRouting: normalizeRoutingRules(merged.siteRouting),
      skipPreviewOnPublish: merged.skipPreviewOnPublish === true,
```

- [ ]  **Step 4：跑测试确认全绿**

```bash
pnpm test tests/settings.test.ts
```

- [ ]  **Step 5：写规则编辑弹窗**

新建 `src/site-routing-modal.ts`，结构照 `src/site-editing-modal.ts`（同样的
`openXxxModal` 返回 Promise + 内部 Modal 类的两段式）：

```ts
import i18next from "i18next";
import { Modal, Setting } from "obsidian";
import type HaloPlugin from "./main";
import type { SiteRoutingRule } from "./glob";
import { normalizeRulePattern } from "./glob";

export function openSiteRoutingModal(
  plugin: HaloPlugin,
  rule?: SiteRoutingRule,
): Promise<SiteRoutingRule | undefined> {
  return new Promise((resolve) => {
    new SiteRoutingModal(plugin, rule ?? { pattern: "", site: plugin.settings.sites[0]?.url ?? "" }, resolve).open();
  });
}

class SiteRoutingModal extends Modal {
  constructor(
    private readonly plugin: HaloPlugin,
    private readonly draft: SiteRoutingRule,
    private readonly onSubmit: (rule: SiteRoutingRule | undefined) => void,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: i18next.t("site_routing_modal.title") });

    new Setting(contentEl)
      .setName(i18next.t("site_routing_modal.pattern.name"))
      .setDesc(i18next.t("site_routing_modal.pattern.description"))
      .addText((text) =>
        text.setValue(this.draft.pattern).onChange((value) => {
          this.draft.pattern = value;
        }),
      );

    new Setting(contentEl)
      .setName(i18next.t("site_routing_modal.site.name"))
      .setDesc(i18next.t("site_routing_modal.site.description"))
      .addDropdown((dropdown) => {
        // 只列出**已配置**的站点：规则指向一个不存在的站点时 `resolveSite` 会直接报错，
        // 让用户在弹窗里就能选到一个真实存在的站点，是这条错误唯一的可预防来源。
        for (const site of this.plugin.settings.sites) {
          dropdown.addOption(site.url, site.name || site.url);
        }

        dropdown.setValue(this.draft.site).onChange((value) => {
          this.draft.site = value;
        });
      });

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(i18next.t("common.button_cancel")).onClick(() => {
          this.onSubmit(undefined);
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText(i18next.t("site_routing_modal.save.button"))
          .setCta()
          .onClick(() => {
            const pattern = normalizeRulePattern(this.draft.pattern);

            // 空模式绝不入表：`matchGlob` 会把它当"永不命中"，但一条什么都不匹配的规则
            // 在设置里看着像生效的，会让人以为已经配好了。
            if (pattern === "") {
              return;
            }

            this.onSubmit({ pattern, site: this.draft.site });
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

- [ ]  **Step 6：在设置面板里渲染规则表**

在 `HaloSettingTab.display()` 的 `publishByDefault` 之后插入。**「匹配 N 篇」这一列是本任务
最有价值的一块**：规则不命中时 `resolveSite` 会安静地往下一级走，用户没有任何线索；
把命中数直接摆在设置里，写错模式立刻肉眼可见。

```ts
    new Setting(containerEl)
      .setName(i18next.t("settings.siteRouting.name"))
      .setDesc(i18next.t("settings.siteRouting.description"))
      .setHeading();

    const rules = this.plugin.settings.siteRouting;

    if (rules.length === 0) {
      containerEl.createEl("p", { text: i18next.t("settings.siteRouting.empty") });
    }

    // 一次遍历算出每行的命中数：vault 里的 markdown 文件清单是现成的，规则又只有几条，
    // 复杂度是 files × rules —— 当前规模（百余篇、个位数规则）下可以忽略。
    const markdownFiles = this.plugin.app.vault.getMarkdownFiles();

    rules.forEach((rule, index) => {
      const matchCount = markdownFiles.filter((file) => matchGlob(rule.pattern, file.path)).length;
      const siteName = this.plugin.settings.sites.find((site) => isSameSiteUrl(site.url, rule.site))?.name ?? rule.site;
      const setting = new Setting(containerEl)
        .setName(`${rule.pattern} → ${siteName}`)
        .setDesc(
          matchCount === 0
            ? i18next.t("settings.siteRouting.no_match")
            : i18next.t("settings.siteRouting.match_count", { count: matchCount }),
        );

      setting.addExtraButton((button) =>
        button.setIcon("lucide-arrow-up").setDisabled(index === 0).onClick(() => {
          this.moveRule(index, index - 1);
        }),
      );
      setting.addExtraButton((button) =>
        button.setIcon("lucide-arrow-down").setDisabled(index === rules.length - 1).onClick(() => {
          this.moveRule(index, index + 1);
        }),
      );
      setting.addExtraButton((button) =>
        button.setIcon("lucide-pencil").onClick(async () => {
          const updated = await openSiteRoutingModal(this.plugin, rule);

          if (updated) {
            rules[index] = updated;
            await this.plugin.saveSettings();
            this.display();
          }
        }),
      );
      setting.addExtraButton((button) =>
        button.setIcon("lucide-trash").onClick(() => {
          rules.splice(index, 1);
          this.plugin.saveSettings();
          this.display();
        }),
      );
    });

    new Setting(containerEl).addButton((button) =>
      button.setButtonText(i18next.t("settings.siteRouting.actions.add")).onClick(async () => {
        const rule = await openSiteRoutingModal(this.plugin);

        if (rule) {
          // 追加到末尾：新规则默认优先级最低。要把它提到前面去，用行上的上移按钮 ——
          // 静默插到最前面会让既有用户下次发布时突然改了目标站点。
          rules.push(rule);
          await this.plugin.saveSettings();
          this.display();
        }
      }),
    );
```

并加一个私有方法（`HaloSettingTab` 内）：

```ts
  /** 交换两条规则的顺序。**顺序就是优先级**，所以这是本设置面板里唯一改语义的操作 */
  private moveRule(from: number, to: number): void {
    const rules = this.plugin.settings.siteRouting;

    if (to < 0 || to >= rules.length) {
      return;
    }

    const [moved] = rules.splice(from, 1);
    rules.splice(to, 0, moved);
    void this.plugin.saveSettings();
    this.display();
  }
```

文件顶部补 import：`import { matchGlob } from "./glob";`、`import { openSiteRoutingModal } from "./site-routing-modal";`，
并确认 `isSameSiteUrl` 已在既有 import 里。

- [ ]  **Step 7：加三语文案**

`zh-cn.json` 的 `settings` 下加：

```json
    "siteRouting": {
      "name": "站点路由规则",
      "description": "按笔记在库内的相对路径匹配目标站点，自上而下取首个命中的规则；都不命中时用默认站点。模式支持 *（不跨目录）、**（跨目录）、?（单个字符）。",
      "empty": "还没有配置路由规则 —— 所有笔记都会走默认站点或弹窗选择。",
      "match_count": "匹配到 {{count}} 篇笔记",
      "no_match": "没有匹配到任何笔记 —— 请检查模式是否写错（注意大小写与目录层级）",
      "actions": {
        "add": "添加规则"
      }
    },
```

> **注记（后续追加，非计划当时的内容）**：上面这段 `siteRouting` 文案是**规划当时的字面量**，
> 已被后续的修复轮改过 —— `description` / `empty` / `no_match` 三句当时都复述了与实现相反的规则细节
>（「自上而下取首个命中 / 都不命中时用默认站点」「所有笔记都会走默认站点或弹窗选择」「注意大小写」），
> 现已收缩为不复述规则细节。**交付时的实际文案见 `src/i18n/locales/*.json`**，
> 本节所引字面量按过程记录保留、不予改写。

顶层加：

```json
  "site_routing_modal": {
    "title": "站点路由规则",
    "pattern": {
      "name": "路径模式",
      "description": "vault 库内相对路径的 glob，例如 博客/** 或 博客/日记/*"
    },
    "site": {
      "name": "目标站点",
      "description": "命中这条模式的笔记将发布到这个站点"
    },
    "save": {
      "button": "保存"
    }
  },
```

`common` 下加 `"button_cancel": "取消"` / `"Cancel"` / `"取消"`。
`en.json` 与 `zh-tw.json` 逐键对应。

- [ ]  **Step 8：核对三语键数一致**

```bash
node -e "
const fs=require('fs');
const keys=(o,p='')=>Object.entries(o).flatMap(([k,v])=>typeof v==='object'&&v!==null?keys(v,p+k+'.'):[p+k]);
const sets=['en','zh-cn','zh-tw'].map(l=>new Set(keys(JSON.parse(fs.readFileSync('src/i18n/locales/'+l+'.json','utf8')))));
console.log('键数:', sets.map(s=>s.size).join(' / '));
for (const a of sets) for (const b of sets) { const d=[...a].filter(k=>!b.has(k)); if (d.length) console.log('差集:', d); }
"
```

- [ ]  **Step 9：确认没有漏掉 `HaloSetting` 的构造点**

```bash
grep -rn "publishByDefault\|DEFAULT_SETTINGS" src/ tests/ | grep -v "i18n/locales"
```

`DEFAULT_SETTINGS` 是生产代码里唯一的字面量来源，但**测试里还有一个**：
**`tests/helpers/obsidian-mocks.ts` 的 `createSettings()`**（约第 47 行）。它的返回类型标注是
`HaloSetting`，所以本任务给 `HaloSetting` 加两个必填字段后，**它不补就会 tsc 报错**。
补两行：`siteRouting: []`、`skipPreviewOnPublish: false`。
它是 `tests/service/index.test.ts` / `image-upload.test.ts` / `settings.test.ts` 三处的共用工厂，
补一处就够，**不要**去各测试文件里逐个改。

> ⚠️ 除了它之外还有一处容易被忽略：`src/settings.ts` 里 `HaloSettingTab.display()` 之外，
> **`src/site-editing-modal.ts:15` 的 `openSiteEditingModal`** 构造站点字面量时用的是
> `{ name: "", url: "", default: false, token: "", mcpToken: "" }` —— 那是 `HaloSite` 不是
> `HaloSetting`，**不需要动**。别顺手给它加字段。

- [ ]  **Step 10：跑全套 + 构建 + 提交**

```bash
pnpm test && pnpm build
git add src/settings.ts src/site-routing-modal.ts \
        src/i18n/locales/en.json src/i18n/locales/zh-cn.json src/i18n/locales/zh-tw.json \
        tests/settings.test.ts
git commit -m "feat(settings): 站点路由规则表（顺序即优先级，含命中数提示）"
```

---

## Task 6：站点解析统一接入 `main.ts`

发布与上传图片**必须解析到同一个站点**。若图片传到了 A 站而文章发到了 B 站，
文章里的图片链接全部指向另一个域名 —— 而两个操作各自都报成功。

**Files:**

- Modify: `src/main.ts`
- Test: 无新增（纯函数已由 Task 4 覆盖；这一层是薄胶水，按 `post-selection-model.ts` 的既有立场不加 UI 脚手架）

**Interfaces:**

- Consumes: `resolveSite`、`SiteResolution`（Task 4）
- Produces: `HaloPlugin.resolveSiteFor(file: TFile): SiteResolution`、`HaloPlugin.siteForResolution(resolution): Promise<HaloSite | undefined>`（两个 private 方法，Task 8 会用）

---

- [ ]  **Step 1：实现解析入口**

在 `src/main.ts` 的 `HaloPlugin` 里加两个方法，删掉分散的三段解析链：

```ts
  /**
   * 决定一篇笔记的目标站点。**同步、不弹窗、不报错** —— 只做判断，
   * 用户可见的处置交给 `siteForResolution`。分开的理由是批量操作：它需要拿到
   * 「为什么这篇没有站点」这个**结果**去汇总，而不是让一次弹窗打断整批。
   */
  private resolveSiteFor(file: TFile): SiteResolution {
    const matterData = this.app.metadataCache.getFileCache(file)?.frontmatter;

    return resolveSite(this.settings.sites, this.settings.siteRouting ?? [], file.path, matterData?.halo?.site);
  }

  /**
   * 把解析结果变成可用的站点：需要用户选的弹窗、需要报错的报错，都收在这里。
   * 返回 `undefined` 表示「这次操作不要继续」（用户取消，或已经弹过提示）。
   */
  private async siteForResolution(resolution: SiteResolution): Promise<HaloSite | undefined> {
    switch (resolution.kind) {
      case "resolved":
        return resolution.site;
      case "no-sites":
        new Notice(i18next.t("command.publish.error_no_sites"));
        return undefined;
      case "unknown-site":
        // 与既有文案一致：笔记的 halo.site 指向一个没配过的站点
        new Notice(i18next.t("command.publish.error_no_matched_site"));
        return undefined;
      case "unknown-rule-site":
        new Notice(i18next.t("service.error_unknown_rule_site", { pattern: resolution.pattern, url: resolution.url }));
        return undefined;
      case "needs-choice":
        return openSiteSelectionModal(this);
    }
  }
```

顶部 import 补：`import { type SiteResolution, resolveSite } from "./site-routing";`

- [ ]  **Step 2：把 `publishCommand` 改成用它**

```ts
  private async publishCommand() {
    const { activeEditor } = this.app.workspace;

    if (!activeEditor || !activeEditor.file) {
      return;
    }

    // 这一处是**行为变更**（刻意的）：改动前 `publishCommand` 在没有 `halo.site` 时
    // 一律弹窗选站点，**完全忽略设置里的默认站点与唯一站点**；而 `CLAUDE.md` 一直写着
    // 的优先级是「frontmatter → 默认站点 → 单站点直取 → 弹窗」。改动后两端一致。
    // 最直观的差别：只配了一个站点的用户不再每次发布都看一眼只有一个选项的弹窗。
    const resolution = this.resolveSiteFor(activeEditor.file);
    const site = await this.siteForResolution(resolution);

    if (!site) {
      return;
    }

    const service = new HaloService(this.app, this.settings, site);
    const uploadResult = await this.uploadImagesForPublish(service);

    if (!uploadResult.success) {
      return;
    }

    await service.publishPost({ markdown: uploadResult.markdown });
  }
```

> ⚠️ **Task 7** 会把 `publishPost` 的参数改成显式 `file`（→ `publishPost(activeEditor.file, { markdown })`），
> **Task 8** 再把这段编排整体换成 `publishFile(file)`。先保持现有调用形状，不要提前改 ——
> 每一步都要留下一个能跑通、能单独审查的状态。

- [ ]  **Step 3：把 `getSiteForActiveFile` 改成用它**

```ts
  private async getSiteForActiveFile(): Promise<HaloSite | undefined> {
    const { activeEditor } = this.app.workspace;

    if (!activeEditor || !activeEditor.file) {
      return undefined;
    }

    // 与发布走**同一个**解析入口。两处各解析一遍是错的：图片会传到 A 站、文章发到 B 站，
    // 两个操作都报成功，而文章里的图片链接指向另一个域名。
    return this.siteForResolution(this.resolveSiteFor(activeEditor.file));
  }
```

- [ ]  **Step 4：`publish-with-defaults` 保持原样，但补一行说明**

该命令的语义就是「用默认站点」，规则表与 `halo.site` 都不该对它生效；`canPublishToSite`
那道守卫继续保留。在它的回调上方加注释：

```ts
      // 这条命令**刻意不经过 `resolveSite`**：它的语义就是「用默认站点」，
      // 让路由规则来改写目标会与命令名直接冲突。`canPublishToSite` 那道守卫
      // （笔记的 halo.site 与目标站点不一致时报错）因此也只在这条路径上有用。
```

- [ ]  **Step 5：加文案**

`zh-cn.json` 的 `service` 下加：

```json
    "error_unknown_rule_site": "路由规则「{{pattern}}」指向的站点（{{url}}）不在站点列表里。请到「设置 → Halo」修正这条规则。",
```

`en.json`：`"error_unknown_rule_site": "The routing rule \"{{pattern}}\" points to a site ({{url}}) that is not in the site list. Fix the rule in Settings → Halo."`
`zh-tw.json`：繁体对应。

- [ ]  **Step 6：手工核对两条路径共用一个入口**

```bash
grep -n "resolveSiteFor\|siteForResolution\|getSiteByUrl\|openSiteSelectionModal" src/main.ts
```

预期：`openSiteSelectionModal` 只出现在 `siteForResolution` 里；`getSiteByUrl` 只剩
`update-post` 与 `canPublishToSite` 两处消费者（它们按 frontmatter 精确匹配，语义不同，保持不动）。

- [ ]  **Step 7：跑全套 + 构建 + 提交**

```bash
pnpm test && pnpm build
git add src/main.ts src/i18n/locales/en.json src/i18n/locales/zh-cn.json src/i18n/locales/zh-tw.json
git commit -m "feat(routing): 发布与上传图片共用一套站点解析"
```

---

## Task 7：解绑 activeEditor —— `uploadImages(file)` / `publishPost(file)`

今天 `publishPost()` 与 `uploadImages()` 都从 `app.workspace.activeEditor` 取文件。
批量操作要对**任意**文件做同样的事，所以这两个入口必须能接收显式文件。

**这一任务的行为必须逐字不变**（单篇路径不传 file 时行为一致），
`tests/service/index.test.ts`（1603 行）与 `tests/service/image-upload.test.ts` 是判据。

**Files:**

- Modify: `src/service/image-upload.ts`（`uploadImages` 的 options 加 `file`）
- Modify: `src/service/index.ts`（`publishPost(file, options)`、`uploadImages(options, file)`）
- Modify: `src/main.ts`（三个调用点传 `activeEditor.file`）
- Test: `tests/service/index.test.ts`、`tests/service/image-upload.test.ts`

**Interfaces:**

- Produces:
  - `uploadImages(options: { silent?: boolean; replaceMarkdown?: boolean; file?: TFile }, ctx)` —— `file` 缺省仍是活动编辑器
  - `HaloService.uploadImages(options, file?)`
  - `HaloService.publishPost(file: TFile, options?: { markdown?: string; publishOverride?: boolean; quiet?: boolean }): Promise<PublishResult>`
  - `type PublishResult = { ok: true } | { ok: false; reason: string }`

---

- [ ]  **Step 1：给 `uploadImages` 解绑**

修改 `src/service/image-upload.ts`：

```ts
export async function uploadImages(
  options: { silent?: boolean; replaceMarkdown?: boolean; file?: TFile },
  ctx: ImageUploadContext,
): Promise<UploadImagesResult> {
  // 显式传入的文件优先。批量操作走的就是这条路 —— 它手上是一个目录里的一批文件，
  // 而"活动编辑器"只有一个，且与批量的进度毫无关系。
  const targetFile = options.file ?? ctx.app.workspace.activeEditor?.file;

  if (!targetFile) {
    return { processedCount: 0, uploadedCount: 0, reusedCount: 0, failedCount: 0, replaced: false };
  }

  const md = await ctx.app.vault.read(targetFile);
  const imageReferences = collectLocalImageReferences(md, targetFile, ctx.app);
  // …（以下把原来的 activeEditor.file 全部换成 targetFile）
```

**逐处替换**：`:383` 的 `vault.read`、`:384` 的 `collectLocalImageReferences`、`:461` 的
`vault.modify`。`replaceMarkdown` 的判定逻辑一字不动。

- [ ]  **Step 2：跑既有测试确认没被打红**

```bash
pnpm test tests/service/image-upload.test.ts
```

预期：全绿。若有失败 → 说明 `activeEditor` 那个回落在既有 mock 下取不到文件，
检查 `tests/setup.ts` 里 `workspace.activeEditor` 的形状，按既有用法调整回落的写法
（**不要改测试去迁就实现**）。

- [ ]  **Step 3：写批量场景的失败测试**

追加到 `tests/service/image-upload.test.ts`：

```ts
  it("显式传入 file 时不再看活动编辑器", async () => {
    // 判别器：把 `options.file ??` 这一半删掉，再让活动编辑器指向**另一个**文件，
    // 这条就会红 —— 它钉的正是「批量操作能对着非当前打开的文件干活」。
    const explicit = createFile("笔记/其它.md");
    const active = createFile("活动.md");
    workspace.activeEditor = { file: active };

    await uploadImages({ file: explicit, silent: true }, ctx);

    expect(vault.read).toHaveBeenCalledWith(explicit);
    expect(vault.read).not.toHaveBeenCalledWith(active);
  });
```

> `createFile` / `ctx` / `workspace` 的取法照抄本文件既有用例。

- [ ]  **Step 4：给 `publishPost` 加 `file` 与 `PublishResult`**

修改 `src/service/index.ts`：

```ts
/**
 * 一次发布的结果。
 *
 * 引入它是因为**批量操作需要把每篇的结果汇总起来**：调用方必须能分辨
 * 「这篇成功了」与「这篇因为什么失败了」，而 `void` + 内部 `Notice` 做不到这件事
 * （118 篇会弹 118 条提示，用户看不过来，代码也拿不到结果）。
 *
 * 失败的 `reason` 是**已渲染好的用户文案** —— 与 `renderErrorMessage` 的分层一致：
 * 渲染发生在产出原因的那一处，调用方只负责决定「怎么告诉用户」（单篇弹提示、批量汇总）。
 */
export type PublishResult = { ok: true } | { ok: false; reason: string };
```

```ts
  /**
   * 发布（或更新）一篇笔记。
   *
   * `file` 是显式的，不再从 `activeEditor` 取：批量操作要发的是一批文件，
   * 而活动编辑器只有一个。单篇命令传 `activeEditor.file`，行为与改动前一致。
   *
   * `options.quiet` 只是**不做便签播报**，结果照常从返回值给出 —— 两条通道里
   * 返回值是权威那份，便签只是单篇路径的呈现方式。
   */
  public async publishPost(
    file: TFile,
    options: { markdown?: string; publishOverride?: boolean; quiet?: boolean } = {},
  ): Promise<PublishResult> {
```

方法体逐处修改：

1. 删掉开头取 `activeEditor` 的三行，`activeFile` 直接 `= file`。
2. 把每一处 `new Notice(i18next.t("service.notice_publish_success"))` 之外的通知改成
   `if (!options.quiet) new Notice(...)`，同时把**文案原样**放进返回值的 `reason`。
   例如：

```ts
    if (matterData?.halo?.site && !isSameSiteUrl(matterData.halo.site, this.site.url)) {
      const reason = i18next.t("service.error_site_not_match");
      this.report(reason, options.quiet);
      return { ok: false, reason };
    }
```

3. 末尾的 `new Notice(i18next.t("service.notice_publish_success"))` 改成：

```ts
    // 成功便签只在单篇路径上弹。批量路径由调用方汇总成一条 —— 118 条「发布成功」
    // 会把真正需要被看见的失败淹掉。
    if (!options.quiet) {
      new Notice(i18next.t("service.notice_publish_success"));
    }

    return { ok: true };
```

4. 加一个小工具方法：

```ts
  /** 便签播报。`quiet` 为真时什么也不做 —— 返回值仍然带着原因，调用方自己去汇总 */
  private report(reason: string, quiet?: boolean): void {
    if (!quiet) {
      new Notice(reason);
    }
  }
```

5. 发布状态的优先级插入 override：

```ts
        // 优先级：命令的显式覆盖 > frontmatter 的 `publish` > 设置里的 publishByDefault。
        //
        // 覆盖存在的原因是批量命令：用户点了「批量撤回」，意图是这批全部退回草稿，
        // 不该被某一篇笔记里写着的 `publish: true` 拦下来 —— 那样他会看到"撤回完成"
        // 而这些笔记仍然在线。单篇命令**不传** override，所以那一条路径的行为完全不变。
        if (options.publishOverride !== undefined) {
          intendedPublish = options.publishOverride;
          await this.changePostPublish(params.metadata.name, intendedPublish);
          // biome-ignore lint/suspicious/noPrototypeBuiltins: 判据必须与上游逐位一致（见下方同款注释）
        } else if (matterData?.halo?.hasOwnProperty("publish")) {
          intendedPublish = Boolean(matterData.halo.publish);
          await this.changePostPublish(params.metadata.name, intendedPublish);
        } else if (this.settings.publishByDefault) {
          intendedPublish = true;
          await this.changePostPublish(params.metadata.name, true);
        }
```

- [ ]  **Step 5：跑测试，看清哪些既有用例需要跟着改**

```bash
pnpm test tests/service/index.test.ts
```

预期：**大量用例因为 `publishPost()` 的签名变化而成批失败**（`Expected 1 arguments, but got 0`）。
逐个改成 `publishPost(activeFile)`，其中 `activeFile` 取本文件既有 mock 造出来的那个文件
（`createFile()` 的返回值，多数用例里已有变量）。

**这一步不改任何断言**，只补第一个参数。若某条用例因此从红变绿或断言失效，说明你在改断言 ——
停下来重看那条用例在钉什么。

- [ ]  **Step 6：加四条判别器**

追加到 `tests/service/index.test.ts`（脚手架同上一步：`createMockApp()` / `createSettings()` /
`fakeService()` / `capturedNotices()`）：

```ts
  test("quiet 时不弹成功便签，但返回值仍是 ok", async () => {
    // 判别器：把 quiet 判断删掉 → 这条红。它钉的是「批量路径不会被 118 条提示淹掉」。
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    const { client } = fakeService();
    const notices = capturedNotices();
    const seen = notices.length;
    metadataCache.getFileCache.mockImplementation(() => ({ frontmatter: { title: "Post title" } }));

    const result = await new HaloService(app, createSettings(), site, client).publishPost(note, { quiet: true });

    expect(result).toEqual({ ok: true });
    expect(notices.slice(seen)).toEqual([]);
  });

  test("失败时返回的 reason 与便签文案**逐字一致**", async () => {
    // 不要断言 reason 等于 `i18next.t("service.error_publish_failed")`：那条路上
    // `publishFailureMessage` 还会拼上服务端原文（`withErrorDetail`），逐字相等本来就是错的。
    // 真正要钉的不变式是「返回值与便签说的是同一件事」—— 否则单篇与批量两条路径
    // 会对**同一次失败**给出两种说法，用户无从判断哪个是真的。
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    const { client } = fakeService({
      onWrite: () => {
        throw new McpError("unauthorized", {});
      },
    });
    const notices = capturedNotices();
    const seen = notices.length;
    metadataCache.getFileCache.mockImplementation(() => ({ frontmatter: { title: "Post title" } }));

    const result = await new HaloService(app, createSettings(), site, client).publishPost(note);

    expect(result.ok).toBe(false);
    expect(notices.slice(seen)).toEqual([(result as { reason: string }).reason]);
  });

  test("publishOverride 压过 frontmatter 里的 publish: true", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    const { client, calls } = fakeService();
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { name: "post-1", publish: true } },
    }));

    await new HaloService(app, createSettings(), site, client).publishPost(note, { publishOverride: false });

    expect(calls.filter((call) => call.name === "halo_set_post_publish_state").at(-1)?.args?.publish).toBe(false);
  });

  test("单篇路径不传 override 时，frontmatter 的 publish 仍然说了算", async () => {
    // 与上一条成对：override 是**新增的最高优先级**，不是替换掉原有规则。
    // 缺了这条，一个「永远听 override」的错误实现也能全绿。
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    const { client, calls } = fakeService();
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { name: "post-1", publish: true } },
    }));

    await new HaloService(app, createSettings(), site, client).publishPost(note);

    expect(calls.filter((call) => call.name === "halo_set_post_publish_state").at(-1)?.args?.publish).toBe(true);
  });
```

- [ ]  **Step 7：改 `main.ts` 的三个调用点**

```ts
    await service.publishPost(activeEditor.file, { markdown: uploadResult.markdown });
```

（`publish-with-defaults` 与 `publishCommand` 各一处；`uploadImagesForPublish(service)` 改成
`uploadImagesForPublish(service, activeEditor.file)`，内部 `service.uploadImages({ silent: true, file })`。）

- [ ]  **Step 8：跑全套 + 构建**

```bash
pnpm test && pnpm build && pnpm exec tsc --noEmit 2>&1 | grep -c "^src/" 
```

预期：测试全绿；`tsc` 的 `src/` 错误数仍是 **3**（那 3 条是既有的 `@halo-dev/api-client` 解析错误，
多一条都说明引入了解析不了的新引用）。

- [ ]  **Step 9：提交**

```bash
git add src/service/image-upload.ts src/service/index.ts src/main.ts \
        tests/service/image-upload.test.ts tests/service/index.test.ts
git commit -m "refactor(service): publishPost/uploadImages 接收显式 file；发布结果结构化"
```

---

## Task 8：发布预览

**Files:**

- Create: `src/publish-preview.ts`（纯构造 `buildPublishPreview`）
- Create: `src/publish-preview-modal.ts`（弹窗）
- Modify: `src/service/image-upload.ts`（`LocalImageSummary` + 只读的 `summarizeLocalImages`）
- Modify: `src/service/post-mapping.ts`（`pickNewTerms`）
- Modify: `src/service/index.ts`（`planPublish` / `executePublish` 拆分）
- Modify: `src/main.ts`（命令接线 + `skipPreviewOnPublish`）
- Modify: `src/settings.ts`（`skipPreviewOnPublish` 开关）
- Test: `tests/publish-preview.test.ts`（新建）、`tests/service/post-mapping.test.ts`（追加）

**Interfaces:**

- Produces:
  - `interface LocalImageSummary { pending: number; cached: number; overLimit: string[] }` —— **定义在 `src/service/image-upload.ts`**（它是产出方），`publish-preview.ts` 与 `batch-publish.ts` 从那里 `import type`
  - `summarizeLocalImages(file, ctx): Promise<LocalImageSummary>`（`image-upload.ts`）；`HaloService.summarizeImages(file)` 薄封装
  - `pickNewTerms(desired: string[] | undefined, existing: { displayName: string }[]): string[]`（`service/post-mapping.ts`）—— 单一实现，同时服务预览、执行路径与 Task 9 的批量确认
  - `interface PublishPreview { site: { name; url; source; pattern? }; title; slug; visible; pinned; priority; publishTime; allowComment; template; characterCount; newCategories; newTags; images: LocalImageSummary }`
  - `buildPublishPreview(input: PublishPreviewInput): PublishPreview`
  - `HaloService.planPublish(file): Promise<{ ok: true; plan: PublishPlan } | { ok: false; reason: string }>`
  - `HaloService.executePublish(file, plan, options): Promise<PublishResult>`，`options = { markdown?: string; publishOverride?: boolean; quiet?: boolean }`
  - `interface PublishPlan { remoteName?: string; post: Post; raw: string; markdown: string; desiredCategories?: string[]; desiredTags?: string[]; newCategories: string[]; newTags: string[]; images: LocalImageSummary; publishFromFrontmatter?: boolean }`

---

- [ ]  **Step 1：写 `buildPublishPreview` 的失败测试**

新建 `tests/publish-preview.test.ts`：

```ts
import { describe, expect, it } from "@rstest/core";
import { buildPublishPreview } from "src/publish-preview";

describe("buildPublishPreview", () => {
  const base = {
    siteName: "博客",
    siteUrl: "https://blog.example.com",
    siteSource: "rule" as const,
    sitePattern: "博客/**",
    title: "标题",
    slug: "slug",
    raw: "正文",
    newCategories: ["新分类"],
    newTags: [],
    images: { pending: 3, cached: 1, overLimit: [] },
  };

  it("把 6 个字段的最终取值原样带出来（含显式假值）", () => {
    const preview = buildPublishPreview({
      ...base,
      spec: {
        visible: "INTERNAL",
        pinned: false,
        priority: 0,
        publishTime: "",
        allowComment: false,
        template: "",
      },
    });

    expect(preview.visible).toBe("INTERNAL");
    expect(preview.pinned).toBe(false);
    expect(preview.priority).toBe(0);
    expect(preview.publishTime).toBe("");
    expect(preview.allowComment).toBe(false);
  });

  it("字符数按正文（frontmatter 之后的部分）算，不把 frontmatter 算进去", () => {
    // 算上 frontmatter 会让这个数字随无关的配置项抖动，用户没法用它估长度。
    const preview = buildPublishPreview({ ...base, spec: {}, raw: "一二三" });
    expect(preview.characterCount).toBe(3);
  });

  it("站点来源被带出来，好让用户在预览里看到是规则命中的", () => {
    const preview = buildPublishPreview({ ...base, spec: {} });
    expect(preview.site).toEqual({
      name: "博客",
      url: "https://blog.example.com",
      source: "rule",
      pattern: "博客/**",
    });
  });

  it("将新建的分类标签为空时给出空数组，不是 undefined", () => {
    const preview = buildPublishPreview({ ...base, spec: {}, newCategories: [], newTags: [] });
    expect(preview.newCategories).toEqual([]);
    expect(preview.newTags).toEqual([]);
  });
});
```

- [ ]  **Step 2：跑测试确认失败**

```bash
pnpm test tests/publish-preview.test.ts
```

- [ ]  **Step 3：实现**

新建 `src/publish-preview.ts`：

```ts
import type { LocalImageSummary } from "./service/image-upload";

export interface PublishPreviewInput {
  siteName: string;
  siteUrl: string;
  /**
   * 站点是怎么定下来的。比 `SiteResolution["source"]` 多一档 `"picked"` ——
   * 用户在站点选择弹窗里手动点的那个，`resolveSite` 并不知道（它只负责说「需要用户选」）。
   * 预览上把「默认站点」写成「唯一站点」会让人以为配置变了，所以这一档必须分出来。
   */
  siteSource: "frontmatter" | "rule" | "default" | "single" | "picked";
  sitePattern?: string;
  title: string;
  slug: string;
  raw: string;
  /** 最终生效的 spec（`applyPostFrontmatter` + 服务端回读之后）—— 只取其中 6 个字段 */
  spec: Record<string, unknown>;
  newCategories: string[];
  newTags: string[];
  images: LocalImageSummary;
}

export interface PublishPreview {
  site: { name: string; url: string; source: PublishPreviewInput["siteSource"]; pattern?: string };
  title: string;
  slug: string;
  visible: string;
  pinned: boolean;
  priority: number;
  publishTime: string;
  allowComment: boolean;
  template: string;
  /** frontmatter **之后**那部分的字符数 */
  characterCount: number;
  newCategories: string[];
  newTags: string[];
  images: LocalImageSummary;
}

/**
 * 把「即将发布什么」摊平成一块可以在弹窗里逐行渲染的数据。
 *
 * 抽成纯函数是因为**弹窗本身没有测试脚手架**（`tests/setup.ts` 里的 `Modal` 是空壳，
 * 本阶段不新建 UI mock 基建）。凡是能在弹窗外面算出来的东西都算出来，
 * 弹窗里就只剩 `createEl` —— 那部分出错的风险靠 CR 覆盖即可。
 */
export function buildPublishPreview(input: PublishPreviewInput): PublishPreview {
  const spec = input.spec;

  return {
    site: {
      name: input.siteName,
      url: input.siteUrl,
      source: input.siteSource,
      pattern: input.sitePattern,
    },
    title: input.title,
    slug: input.slug,
    visible: String(spec.visible ?? ""),
    pinned: spec.pinned === true,
    priority: typeof spec.priority === "number" ? spec.priority : 0,
    publishTime: String(spec.publishTime ?? ""),
    allowComment: spec.allowComment !== false,
    template: String(spec.template ?? ""),
    // 按 `raw` 算，不按含 frontmatter 的全文算：否则这个数字会随无关的配置项抖动
    characterCount: input.raw.length,
    newCategories: input.newCategories,
    newTags: input.newTags,
    images: input.images,
  };
}
```

- [ ]  **Step 4：跑测试确认全绿**

```bash
pnpm test tests/publish-preview.test.ts
```

- [ ]  **Step 5：给 `image-upload.ts` 加只读概览**

在 `src/service/image-upload.ts` 里**定义**这个类型（它是产出方，另外两个模块只 `import type`）：

```ts
/**
 * 图片概览。三个数字刻意分开：
 * - `pending` 是**真的会发请求**的张数（用户能据此预估这次发布要多久）；
 * - `cached` 是命中缓存的张数（不发请求，但仍会被替换链接）；
 * - `overLimit` 是超过 7 MiB、必须走 REST + PAT 的那几张的**文件名**。
 *
 * 给文件名而不是只给数字：这正是缺 PAT 时唯一会失败的几张，而用户此刻能做的动作
 * （压缩这几张，或去补一个 PAT）取决于**是哪几张**。
 */
export interface LocalImageSummary {
  pending: number;
  cached: number;
  overLimit: string[];
}
```

再加扫描函数：

```ts
/**
 * 统计一篇笔记里的本地图片，**不发出任何请求**。
 *
 * 预览要在用户点确认之前告诉他"这次要传几张、有没有超限"，而 `uploadImages` 是
 * 边扫边传的。这个函数只做扫描 + 缓存查表 + 体积判断。
 *
 * 按 `file.path` 去重：同一张图在一篇笔记里被引用两次时上传只发生一次
 * （`uploadImages` 里的 `uploadedPermalinks` 就是干这个的），概览必须与它口径一致 ——
 * 否则预览说"要传 5 张"而实际只传 3 次，用户会以为有一张没传上去。
 */
export async function summarizeLocalImages(file: TFile, ctx: ImageUploadContext): Promise<LocalImageSummary> {
  const md = await ctx.app.vault.read(file);
  const references = collectLocalImageReferences(md, file, ctx.app);
  const seen = new Set<string>();
  const overLimit: string[] = [];
  let pending = 0;
  let cached = 0;

  for (const reference of references) {
    if (seen.has(reference.file.path)) {
      continue;
    }

    seen.add(reference.file.path);

    if (getCachedImagePermalink(reference.file, ctx)) {
      cached++;
      continue;
    }

    pending++;

    if (reference.file.stat.size > MCP_UPLOAD_MAX_BYTES) {
      overLimit.push(reference.file.name);
    }
  }

  return { pending, cached, overLimit };
}
```

`publish-preview.ts` 与 `batch-publish.ts` 各加一行
`import type { LocalImageSummary } from "./service/image-upload";`。

再给 `HaloService` 加一层薄封装（**不要**把 `imageUploadContext()` 从 private 开成 public ——
那为了省一行封装会暴露出整个上传模块的运行上下文）：

```ts
  /** 只读的图片概览，供发布预览与批量确认使用（不发出任何请求） */
  public async summarizeImages(file: TFile): Promise<LocalImageSummary> {
    return summarizeLocalImages(file, this.imageUploadContext());
  }
```

- [ ]  **Step 6：把 `publishPost` 拆成 `planPublish` / `executePublish`**

本步是**纯重构，行为必须不变**（Task 7 的测试就是判据）。拆的动机：预览必须在
**任何写操作之前**拿到最终取值，而 `publishPost` 把「读远端 → 套 frontmatter → 写」
串在了一个重试闭包里。

`src/service/index.ts`：

```ts
export interface PublishPlan {
  /** 走更新分支时的远端文章名；为空表示这次是新建 */
  remoteName?: string;
  /** `applyPostFrontmatter` 之后的最终 spec */
  post: Post;
  raw: string;
  markdown: string;
  /** frontmatter 里写着的分类/标签显示名（还没解析资源名） */
  desiredCategories?: string[];
  desiredTags?: string[];
  /** 站点上**还不存在**的那些显示名 —— 预览里的「将新建」就是它 */
  newCategories: string[];
  newTags: string[];
  images: LocalImageSummary;
  /** frontmatter 里的 publish: true/false/没写（`undefined`） */
  publishFromFrontmatter?: boolean;
}
```

```ts
  /**
   * 发布前的规划：读远端、套 frontmatter、算图片概览、算出「将新建」的分类标签。
   *
   * **不写任何东西**（不建分类、不改笔记、不碰站点）。这是预览能成立的前提 ——
   * 用户在弹窗里点「取消」时，站点与本地都必须与打开弹窗之前一模一样。
   *
   * 与 `getCategoryNames` 的分工：那个负责**建**，这个只负责**算出要建哪些**。
   * 分类/标签的列表在两处各取一次（`halo_list_categories` 是只读的，代价可接受），
   * 换来的是「规划」与「执行」各自独立可测。
   */
  public async planPublish(file: TFile): Promise<{ ok: true; plan: PublishPlan } | { ok: false; reason: string }>
```

```ts
  /**
   * 按规划执行：建分类标签 → 建/更新文章 → 设定发布状态 → 回读 → 回写笔记。
   *
   * `options.markdown` 是**上传图片之后**的正文（本地图片链接已被换成远程地址）。
   * 发布流程必须在它之后才执行，所以规划时算出的 `plan.markdown` 会过时；
   * 给了 `markdown` 就用它，没给才回落 `plan.markdown`。
   */
  public async executePublish(
    file: TFile,
    plan: PublishPlan,
    options: { markdown?: string; publishOverride?: boolean; quiet?: boolean } = {},
  ): Promise<PublishResult>
```

拆分的具体做法：把现有 `publishPost` 的方法体按下面切一刀 ——

- 切点之前的（读文件、套 frontmatter、解析分类标签的**期望值**、算图片）搬进 `planPublish`；
- 切点之后的（`withPublishRetry` 闭包、回读、回写、返回值）搬进 `executePublish`，
  它接收 `plan` 而不是自己再读一遍文件。

**顺序上有一条必须原样保留**：预览发生在**上传图片之前**，而 `uploadImages` 会改写本地笔记
（把图片链接换成远程地址）。反过来先上传再预览的话，用户在预览里点「取消」时，
笔记已经被改过了 —— 一次「什么都没发生」的取消，实际改动了 118 个文件里的图片链接。

`planPublish` 里分类/标签的处理**必须改成只列不建**：

```ts
    // 只列不建：预览要在**写之前**告诉用户"将新建这 3 个标签"，而 `getCategoryNames`
    // 会真的把它们建到站点上。用户点取消后站点上多出 3 个空标签，是这次改造最容易漏的一处。
    const existingCategories = matterData?.categories ? await this.getCategories() : [];
    const existingTags = matterData?.tags ? await this.getTags() : [];
```

`plan.newCategories` / `plan.newTags` 用 `pickNewTerms` 算。**它定义在本任务**，
放在 `src/service/post-mapping.ts` —— 与它的邻居 `generateResourceName`（"从显示名到资源"的
同一族）放一起，而且 Task 9 的批量模块本来就已经从那个文件 import 类型，
单一实现的依赖方向天然成立：

```ts
/**
 * 从「期望的显示名」里挑出站点上还没有的那些。
 *
 * 判等用 `displayName` 精确匹配，**与 `getCategoryNames()` / `getTagNames()` 创建时的判等
 * 必须是同一套**：两处判等一分叉，就会出现「预览说将新建、执行时又不建」或反过来，
 * 而用户在预览里刚为它做过决定。所以这一份实现同时服务预览、执行路径与批量确认。
 *
 * 刻意**不去重**：它是个过滤器，去重是调用方对"并集"的处置（批量路径要先去重再传进来）。
 * 在过滤器里偷偷去重会让调用方失去对顺序与重复的控制。
 */
export function pickNewTerms(desired: string[] | undefined, existing: { displayName: string }[]): string[] {
  if (!desired) {
    return [];
  }

  return desired.filter((name) => !existing.some((item) => item.displayName === name));
}
```

`executePublish` 继续用 `getCategoryNames()` / `getTagNames()`（会真的创建），
`plan.desiredCategories` 作为入参。

追加到 `tests/service/post-mapping.test.ts`：

```ts
import { pickNewTerms } from "src/service/post-mapping";

describe("pickNewTerms", () => {
  it("挑出站点上还没有的显示名（按 displayName 精确匹配）", () => {
    expect(pickNewTerms(["技术", "随笔"], [{ displayName: "技术" }])).toEqual(["随笔"]);
  });

  it("入参缺席时给空数组，不把「没写分类」变成「要建空分类」", () => {
    expect(pickNewTerms(undefined, [])).toEqual([]);
  });

  it("大小写不同算不同的显示名（与创建时的 `===` 判等同一套）", () => {
    expect(pickNewTerms(["halo"], [{ displayName: "Halo" }])).toEqual(["halo"]);
  });

  it("保持入参顺序、不去重（去重是调用方对「并集」的处置）", () => {
    expect(pickNewTerms(["X", "X"], [])).toEqual(["X", "X"]);
  });
});
```

> **`publishPost` 保留为薄封装**（`planPublish` + `executePublish`），让 Task 7 建立的
> 调用面与全部既有测试继续有效：
>
> ```ts
>   /** 单篇发布的便捷入口：规划 + 执行。命令层刻意不用它 —— 它要拿到 `plan` 才能预览 */
>   public async publishPost(
>     file: TFile,
>     options: { markdown?: string; publishOverride?: boolean; quiet?: boolean } = {},
>   ): Promise<PublishResult> {
>     const planned = await this.planPublish(file);
>     return planned.ok ? this.executePublish(file, planned.plan, options) : { ok: false, reason: planned.reason };
>   }
> ```

- [ ]  **Step 7：跑全套确认重构没改行为**

```bash
pnpm test
```

预期：全绿，**一条断言都不改**。若有失败 → 是拆分切错了位置，不要动测试。

- [ ]  **Step 8：加两条「规划阶段零写入」的判别器**

追加到 `tests/service/index.test.ts`：

```ts
  test("planPublish 不建分类标签，也不调任何写工具", async () => {
    // 判别器：把 `getCategories()`（只列）换回 `getCategoryNames()`（会建）就会红。
    // 这条是预览能成立的全部依据：用户在弹窗里点「取消」之后，站点上不能多出任何东西。
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    const { client, calls } = fakeService();
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", categories: ["还没有的分类"] },
    }));

    const result = await new HaloService(app, createSettings(), site, client).planPublish(note);

    expect(result.ok).toBe(true);
    expect((result as { plan: PublishPlan }).plan.newCategories).toEqual(["还没有的分类"]);
    expect(calls.filter((call) => call.name.startsWith("halo_create_"))).toEqual([]);
    expect(calls.filter((call) => call.method === "callToolVoid")).toEqual([]);
  });

  test("planPublish 失败时不抛，把原因放进 reason", async () => {
    // 预览路径的调用方是命令回调。异常穿到 Obsidian 只会进控制台 ——
    // 用户点了「发布」，什么都没发生，也没有任何提示。
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    const { client } = fakeService({
      itemFor: () => {
        throw new McpError("network", {});
      },
    });
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { name: "post-1" } },
    }));

    const result = await new HaloService(app, createSettings(), site, client).planPublish(note);

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBeTruthy();
  });
```

- [ ]  **Step 9：写预览弹窗**

新建 `src/publish-preview-modal.ts`：

```ts
import i18next from "i18next";
import { Modal, Setting } from "obsidian";
import type HaloPlugin from "./main";
import type { PublishPreview } from "./publish-preview";

/** 打开预览并等用户决定。**取消返回 `false`**，调用方据此直接结束，不写任何东西 */
export function confirmPublishPreview(plugin: HaloPlugin, preview: PublishPreview): Promise<boolean> {
  return new Promise((resolve) => {
    new PublishPreviewModal(plugin, preview, resolve).open();
  });
}

class PublishPreviewModal extends Modal {
  constructor(
    private readonly plugin: HaloPlugin,
    private readonly preview: PublishPreview,
    private readonly onDecide: (confirmed: boolean) => void,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const preview = this.preview;

    contentEl.createEl("h2", { text: i18next.t("publish_preview.title") });

    const row = (name: string, value: string): void => {
      new Setting(contentEl).setName(name).setDesc(value);
    };

    // 站点来源要说清是**哪一条规则**命中的：命错站点是没法从结果里反查的
    // （两边都会显示"发布成功"），只有在预览这一处还能看见。
    const siteSource =
      preview.site.source === "rule"
        ? i18next.t("publish_preview.site_from_rule", { pattern: preview.site.pattern })
        : i18next.t(`publish_preview.site_from_${preview.site.source}`);

    row(i18next.t("publish_preview.row_site"), `${preview.site.name}（${preview.site.url}）${siteSource}`);
    row(i18next.t("publish_preview.row_title"), preview.title);
    row(i18next.t("publish_preview.row_slug"), preview.slug || i18next.t("publish_preview.value_auto"));
    row(i18next.t("publish_preview.row_characters"), String(preview.characterCount));

    // 这一块是本阶段新增能力在界面上的落点：用户在这里第一次能看见这些值。
    row(i18next.t("publish_preview.row_visible"), preview.visible);
    row(i18next.t("publish_preview.row_pinned"), preview.pinned ? i18next.t("publish_preview.value_yes") : i18next.t("publish_preview.value_no"));
    row(i18next.t("publish_preview.row_priority"), String(preview.priority));
    row(
      i18next.t("publish_preview.row_publish_time"),
      preview.publishTime || i18next.t("publish_preview.value_immediate"),
    );
    row(i18next.t("publish_preview.row_allow_comment"), preview.allowComment ? i18next.t("publish_preview.value_yes") : i18next.t("publish_preview.value_no"));
    row(i18next.t("publish_preview.row_template"), preview.template || i18next.t("publish_preview.value_none"));

    if (preview.newCategories.length > 0) {
      row(i18next.t("publish_preview.row_new_categories"), preview.newCategories.join("、"));
    }

    if (preview.newTags.length > 0) {
      row(i18next.t("publish_preview.row_new_tags"), preview.newTags.join("、"));
    }

    row(
      i18next.t("publish_preview.row_images"),
      i18next.t("publish_preview.value_images", { pending: preview.images.pending, cached: preview.images.cached }),
    );

    if (preview.images.overLimit.length > 0) {
      // 超限的那几张是唯一需要 PAT 的，也是缺 PAT 时唯一会失败的 —— 点名它们，
      // 用户此刻能做的动作（压缩这几张 / 去补一个 PAT）取决于**是哪几张**。
      row(i18next.t("publish_preview.row_images_over_limit"), preview.images.overLimit.join("、"));
    }

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(i18next.t("common.button_cancel")).onClick(() => {
          this.onDecide(false);
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText(i18next.t("publish_preview.button_confirm"))
          .setCta()
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

- [ ]  **Step 10：接线到命令 + 设置开关**

`src/settings.ts` 的 `HaloSettingTab.display()` 里加开关：

```ts
    new Setting(containerEl)
      .setName(i18next.t("settings.skipPreviewOnPublish.name"))
      .setDesc(i18next.t("settings.skipPreviewOnPublish.description"))
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.skipPreviewOnPublish).onChange((value) => {
          this.plugin.settings.skipPreviewOnPublish = value;
          this.plugin.saveSettings();
        });
      });
```

`src/main.ts` 抽一个共用的发布入口，让 ribbon / 两个发布命令都走它：

```ts
  /**
   * 单篇发布的完整流程：解析站点 → 规划 → 预览 → 确认 → 上传图片 → 执行。
   *
   * 预览发生在**规划之后、任何写操作之前**。`uploadImages` 也会改笔记（替换图片链接），
   * 所以它必须排在确认之后 —— 否则用户点了「取消」，笔记里的图片链接已经被换掉了。
   */
  private async publishFile(file: TFile): Promise<void> {
    const resolution = this.resolveSiteFor(file);

    if (resolution.kind === "resolved") {
      await this.publishToResolvedSite(file, resolution);
      return;
    }

    // 其余四档（no-sites / unknown-site / unknown-rule-site / needs-choice）的处置都在
    // `siteForResolution` 里：该报错的报错，该弹窗的弹窗。返回 undefined 就是「这次算了」。
    const site = await this.siteForResolution(resolution);

    if (!site) {
      return;
    }

    // 这一档是用户在弹窗里手选的，`resolveSite` 并不知道 —— 预览上要如实标成「你选的」，
    // 而不是套用「唯一站点」或「默认站点」的说法（那会让人以为自己的配置变了）。
    await this.publishToResolvedSite(file, { site, source: "picked" });
  }

  /** 站点已经定下来之后的发布流程。签名刻意只接受「已解析」这一档，省掉调用方的判空 */
  private async publishToResolvedSite(
    file: TFile,
    resolved: { site: HaloSite; source: PublishPreviewInput["siteSource"]; pattern?: string },
  ): Promise<void> {
    const service = new HaloService(this.app, this.settings, resolved.site);
    const planned = await service.planPublish(file);

    if (!planned.ok) {
      new Notice(planned.reason);
      return;
    }

    if (!this.settings.skipPreviewOnPublish) {
      const preview = buildPublishPreview({
        siteName: resolved.site.name || resolved.site.url,
        siteUrl: resolved.site.url,
        siteSource: resolved.source,
        sitePattern: resolved.pattern,
        title: planned.plan.post.spec.title,
        slug: planned.plan.post.spec.slug,
        raw: planned.plan.raw,
        spec: planned.plan.post.spec as unknown as Record<string, unknown>,
        newCategories: planned.plan.newCategories,
        newTags: planned.plan.newTags,
        images: planned.plan.images,
      });

      if (!(await confirmPublishPreview(this, preview))) {
        return;
      }
    }

    const uploadResult = await this.uploadImagesForPublish(service, file);

    if (!uploadResult.success) {
      return;
    }

    // 单篇路径不传 quiet，`executePublish` 自己会弹成功便签，这里不重复播报。
    // 失败的原因也已经由它弹过 —— 拿返回值只是为了让「不弹便签」这件事有据可依。
    await service.executePublish(file, planned.plan, { markdown: uploadResult.markdown });
  }
```

`publishCommand` / `publish-with-defaults` 的转发命令体缩成一行
`await this.publishFile(activeEditor.file);`（`publish-with-defaults` 走下面那条）——

但 `publish-with-defaults` **不能**走 `resolveSiteFor`，它要的是默认站点。给它单独一条：

```ts
  private async publishToDefaultSite(file: TFile): Promise<void> {
    const site = this.settings.sites.find((item) => item.default);

    if (!site) {
      new Notice(i18next.t("command.publish_with_defaults.error_no_default_site"));
      return;
    }

    if (!this.canPublishToSite(site)) {
      return;
    }

    await this.publishToResolvedSite(file, { site, source: "default" });
  }
```

`src/main.ts` 顶部 import 补两条：

```ts
import { type PublishPreviewInput, buildPublishPreview } from "./publish-preview";
import { confirmPublishPreview } from "./publish-preview-modal";
```

- [ ]  **Step 11：加三语文案**

`zh-cn.json` 加：

```json
  "publish_preview": {
    "title": "发布预览",
    "button_confirm": "发布",
    "row_site": "目标站点",
    "site_from_frontmatter": "（来自笔记的 halo.site）",
    "site_from_rule": "（来自路由规则「{{pattern}}」）",
    "site_from_default": "（来自默认站点设置）",
    "site_from_single": "（唯一已配置的站点）",
    "site_from_picked": "（你在弹窗里选的）",
    "row_title": "标题",
    "row_slug": "Slug",
    "row_characters": "正文字符数",
    "row_visible": "可见性",
    "row_pinned": "置顶",
    "row_priority": "排序权重",
    "row_publish_time": "定时发布",
    "row_allow_comment": "允许评论",
    "row_template": "渲染模板",
    "row_new_categories": "将新建的分类",
    "row_new_tags": "将新建的标签",
    "row_images": "图片",
    "row_images_over_limit": "超过 7 MiB（需要 PAT）",
    "value_auto": "（由服务端生成）",
    "value_immediate": "立即发布",
    "value_none": "（无）",
    "value_yes": "是",
    "value_no": "否",
    "value_images": "待上传 {{pending}} 张，缓存命中 {{cached}} 张"
  },
```

`settings` 下加：

```json
    "skipPreviewOnPublish": {
      "name": "发布时跳过预览",
      "description": "勾选后，发布命令不再弹出预览确认框，直接执行。"
    },
```

`en.json` / `zh-tw.json` 逐键对应。

- [ ]  **Step 12：核对三语键数 + 跑全套 + 构建 + 提交**

```bash
node -e "
const fs=require('fs');
const keys=(o,p='')=>Object.entries(o).flatMap(([k,v])=>typeof v==='object'&&v!==null?keys(v,p+k+'.'):[p+k]);
const sets=['en','zh-cn','zh-tw'].map(l=>new Set(keys(JSON.parse(fs.readFileSync('src/i18n/locales/'+l+'.json','utf8')))));
console.log('键数:', sets.map(s=>s.size).join(' / '));
for (const a of sets) for (const b of sets) { const d=[...a].filter(k=>!b.has(k)); if (d.length) console.log('差集:', d); }
" && pnpm test && pnpm build
git add src/publish-preview.ts src/publish-preview-modal.ts src/service/index.ts \
        src/service/image-upload.ts src/service/post-mapping.ts src/main.ts src/settings.ts \
        src/i18n/locales/en.json src/i18n/locales/zh-cn.json src/i18n/locales/zh-tw.json \
        tests/publish-preview.test.ts tests/service/index.test.ts
git commit -m "feat(publish): 发布前预览；publishPost 拆成 plan/execute（规划阶段零写入）"
```

---

## Task 9：批量 —— 候选筛选与聚合确认

**Files:**

- Create: `src/batch-publish.ts`（纯逻辑）
- Create: `src/batch-confirm-modal.ts`（确认弹窗）
- Test: `tests/batch-publish.test.ts`（新建）

> `src/main.ts` 的三个批量命令在 **Task 10** 接线 —— 那时 `runBatch` 才存在。
> 本任务只产出可被单测的库与一个弹窗，**不碰 `main.ts`**（否则本任务的产物编译不过）。

**Interfaces:**

- Consumes: `resolveSite` / `SiteResolution`（Task 4）、`LocalImageSummary`（Task 8）、`pickNewTerms` / `McpCategoryItem` / `McpTagItem`（`service/post-mapping.ts`，Task 8 定义）
- Produces:
  - `type BatchAction = "draft" | "publish" | "unpublish"`
  - `interface BatchSkip { path: string; key: string; params?: Record<string, unknown> }`
  - `interface BatchCandidate { file: TFile; resolution: SiteResolution; remoteName?: string; categories: string[]; tags: string[] }`
  - `interface BatchItem extends BatchCandidate { images: LocalImageSummary }`
  - `interface BatchGroup { site: HaloSite; items: BatchItem[]; taxonomy: { categories: McpCategoryItem[]; tags: McpTagItem[] } }`
  - `interface BatchPlan { action: BatchAction; groups: BatchGroup[]; skipped: BatchSkip[] }`
  - `collectBatchCandidates(files, app, settings, action): { candidates: BatchCandidate[]; skipped: BatchSkip[] }`
  - `planBatch(candidates, skipped, action, deps): Promise<BatchPlan>`
  - `interface BatchSelectionSummary { total: number; groups: { site: HaloSite; count: number; newCategories: string[]; newTags: string[]; images: LocalImageSummary }[] }`
  - `summarizeSelection(plan, selected: Set<string>): BatchSelectionSummary`
  - `confirmBatchPlan(plugin, plan): Promise<Set<string> | undefined>`（`batch-confirm-modal.ts`；返回勾选的路径集合，取消返回 `undefined`）

---

- [ ]  **Step 1：写失败测试**

新建 `tests/batch-publish.test.ts`。三个筛选/计划函数都是纯的或只依赖注入的，
不需要 UI 脚手架：

```ts
import { describe, expect, it } from "@rstest/core";
import type { App, TFile } from "obsidian";
import { type BatchCandidate, collectBatchCandidates, planBatch, summarizeSelection } from "src/batch-publish";
import type { SiteRoutingRule } from "src/site-routing";
import type { HaloSetting, HaloSite } from "src/settings";

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
```

> `pickNewTerms` 的单测写在 **`tests/service/post-mapping.test.ts`**（它的定义在
> `src/service/post-mapping.ts`），与本文件分开 —— 按 `src/` 结构镜像测试是既有约定。

再写 `collectBatchCandidates` 的筛选语义 —— **这一组是本任务的核心**：

```ts
describe("collectBatchCandidates", () => {
  function makeSettings(rules: SiteRoutingRule[]): HaloSetting {
    return {
      settingsVersion: 1,
      sites: [siteA, siteB],
      publishByDefault: false,
      skipPreviewOnPublish: false,
      siteRouting: rules,
      replaceImageLinks: true,
      imageUploadCache: {},
    };
  }

  it("规则命中的笔记归到对应站点（end-to-end 走 resolveSite）", () => {
    const { candidates } = collectBatchCandidates(
      [fileAt("博客/技术/a.md"), fileAt("日记/b.md")],
      appWith({ "博客/技术/a.md": { title: "A" }, "日记/b.md": { title: "B" } }),
      makeSettings([{ pattern: "博客/**", site: siteB.url }]),
      "draft",
    );

    expect(candidates.map((item) => [item.file.path, (item.resolution as { site: HaloSite }).site.url])).toEqual([
      ["博客/技术/a.md", siteB.url],
      ["日记/b.md", siteA.url],
    ]);
  });

  it("解析不出站点的笔记进 skipped，带上**具体原因**而不是一句「失败」", () => {
    const { candidates, skipped } = collectBatchCandidates(
      [fileAt("a.md")],
      appWith({ "a.md": { title: "A", halo: { site: "https://gone.example.com" } } }),
      makeSettings([]),
      "draft",
    );

    expect(candidates).toEqual([]);
    expect(skipped).toEqual([{ path: "a.md", key: "batch.skip_unknown_site", params: { url: "https://gone.example.com" } }]);
  });

  it("撤回只收已经有 halo.name 的笔记（没有就没什么可撤回的）", () => {
    const { candidates, skipped } = collectBatchCandidates(
      [fileAt("a.md"), fileAt("b.md")],
      appWith({ "a.md": { title: "A", halo: { name: "post-1" } }, "b.md": { title: "B" } }),
      makeSettings([]),
      "unpublish",
    );

    expect(candidates.map((item) => item.file.path)).toEqual(["a.md"]);
    expect(skipped).toEqual([{ path: "b.md", key: "batch.skip_not_published" }]);
  });

  it("推草稿 / 发布**不**要求 halo.name（没有就是新建）", () => {
    const { candidates } = collectBatchCandidates(
      [fileAt("b.md")],
      appWith({ "b.md": { title: "B" } }),
      makeSettings([]),
      "publish",
    );

    expect(candidates).toHaveLength(1);
  });
});
```

`planBatch` 的测试用注入的假依赖：

```ts
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
        item.file.path === "a.md" ? { pending: 1, cached: 0, overLimit: ["big.png"] } : { pending: 2, cached: 1, overLimit: [] },
    });

    expect(plan.groups[0].items.map((item) => item.images.pending)).toEqual([1, 2]);
  });

  it("跨站点的候选分成多组，组内保持候选顺序", async () => {
    const plan = await planBatch([candidate("a.md", siteA), candidate("b.md", siteB), candidate("c.md", siteA)], [], "draft", {
      listTaxonomy: noTaxonomy,
      summarizeImages: noImages,
    });

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
    const plan = await planBatch(
      [{ file: fileAt("a.md"), resolution: { kind: "needs-choice" }, categories: [], tags: [] }],
      [],
      "draft",
      { listTaxonomy: noTaxonomy, summarizeImages: noImages },
    );

    expect(plan.groups).toEqual([]);
  });
});

describe("summarizeSelection", () => {
  /** 两篇在 A 站（都打 Halo 标签）、一篇在 B 站，A 站已有「技术」分类 */
  async function threeItemPlan(): Promise<BatchPlan> {
    return planBatch(
      [candidate("a.md", siteA, ["技术"], ["Halo"]), candidate("b.md", siteA, ["随笔"], ["Halo"]), candidate("c.md", siteB)],
      [],
      "draft",
      {
        listTaxonomy: async (site) =>
          site.url === siteA.url ? { categories: [{ name: "c1", displayName: "技术" }], tags: [] } : { categories: [], tags: [] },
        summarizeImages: async (item) =>
          item.file.path === "a.md" ? { pending: 3, cached: 1, overLimit: ["big.png"] } : { pending: 1, cached: 0, overLimit: [] },
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
  });

  it("把某一篇取消勾选后，它独占的「将新建」跟着消失", async () => {
    const plan = await threeItemPlan();
    const summary = summarizeSelection(plan, new Set(["a.md"]));

    expect(summary.groups[0].newCategories).toEqual([]); // 技术已存在，随笔的那篇被取消了
    expect(summary.groups[0].newTags).toEqual(["Halo"]);
  });

  it("图片概览按勾选的笔记累加，超限文件名去重", async () => {
    const plan = await threeItemPlan();
    const all = summarizeSelection(plan, new Set(["a.md", "b.md"]));

    expect(all.groups[0].images).toEqual({ pending: 4, cached: 1, overLimit: ["big.png"] });
  });

  it("勾选集合里混进不存在的路径时忽略它，不抛错", async () => {
    const plan = await threeItemPlan();
    const summary = summarizeSelection(plan, new Set(["不存在.md"]));

    expect(summary.total).toBe(0);
    expect(summary.groups).toEqual([]);
  });

  it("没有任何勾选时给空汇总（弹窗据此禁用确认按钮）", async () => {
    const plan = await threeItemPlan();
    const summary = summarizeSelection(plan, new Set());

    expect(summary).toEqual({ total: 0, groups: [] });
  });
});
```

- [ ]  **Step 2：跑测试确认失败**

```bash
pnpm test tests/batch-publish.test.ts
```

- [ ]  **Step 3：实现 `src/batch-publish.ts`**

```ts
import type { App, TFile } from "obsidian";
import type { SiteResolution } from "./site-routing";
import { resolveSite } from "./site-routing";
import type { LocalImageSummary } from "./publish-preview";
import { type McpCategoryItem, type McpTagItem, pickNewTerms } from "./service/post-mapping";
import type { HaloPostFrontmatter } from "./service/local-content";
import type { HaloSetting, HaloSite } from "./settings";

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
  /** `halo.name`。有它才是「已发布过」，撤回也才有对象 */
  remoteName?: string;
  /** frontmatter 里写着的分类/标签**显示名**（还没解析成资源名） */
  categories: string[];
  tags: string[];
}

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

    const remoteName = matterData?.halo?.name;

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
    (candidate): candidate is BatchCandidate & { resolution: { kind: "resolved"; site: HaloSite } } =>
      candidate.resolution.kind === "resolved",
  );

  // 先按站点分桶，再逐桶干活。**分桶必须在最前面**：分类标签要按站点整桶取一次，
  // 边遍历边取会让"这个站点的候选还没遍历完"变成一道需要额外小心才能维持的不变式。
  const buckets = new Map<string, BatchCandidate[]>();

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
    const site = (bucket[0].resolution as { site: HaloSite }).site;
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
```

- [ ]  **Step 4：跑测试确认全绿**

```bash
pnpm test tests/batch-publish.test.ts
```

- [ ]  **Step 5：写确认弹窗**

新建 `src/batch-confirm-modal.ts`：

```ts
import i18next from "i18next";
import { Modal, Setting } from "obsidian";
import type { BatchPlan } from "./batch-publish";
import type HaloPlugin from "./main";

/**
 * 一次聚合确认。**返回勾选的路径集合；取消返回 `undefined`**，调用方据此直接结束，不写任何东西。
 *
 * 为什么是「返回集合」而不是「返回 true/false」：清单里每一篇都带一个勾选框，默认全勾。
 * 「批量发布」这个按钮听起来就像"把该发的都发了"，而**全库有 118 篇笔记** ——
 * 一个不接受任何勾选、默认对全部文件生效的批量命令，用户点下去之后才会发现自己
 * 把阅读笔记和日记也一起发到了博客上。默认全勾让"什么都不选"仍然是最省事的路径，
 * 而勾选框让"我只想发这几篇"有一个表达的地方。
 */
export function confirmBatchPlan(plugin: HaloPlugin, plan: BatchPlan): Promise<Set<string> | undefined> {
  return new Promise((resolve) => {
    new BatchConfirmModal(plugin, plan, resolve).open();
  });
}

class BatchConfirmModal extends Modal {
  /** 当前勾选的路径。初始全勾 —— 见 `confirmBatchPlan` 的说明 */
  private readonly selected = new Set<string>();

  /** 汇总一块独立的容器：勾选变化时只重画它，不重画上面那 118 行 */
  private summaryEl?: HTMLElement;
  private confirmButton?: ButtonComponent;

  constructor(
    private readonly plugin: HaloPlugin,
    private readonly plan: BatchPlan,
    private readonly onDecide: (selected: Set<string> | undefined) => void,
  ) {
    super(plugin.app);

    for (const group of plan.groups) {
      for (const item of group.items) {
        this.selected.add(item.file.path);
      }
    }
  }

  onOpen(): void {
    this.renderContent();
  }

  /**
   * 整块重画。
   *
   * 只在**整组全选/全不选**时走这条路：那些勾选框的状态被程序改了，
   * 不重画它们不会自己更新。逐条勾选走 `renderSummary`（只动汇总），
   * 否则用户每勾一个就会丢掉滚动位置。
   *
   * `selected` 集合**不重建** —— 重画的是界面，状态一直在 `this.selected` 里。
   */
  private renderContent(): void {
    const { contentEl } = this;

    contentEl.empty();
    this.summaryEl = undefined;
    this.confirmButton = undefined;

    contentEl.createEl("h2", { text: i18next.t(`batch.title_${this.plan.action}`) });

    for (const group of this.plan.groups) {
      const header = new Setting(contentEl).setName(`${group.site.name || group.site.url}（${group.items.length}）`);

      // 整组全选/全不选：118 篇一条条点太费事，而"我只想发这个站"是最常见的取舍
      header.addButton((button) =>
        button.setButtonText(i18next.t("batch.button_select_all")).onClick(() => {
          this.selectGroup(group, true);
        }),
      );
      header.addButton((button) =>
        button.setButtonText(i18next.t("batch.button_select_none")).onClick(() => {
          this.selectGroup(group, false);
        }),
      );

      for (const item of group.items) {
        new Setting(contentEl).setName(item.file.path).addToggle((toggle) => {
          toggle.setValue(this.selected.has(item.file.path)).onChange((value) => {
            if (value) {
              this.selected.add(item.file.path);
            } else {
              this.selected.delete(item.file.path);
            }

            this.renderSummary();
          });
        });
      }
    }

    if (this.plan.skipped.length > 0) {
      contentEl.createEl("h3", { text: i18next.t("batch.skipped_title", { count: this.plan.skipped.length }) });

      for (const skip of this.plan.skipped) {
        contentEl.createEl("div", { text: `${skip.path} —— ${i18next.t(skip.key, skip.params)}` });
      }
    }

    this.summaryEl = contentEl.createDiv();

    // 这条提示必须在确认**之前**出现：`uploadImages` 会真的改写笔记里的图片链接。
    // 「批量发布」听起来像是只动远端，实际会改一批本地文件。
    if (this.plugin.settings.replaceImageLinks) {
      new Setting(contentEl)
        .setName(i18next.t("batch.notice_rewrites_notes"))
        .setDesc(i18next.t("batch.notice_rewrites_notes_desc"));
    }

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(i18next.t("common.button_cancel")).onClick(() => {
          this.onDecide(undefined);
          this.close();
        }),
      )
      .addButton((button) => {
        this.confirmButton = button.setButtonText(i18next.t("batch.button_confirm")).setCta();
        button.onClick(() => {
          this.onDecide(new Set(this.selected));
          this.close();
        });
      });

    this.renderSummary();
  }

  private selectGroup(group: BatchGroup, selected: boolean): void {
    for (const item of group.items) {
      if (selected) {
        this.selected.add(item.file.path);
      } else {
        this.selected.delete(item.file.path);
      }
    }

    this.renderContent();
  }

  /** 重画汇总。**只动 `summaryEl`**，让勾选框与滚动位置保持原样 */
  private renderSummary(): void {
    if (!this.summaryEl) {
      return;
    }

    this.summaryEl.empty();

    const summary = summarizeSelection(this.plan, this.selected);

    this.summaryEl.createEl("p", { text: i18next.t("batch.summary_count", { count: summary.total }) });

    for (const group of summary.groups) {
      this.summaryEl.createEl("h3", { text: `${group.site.name || group.site.url}（${group.count}）` });

      if (group.newCategories.length > 0) {
        new Setting(this.summaryEl)
          .setName(i18next.t("batch.row_new_categories"))
          .setDesc(group.newCategories.join("、"));
      }

      if (group.newTags.length > 0) {
        new Setting(this.summaryEl).setName(i18next.t("batch.row_new_tags")).setDesc(group.newTags.join("、"));
      }

      if (group.images.pending > 0 || group.images.overLimit.length > 0) {
        new Setting(this.summaryEl)
          .setName(i18next.t("batch.row_images"))
          .setDesc(i18next.t("batch.value_images", { pending: group.images.pending, cached: group.images.cached }));
      }

      if (group.images.overLimit.length > 0) {
        new Setting(this.summaryEl)
          .setName(i18next.t("batch.row_images_over_limit"))
          .setDesc(group.images.overLimit.join("、"));
      }
    }

    // 一篇都没勾时禁掉确认：允许"确认一个空操作"只会让用户以为自己的取消没生效
    this.confirmButton?.setDisabled(summary.total === 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

> `ButtonComponent` 要从 `obsidian` 一并 import（它是 `addButton` 回调参数的类型）。
> 注意 `renderSummary` 里那句 `this.summaryEl.empty()` 之后**重建**了每个 `Setting` ——
> 这是有意的：Obsidian 的 `Setting` 没有"更新描述"的公开 API，重画是唯一干净的做法，
> 而这块容器里本来就只有几行文字。

- [ ]  **Step 6：加三语文案**

`zh-cn.json` 加 `batch` 命名空间（`title_draft` / `title_publish` / `title_unpublish` /
`summary_count` / `button_confirm` / `button_select_all` / `button_select_none` /
`row_new_categories` / `row_new_tags` / `row_images` / `row_images_over_limit` / `value_images` /
`notice_rewrites_notes` / `notice_rewrites_notes_desc` /
`skipped_title` / `skip_needs_choice` / `skip_no_sites` / `skip_unknown_site` /
`skip_unknown_rule_site` / `skip_not_published` / `error_no_sites` / `error_no_candidates`），
`en.json` / `zh-tw.json` 逐键对应。命令名（`command.batch_draft.name` 等三个）在 Task 10 加 ——
那时才注册命令。

参考文案（`zh-cn`）：

```json
  "batch": {
    "title_draft": "批量推草稿",
    "title_publish": "批量发布",
    "title_unpublish": "批量撤回",
    "summary_count": "将处理 {{count}} 篇",
    "button_confirm": "执行",
    "button_select_all": "全选本组",
    "button_select_none": "全不选本组",
    "row_new_categories": "将新建的分类",
    "row_new_tags": "将新建的标签",
    "row_images": "图片",
    "row_images_over_limit": "超过 7 MiB（需要 PAT）",
    "value_images": "待上传 {{pending}} 张，缓存命中 {{cached}} 张",
    "notice_rewrites_notes": "注意：本地笔记也会被改写",
    "notice_rewrites_notes_desc": "勾选了「替换图片链接」时，执行过程中会把笔记里的本地图片地址换成 Halo 地址。",
    "skipped_title": "已跳过 {{count}} 篇",
    "skip_needs_choice": "有多个站点可用但没有默认站点，也没有规则命中 —— 请到设置里配一条路由规则或指定默认站点。",
    "skip_no_sites": "还没有配置任何站点。",
    "skip_unknown_site": "笔记里写的 halo.site（{{url}}）不在站点列表里。",
    "skip_unknown_rule_site": "路由规则「{{pattern}}」指向的站点（{{url}}）已不在站点列表里。",
    "skip_not_published": "还没有发布到 Halo（没有 halo.name），没有可撤回的文章。",
    "error_no_sites": "请先配置站点。",
    "error_no_candidates": "没有可批量处理的笔记。"
  },
```

- [ ]  **Step 7：核对三语键数 + 跑全套 + 构建 + 提交**

```bash
node -e "
const fs=require('fs');
const keys=(o,p='')=>Object.entries(o).flatMap(([k,v])=>typeof v==='object'&&v!==null?keys(v,p+k+'.'):[p+k]);
const sets=['en','zh-cn','zh-tw'].map(l=>new Set(keys(JSON.parse(fs.readFileSync('src/i18n/locales/'+l+'.json','utf8')))));
console.log('键数:', sets.map(s=>s.size).join(' / '));
for (const a of sets) for (const b of sets) { const d=[...a].filter(k=>!b.has(k)); if (d.length) console.log('差集:', d); }
" && pnpm test && pnpm build
git add src/batch-publish.ts src/batch-confirm-modal.ts src/service/post-mapping.ts \
        src/i18n/locales/en.json src/i18n/locales/zh-cn.json src/i18n/locales/zh-tw.json \
        tests/batch-publish.test.ts tests/service/post-mapping.test.ts
git commit -m "feat(batch): 候选筛选、按站点聚合的计划与一次确认"
```

---

## Task 10：批量执行 —— 跳过失败项继续、末尾汇总

用户 2026-10-03 的裁定：**跳过失败项继续，末尾汇总**。这是对上游「任一图片失败即中止发布」
语义的**刻意偏离**，只用于批量路径；单篇仍保留中止语义。

**Files:**

- Modify: `src/batch-publish.ts`（`runBatch`）
- Modify: `src/batch-confirm-modal.ts`（加汇总弹窗）
- Modify: `src/main.ts`（`runBatch` 接线）
- Test: `tests/batch-publish.test.ts`

**Interfaces:**

- Produces:
  - `interface BatchItemResult { path: string; ok: boolean; reason?: string }`
  - `interface BatchRunSummary { action: BatchAction; results: BatchItemResult[]; successCount: number; failureCount: number; skippedCount: number }`
  - `runBatch(plan, selected: Set<string>, serviceFor): Promise<BatchRunSummary>`
  - `showBatchSummary(plugin, summary): void`

---

- [ ]  **Step 1：写失败测试**

追加到 `tests/batch-publish.test.ts`（同一个文件，复用 Step 1 里的 `fileAt` / `candidate` 辅助）。

**这一组测的是 `runBatch` 的循环语义，不是 MCP 报文** —— 所以全部用假的 `HaloService`。
「撤回到底调了哪个工具」由 `tests/service/index.test.ts` 里 `changePostPublish` 的既有断言覆盖，
在这里再验一遍只会多一份要跟着服务端走的契约。

```ts
import type { SiteRoutingRule } from "src/site-routing";
import { runBatch } from "src/batch-publish";
import HaloService from "src/service";

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
    uploadImages: async () => ({ processedCount: 0, uploadedCount: 0, reusedCount: 0, failedCount: 0, replaced: false }),
    publishPost: async () => ({ ok: true }),
    changePostPublish: async () => undefined,
    ...overrides,
  } as unknown as HaloService;
}

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
        uploadImages: async () => ({ processedCount: 1, uploadedCount: 0, reusedCount: 0, failedCount: 1, replaced: false }),
        publishPost: async (file: { path: string }) => {
          publishedPaths.push(file.path);
          return { ok: true };
        },
      }),
    );

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
});
```

- [ ]  **Step 2：跑测试确认失败**

```bash
pnpm test tests/batch-publish.test.ts
```

- [ ]  **Step 3：实现 `runBatch`**

```ts
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
  /** 解析阶段就被排除的篇数（没站点、没 `halo.name` 等）。汇总里要能说清它们去哪了 */
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
 * `selected` 是确认弹窗里勾选的路径集合。**只跑勾选的** —— 整组都没勾的站点连
 * `serviceFor` 都不会被调用（不白建客户端）。
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

  for (const group of plan.groups) {
    const items = group.items.filter((item) => selected.has(item.file.path));

    if (items.length === 0) {
      continue;
    }

    const service = serviceFor(group.site);

    for (const item of items) {
      try {
        if (plan.action === "unpublish") {
          // 撤回只动发布状态，连正文都不读 —— 没有理由为它去上传图片或回写笔记
          await service.changePostPublish(item.remoteName ?? "", false);
          results.push({ path: item.file.path, ok: true });
          continue;
        }

        // 图片先上传：上传会改写笔记里的图片链接，而 `publishPost` 要用改写后的 markdown。
        // 任一图片失败就跳过这一篇 —— 「有的链接是远程、有的是本地」的半成品不落盘，
        // 与单篇路径的处置一致（上游同款）。
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
          quiet: true,
        });

        results.push(
          published.ok ? { path: item.file.path, ok: true } : { path: item.file.path, ok: false, reason: published.reason },
        );
      } catch (error) {
        // `publishPost` 的契约是「不抛」，但整批的可用性不该押在这条契约上：
        // 一次未捕获的异常会让已经成功的十几篇没有任何汇总，用户以为全军覆没。
        results.push({ path: item.file.path, ok: false, reason: renderErrorMessage(error) });
      }
    }
  }

  return {
    action: plan.action,
    results,
    successCount: results.filter((item) => item.ok).length,
    failureCount: results.filter((item) => !item.ok).length,
    skippedCount: plan.skipped.length,
  };
}
```

> `runBatch` 里用到 `i18next` 与 `renderErrorMessage` —— 它们把**渲染**引进了这个模块。
> 这与 `transport/errors.ts` 不依赖 i18next 的约定不冲突（那条约束只针对 `transport/`），
> 但确实让 `batch-publish.ts` 从"纯逻辑"变成了"逻辑 + 文案"。**可以接受，但要在文件头注释里写明**：
> 它的产出（`BatchRunSummary`）本来就要直接喂给汇总弹窗，`path` + `reason` 是最终形态。
> 替代方案（返回 `{key, params}` 让弹窗渲染）会让 `PublishResult.reason`（已经是字符串）
> 与错误描述符两种形态混杂，得不偿失。

- [ ]  **Step 4：跑测试确认全绿**

```bash
pnpm test tests/batch-publish.test.ts
```

- [ ]  **Step 5：写汇总弹窗**

追加到 `src/batch-confirm-modal.ts`：

```ts
/**
 * 末尾汇总。
 *
 * 用弹窗而不是 Notice：失败项可能几十条，`Notice` 几秒就消失且不可复制。
 * 用户此刻最需要的是**能停下来逐条看**的那份清单（哪一篇、为什么）。
 */
export function showBatchSummary(plugin: HaloPlugin, summary: BatchRunSummary): void {
  new BatchSummaryModal(plugin, summary).open();
}

class BatchSummaryModal extends Modal {
  constructor(
    private readonly plugin: HaloPlugin,
    private readonly summary: BatchRunSummary,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: i18next.t("batch.summary_title") });
    contentEl.createEl("p", {
      text: i18next.t("batch.summary_line", {
        success: this.summary.successCount,
        failed: this.summary.failureCount,
        skipped: this.summary.skippedCount,
      }),
    });

    for (const result of this.summary.results.filter((item) => !item.ok)) {
      contentEl.createEl("div", { text: `${result.path} —— ${result.reason ?? ""}` });
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

- [ ]  **Step 6：注册三个命令并接线**

在 `main.ts` 的 `onload()` 里注册三个命令（放在 `mcp-self-check` 之后）：

```ts
    this.addCommand({
      id: "batch-draft",
      name: i18next.t("command.batch_draft.name"),
      callback: async () => {
        await this.runBatchCommand("draft");
      },
    });

    this.addCommand({
      id: "batch-publish",
      name: i18next.t("command.batch_publish.name"),
      callback: async () => {
        await this.runBatchCommand("publish");
      },
    });

    this.addCommand({
      id: "batch-unpublish",
      name: i18next.t("command.batch_unpublish.name"),
      callback: async () => {
        await this.runBatchCommand("unpublish");
      },
    });
```

加两个私有方法：

```ts
  /**
   * 三个批量命令共用的入口：取候选 → 聚合规划 → 一次确认 → 执行 → 汇总。
   *
   * 候选来源就是**vault 里当前所有 markdown 文件**，用户靠确认弹窗里的分组清单看到全貌。
   * 刻意不做「先选文件夹再选标签」的多选对话框：一次聚合确认（用户 2026-10-03 的裁定）
   * 的前提正是"清单里能看到全部候选"，先让用户筛一遍再让他看清单，等于把同一件事问两遍。
   *
   * 站点解析不出来（多站点无规则无默认 / 指向未配置的站点 / 站点已被删）的笔记
   * 一律进 `skipped` 并在弹窗里逐条列出原因 —— 批量路径**不弹站点选择弹窗**，
   * 一篇一弹会把"批量"变成 118 次点击。
   */
  private async runBatchCommand(action: BatchAction): Promise<void> {
    if (this.settings.sites.length === 0) {
      new Notice(i18next.t("batch.error_no_sites"));
      return;
    }

    const files = this.app.vault.getMarkdownFiles();
    const { candidates, skipped } = collectBatchCandidates(files, this.app, this.settings, action);

    if (candidates.length === 0) {
      new Notice(i18next.t("batch.error_no_candidates"));
      return;
    }

    // 每个站点造一个 service：分类/标签的列举与图片概览都要用它，
    // 而 118 篇里同一站点的那些共用同一个客户端。
    const services = new Map<string, HaloService>();
    const serviceFor = (site: HaloSite): HaloService => {
      let service = services.get(site.url);

      if (!service) {
        service = new HaloService(this.app, this.settings, site);
        services.set(site.url, service);
      }

      return service;
    };

    const plan = await planBatch(candidates, skipped, action, {
      listTaxonomy: async (site) => {
        const service = serviceFor(site);
        const [categories, tags] = await Promise.all([service.getCategories(), service.getTags()]);
        return { categories, tags };
      },
      summarizeImages: async (item) =>
        item.resolution.kind === "resolved"
          ? serviceFor(item.resolution.site).summarizeImages(item.file)
          : { pending: 0, cached: 0, overLimit: [] },
    });

    const selected = await confirmBatchPlan(this, plan);

    // `undefined` = 用户取消。到此为止，站点与本地都还没被动过
    //（预览与确认都发生在任何写操作之前，包括上传图片那一步）。
    if (!selected) {
      return;
    }

    showBatchSummary(this, await runBatch(plan, selected, serviceFor));

    // 执行过程中图片缓存被写进了 `settings.imageUploadCache`；不落盘的话下次还得重传一遍。
    await this.saveSettings();
  }
```

顶部 import 补：`import { type BatchAction, collectBatchCandidates, planBatch, runBatch } from "./batch-publish";`、
`import { confirmBatchPlan, showBatchSummary } from "./batch-confirm-modal";`。

- [ ]  **Step 7：加三语文案**

`batch` 下加 `summary_title` 与 `summary_line`（插值 `{{success}}` / `{{failed}}` / `{{skipped}}`），
`command` 下加三个命令名（`batch_draft` / `batch_publish` / `batch_unpublish` 各自的 `name`），
三语逐键对应。

```json
    "summary_title": "批量操作完成",
    "summary_line": "成功 {{success}} 篇，失败 {{failed}} 篇，另有 {{skipped}} 篇因无法确定站点或尚未发布而跳过。",
```

- [ ]  **Step 8：跑全套 + 构建 + 提交**

```bash
node -e "
const fs=require('fs');
const keys=(o,p='')=>Object.entries(o).flatMap(([k,v])=>typeof v==='object'&&v!==null?keys(v,p+k+'.'):[p+k]);
const sets=['en','zh-cn','zh-tw'].map(l=>new Set(keys(JSON.parse(fs.readFileSync('src/i18n/locales/'+l+'.json','utf8')))));
console.log('键数:', sets.map(s=>s.size).join(' / '));
for (const a of sets) for (const b of sets) { const d=[...a].filter(k=>!b.has(k)); if (d.length) console.log('差集:', d); }
" && pnpm test && pnpm build
git add src/batch-publish.ts src/batch-confirm-modal.ts src/main.ts \
        src/i18n/locales/en.json src/i18n/locales/zh-cn.json src/i18n/locales/zh-tw.json \
        tests/batch-publish.test.ts
git commit -m "feat(batch): 执行循环跳过失败项继续，末尾汇总"
```

---

## Task 11：收口 —— 文档、契约、端到端清单

**Files:**

- Modify: `README.md`、`README.zh-CN.md`、`CLAUDE.md`
- Modify: `tests/contract/mcp-contract.test.ts`（只在工具集有变化时；本阶段**不变**，核对一遍即可）

**Interfaces:** 无新导出

---

- [ ]  **Step 1：核对文档里的工具清单仍与 `REQUIRED_TOOLS` 一致**

```bash
node -e "
const fs=require('fs');
const m=fs.readFileSync('src/mcp-self-check.ts','utf8');
console.log('REQUIRED_TOOLS:', [...m.matchAll(/\"(halo_[a-z_]+)\"/g)].map(x=>x[1]).join(' '));
" && grep -n "勾选\|check the" README.md CLAUDE.md
```

1-A 的最终审查在这一点上吃过一次亏（README 与 CLAUDE.md 都漏了 `halo_recycle_post` /
`halo_restore_post`，而 README 多列了「独立页面」）。**本阶段没有改 `REQUIRED_TOOLS`**，
所以两处应当仍然一致 —— 但必须核一遍，而不是假设它没变。

- [ ]  **Step 2：写 `README.zh-CN.md` 的 MCP 章节**

1-A 的账本记着这条待办：`README.zh-CN.md` 完全没有 MCP 相关的章节，而 `README.md` 有一整节。
两个文件都在仓库根、都被用户看到，只改一个等于告诉中文读者「你现在看到的说明是旧的」。

内容对齐 `README.md` 的「当前进度与凭据要求」一节，并补上本阶段的新事实。

- [ ]  **Step 3：README 里补三件本阶段新增的事**

1. **6 个元数据字段**：给出完整的 frontmatter 示例（照 spec §5.1），并写清那条最容易踩的规则：

   > **删掉一行 ≠ 清空它。** 删掉 `halo.pinned:` 那一行表示「跟随远端当前的值」；
   > 要取消置顶必须写 `pinned: false`。唯一的例外是 `publishTime`：写 `""`（空串）表示
   > 「立即发布」，写一行空的 `publishTime:` 仍然是「跟随远端」。
   >
2. **站点路由规则**：给出示例与那条「报错而不改道」的行为：

   > 规则自上而下取首个命中。若命中的规则指向一个已被删除的站点，插件会**停下来报错**，
   > 而不是改用默认站点 —— 把笔记发到另一个站是不可逆的。
   >
3. **批量操作**：三个命令各自改什么，并且**明说批量发布也会改写本地笔记**
   （图片链接替换那一步），因为「批量发布」听起来像只动远端。

- [ ]  **Step 4：CLAUDE.md 补本阶段的三个新事实**

- 「架构」一节：加 `src/frontmatter-map.ts` / `src/site-routing.ts` / `src/publish-preview.ts` /
  `src/batch-publish.ts` 四个文件与它们的唯一职责；补上「站点解析只有一处入口」
  （`HaloPlugin.resolveSiteFor` → `resolveSite`），发布与上传图片共用。
- 「frontmatter 契约」一节：把 spec §5.1 的完整示例与**那个稀疏语义**写进去
  （`null` 与缺席同义；`false`/`0`/`""` 是显式值；`publishTime: ""` 是清空）。
  这一节现在是本仓库最容易被误读的一处 —— 1-A 的教训是「文档的消费方没跟着改」，
  所以本步要顺手核对同一份契约在 `README.md` 里的表述是否一致。
- 「常用命令」之后：补一句批量操作会改写本地笔记。

- [ ]  **Step 5：写端到端手工清单**

在 `README.md`（或 `docs/`）里加一节，写明**必须在真实 Obsidian 里跑**的验证项。
按 1-A 的《A4》格式写：每项给出「做什么 → 预期看到什么 → 若不符，最可能的错在哪」。

至少覆盖：

1. 笔记里写 `halo: { visible: INTERNAL }` → 发布 → 预览里可见性是 INTERNAL → 站点后台核对。
2. 写 `pinned: false` 而远端正置顶 → 发布 → 站上取消置顶（**证明假值不是「没写」**）。
3. 删掉 `pinned` 那一行再发布 → 站上**保持**原状（证明「没写就跟随远端」）。
4. `visible: public`（小写）→ 发布 → **中止**并弹出带 `public` 的提示，站点上什么都没变。
5. 配一条 `博客/** → B 站` 的规则 → 在 `博客/` 下发布 → 预览显示「来自路由规则「博客/**」」→ 发到 B 站。
6. 把规则指向一个已删除的站点 → 发布 → 报错，**没有**发到默认站点。
7. 规则模式写成 `Blog/**` 而目录是 `blog` → 设置页里那一行显示「匹配到 N 篇」（证明大小写不敏感）。
8. 关掉 `skipPreviewOnPublish` → 每次发布都弹预览；勾上 → 直接发布。
9. 预览里点「取消」→ **笔记与站点都没有任何变化**（尤其：没有新建分类标签、图片链接没被替换）。
10. 批量推草稿：确认弹窗里**取消勾选几篇** → 「将处理 N 篇」立刻跟着变小 → 执行后只有勾选的被处理。
11. 批量推草稿选一批含 1 篇图片上传会失败的笔记 → 其余全部成功，末尾汇总里列出那一篇及原因。
12. 批量撤回 → 站点上那几篇变成草稿，本地笔记的 `halo.publish` 变成 `false`；**没有 `halo.name` 的笔记出现在「已跳过」里而不是「失败」里**。
13. 清空站点配置里的 `token` 字段 → 上面 12 项里除了「传超限图片」，其余全部仍可用。

- [ ]  **Step 6：跑全套 + 构建 + 契约测试（有凭据时）**

```bash
pnpm test && pnpm build && pnpm exec tsc --noEmit 2>&1 | grep "^src/" | wc -l
```

预期：测试全绿；`src/` 的 tsc 错误数 **3**（既有的 `@halo-dev/api-client` 解析错误）。

- [ ]  **Step 7：确认没有新增运行时依赖**

```bash
node -e "
const fs=require('fs');
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
console.log('dependencies:', JSON.stringify(pkg.dependencies, null, 2));
" && git log --oneline main..HEAD -- package.json
```

预期：第二个命令**没有输出**（本次分支没碰过 `package.json`）。

- [ ]  **Step 8：提交**

```bash
git add README.md README.zh-CN.md CLAUDE.md
git commit -m "docs: 元数据字段的空值语义、路由规则与批量操作；补端到端手工清单"
```

---

## 执行顺序与依赖

```
Task 1 (frontmatter-map 校验与落地)
   └─→ Task 2 (回写收敛为一份实现)
          └─→ Task 3 (6 字段贯通发布 / 更新 / 拉取)

Task 4 (site-routing 纯函数)
   └─→ Task 5 (设置项 siteRouting + 规则表 UI)
          └─→ Task 6 (main.ts 的站点解析统一到一处)

Task 7 (解绑 activeEditor：uploadImages(file) / publishPost(file) → PublishResult)
   └─→ Task 8 (planPublish / executePublish 拆分 + 预览弹窗)
          └─→ Task 9 (批量候选 + 聚合计划 + 一次确认)
                 └─→ Task 10 (批量执行：跳过失败项继续 + 末尾汇总；注册三个命令)

Task 3 ─┐
Task 6 ─┼─→ Task 8（6 字段要能在预览里显示；站点来源要能在预览里显示）
Task 7 ─┘

Task 11 (收口：文档、契约核对、端到端清单)
```

**两条彼此独立的链**：`1→2→3`（本地 frontmatter 契约）与 `4→5→6`（站点路由）。
两者在 Task 7 之后汇入 `8→9→10`（交互面）。`1–3` 与 `4–6` 之间没有任何依赖关系，
如果将来要并行化，那是唯一的切点。

## 完成判据（整支）

- [ ]  `pnpm test` 全绿，且新增测试覆盖：稀疏语义（假值留存 / 缺席跟随）、6 个字段的落点、
  三处回写共用一份实现、glob 的四类模式与优先级、规划阶段零写入、批量只跑勾选项、
  批量跳过失败继续、汇总跟着勾选实时变。
- [ ]  `pnpm build` 产出可加载的 `main.js`；`tsc` 的 `src/` 错误数仍是 3。
- [ ]  `package.json` 未被触碰（无新运行时依赖）。
- [ ]  三个 locale 文件的键逐一对应。
- [ ]  **清空站点配置里的 `token` 字段后**，发布 / 更新 / 拉取 / 小图上传 / 自检 / 预览 /
  批量推草稿 / 批量发布 / 批量撤回九条路径全部可用；唯一断的仍是上传超过 7 MiB 的图。
- [ ]  README.md 与 README.zh-CN.md 的 MCP 章节内容一致；CLAUDE.md 的 frontmatter 契约一节
  写明了稀疏语义。
- [ ]  端到端手工清单已列在文档里，**并且已由人跑过**（清单本身是交付物，跑它是用户的事）。
