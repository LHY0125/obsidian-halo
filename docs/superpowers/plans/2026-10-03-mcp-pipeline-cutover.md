# 阶段 1-A：发布管线 MCP 切换 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把既有 5 个命令（发布 / 发布到默认站点 / 上传图片 / 拉取 / 更新）的发布后端从「直连 Halo REST API + PAT」整体切到「Halo 官方 MCP Server」，并把 1085 行的 `service/index.ts` 按职责拆分。

**Architecture:** `McpClient`（阶段 0 已建好）是唯一出口；`service/index.ts` 从「一个装了全部 REST 逻辑的类」变成「分流门面 + 编排」，把本地内容处理抽到 `service/local-content.ts`（纯函数为主）、图片上传抽到 `service/image-upload.ts`（含 MCP base64 主路径与 >7 MiB 的 REST 回退）。**本计划刻意不改变用户可见行为**——完成后用户看不出区别，唯一的实质变化是既有命令不再需要 PAT（除大图）。

**Tech Stack:** TypeScript 5.1.6 / Rslib 构建 / rstest 测试 / Biome lint / pnpm。**不新增任何依赖。**

**Spec:** `docs/superpowers/specs/2026-10-03-obsidian-halo-mcp-reshape-design.md`

**前置计划：** `docs/superpowers/plans/2026-10-03-bootstrap-and-mcp-transport.md`（阶段 0 基座 + MCP 传输层，已合入 `main`）

## Global Constraints

以下为 spec 的项目级要求，**每个任务都隐含包含**，不再逐条重复：

- **插件 id 必须是 `halo-mcp`**（官方占用 `halo`，同 id 无法共存）。显示名可仍为「Halo」。
- **License 按 GPL-3.0 处理**（上游 `LICENSE` 是 GPL-3.0 全文，尽管 `package.json` 误写 MIT）。
- **MCP 端点固定推导规则**：`<site.url 去掉尾部斜杠>/mcp`，不新增存储字段。已有现成函数：`mcpEndpointOf(site)`（`src/settings.ts`）。
- **请求头硬性要求**：`Accept` **必须**同时包含 `application/json` 与 `text/event-stream`，缺任一会被服务端判为 `400` 且**响应体为空**。（`McpClient` 已处理。）
- **握手顺序硬性要求**：必须先 `initialize` 成功，才能调 `tools/list` 或 `tools/call`；服务端**无 `Mcp-Session-Id`**（无状态）。（`McpClient` 已处理。）
- **前置条件**：站点需 Halo ≥ 2.26 且已启用 MCP Server 插件。
- **不新增运行时依赖。**
- 所有面向用户的文案走 `i18next`；**新增或修改的键必须三份 locale 同步**
  （`src/i18n/locales/{en,zh-cn,zh-tw}.json`），否则切语言时用户看到原始键名。
- 代码注释用中文。新写/改写的文件按 `.editorconfig` 用 LF。
- **测试用 rstest，mock API 是 Jest 风格**（`rs.fn(impl)` / `rs.spyOn` / `mock.calls` / `mockReset()`）。
- **本计划不得改变用户可见行为**：除「错误文案更准确」外，发布/更新/拉取/传图的输入输出与阶段 0 之前一致。**尤其是 `publishPost` 的「任一图片上传失败即中止发布」语义必须保留。**

### 实测得出的 MCP 协议细则（2026-10-03 抓原始响应与 tool schema，非推测）

这几条是本计划最容易写错的地方，**每一条都会静默出错**：

1. **`tools/call` 的工具级失败是 `HTTP 200` + `result.isError: true` 的「成功响应」**，不是 HTTP 错误。只检查 JSON-RPC 的 `error` 字段会把参数错误当成数据返回。
2. **成功时取负载优先用 `result.structuredContent`**（服务端已解析好的对象）；它缺席时才回落去 `JSON.parse(result.content[0].text)`。**失败时 `structuredContent` 不存在**，错误消息在 `content[].text` 里。`content` 是文本块**数组**：首块是负载，末块是人读摘要（如 `"Listed 1 posts"`）。
3. **`rawType` 的 schema 默认值是 `"html"`，不是 `"markdown"`**（`halo_create_post` / `halo_update_post` 皆然）。传 Markdown 时**必须显式写 `rawType: "markdown"`**，否则 Halo 把 Markdown 当 HTML 存，站点渲染错乱而本地看不出来。
4. **`publishTime` 是 `["string","null"]` + `format: date-time`**：「立即发布」要传 `null` 或**省略**，**传空字符串 `""` 非法**。
5. **`halo_create_category` / `halo_create_tag` 都要求显式传 `name`**，REST 的 `metadata.generateName` 在 MCP **没有等价物**——name 生成的职责从服务端搬到客户端。站点现存数据的形态是 `category-sc9pomuo` / `tag-tnpxywrp`（前缀 + 8 位小写字母数字），**生成规则必须与之同形**（见 Task 5）。
6. **`halo_create_post` / `halo_update_post` 的 `content` 是可选且默认取 `raw`**，所以**不要**再在客户端跑 `markdownIt.render()`——让服务端渲染。（这与 spec 的 F1/N1 一致：客户端渲染结果不是读者看到的 HTML。）顺带删掉上游那段无用功。
7. **`halo_update_post` 没有 `publish` 入参**，发布状态只能由 `halo_set_post_publish_state` 单独管（spec F5 已记）。

### 工具入参速查（从 tool schema 抄录，实现时照此对齐）

| 工具 | 必填 | 与本计划相关的可选入参 |
|---|---|---|
| `halo_create_post` | `name` `title` `raw` | `slug` `cover` `excerpt` `autoGenerateExcerpt` `categories[]` `tags[]` `rawType` `publish` `visible` `pinned` `priority` `publishTime` `allowComment` `template` |
| `halo_update_post` | `name` | 同上，但**无 `publish`**；`raw` 省略即只改元数据；`content`/`rawType` 仅在给了 `raw` 时有效 |
| `halo_get_post` | `name` | `format` = `RAW`\|`RENDERED`\|`BOTH`（默认 `RAW`）；`version` = `HEAD`\|`RELEASE`（默认 `HEAD`） |
| `halo_list_posts` | — | `page` `size`(≤100) `published` `recycled` |
| `halo_set_post_publish_state` | `name` `publish` | — |
| `halo_upload_attachment` | `filename` `contentBase64` | `mediaType`。`filename` 不得含路径分隔符；`contentBase64` **maxLength 9786712**（≈ 7 MiB 原始字节的 base64 长度），不带 data URL 前缀 |
| `halo_list_categories` | — | `keyword` `page` `size` `parent` |
| `halo_create_category` | `name` `displayName` | `slug` `parent` `priority` `cover` `description` `template` `postTemplate` `hideFromList` `preventParentPostCascadeQuery` |
| `halo_list_tags` | — | `keyword` `page` `size` |
| `halo_create_tag` | `name` `displayName` | `slug` `color` `cover` `description` |

### 既有测试必须**迁移**，而不是「保持一字不改」

**这条推翻了本计划初稿的一个假设。** `tests/service/index.test.ts` 里现有 11 个用例是靠 mock `requestUrl`（REST）驱动的，
而 `requestUrl` 正是本次要被替换掉的那条边界——所以这些用例**必然**会因为"换了后端"而变红：

| 既有 describe | 用例数 | 行 | 被哪个任务影响 |
|---|---|---|---|
| `HaloService.uploadImages` | 7 | 205–440 | Task 3（≤7 MiB 改走 MCP） |
| `HaloService.updatePost` | 2 | 442–583 | Task 5 / 6（读取改走 MCP） |
| `HaloService.publishPost` | 2 | 584– 末 | Task 4（写入改走 MCP） |

**判据是「行为断言仍然成立」，不是「测试文件字节未变」。** 每个受影响的任务里，把这些用例改成 mock `McpClient`
（用 Task 3 Step 1 的 `createFakeClient` 脚手架），**保留原有断言的含义**。其中两条是硬红线，**不得删除、不得放宽**：

- `does not write partial markdown when one image upload fails`（行 395）——守住「任一图片失败就不写回部分 markdown」
- `retries draft update failures before showing publish failure`（行 589）——守住「失败重试 3 次」

**不许**为了让测试变绿而删用例，也不许把 `toEqual` 降级成 `toBeTruthy` 之类的弱断言。
若某条断言在新架构下**确实**不再成立（例如它断言的是 REST 的两步写入，而 MCP 只需一步），
**不要默默改断言**——在提交信息与报告里写明"该断言因架构变化而失效，原因是 X"，让评审能独立判断。

### 现有代码事实（读代码所得，实现时按此对齐）

`src/service/index.ts` 当前 **1085 行**，共 11 个公开方法：

| 方法 | 行 | 本计划处置 |
|---|---|---|
| `getPost(name)` | 91 | Task 5 改为 MCP |
| `publishPost(options)` | 130 | Task 4 改为 MCP |
| `changePostPublish(name, publish)` | 304 | Task 4 改为 MCP |
| `getCategories()` / `getTags()` | 403 / 411 | Task 5 改为 MCP |
| `updatePost()` | 419 | Task 6 改为 MCP |
| `pullPost(name)` | 464 | Task 6 改为 MCP |
| `uploadImages(options)` | 493 | Task 3 迁入 `image-upload.ts`，接 MCP 主路径 |
| `uploadImage(file)` | 597 | Task 3 拆成 MCP / REST 两条 |
| `getCategoryNames(displayNames)` | 805 | Task 5 改为 MCP（**注意：上游靠服务端 `generateName` 造 name，MCP 无此能力**） |
| `getCategoryDisplayNames(names)` | 847 | Task 5 改为 MCP |
| `getTagNames(displayNames)` / `getTagDisplayNames(names)` | 857 / 894 | Task 5 改为 MCP |

---

## File Structure

| 文件 | 职责 | 状态 |
|---|---|---|
| `src/transport/types.ts` | 补 `structuredContent`；新增 `McpToolResultEnvelope` | 修改 |
| `src/transport/errors.ts` | 新增 `toolFailureError()` | 修改 |
| `src/transport/mcp-client.ts` | 新增 `parseToolResult()` 与 `callToolJson()` | 修改 |
| `src/service/local-content.ts` | **新建**：frontmatter 映射、图片引用扫描、路径与 embed 格式化（纯函数为主） | 创建 |
| `src/service/post-mapping.ts` | **新建**：把 MCP 的**扁平**文章表示适配回领域模型 `Post`（`{metadata, spec}` 嵌套）。spec §4.1 未列出本文件，但它是必须的——见 Task 5 的说明 | 创建 |
| `src/service/image-upload.ts` | **新建**：MCP base64 主路径 + REST multipart 回退 + 上传缓存 | 创建 |
| `src/service/index.ts` | 改造：分流门面 + 编排；净瘦身 | 修改 |
| `src/main.ts` | 命令层的错误提示带上 `detail` | 修改 |
| `src/i18n/locales/{en,zh-cn,zh-tw}.json` | 新增/调整文案键 | 修改 |
| `tests/transport/mcp-client.test.ts` | 补 `tools/call` 解包与工具级错误用例 | 修改 |
| `tests/service/local-content.test.ts` | **新建**：抽取出来的纯函数测试 | 创建 |
| `tests/service/image-upload.test.ts` | **新建**：7 MiB 边界、base64 正确性、缓存命中/失效 | 创建 |
| `tests/service/index.test.ts` | 既有脚手架；补分流行为断言 | 修改 |
| `tests/contract/mcp-contract.test.ts` | 契约测试所需工具集扩到本计划用到的全部 | 修改 |
| `README.md` | 前置条件与凭据要求按新现状重写一栏 | 修改 |

---

## Task 1: 传输层补齐 `tools/call` 的结果解包与工具级错误

**Files:**
- Modify: `src/transport/types.ts`, `src/transport/errors.ts`, `src/transport/mcp-client.ts`
- Test: `tests/transport/mcp-client.test.ts`

**Interfaces:**
- Consumes: `McpError`（`src/transport/errors.ts`）
- Produces:
  - `parseToolResult<T>(result: McpToolCallResult, tool: string): T`
  - `toolFailureError(tool: string, message: string): McpError`
  - `McpClient.callToolJson<T>(name: string, args?: Record<string, unknown>): Promise<T>`
  - `McpToolCallResult.structuredContent?: unknown`

> **为什么这是第一个任务**：下面 Task 3–6 每一次调用工具都要用它。没有它，参数写错时你会拿到一段报错文本并**当成数据**继续往下跑——这类错误最难查。

- [ ] **Step 1: 写失败测试**

在 `tests/transport/mcp-client.test.ts` 末尾追加。两个 fixture 是**从真实站点抓下来的原始响应**，逐字照抄，不要改写：

```ts
import { parseToolResult } from "src/transport/mcp-client";

// 以下两个外壳取自 2026-10-03 对 https://blog.liuhangyv.top/mcp 的实测原始响应
const SUCCESS_RESULT = {
  content: [
    { type: "text", text: '{"items":[{"name":"real-ip-always-there-and-forgery"}],"total":74}' },
    { type: "text", text: "Listed 1 posts" },
  ],
  isError: false,
  structuredContent: { items: [{ name: "real-ip-always-there-and-forgery" }], total: 74 },
};

// 工具级失败：HTTP 状态码是 200，但它不是成功
const TOOL_FAILURE_RESULT = {
  content: [
    {
      type: "text",
      text: "Tool (halo_list_posts) input validation failed: Validation failed: JSON schema validation errors: [/size: must have a maximum value of 100]",
    },
  ],
  isError: true,
};

describe("parseToolResult", () => {
  it("优先使用 structuredContent，而不是解析 content 文本", () => {
    const parsed = parseToolResult<{ total: number }>(SUCCESS_RESULT, "halo_list_posts");
    expect(parsed.total).toBe(74);
  });

  it("structuredContent 缺席时回落解析 content[0].text", () => {
    const withoutStructured = {
      content: [{ type: "text", text: '{"total":9}' }],
      isError: false,
    };
    const parsed = parseToolResult<{ total: number }>(withoutStructured, "halo_list_posts");
    expect(parsed.total).toBe(9);
  });

  it("isError 为 true 时抛 McpError，且 detail 带上服务端原文", () => {
    let thrown: unknown;
    try {
      parseToolResult(TOOL_FAILURE_RESULT, "halo_list_posts");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).detail).toContain("must have a maximum value of 100");
  });

  it("isError 为 true 时绝不能被当成数据返回", () => {
    expect(() => parseToolResult(TOOL_FAILURE_RESULT, "halo_list_posts")).toThrow();
  });

  it("既无 structuredContent 又无可用文本块时抛错，而不是返回 undefined", () => {
    expect(() => parseToolResult({ content: [], isError: false }, "halo_x")).toThrow(McpError);
  });

  it("content[0].text 不是合法 JSON 时抛错", () => {
    expect(() => parseToolResult({ content: [{ type: "text", text: "not json" }], isError: false }, "halo_x")).toThrow(
      McpError,
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test tests/transport/mcp-client.test.ts
```

预期：FAIL，报 `parseToolResult is not a function`（或 `does not provide an export named`）。

- [ ] **Step 3: 补类型**

`src/transport/types.ts` —— 给 `McpToolCallResult` 加一个字段，**只加不改**：

```ts
export interface McpToolCallResult {
  content?: McpContentBlock[];
  isError?: boolean;
  /**
   * 服务端提供的**已解析**结果。成功时存在，失败时缺席。
   * 优先用它而不是解析 content[0].text —— 后者要处理转义与分块。
   */
  structuredContent?: unknown;
}
```

- [ ] **Step 4: 补错误工厂**

`src/transport/errors.ts` 末尾追加：

```ts
/**
 * 工具执行失败。
 *
 * ⚠️ 这类失败以 `HTTP 200` + `result.isError: true` 送达，**不是 HTTP 错误**——
 * `classifyHttpFailure()` 看不到它。只检查 JSON-RPC 的 `error` 字段会把参数错误当成成功。
 * 归类沿用 `unknown`（服务端拒绝的原因千差万别，硬拆 kind 只会拆错），
 * 但**必须把服务端原文放进 `detail`**，否则用户看到「MCP 请求失败」却拿不到任何线索。
 */
export function toolFailureError(tool: string, message: string): McpError {
  return new McpError("unknown", { tool }, message);
}
```

- [ ] **Step 5: 实现解包并暴露 `callToolJson`**

`src/transport/mcp-client.ts` —— 先改 import 行把 `toolFailureError` 加进去：

```ts
import { McpError, assertJsonBody, classifyHttpFailure, missingToolError, toolFailureError } from "./errors";
```

再在 `unwrap()` 之后、`export class McpClient` 之前插入：

```ts
/**
 * 解包 `tools/call` 的结果。
 *
 * 三条实测出来的形状约束（见 Global Constraints）：
 * ① 工具级失败是 HTTP 200 + `isError: true`，必须显式检查，否则会把报错文本当数据；
 * ② 成功时优先取 `structuredContent`（已解析），它缺席才回落解析 `content[0].text`；
 * ③ `content` 是文本块**数组**——首块是负载，末块是人读摘要，拼接全部会得到非法 JSON。
 */
export function parseToolResult<T>(result: McpToolCallResult | undefined, tool: string): T {
  const blocks = result?.content ?? [];
  const message = blocks
    .map((block) => block.text ?? "")
    .filter(Boolean)
    .join(" ")
    .trim();

  if (result?.isError) {
    throw toolFailureError(tool, message);
  }

  if (result?.structuredContent !== undefined) {
    return result.structuredContent as T;
  }

  const first = blocks.find((block) => block.type === "text" && block.text)?.text;

  if (first === undefined) {
    throw toolFailureError(tool, message);
  }

  try {
    return JSON.parse(first) as T;
  } catch {
    throw new McpError("unknown", { tool }, first.slice(0, 200));
  }
}
```

最后给 `McpClient` 加一个方法（放在 `callTool` 之后）：

```ts
  /**
   * 调用工具并解包成实际负载。
   *
   * 业务代码一律用这个方法，**不要**直接用 `callTool()` —— 后者返回的是
   * 未解包的 MCP 外壳，会让每个调用点都重复一遍「检查 isError / 取 structuredContent」。
   */
  public async callToolJson<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.callTool<McpToolCallResult>(name, args);
    return parseToolResult<T>(result, name);
  }
```

> `McpToolCallResult` 已在 `src/transport/mcp-client.ts` 第 3 行的 type-only import 里，无需新增 import。

- [ ] **Step 6: 运行测试确认通过**

```bash
pnpm test tests/transport/mcp-client.test.ts
```

预期：新增 6 个用例全过，既有用例不掉。

- [ ] **Step 7: 跑全套并提交**

```bash
pnpm test
pnpm check
git add src/transport tests/transport/mcp-client.test.ts
git commit -m "feat(transport): 补 tools/call 的结果解包与工具级错误识别"
```

预期：全套 **64 通过**（基线 58 + 新增 6），`pnpm check` 无新增待修。

---

## Task 2: 抽取 `src/service/local-content.ts`（纯重构，零行为变化）

**Files:**
- Create: `src/service/local-content.ts`
- Modify: `src/service/index.ts`
- Test: `tests/service/local-content.test.ts`

**Interfaces:**
- Consumes: `HaloPostFrontmatter`（现定义在 `src/service/index.ts` 顶部，本任务一并迁走并导出）；`TFile` / `App`（`obsidian`）；`getLinkpath` / `normalizePath`（`obsidian`）
- Produces（全部具名导出）：
  - `collectLocalImageReferences(markdown: string, sourceFile: TFile, app: App): LocalImageReference[]`
  - `applyPostFrontmatter(post: Post, options: ApplyPostFrontmatterOptions): Post`
  - `resolveImageFile(path: string, sourceFile: TFile, app: App): TFile | undefined`
  - `isImageFile(file: TFile): boolean`
  - `isRemotePath(path: string): boolean`
  - `decodeMarkdownPath(path: string): string`
  - `parseMarkdownImageTarget(rawTarget: string): MarkdownImageTarget | undefined`
  - `getWikiImageAlias(linkText: string): string`
  - `getWikiImageAlt(linkText: string): string`
  - `getMarkdownImageAlt(markdownImage: string): string`
  - `formatMarkdownImagePath(path: string): string`
  - `formatWikiImageEmbed(cacheEntry: ImageUploadCacheEntry, fallbackAlias?: string): string`
  - 类型：`HaloPostFrontmatter`、`LocalImageReference`、`MarkdownImageTarget`、`ApplyPostFrontmatterOptions`
  - 常量：`IMAGE_EXTENSIONS`、`IMAGE_MIME_TYPES`

> **本任务是纯搬家，不改任何行为。** 判据：搬完之后 `pnpm test` 的既有用例数不变且全过。
> 先搬家再改行为，是为了让后面 Task 3–6 的 diff 只含**真正的改动**——1085 行里混着搬家与改逻辑，评审无法分辨哪一行是新的。

- [ ] **Step 1: 先跑一次基线，记下数字**

```bash
pnpm test
```

预期：**64 通过**（Task 1 之后的数量）。**把这个数字记下来**，Step 6 要用它比对。

- [ ] **Step 2: 建新文件并原样搬运**

创建 `src/service/local-content.ts`。**成员一律剪切粘贴，不要重新手打**——重打会引入静默的语义漂移。搬家清单（括号内是当前行号，便于定位）：

| 现成员 | 现位置 | 新形态 |
|---|---|---|
| `HaloPostFrontmatter` 等顶部类型 | 1–50 | 原样迁入并 `export` |
| `IMAGE_EXTENSIONS` / `IMAGE_MIME_TYPES` | 52–63 | 原样迁入并 `export` |
| `isImageFile` | 1037–1039 | 去掉 `this.`，改模块函数 |
| `isRemotePath` | 1041–1043 | 同上 |
| `decodeMarkdownPath` | 1003–1009 | 同上 |
| `parseMarkdownImageTarget` | 972–1001 | `this.decodeMarkdownPath` → `decodeMarkdownPath` |
| `getWikiImageAlias` | 1055–1057 | 去掉 `this.` |
| `getWikiImageAlt` | 1045–1053 | `this.getWikiImageAlias` → `getWikiImageAlias` |
| `getMarkdownImageAlt` | 795–803 | 去掉 `this.` |
| `formatMarkdownImagePath` | 759–765 | 去掉 `this.` |
| `formatWikiImageEmbed` | 785–793 | 去掉 `this.` |
| `resolveImageFile` | 1011–1035 | 新增 `app: App` 参数；`this.app` → `app`；`this.isImageFile` → `isImageFile` |
| `collectLocalImageReferences` | 904–970 | 新增 `app: App` 参数；`this.X` 全部改模块函数；`app` 透传给 `resolveImageFile` |
| `applyPostFrontmatter` | 313–373 | 去掉 `private`，改 `export function`；**它本来就不用 `this`**，签名原样 |

搬运后 `src/service/index.ts` 的 import 块同步改成从 `./local-content` 引入这些名字；
`src/service/index.ts` 里所有 `this.collectLocalImageReferences(...)` / `this.applyPostFrontmatter(...)`
改为 `collectLocalImageReferences(..., this.app)` / `applyPostFrontmatter(...)`。

- [ ] **Step 3: 为新文件的纯函数写测试**

创建 `tests/service/local-content.test.ts`。**只测不依赖 `App` 的那些**（依赖 `App` 的留给既有集成用例覆盖）：

```ts
import {
  decodeMarkdownPath,
  formatMarkdownImagePath,
  formatWikiImageEmbed,
  getMarkdownImageAlt,
  getWikiImageAlias,
  getWikiImageAlt,
  isRemotePath,
  parseMarkdownImageTarget,
} from "src/service/local-content";

describe("isRemotePath", () => {
  it.each([
    ["https://example.com/a.png", true],
    ["http://example.com/a.png", true],
    ["//cdn.example.com/a.png", true],
    ["#anchor", true],
    ["assets/a.png", false],
    ["a.png", false],
  ])("%s → %s", (input, expected) => {
    expect(isRemotePath(input)).toBe(expected);
  });
});

describe("decodeMarkdownPath", () => {
  it("解码百分号转义", () => {
    expect(decodeMarkdownPath("a%20b.png")).toBe("a b.png");
  });

  it("不是合法转义时原样返回，不抛错", () => {
    expect(decodeMarkdownPath("100%")).toBe("100%");
  });
});

describe("parseMarkdownImageTarget", () => {
  it("解析尖括号包裹的路径，并给出 rawPath 与 start", () => {
    const target = parseMarkdownImageTarget("<a b.png>");
    expect(target).toEqual({ rawPath: "a b.png", path: "a b.png", start: 1 });
  });

  it("解析裸路径，start 指到首个非空白字符", () => {
    const target = parseMarkdownImageTarget("  a.png");
    expect(target).toEqual({ rawPath: "a.png", path: "a.png", start: 2 });
  });

  it("空串返回 undefined", () => {
    expect(parseMarkdownImageTarget("   ")).toBeUndefined();
  });
});

describe("formatMarkdownImagePath", () => {
  it("含空格或括号时用尖括号包裹", () => {
    expect(formatMarkdownImagePath("a b.png")).toBe("<a b.png>");
    expect(formatMarkdownImagePath("a(1).png")).toBe("<a(1).png>");
  });

  it("普通路径原样返回", () => {
    expect(formatMarkdownImagePath("assets/a.png")).toBe("assets/a.png");
  });
});

describe("getWikiImageAlias / getWikiImageAlt", () => {
  it("取竖线后的别名", () => {
    expect(getWikiImageAlias("a.png|截图")).toBe("截图");
  });

  it("纯数字别名视为尺寸而非 alt，返回空", () => {
    expect(getWikiImageAlt("a.png|200")).toBe("");
    expect(getWikiImageAlt("a.png|200x300")).toBe("");
  });

  it("有意义的别名作为 alt，并转义右方括号", () => {
    expect(getWikiImageAlt("a.png|截图]x")).toBe("截图\\]x");
  });
});

describe("getMarkdownImageAlt", () => {
  it("取出方括号里的 alt", () => {
    expect(getMarkdownImageAlt("![截图](a.png)")).toBe("截图");
  });

  it("空 alt 返回空串", () => {
    expect(getMarkdownImageAlt("![](a.png)")).toBe("");
  });

  it("不是图片语法时返回空串", () => {
    expect(getMarkdownImageAlt("[链接](a.png)")).toBe("");
  });
});

describe("formatWikiImageEmbed", () => {
  const entry = { filePath: "assets/a.png", permalink: "/upload/a.png", size: 1, mtime: 1, updatedAt: 1 };

  it("无别名时生成不含竖线的 embed", () => {
    expect(formatWikiImageEmbed(entry)).toBe("![[assets/a.png]]");
  });

  it("有别名时带上别名", () => {
    expect(formatWikiImageEmbed(entry, "截图")).toBe("![[assets/a.png|截图]]");
  });

  it("别名里的竖线被转义，避免破坏 embed 语法", () => {
    expect(formatWikiImageEmbed(entry, "a|b")).toBe("![[assets/a.png|a\\|b]]");
  });
});
```

- [ ] **Step 4: 运行新测试**

```bash
pnpm test tests/service/local-content.test.ts
```

预期：全过。（这些函数是从既有代码搬来的，行为已存在，所以这里**不要求先看到 RED**——本任务是纯重构，不是 TDD 新功能。若有用例失败，说明搬运过程中改坏了东西，**去比对原实现，不要改测试**。）

- [ ] **Step 5: 跑 `tsc` 找漏改的引用**

```bash
pnpm exec tsc --noEmit
```

预期：无新增错误。若报 `Property 'X' does not exist on type 'HaloService'`，说明还有 `this.X` 没改干净——**此时不要用 `@ts-expect-error` 压掉**，回去改。

- [ ] **Step 6: 跑全套，与 Step 1 的数字逐字比对**

```bash
pnpm test
```

预期：**既有用例数不变、全过**；总数 = 64（基线）+ 本任务新增的纯函数用例数。若有既有用例变红，**本任务不成立**——回退重搬。

- [ ] **Step 7: 确认 `service/index.ts` 净瘦身**

```bash
wc -l src/service/index.ts src/service/local-content.ts
```

预期：`index.ts` 从 1085 降到约 **790 行**；`local-content.ts` 约 **300 行**。（数字不要求精确，但 `index.ts` **必须明显变短**——没变短说明你复制而非剪切。）

- [ ] **Step 8: 提交**

```bash
git add src/service tests/service/local-content.test.ts
git commit -m "refactor(service): 抽 local-content.ts，纯搬家不改行为"
```

---

## Task 3: 抽取 `src/service/image-upload.ts`，图片上传改走 MCP base64

**Files:**
- Create: `src/service/image-upload.ts`
- Modify: `src/service/index.ts`
- Test: `tests/service/image-upload.test.ts`

**Interfaces:**
- Consumes: `McpClient.callToolJson`（Task 1）；`isImageFile` / `formatWikiImageEmbed` / `formatMarkdownImagePath` / `getMarkdownImageAlt` / `getWikiImageAlias` / `parseMarkdownImageTarget` / `decodeMarkdownPath`（Task 2）；`IMAGE_MIME_TYPES`（Task 2）
- Produces:
  - `MCP_UPLOAD_MAX_BYTES: number`（= `7340032`）
  - `toBase64(data: ArrayBuffer): string`
  - `interface ImageUploadContext { app: App; settings: HaloSetting; site: HaloSite; client: McpClient }`
  - `uploadImage(file: TFile, ctx: ImageUploadContext): Promise<string>`
  - `uploadImages(options: { silent?: boolean; replaceMarkdown?: boolean }, ctx: ImageUploadContext): Promise<UploadImagesResult>`
  - `restoreCachedLocalImageLinks(markdown: string, ctx: ImageUploadContext): string`
  - 类型 `UploadImagesResult` 原样从 `service/index.ts` 迁来并导出

**关键事实（实测所得）：**
- `halo_upload_attachment` 的 `contentBase64` **maxLength = 9786712**，恰好是 7 MiB（7340032 字节）的 base64 长度——所以判据是**原始字节数 > 7340032 就回退**。
- `halo_list_attachments` 的返回体里，`permalink` 是**扁平字段**（`{"permalink":"/upload/x.jpg", ...}`），而上游 REST 那边是嵌套的 `attachment.status.permalink`。**字段路径不同**，且同样需要补站点前缀。

- [ ] **Step 1: 写失败测试**

创建 `tests/service/image-upload.test.ts`：

```ts
import { MCP_UPLOAD_MAX_BYTES, toBase64 } from "src/service/image-upload";

describe("toBase64", () => {
  it("编码已知字节", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(toBase64(bytes.buffer as ArrayBuffer)).toBe("aGVsbG8=");
  });

  it("能处理超过单个 spread 上限的数组，不爆栈", () => {
    // String.fromCharCode(...bytes) 在 7 MiB 的数组上会抛 RangeError，
    // 所以实现必须分块。这里用超过分块大小的数据守住这个性质。
    const big = new Uint8Array(MCP_UPLOAD_MAX_BYTES / 2);
    expect(() => toBase64(big.buffer)).not.toThrow();
    expect(toBase64(big.buffer).length).toBeGreaterThan(0);
  });

  it("空数组编码为空串", () => {
    expect(toBase64(new ArrayBuffer(0))).toBe("");
  });
});

describe("MCP_UPLOAD_MAX_BYTES", () => {
  it("恰好是 7 MiB", () => {
    expect(MCP_UPLOAD_MAX_BYTES).toBe(7 * 1024 * 1024);
    expect(MCP_UPLOAD_MAX_BYTES).toBe(7340032);
  });
});
```

再追加上传路径的**边界**用例。用 `tests/setup.ts` 里被 mock 的 `requestUrl` 与一个假的 `McpClient`：

```ts
import type { McpClient } from "src/transport/mcp-client";

function createFakeClient(responder: (name: string, args: Record<string, unknown>) => unknown) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    callToolJson: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return responder(name, args);
    },
  } as unknown as McpClient;
  return { client, calls };
}

describe("uploadImage（≤7 MiB 走 MCP，>7 MiB 回退 REST）", () => {
  /** 造一个指定字节数的假图片文件与对应的 app / settings / site */
  function setup(sizeInBytes: number, siteToken = "") {
    const file = createFile("assets/a.png");
    const data = new ArrayBuffer(sizeInBytes);
    const app = createMockApp({
      vault: { readBinary: async () => data, getAbstractFileByPath: () => file },
    });
    const settings = createSettings();
    const site = { name: "s", url: "https://blog.example.com", token: siteToken, mcpToken: "hmcp_x", default: true };

    return { file, app, settings, site };
  }

  it("恰好等于 7 MiB 走 MCP（上限是闭区间）", async () => {
    const { client, calls } = createFakeClient(() => ({ permalink: "/upload/a.png" }));
    const { file, app, settings, site } = setup(MCP_UPLOAD_MAX_BYTES);

    await uploadImage(file, { app, settings, site, client });

    expect(calls.map((call) => call.name)).toEqual(["halo_upload_attachment"]);
  });

  it("超过 7 MiB 时回退 REST，不打 MCP 工具", async () => {
    const { client, calls } = createFakeClient(() => ({ permalink: "/upload/a.png" }));
    const { file, app, settings, site } = setup(MCP_UPLOAD_MAX_BYTES + 1, "pat_x");
    const requestUrlMock = requestUrl as unknown as RequestUrlMock;
    requestUrlMock.mockResolvedValue({ json: { status: { permalink: "/upload/a.png" } } });

    await uploadImage(file, { app, settings, site, client });

    expect(calls).toHaveLength(0);
    expect(requestUrlMock).toHaveBeenCalledTimes(1);
  });

  it("超过 7 MiB 但没配 PAT 时给出可操作的错误，不发注定 401 的请求", async () => {
    const { client, calls } = createFakeClient(() => ({ permalink: "/upload/a.png" }));
    const { file, app, settings, site } = setup(MCP_UPLOAD_MAX_BYTES + 1, "");
    const requestUrlMock = requestUrl as unknown as RequestUrlMock;

    await expect(uploadImage(file, { app, settings, site, client })).rejects.toBeInstanceOf(McpError);

    expect(requestUrlMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("MCP 返回相对 permalink 时补上站点前缀", async () => {
    const { client } = createFakeClient(() => ({ permalink: "/upload/a.png" }));
    const { file, app, settings, site } = setup(1024);

    expect(await uploadImage(file, { app, settings, site, client })).toBe("https://blog.example.com/upload/a.png");
  });

  it("MCP 返回绝对 URL 时原样返回，不重复拼接", async () => {
    const { client } = createFakeClient(() => ({ permalink: "https://cdn.example.com/a.png" }));
    const { file, app, settings, site } = setup(1024);

    expect(await uploadImage(file, { app, settings, site, client })).toBe("https://cdn.example.com/a.png");
  });

  it("base64 编码的是真实字节，不是文件名占位", async () => {
    const { client, calls } = createFakeClient(() => ({ permalink: "/upload/a.png" }));
    const file = createFile("assets/a.png");
    const app = createMockApp({
      vault: { readBinary: async () => new TextEncoder().encode("hello").buffer, getAbstractFileByPath: () => file },
    });
    const settings = createSettings();
    const site = { name: "s", url: "https://blog.example.com", token: "", mcpToken: "hmcp_x", default: true };

    await uploadImage(file, { app, settings, site, client });

    expect(calls[0].args.contentBase64).toBe("aGVsbG8=");
  });
});
```

> 上面的 `createMockApp` / `createFile` / `createSettings` 是 `tests/service/index.test.ts` 里**已经存在**的脚手架，照抄用法。
> **若 `createMockApp()` 不接受覆盖参数**，就地扩展它以接受一个 partial 覆盖（它就在同一个测试文件里），
> **不要**另起一套平行的 mock 基建——两套 mock 早晚会漂移。
> `requestUrl as unknown as RequestUrlMock` 的取用方式见 `CLAUDE.md` 的「测试约定」。

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test tests/service/image-upload.test.ts
```

预期：FAIL，`Cannot find module 'src/service/image-upload'`。

- [ ] **Step 3: 建文件，搬运缓存与解析逻辑**

创建 `src/service/image-upload.ts`，**剪切粘贴**搬入（行号指当前 `src/service/index.ts`）：

| 现成员 | 现位置 | 新形态 |
|---|---|---|
| `UploadImagesResult` 类型 | 24–31 | 迁入并 `export` |
| `createMultipartBody` | 1059–1082 | 迁入；依赖 `randomUUID`（`src/utils/id`）与 `IMAGE_MIME_TYPES` |
| `normalizePermalink` | 767–783 | 迁入；`this.site.url` → `ctx.site.url` |
| `isSameImageFile` | 662–664 | 迁入（纯函数） |
| `getCachedImagePermalink` | 621–629 | 迁入；`ctx.settings` / `ctx.site` |
| `cacheImagePermalink` | 631–643 | 同上 |
| `cacheImageReference` | 645–660 | 同上 |
| `getCachedLocalImageEntry` | 740–757 | 迁入；`ctx.app.vault` / `ctx.settings` / `ctx.site` |
| `restoreCachedLocalImageLinks` | 666–738 | 迁入；内部调用改 Task 2 的模块函数，并透传 `ctx` |
| `uploadImages` | 493–595 | 迁入；`this.app` → `ctx.app`，`this.settings` → `ctx.settings`，`this.uploadImage(...)` → `uploadImage(..., ctx)` |

- [ ] **Step 4: 写两条上传路径**

在 `src/service/image-upload.ts` 里新增：

```ts
/** MCP base64 上传的硬上限：7 MiB。恰好等于它仍走 MCP，超出才回退 REST。 */
export const MCP_UPLOAD_MAX_BYTES = 7 * 1024 * 1024;

/**
 * 分块编码 base64。
 *
 * 必须分块：`String.fromCharCode(...bytes)` 在 7 MiB 的数组上会因参数过多抛 RangeError，
 * 而这个上限正是我们要支持的大小。
 */
export function toBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

/** 相对 permalink 补站点前缀；已是绝对 URL 的原样返回 */
function toAbsolutePermalink(permalink: string, siteUrl: string): string {
  if (permalink.startsWith("http://") || permalink.startsWith("https://")) {
    return permalink;
  }

  return `${siteUrl}${permalink}`;
}

interface AttachmentResult {
  permalink?: string;
}

/** 走 MCP base64 上传（≤ 7 MiB 的主路径） */
async function uploadImageViaMcp(file: TFile, ctx: ImageUploadContext): Promise<string> {
  const data = await ctx.app.vault.readBinary(file);
  const attachment = await ctx.client.callToolJson<AttachmentResult>("halo_upload_attachment", {
    filename: file.name,
    contentBase64: toBase64(data),
    mediaType: IMAGE_MIME_TYPES[file.extension.toLowerCase()] || "application/octet-stream",
  });

  if (!attachment?.permalink) {
    throw new Error("Halo MCP attachment response has no permalink");
  }

  return toAbsolutePermalink(attachment.permalink, ctx.site.url);
}

/** 走 REST multipart 上传：仅用于超过 7 MiB 的图片，需要 PAT */
async function uploadImageViaRest(file: TFile, ctx: ImageUploadContext): Promise<string> {
  const data = await ctx.app.vault.readBinary(file);
  const body = createMultipartBody(file.name, file.extension, data);
  const attachment = (await requestUrl({
    url: `${ctx.site.url}/apis/uc.api.storage.halo.run/v1alpha1/attachments/-/upload`,
    method: "POST",
    contentType: body.contentType,
    headers: { Authorization: `Bearer ${ctx.site.token}` },
    body: body.data,
  }).json) as { status?: { permalink?: string } };

  const permalink = attachment.status?.permalink;

  if (!permalink) {
    throw new Error("Halo attachment response has no permalink");
  }

  return toAbsolutePermalink(permalink, ctx.site.url);
}

/**
 * 上传单张图片并返回 permalink。
 *
 * 分流：≤ 7 MiB 走 MCP；> 7 MiB 回退 REST（MCP 有硬上限，见 spec §4.4）。
 * 回退需要 PAT —— 没配就给出可操作的错误，而不是发一个注定 401 的请求。
 */
export async function uploadImage(file: TFile, ctx: ImageUploadContext): Promise<string> {
  const data = await ctx.app.vault.readBinary(file);

  if (data.byteLength > MCP_UPLOAD_MAX_BYTES) {
    if (!ctx.site.token) {
      throw new McpError("unknown", { size: data.byteLength });
    }

    return uploadImageViaRest(file, ctx);
  }

  return uploadImageViaMcp(file, ctx);
}
```

> 注意 `uploadImage()` 里先 `readBinary` 判大小、再让两条路径各自 `readBinary`——**这是刻意的**：判大小需要字节数，而把 `ArrayBuffer` 传进两条路径会让签名复杂化。读两次本地文件比让签名多一个可选大参数更简单，且 `readBinary` 是本地操作。
> 若你认为这不可接受，改成把 `ArrayBuffer` 作为第三参数传入两条路径亦可，但**两条路径的行为必须一致**。

- [ ] **Step 5: 更新 `src/service/index.ts` 改为委托**

- import 区引入 `uploadImage` / `uploadImages` / `restoreCachedLocalImageLinks` / `ImageUploadContext`
- `uploadImage(file)` 与 `uploadImages(options)` 变成薄包装：构造 `ctx`（`{ app: this.app, settings: this.settings, site: this.site, client: this.client }`）后调用模块函数
- 删掉已迁走的私有方法；`uploadPostContent` 之类若失去引用一并清理（`pnpm exec tsc --noEmit` 会告诉你）
- `src/service/index.ts` 需要一个 `client` 字段。**本任务先加上**，Task 4 才真正用它：

```ts
  /**
   * MCP 客户端。**可注入**——测试传 `createFakeClient()` 造的对象，生产代码不传、用真实的。
   * 可注入是本计划全部服务层测试的前提：`McpClient` 内部走 `requestUrl`，
   * 而测试要断言的是「调了哪个工具、传了什么参数」，不是「发了什么 HTTP 请求」。
   */
  private readonly client: McpClient;

  // 构造函数签名改为四参（第四个可选），并在 existing 赋值之后加：
  // this.client = client ?? new McpClient({ endpoint: mcpEndpointOf(site), token: site.mcpToken });
```

（import：`import { McpClient } from "../transport/mcp-client";`、`import { mcpEndpointOf } from "../settings";`）

- [ ] **Step 6: 迁移 `HaloService.uploadImages` 的 7 个既有用例**

这一步**不可跳过**。`tests/service/index.test.ts:205-440` 的 7 个用例现在 mock 的是 `requestUrl`，
而 ≤7 MiB 的图片已经不走 REST 了——它们会红。逐个改成 mock `McpClient`：

| 用例 | 行 | 迁移要点 |
|---|---|---|
| `uploads local markdown and wiki images, skips remote images, and writes replaced markdown` | 210 | 断言"远程图片被跳过、本地图片被替换"，改为断言 `halo_upload_attachment` 的调用次数与返回 permalink 的替换结果 |
| `leaves remote-only markdown from Halo updates untouched` | 257 | 断言没有任何上传调用（`calls` 为空） |
| `uploads encoded markdown image targets wrapped in angle brackets` | 282 | 同上，重点在路径解析，与后端无关 |
| `returns uploaded markdown without modifying the note when replacement is disabled` | 302 | 同上 |
| `reuses a valid local upload cache entry instead of uploading again` | 324 | **断言缓存命中时 `calls` 为空**——这条在新架构下更有价值 |
| `ignores stale cache entries and refreshes the cache after upload` | 359 | 断言失效缓存触发一次上传 |
| `does not write partial markdown when one image upload fails` | 395 | ⚠️ **红线用例**。改成让 `callToolJson` 对其中一张图抛错，断言**本地文件未被改写** |

- [ ] **Step 7: 运行全套确认通过**

```bash
pnpm test
```

预期：新文件用例全过；`HaloService.uploadImages` 的 7 个用例**断言含义不变**地通过；
全套 = Task 2 之后的数字 + 本任务新增数。任何一条既有用例被删或断言被放宽，本任务不成立。

- [ ] **Step 8: 提交**

```bash
git add src/service tests/service
git commit -m "refactor(service): 抽 image-upload.ts，≤7MiB 走 MCP base64、超出回退 REST"
```

---

## Task 4: 发布与发布状态改走 MCP

**Files:**
- Modify: `src/service/index.ts`
- Test: `tests/service/index.test.ts`

**Interfaces:**
- Consumes: `McpClient.callToolJson`（Task 1）；`local-content.ts` 的 `applyPostFrontmatter` / `collectLocalImageReferences`（Task 2）；既有 `getCategoryNames` / `getTagNames`（本任务**暂不改**，Task 5 才改）
- Produces（`service/index.ts` 内部）：
  - `private toCreateArgs(params: Post, raw: string): Record<string, unknown>`
  - `private toUpdateArgs(params: Post, raw: string): Record<string, unknown>`
  - `publishPost` / `changePostPublish` 的 MCP 实现

> **本任务为什么不碰那 6 个字段**：计划 3 才把 `visible` / `pinned` / `priority` / `publishTime` / `allowComment` / `template` 从 frontmatter 读出来。
> 此刻它们仍是 `publishPost` 里那个 `Post` 字面量的初始值（`visible: "PUBLIC"`、`pinned: false`……）。
> 本任务只做**投影**——把已有对象映射成 MCP 入参，行为逐位保持。这样计划 3 只需改 `applyPostFrontmatter` 一处，不必再动发布逻辑。

- [ ] **Step 1: 写失败测试**

追加到 `tests/service/index.test.ts`。断言**工具名与关键入参**：

```ts
describe("publishPost 走 MCP", () => {
  it("新建文章时调 halo_create_post，且 rawType 显式传 markdown", async () => {
    // ... 用 createFakeClient 捕获 calls
    const create = calls.find((call) => call.name === "halo_create_post");
    expect(create).toBeDefined();
    expect(create?.args.rawType).toBe("markdown");
  });

  it("新建文章不传 content，交给服务端渲染", async () => {
    expect(create?.args.content).toBeUndefined();
  });

  it("publishTime 为空时传 null 或省略，绝不留空字符串", async () => {
    const value = create?.args.publishTime;
    expect(value === null || value === undefined).toBe(true);
  });

  it("已发布文章走 halo_update_post，而不是再建一篇", async () => {
    const names = calls.map((call) => call.name);
    expect(names).toContain("halo_update_post");
    expect(names).not.toContain("halo_create_post");
  });

  it("frontmatter 有 publish: true 时调 halo_set_post_publish_state 且 publish 为 true", async () => {
    const state = calls.find((call) => call.name === "halo_set_post_publish_state");
    expect(state?.args).toEqual({ name: expect.any(String), publish: true });
  });

  it("frontmatter 无 publish 且 publishByDefault 为 false 时不调发布状态工具", async () => {
    expect(calls.some((call) => call.name === "halo_set_post_publish_state")).toBe(false);
  });
});

describe("changePostPublish 走 MCP", () => {
  it("publish 为 false 时调 halo_set_post_publish_state 并传 publish: false", async () => {
    await service.changePostPublish("abc", false);
    expect(calls.at(-1)).toEqual({ name: "halo_set_post_publish_state", args: { name: "abc", publish: false } });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test tests/service/index.test.ts
```

预期：FAIL —— 调用的是 `requestUrl`（REST），`calls` 里没有 MCP 工具名。

- [ ] **Step 3: 加入参投影**

在 `src/service/index.ts` 里加两个私有方法：

```ts
  /**
   * 把 Post 投影成 `halo_create_post` 的入参。
   *
   * 两条硬约束（见 Global Constraints）：
   * - `rawType` 必须显式传 `"markdown"` —— schema 默认值是 `"html"`，漏传会把 Markdown 当 HTML 存；
   * - `publishTime` 空值时传 `null`，**不能传空字符串**（schema 要求 date-time）。
   * 另外刻意不传 `content`：schema 说它默认取 `raw`，交给服务端渲染即可。
   */
  private toCreateArgs(params: Post, raw: string): Record<string, unknown> {
    return {
      ...this.toUpdateArgs(params, raw),
      // 新建时默认推草稿；是否发布由随后的 set_post_publish_state 决定（与上游行为一致）
      publish: false,
    };
  }

  /** 把 Post 投影成 `halo_update_post` 的入参。注意该工具没有 `publish`。 */
  private toUpdateArgs(params: Post, raw: string): Record<string, unknown> {
    return {
      name: params.metadata.name,
      title: params.spec.title,
      slug: params.spec.slug || undefined,
      raw,
      rawType: "markdown",
      cover: params.spec.cover || null,
      excerpt: params.spec.excerpt.autoGenerate ? null : params.spec.excerpt.raw || null,
      autoGenerateExcerpt: params.spec.excerpt.autoGenerate,
      categories: params.spec.categories,
      tags: params.spec.tags,
      visible: params.spec.visible,
      pinned: params.spec.pinned,
      priority: params.spec.priority,
      publishTime: params.spec.publishTime || null,
      allowComment: params.spec.allowComment,
      template: params.spec.template || null,
    };
  }
```

- [ ] **Step 4: 改写 `publishPost` 的两个分支**

把 `publishPost` 里 `withPublishRetry` 包裹的那段（现 197–276 行）替换成：

```ts
      params = await this.withPublishRetry(async () => {
        if (remotePostName) {
          const latestPost = await this.getPostResource(remotePostName);

          params = applyPostFrontmatter(latestPost, {
            activeFile,
            categoryNames,
            matterData,
            tagNames,
            useActiveFileDefaults: false,
          });

          // 上游原本分两步写（PUT post + PUT draft 快照），MCP 的 update_post 带 raw
          // 即同时更新元数据与可编辑内容，两次请求合成一次。
          return this.client.callToolJson<Post>("halo_update_post", this.toUpdateArgs(params, raw));
        }

        if (!params.metadata.name) {
          params.metadata.name = randomUUID();
        }

        params = applyPostFrontmatter(params, {
          activeFile,
          categoryNames,
          matterData,
          tagNames,
          useActiveFileDefaults: true,
        });

        return this.client.callToolJson<Post>("halo_create_post", this.toCreateArgs(params, raw));
      });

      // 发布状态独立于内容：上游用 changePostPublish，MCP 是 set_post_publish_state
      if (matterData?.halo?.hasOwnProperty("publish")) {
        await this.changePostPublish(params.metadata.name, Boolean(matterData.halo.publish));
      } else if (this.settings.publishByDefault) {
        await this.changePostPublish(params.metadata.name, true);
      }
```

> **注意 `hasOwnProperty` 那段的语义**：上游是「frontmatter 明确写了 `publish` 就听它的，没写才看 `publishByDefault`」。
> 改写后必须保持这个优先级——`matterData.halo.publish` 为显式 `false` 时要**主动退回草稿**，不能因为 `publishByDefault` 而发布。
> 上方代码用 `Boolean(...)` 保留了这个区分（`false` 与 `undefined` 在 `hasOwnProperty` 分支内被分开处理）。

再把紧随其后的 `params = (await this.getPost(...))?.post || params;` 一行改为直接复用返回值（MCP 的 `update_post`/`create_post` 已返回最新 Post）：

```ts
      params = (await this.getPost(params.metadata.name))?.post || params;
```

保持原样即可（`getPost` 将在 Task 5 改为 MCP；本任务它仍走 REST，**因此本任务结束时发布路径是 MCP 写 + REST 读的混合态，这是刻意的**——Task 5 收口）。

- [ ] **Step 5: 改写 `changePostPublish`**

```ts
  public async changePostPublish(name: string, publish: boolean): Promise<void> {
    await this.client.callToolJson("halo_set_post_publish_state", { name, publish });
  }
```

- [ ] **Step 6: 迁移 `HaloService.publishPost` 的 2 个既有用例**

`tests/service/index.test.ts:584` 起的两条也要改 mock：

| 用例 | 行 | 迁移要点 |
|---|---|---|
| `retries draft update failures before showing publish failure` | 589 | ⚠️ **红线用例**。让 `callToolJson("halo_update_post", ...)` 前两次抛错、第三次成功，断言最终成功；再让三次全抛，断言弹出 `service.error_publish_failed`。**3 次重试的语义一字不能改** |
| `publishes the provided markdown instead of rereading the local note` | 697 | 断言传给 `halo_create_post`/`halo_update_post` 的 `raw` 就是传入的 markdown，而不是重新读盘的内容 |

> 第一条用例名里的「draft update」指的是上游那步 `PUT .../draft`——MCP 之后这一步没有了。
> **不要因此删掉重试断言**：重试包住的是整个发布事务，与具体几步写入无关。

- [ ] **Step 7: 运行测试确认通过**

```bash
pnpm test
```

预期：新增用例全过；`HaloService.publishPost` 的 2 条断言含义不变地通过。

- [ ] **Step 8: 提交**

```bash
git add src/service/index.ts tests/service/index.test.ts
git commit -m "feat(service): 发布与发布状态改走 MCP，rawType 显式 markdown"
```

---

## Task 5: `post-mapping.ts` 适配器 + 读取路径改走 MCP

**Files:**
- Create: `src/service/post-mapping.ts`
- Modify: `src/service/index.ts`
- Test: `tests/service/post-mapping.test.ts`, `tests/service/index.test.ts`

**Interfaces:**
- Consumes: `McpClient.callToolJson`（Task 1）
- Produces：
  - 类型：`McpPostItem`、`McpCategoryItem`、`McpTagItem`、`McpGetPostResult`
  - `toPost(item: McpPostItem): Post`
  - `toContent(content: McpGetPostResult["content"]): Content`
  - `generateResourceName(prefix: "category" | "tag"): string`
  - `getPost(name): Promise<{ post: Post; content: Content }>`（**改为失败即抛，不再返回 `undefined`**）
  - `getCategories(): Promise<McpCategoryItem[]>`、`getTags(): Promise<McpTagItem[]>`

> ### 为什么必须新增这个文件（spec §4.1 没列它）
>
> 实测发现：**MCP 的文章/分类表示是扁平的**（`item.title`、`item.categories`、`item.displayName`），
> 而 REST 那边是嵌套的（`post.spec.title`、`post.metadata.name`、`item.spec.displayName`）。
> 服务层现有每一处消费点都读嵌套路径——`applyPostFrontmatter`（`src/service/local-content.ts`）、
> `toUpdateArgs`（Task 4）、`updatePost` / `pullPost`（Task 6）全在内。
>
> 两条路：① 改所有消费点去读扁平字段；② 加一层适配器把扁平转回嵌套。
> **选 ②**。①会让本次 diff 从「换个后端」变成「服务层重写」，评审再也分不清哪一行是真正的改动；
> 而适配器是纯函数、可单测、只有一处。**这是本计划唯一的架构取舍，如果评审不同意，改 ① 也可以，但那要重写 Task 4–6。**

- [ ] **Step 1: 写适配器测试**

创建 `tests/service/post-mapping.test.ts`。fixture 取自**实抓的 `halo_get_post` 返回体**（字段已删减为结构骨架）：

```ts
import { McpError } from "src/transport/errors";
import { toContent, toPost } from "src/service/post-mapping";

const ITEM = {
  name: "real-ip-always-there-and-forgery",
  title: "真实 IP 一直在",
  slug: "real-ip-always-there-and-forgery",
  excerpt: "摘要",
  excerptRaw: "摘要",
  autoGenerateExcerpt: false,
  cover: "/upload/a.webp",
  template: "",
  pinned: true,
  priority: 3,
  publishTime: "2026-10-01T12:10:43.104320897Z",
  allowComment: false,
  published: true,
  visible: "PUBLIC",
  categories: ["category-sc9pomuo"],
  tags: ["tag-tnpxywrp"],
};

describe("toPost", () => {
  it("把扁平字段还原成 {metadata, spec} 嵌套结构", () => {
    const post = toPost(ITEM);
    expect(post.metadata.name).toBe("real-ip-always-there-and-forgery");
    expect(post.spec.title).toBe("真实 IP 一直在");
    expect(post.spec.visible).toBe("PUBLIC");
    expect(post.spec.pinned).toBe(true);
    expect(post.spec.priority).toBe(3);
    expect(post.spec.allowComment).toBe(false);
    expect(post.spec.publishTime).toBe("2026-10-01T12:10:43.104320897Z");
  });

  it("excerpt 还原成 {autoGenerate, raw} 结构", () => {
    expect(toPost(ITEM).spec.excerpt).toEqual({ autoGenerate: false, raw: "摘要" });
  });

  it("autoGenerateExcerpt 为 true 时 raw 取空串，交给服务端生成", () => {
    const post = toPost({ ...ITEM, autoGenerateExcerpt: true });
    expect(post.spec.excerpt).toEqual({ autoGenerate: true, raw: "" });
  });

  it("categories / tags 原样搬运（它们是 metadata.name 数组，不是显示名）", () => {
    expect(toPost(ITEM).spec.categories).toEqual(["category-sc9pomuo"]);
    expect(toPost(ITEM).spec.tags).toEqual(["tag-tnpxywrp"]);
  });

  it("缺字段时不抛错，给出安全默认值", () => {
    const post = toPost({ name: "x" } as never);
    expect(post.spec.visible).toBe("PUBLIC");
    expect(post.spec.categories).toEqual([]);
    expect(post.spec.tags).toEqual([]);
  });
});

describe("generateResourceName", () => {
  it("与站点现存的 category-xxxxxxxx 同形", () => {
    expect(generateResourceName("category")).toMatch(/^category-[a-z0-9]{8}$/);
    expect(generateResourceName("tag")).toMatch(/^tag-[a-z0-9]{8}$/);
  });

  it("两次调用不重复", () => {
    const names = new Set(Array.from({ length: 200 }, () => generateResourceName("tag")));
    expect(names.size).toBe(200);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test tests/service/post-mapping.test.ts
```

预期：FAIL，`Cannot find module 'src/service/post-mapping'`。

- [ ] **Step 3: 实现适配器**

创建 `src/service/post-mapping.ts`：

```ts
import type { Content, Post } from "@halo-dev/api-client";

/**
 * MCP 的文章表示是**扁平**的，与 REST 的 {metadata, spec} 嵌套不同。
 * 字段来自 2026-10-03 对真实站点的实测（`halo_get_post` / `halo_list_posts`）。
 */
export interface McpPostItem {
  name?: string;
  title?: string;
  slug?: string;
  excerpt?: string;
  excerptRaw?: string;
  autoGenerateExcerpt?: boolean;
  cover?: string;
  template?: string;
  pinned?: boolean;
  priority?: number;
  publishTime?: string;
  allowComment?: boolean;
  visible?: "PUBLIC" | "INTERNAL" | "PRIVATE";
  categories?: string[];
  tags?: string[];
}

/** MCP 的分类表示同样是扁平的（实测 `halo_list_categories`） */
export interface McpCategoryItem {
  name: string;
  displayName: string;
  slug?: string;
  priority?: number;
}

export interface McpTagItem {
  name: string;
  displayName: string;
  slug?: string;
}

export interface McpGetPostResult {
  item: McpPostItem;
  content: { snapshotName?: string; rawType?: string; raw?: string };
  /** ⚠️ 服务端可能截断长正文；为 true 时绝不能把内容当完整文章使用 */
  truncated?: boolean;
}

/** 把 MCP 的扁平文章表示还原成领域模型 Post，让既有消费点无需改动 */
export function toPost(item: McpPostItem): Post {
  return {
    apiVersion: "content.halo.run/v1alpha1",
    kind: "Post",
    metadata: { name: item.name ?? "", annotations: {} },
    spec: {
      title: item.title ?? "",
      slug: item.slug ?? "",
      cover: item.cover ?? "",
      template: item.template ?? "",
      pinned: item.pinned ?? false,
      priority: item.priority ?? 0,
      publishTime: item.publishTime ?? "",
      allowComment: item.allowComment ?? true,
      visible: item.visible ?? "PUBLIC",
      publish: false,
      excerpt: {
        autoGenerate: item.autoGenerateExcerpt ?? true,
        // autoGenerate 时 raw 交给服务端生成，本地留空
        raw: item.autoGenerateExcerpt ? "" : (item.excerptRaw ?? item.excerpt ?? ""),
      },
      categories: item.categories ?? [],
      tags: item.tags ?? [],
      htmlMetas: [],
    },
  } as Post;
}

export function toContent(content: McpGetPostResult["content"]): Content {
  return {
    content: "",
    raw: content.raw ?? "",
    rawType: content.rawType ?? "markdown",
  } as Content;
}

/**
 * 生成 Halo 风格的资源 name。
 *
 * REST 有 `metadata.generateName` 让服务端造 name，**MCP 没有等价物**——
 * `halo_create_category` / `halo_create_tag` 都要求显式传 name，所以这一步搬到了客户端。
 * 形态与站点现存数据 (`category-sc9pomuo` / `tag-tnpxywrp`) 保持一致：前缀 + 8 位小写字母数字。
 * 36^8 ≈ 2.8e12，撞名概率可忽略。
 */
export function generateResourceName(prefix: "category" | "tag"): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";

  for (let index = 0; index < 8; index++) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }

  return `${prefix}-${suffix}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm test tests/service/post-mapping.test.ts
```

预期：全过。

- [ ] **Step 5: 把读取路径接到 MCP**

在 `src/service/index.ts` 里：

1. 删掉 `getPostResource` 与 `getPostDraft`（它们的 REST 实现与 `Snapshot` 类型不再需要）。
2. 改写 `getPost`，并**移除原先那个吞掉一切的 `try/catch`**：

```ts
  /**
   * 读取一篇文章的元数据与可编辑正文。
   *
   * 与上游的差异（刻意的）：
   * - 上游要发两次请求（post 资源 + draft 快照），MCP 的 `halo_get_post` 一次返回两者；
   * - 上游把所有失败都吞成 `undefined`，导致网络故障被显示成「文章不存在」。现在失败即抛，
   *   由调用方决定文案 —— Task 6 会修好两个调用点。
   */
  public async getPost(name: string): Promise<{ post: Post; content: Content }> {
    const result = await this.client.callToolJson<McpGetPostResult>("halo_get_post", {
      name,
      version: "HEAD",
      format: "RAW",
    });

    if (result.truncated) {
      // 绝不能把截断的正文当完整文章写进本地文件 —— 那是静默损坏用户的笔记
      throw new McpError("unknown", { tool: "halo_get_post" }, `content truncated: ${name}`);
    }

    return { post: toPost(result.item), content: toContent(result.content) };
  }
```

3. `publishPost` 里对 `getPostResource` 的两处调用（现 199 行与 278 行）改为用 `getPost`：

```ts
          const latestPost = (await this.getPost(remotePostName)).post;
```

（278 行那处 `params = (await this.getPost(...))?.post || params;` 改为 `params = (await this.getPost(params.metadata.name)).post;`）

4. 改写 `getCategories` / `getTags` 为扁平类型：

```ts
  public async getCategories(): Promise<McpCategoryItem[]> {
    const result = await this.client.callToolJson<{ items?: McpCategoryItem[] }>("halo_list_categories", {
      size: 100,
    });
    return result.items ?? [];
  }

  public async getTags(): Promise<McpTagItem[]> {
    const result = await this.client.callToolJson<{ items?: McpTagItem[] }>("halo_list_tags", { size: 100 });
    return result.items ?? [];
  }
```

> **`size: 100` 是上限也是刻意写死的**：schema 的 `maximum` 是 100。站上现有 8 个分类、标签数量相近，
> 一页足够。**若将来超过 100 个，这里会静默漏掉后面的**——Task 7 的契约测试里加一条断言守住这个假设，
> 并在代码注释里写明「超出需要翻页」。

5. 把 `getCategoryNames` / `getTagNames` / `getCategoryDisplayNames` / `getTagDisplayNames` 改读扁平字段，
   并让缺失项通过 MCP 创建：

```ts
  /**
   * 把显示名数组解析成 metadata.name 数组，缺失的**自动创建**。
   *
   * 与上游的差异（刻意的）：
   * - 上游用 `metadata.generateName` 让服务端造 name，MCP 没有等价物 → 本地生成（`generateResourceName`）；
   * - 上游并行创建（`Promise.all`），改成**顺序创建**：创建是有副作用的写操作，
   *   顺序化让失败定位更清楚，也避免同一批里撞名；
   * - 上游把结果重排成「已存在的在前、新建的在后」，那会丢掉与入参的顺序对应关系。这里**保持入参顺序**。
   */
  public async getCategoryNames(displayNames: string[]): Promise<string[]> {
    const all = await this.getCategories();
    const names: string[] = [];

    for (const [index, displayName] of displayNames.entries()) {
      const existing = all.find((item) => item.displayName === displayName);

      if (existing) {
        names.push(existing.name);
        continue;
      }

      const created = await this.client.callToolJson<{ name?: string }>("halo_create_category", {
        name: generateResourceName("category"),
        displayName,
        slug: slugify(displayName, { trim: true }),
        priority: all.length + index,
      });

      if (created?.name) {
        names.push(created.name);
      }
    }

    return names;
  }
```

`getTagNames` 同构（用 `halo_create_tag`、`generateResourceName("tag")`、不带 `priority`）。
`getCategoryDisplayNames` / `getTagDisplayNames` 只把 `item.spec.displayName` / `item.metadata.name` 改成
`item.displayName` / `item.name`，其余逻辑不动。

- [ ] **Step 6: 迁移 `HaloService.updatePost` 的 2 个既有用例**

`tests/service/index.test.ts:442` 起的两条改 mock 为 `McpClient`：
- `restores cached local image links when image link replacement is disabled`（447）
- `keeps remote image links when image link replacement is enabled`（544）

两条断言的都是**图片链接还原行为**，与读取后端无关，迁移时**保持断言不变**，只换数据来源。

- [ ] **Step 7: 运行全套**

```bash
pnpm test
```

预期：全过。若 `publishPost` 的两条用例此时变红，**那是预期的**——它们归 Task 4 已迁移，
此时若因 `getPost` 签名变化（不再返回 `undefined`）而红，回 Task 4 的迁移处把 `?.post` 去掉即可。

- [ ] **Step 8: 提交**

```bash
git add src/service tests/service
git commit -m "feat(service): 读取与分类标签改走 MCP，新增扁平→嵌套适配器"
```

---

## Task 6: 更新与拉取改走 MCP

**Files:**
- Modify: `src/service/index.ts`
- Test: `tests/service/index.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `getPost`（失败即抛）、`getCategoryDisplayNames` / `getTagDisplayNames`
- Produces: `updatePost()` / `pullPost(name)` 的调用语义——**失败时给出可操作的文案，而不是「文章不存在」**

> Task 5 让 `getPost` 从「失败返回 `undefined`」变成「失败即抛」，本任务收口那两个调用点。
> 这是刻意的分步：读取语义与调用点处理分开审，评审能独立判断「抛错是否是对的」与「调用点接得对不对」。

- [ ] **Step 1: 写失败测试**

```ts
describe("updatePost / pullPost 的错误处理", () => {
  it("读取失败时提示的是真实原因，而不是「文章不存在」", async () => {
    const { client } = createFakeClient(() => {
      throw new McpError("unauthorized", { status: 401 });
    });
    const service = new HaloService(createMockApp(), createSettings(), createSite(), client);
    await service.updatePost();
    expect(notices.at(-1)).not.toBe(i18next.t("service.error_post_not_found"));
  });

  it("读取成功但 truncated 为 true 时，pullPost 不写文件", async () => {
    // 服务端截断长正文时，绝不能把半个文件写进 vault
    const { client } = createFakeClient(() => ({
      item: { name: "big-post", title: "长文" },
      content: { rawType: "markdown", raw: "前半段……" },
      truncated: true,
    }));
    const service = new HaloService(createMockApp(), createSettings(), createSite(), client);
    await expect(service.pullPost("big-post")).rejects.toBeInstanceOf(McpError);
    expect(vaultCreate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test tests/service/index.test.ts
```

预期：FAIL —— 当前实现里 `getPost` 不抛错，或抛错后未被捕获。

- [ ] **Step 3: 改造两个调用点**

`updatePost`（现 419–462 行）与 `pullPost`（现 464–491 行）的读取都改成：

```ts
    let post: { post: Post; content: Content };

    try {
      post = await this.getPost(matterData.halo.name);
    } catch (error) {
      // 不要把它说成「文章不存在」——网络故障、密钥失效、站点侧工具缺失都会走到这里，
      // 而这三者的处置完全不同。把服务端原文带给用户。
      new Notice(
        i18next.t("service.error_fetch_post_failed", {
          message: error instanceof McpError ? (error.detail ?? "") : String(error),
        }),
      );
      return;
    }
```

两处 `post.post.spec.X` / `post.content.raw` 的用法**保持不变**（适配器已还原嵌套结构）。

- [ ] **Step 4: 补 i18n 键（三份 locale 同步）**

在 `src/i18n/locales/{en,zh-cn,zh-tw}.json` 的 `service` 段各加一条：

```jsonc
// zh-cn
"error_fetch_post_failed": "读取文章失败：{{message}}"
// zh-tw
"error_fetch_post_failed": "讀取文章失敗：{{message}}"
// en
"error_fetch_post_failed": "Failed to read the post: {{message}}"
```

- [ ] **Step 5: 运行全套**

```bash
pnpm test
```

预期：全过。

- [ ] **Step 6: 手工验证一次拉取（关键的一步）**

在 Obsidian 里对一篇**真实存在的**长文章执行「Halo: 从 Halo 拉取文章」，确认：
1. 拉下来的正文完整（与站点上对照首尾两段）；
2. frontmatter 的 `halo.name` / `halo.site` 正确写入；
3. 图片链接是远程地址。

**这一步不能用单测替代**：`truncated` 是服务端行为，只有真拉一篇才知道阈值在哪。把结果记进报告。

- [ ] **Step 7: 提交**

```bash
git add src/service src/i18n tests
git commit -m "feat(service): 更新与拉取改走 MCP，失败文案给出真实原因"
```

---

## Task 7: 收尾 —— 契约测试扩工具集、README、端到端清单

**Files:**
- Modify: `tests/contract/mcp-contract.test.ts`, `src/mcp-self-check.ts`, `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: `REQUIRED_TOOLS`（`src/mcp-self-check.ts`）
- Produces: 契约测试与本计划实际用到的工具集对齐；README/CLAUDE.md 反映新现状

- [ ] **Step 1: 把本计划用到的工具加进 `REQUIRED_TOOLS`**

`src/mcp-self-check.ts` 的 `REQUIRED_TOOLS` 目前 13 项。本计划新增用到的：

```
halo_create_post
halo_update_post
halo_get_post
halo_set_post_publish_state
halo_update_attachment → 实际是 halo_upload_attachment
halo_list_categories
halo_create_category
halo_list_tags
halo_create_tag
```

**逐条核对后再加**——不要照抄上面这一串（我故意在中间留了一个不存在的名字）。
核实方法：`halo_list_posts` / `tools/list` 的真实返回里 `name` 字段就是权威。
**自检的作用正是「站点侧工具缺失时提前发现」，漏加就等于这条防线有缺口。**

- [ ] **Step 2: 同步更新契约测试的期望**

`tests/contract/mcp-contract.test.ts` 断言 `REQUIRED_TOOLS` 全部存在于真实站点。
`REQUIRED_TOOLS` 改了之后它自动跟着变——跑一次确认：

```bash
HALO_MCP_ENDPOINT=https://<你的站点>/mcp HALO_MCP_TOKEN="$HALO_MCP_TOKEN" pnpm test:contract
```

预期：**1 passed**，`report.missing` 为空。若报缺失，说明该工具在本站点确实没有——
**那就不要加进 `REQUIRED_TOOLS`**，改成本计划的实际实现绕开它，并在报告里说明。

> 注意：`HALO_MCP_TOKEN` 必须来自环境变量，**绝不要把真实密钥写进任何文件或报告**。

- [ ] **Step 3: 更新 README 的凭据要求栏**

`README.md:6-19` 的「当前进度与凭据要求」两列表格，把「尚未迁移（仍走 REST + PAT）」一栏里的
**发布 / 更新 / 拉取**移到「已就绪（走 MCP）」，**只留图片上传**（且注明「仅 >7 MiB 的图片」）。

改完后 PAT 的定位变成：**只有上传超过 7 MiB 的图片时才需要**。若该栏只剩这一项，
把它改写成一句说明而不是表格行，避免读者以为还有一大堆功能没迁移。

- [ ] **Step 4: 更新 CLAUDE.md**

至少改这两处（原文已经不成立）：
- 「唯一的业务层 — `src/service/index.ts`，**单类、1085 行**，装下了全部 REST 业务逻辑」→ 改成现在的分层
  （`service/index.ts` 编排 + `local-content.ts` 本地内容 + `image-upload.ts` 上传 + `post-mapping.ts` 适配）
- 「API 分了三套命名空间，用错会 403」那段：REST 命名空间的知识仍要保留（图片回退还在用），
  但要补一句「MCP 路径不经这些命名空间」

- [ ] **Step 5: 跑全套 + 构建**

```bash
pnpm test && pnpm build && pnpm check
```

预期：全过；`main.js` 产出；`pnpm check` 无新增待修（那 15 个 CRLF 报错是既有假阳性，见 CLAUDE.md）。

- [ ] **Step 6: 端到端手工清单（在真实 Obsidian 里跑一遍）**

逐项确认并在报告里记录实际结果：

- [ ] 「Halo: 发布到 MCP」新建一篇 → 站点上出现**草稿**（不是已发布）
- [ ] frontmatter 写 `publish: true` 再发一次 → 站点上变成**已发布**
- [ ] 「Halo: 更新当前笔记内容」→ 本地正文被站上内容覆盖，图片链接按设置还原/保留
- [ ] 「Halo: 从 Halo 拉取文章」→ 新文件内容完整
- [ ] 「Halo: 上传图片到 Halo」→ 图片出现在站点附件列表，正文链接被替换
- [ ] **把 `mcpToken` 故意改错再发一次** → 提示是「密钥无效」类文案，且**本地文件未被改动**
- [ ] 「Halo: 连通性自检」→ 报告全部所需工具齐备

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "docs: 契约测试工具集对齐，README 与 CLAUDE.md 反映 MCP 切换后的现状"
```

---

## 完成判据（本计划什么算做完）

- [ ] `pnpm test` 全绿，且 `HaloService.uploadImages`（7）、`updatePost`（2）、`publishPost`（2）
      这 11 个既有用例**断言含义不变**地通过——**没有任何一条被删除或放宽**
- [ ] `pnpm build` 产出 `main.js`
- [ ] `REQUIRED_TOOLS` 覆盖本计划实际调用的每个工具，契约测试对真实站点 **1 passed**
- [ ] Step 6 的 7 项端到端清单全部实测通过，结果记入报告
- [ ] **PAT 不再是任何主路径的必需项**：删掉 `token` 字段后，除「>7 MiB 图片上传」外的全部功能仍可用
      （这条要真的试一次：把 `token` 清空，跑一遍发布/更新/拉取/传小图）
- [ ] `src/service/index.ts` 明显短于 1085 行；新增的三个文件各只有一项职责
- [ ] 没有新增运行时依赖（`package.json` 的 `dependencies` 未变）


