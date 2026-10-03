# 阶段 0（基座）+ MCP 传输层 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把上游 `halo-sigs/obsidian-halo` v1.2.0 引入本项目并改名为 `halo-mcp`，然后从零建起一个能被单元测试覆盖的 MCP 传输层（握手 / 工具列表 / 工具调用 / 错误归一化），并以一条"连通性自检"命令作为本阶段的可见交付物。

**Architecture:** 新增 `src/transport/` 目录承载 MCP JSON-RPC 客户端与错误归一化，与上游既有的 `src/service/`（直连 REST）暂时并存互不干扰——本阶段不动 `service/`，保证插件在改造期间始终可用。设置对象扩展 `mcpToken`（`hmcp_` 密钥）并保留 `token`（PAT，供后续 >7 MiB 图片回退用）。所有与 MCP 的通信都经过唯一入口 `McpClient`，便于单测 mock。

**Tech Stack:** TypeScript 5.1.6 / Rslib（`@rslib/core`，Rspack 系）构建 / rstest 测试 / Biome lint / pnpm 10。全部沿用上游，不引入新依赖。

**Spec:** `docs/superpowers/specs/2026-10-03-obsidian-halo-mcp-reshape-design.md`

## Global Constraints

以下为 spec 的项目级要求，**每个任务都隐含包含**，不再逐条重复：

- **插件 id 必须是 `halo-mcp`**（官方占用 `halo`，同 id 无法共存）。显示名可仍为「Halo」。
- **License 按 GPL-3.0 处理**（上游 `LICENSE` 文件是 GPL-3.0 全文，尽管 `package.json` 误写 MIT）。
- **MCP 端点固定推导规则**：`<site.url 去掉尾部斜杠>/mcp`，不新增存储字段。
- **请求头硬性要求**：`Accept` **必须**同时包含 `application/json` 与 `text/event-stream`，缺任一会被服务端判为 `400` 且**响应体为空**。
- **握手顺序硬性要求**：必须先 `initialize` 成功，才能调用 `tools/list` 或 `tools/call`；服务端**无 `Mcp-Session-Id`**（无状态），无需会话管理。
- **前置条件**：站点需 Halo ≥ 2.26 且已启用 MCP Server 插件。本阶段**不**实现 REST 回退（除后续阶段的大图上传）。
- **本阶段不得修改 `src/service/` 下的任何文件**，也不得改动任何既有命令的行为。
  - **一处刻意的例外**：Task 6 会把站点编辑弹窗的「Validate」按钮从「用 PAT 探测 REST 权限」改为「调 MCP 自检」。它不在 `src/service/` 下、也不是命令，但它确实改变了既有行为。理由：该按钮校验的是 `token`（PAT），对用户真正要填的 `mcpToken` 毫无意义——保留它等于让用户在设置页得到错误的安心感。若不认可这处例外，删掉 Task 6 Step 5 的第 4 项即可，其余不受影响。
- **不新增运行时依赖**。
- 所有面向用户的文案走 `i18next`，与上游一致。

---

## File Structure


| 文件                                  | 职责                                                                         | 状态 |
| --------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| `.gitignore`                          | 忽略`node_modules/`、构建产物、Obsidian 运行时文件                           | 创建 |
| `manifest.json`                       | 插件清单，id 改`halo-mcp`                                                    | 修改 |
| `package.json`                        | 包名与版本                                                                   | 修改 |
| `README.md`                           | 写入前置条件与开发说明                                                       | 修改 |
| `src/transport/types.ts`              | JSON-RPC 与 MCP 的类型定义                                                   | 创建 |
| `src/transport/errors.ts`             | 错误归一化（纯函数，无 IO）                                                  | 创建 |
| `src/transport/mcp-client.ts`         | MCP 客户端：握手 / tools/list / tools/call                                   | 创建 |
| `src/settings.ts`                     | `HaloSite` 增 `mcpToken`；`HaloSetting` 增 `settingsVersion`；新增迁移纯函数 | 修改 |
| `src/site-editing-modal.ts`           | 站点编辑弹窗增`mcpToken` 输入项；默认站点字面量补字段                        | 修改 |
| `src/mcp-self-check.ts`               | 连通性自检（返回结构化报告，不弹窗）                                         | 创建 |
| `src/settings-migration-modal.ts`     | 迁移提示弹窗（薄 UI 层）                                                     | 创建 |
| `src/i18n/locales/en.json`            | 新增文案键                                                                   | 修改 |
| `src/i18n/locales/zh-cn.json`         | 新增文案键                                                                   | 修改 |
| `src/i18n/locales/zh-tw.json`         | 新增文案键                                                                   | 修改 |
| `src/main.ts`                         | 注册自检命令、接入迁移                                                       | 修改 |
| `tests/transport/errors.test.ts`      | 错误归一化测试                                                               | 创建 |
| `tests/transport/mcp-client.test.ts`  | 客户端测试                                                                   | 创建 |
| `tests/settings.test.ts`              | 迁移测试（追加到既有文件）                                                   | 修改 |
| `tests/mcp-self-check.test.ts`        | 自检测试                                                                     | 创建 |
| `tests/contract/mcp-contract.test.ts` | 对真实端点的契约测试（无 token 时跳过）                                      | 创建 |

> **i18n 形态（已确认，非推测）**：`src/i18n/locales/` 下是 `en.json` / `zh-cn.json` / `zh-tw.json` 三个 JSON，由 `src/i18n/index.ts` 注册为 `i18next` 的 translation 资源。键为嵌套对象，取值走点号路径，例如 `i18next.t("command.publish.name")`。
>
> **本阶段不新增运行时依赖，因此新命令的联动文案走 i18next 既有机制**（Task 6 给出三个语言文件的确切键与值），不引入任何 i18n 工具库。

---

## Task 1: 改名为 halo-mcp 并打通构建

> **基座已完成（2026-10-03），本任务不再需要引入上游源码。** 仓库已 fork 到
> `LHY0125/obsidian-halo` 并接好两个 remote：`origin` = 我们的 fork（推送目标）、
> `upstream` = 官方源（只作参考）。上游 v1.2.0 的**完整历史与源码已在 `main` 上**，
> 我们的三个文档提交线性叠在其之上。因此本任务只剩改名、加 `.gitignore`、打通构建。

**Files:**

- Create: `.gitignore`
- Modify: `manifest.json`, `package.json`, `README.md`

**Interfaces:**

- Consumes: 已就位的 fork（`origin`）与上游源码树
- Produces: 一个能 `pnpm build` 产出 `main.js` 且插件 id 为 `halo-mcp` 的仓库；`git log 1.2.0` 可访问上游历史，`upstream/main` 可用于拉取未来更新

- [ ]  **Step 1: 核对基座状态**

```bash
cd D:/Code/doing_exercises/programs/Obsidian-Halo
git remote -v
git log --oneline -4
git status --short
```

预期：

- `origin` 指向 `git@github.com:LHY0125/obsidian-halo.git`（fetch 与 push 都是它）
- `upstream` 指向 `https://github.com/halo-sigs/obsidian-halo.git`
- `git log` 的第四行是 `Release 1.2.0`，其上是我们的三个 `docs:` 提交
- 工作区干净

若不符，先停下核对再继续——**不要**试图重新引入源码，基座已经在了。

- [ ]  **Step 2: 确认 i18n 资源形态**

```bash
ls src/i18n/locales/
```

预期输出为 `en.json  zh-cn.json  zh-tw.json` 三个文件。Task 6 需要往这三个文件里**同步**加键。若实际文件与预期不符，先停下来核对，不要凭猜测改。

- [ ]  **Step 3: 改插件清单**

修改 `manifest.json`，**只改 `id` 与 `description` 两个字段**，其余保持上游原样：

```json
{
  "id": "halo-mcp",
  "name": "Halo",
  "version": "1.2.0",
  "minAppVersion": "1.4.4",
  "description": "Publish content to Halo sites through the official Halo MCP Server",
  "author": "Ryan Wang",
  "authorUrl": "https://github.com/ruibaby",
  "isDesktopOnly": false
}
```

> `id` 是本次改名**唯一有功能意义**的字段：它决定了插件目录名与启用标识，改掉之后新插件才能与已有的官方 `halo` 插件共存。
>
> `author` / `authorUrl` **刻意保留上游署名**：本项目是 GPL-3.0 衍生作品，保留原作者署名是许可要求。等本项目成型后再另加一行 fork 说明，不要直接顶掉。`version` 暂沿用上游 `1.2.0`，首个自有版本在阶段 1 落地时再升。

- [ ]  **Step 4: 改包名**

修改 `package.json` 的 `name` 与 `version`（其余字段一律不动）：

```json
"name": "obsidian-halo-mcp",
"version": "0.1.0",
```

- [ ]  **Step 5: 加 .gitignore**

创建 `.gitignore`：

```gitignore
node_modules/
main.js
*.log
.DS_Store
data.json
```

> `data.json` 是 Obsidian 插件的本地设置文件，含 `hmcp_` 密钥与 PAT，**绝不能提交**。

- [ ]  **Step 6: 安装依赖并验证构建**

```bash
pnpm install
pnpm build
```

预期：命令成功结束，仓库根目录出现 `main.js`。

- [ ]  **Step 7: 验证既有测试仍全绿**

```bash
pnpm test
```

预期：上游既有测试全部通过（这是我们的回归基线）。

- [ ]  **Step 8: 提交**

```bash
git add -A
git commit -m "chore: 引入上游 v1.2.0 并改名为 halo-mcp"
```

---

## Task 2: 类型定义与错误归一化

**Files:**

- Create: `src/transport/types.ts`, `src/transport/errors.ts`
- Test: `tests/transport/errors.test.ts`

**Interfaces:**

- Consumes: 无
- Produces:
  - `type McpErrorKind = "protocol" | "auth" | "gateway" | "missing-tool" | "network" | "unknown"`
  - `class McpError extends Error { readonly kind: McpErrorKind; readonly detail?: string }`
  - `function classifyHttpFailure(status: number, body: string): McpError`
  - `function assertJsonBody(body: string): unknown`
  - `function missingToolError(name: string, available: string[]): McpError`

- [ ]  **Step 1: 写失败的测试**

创建 `tests/transport/errors.test.ts`：

```typescript
import { describe, expect, it } from "@rstest/core";
import { assertJsonBody, classifyHttpFailure, McpError, missingToolError } from "../../src/transport/errors";

describe("classifyHttpFailure", () => {
  it("400 且响应体为空 → protocol（这是误解 Accept 头或握手顺序的典型症状）", () => {
    const err = classifyHttpFailure(400, "");
    expect(err).toBeInstanceOf(McpError);
    expect(err.kind).toBe("protocol");
    expect(err.message).toContain("text/event-stream");
  });

  it("400 但响应体非空 → 不判为 protocol，交回 unknown", () => {
    expect(classifyHttpFailure(400, '{"error":"bad params"}').kind).toBe("unknown");
  });

  it("401 → auth", () => {
    expect(classifyHttpFailure(401, "").kind).toBe("auth");
  });

  it("403 → auth，且提示去后台勾选工具", () => {
    const err = classifyHttpFailure(403, "");
    expect(err.kind).toBe("auth");
    expect(err.message).toContain("工具");
  });

  it("状态码正常但响应体是 HTML → gateway（ESA/WAF 拦截页）", () => {
    const err = classifyHttpFailure(200, "<!DOCTYPE html><html><body>blocked</body></html>");
    expect(err.kind).toBe("gateway");
  });

  it("其它状态码 → unknown，并带上响应体片段", () => {
    const err = classifyHttpFailure(500, "boom");
    expect(err.kind).toBe("unknown");
    expect(err.detail).toBe("boom");
  });
});

describe("assertJsonBody", () => {
  it("合法 JSON 正常解析", () => {
    expect(assertJsonBody('{"a":1}')).toEqual({ a: 1 });
  });

  it("HTML 即便状态码是 200 也判为 gateway——不能把拦截页当 JSON 解", () => {
    expect(() => assertJsonBody("<html><head></head></html>")).toThrowError(/网关/);
  });

  it("非 JSON 非 HTML → unknown", () => {
    expect(() => assertJsonBody("not json at all")).toThrowError(/JSON/);
  });
});

describe("missingToolError", () => {
  it("消息里包含缺失工具名与可操作指引", () => {
    const err = missingToolError("halo_create_post", ["halo_list_posts"]);
    expect(err.kind).toBe("missing-tool");
    expect(err.message).toContain("halo_create_post");
    expect(err.message).toContain("2.26");
  });
});
```

- [ ]  **Step 2: 运行测试确认失败**

```bash
pnpm test tests/transport/errors.test.ts
```

预期：FAIL，报找不到模块 `../../src/transport/errors`。

- [ ]  **Step 3: 写类型定义**

创建 `src/transport/types.ts`：

```typescript
/** MCP 使用的 JSON-RPC 2.0 响应外壳 */
export interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id?: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: { tools?: { listChanged?: boolean } };
  serverInfo: { name: string; version: string };
  instructions?: string;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolsListResult {
  tools: McpTool[];
}

/** MCP 工具返回的内容块 */
export interface McpContentBlock {
  type: string;
  text?: string;
}

export interface McpToolCallResult {
  content?: McpContentBlock[];
  isError?: boolean;
}
```

- [ ]  **Step 4: 写错误归一化实现**

创建 `src/transport/errors.ts`：

```typescript
export type McpErrorKind = "protocol" | "auth" | "gateway" | "missing-tool" | "network" | "unknown";

export class McpError extends Error {
  constructor(
    readonly kind: McpErrorKind,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

/** 响应体看上去是 HTML —— 说明命中了网关（ESA/WAF）拦截页而非 MCP 端点 */
const HTML_BODY = /<\s*(!doctype|html|head|body)\b/i;

const PROTOCOL_HINT =
  "MCP 协议错误：服务端返回 400 且响应体为空。通常是握手顺序错误（未先 initialize），或请求头 Accept 未同时包含 application/json 与 text/event-stream。";

/**
 * 把 HTTP 层现象归一化成可操作的错误类别。
 * 判据取自真实站点的实测行为（见 spec 的 F4 / F7）。
 */
export function classifyHttpFailure(status: number, body: string): McpError {
  const trimmed = body.trim();

  if (HTML_BODY.test(trimmed)) {
    return new McpError("gateway", "站点返回了 HTML 而非 JSON，疑似被网关（ESA/WAF）拦截。", trimmed.slice(0, 200));
  }
  if (status === 400 && trimmed === "") {
    return new McpError("protocol", PROTOCOL_HINT);
  }
  if (status === 401) {
    return new McpError("auth", "MCP 密钥无效或已失效。请到 Halo 后台「工具 → MCP 服务」核对访问密钥。");
  }
  if (status === 403) {
    return new McpError(
      "auth",
      "该 MCP 密钥未被授权调用此工具。请到 Halo 后台「工具 → MCP 服务」为该密钥勾选所需工具。",
    );
  }
  return new McpError("unknown", `MCP 请求失败：HTTP ${status}`, trimmed.slice(0, 200));
}

/** 响应体必须能解析为 JSON；HTML 一律判为网关拦截，即使状态码是 200 */
export function assertJsonBody(body: string): unknown {
  const trimmed = body.trim();

  if (HTML_BODY.test(trimmed)) {
    throw new McpError("gateway", "站点返回了 HTML 而非 JSON，疑似被网关（ESA/WAF）拦截。", trimmed.slice(0, 200));
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new McpError("unknown", "MCP 响应不是合法 JSON。", trimmed.slice(0, 200));
  }
}

export function missingToolError(name: string, available: string[]): McpError {
  return new McpError(
    "missing-tool",
    `站点未提供 MCP 工具「${name}」。请确认站点 Halo 版本 ≥ 2.26 且已启用 MCP Server 插件，并检查该密钥的工具授权。`,
    `当前可用 ${available.length} 个工具`,
  );
}
```

- [ ]  **Step 5: 运行测试确认通过**

```bash
pnpm test tests/transport/errors.test.ts
```

预期：PASS（10 个用例）。

- [ ]  **Step 6: 提交**

```bash
git add src/transport/types.ts src/transport/errors.ts tests/transport/errors.test.ts
git commit -m "feat(transport): 新增 MCP 类型定义与错误归一化"
```

---

## Task 3: McpClient 握手

**Files:**

- Create: `src/transport/mcp-client.ts`
- Test: `tests/transport/mcp-client.test.ts`

**Interfaces:**

- Consumes: `src/transport/types.ts`、`src/transport/errors.ts`（Task 2）
- Produces:
  - `interface McpClientOptions { endpoint: string; token: string }`
  - `class McpClient { constructor(options: McpClientOptions); initialize(): Promise<McpInitializeResult> }`

- [ ]  **Step 1: 写失败的测试**

创建 `tests/transport/mcp-client.test.ts`：

```typescript
import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import { requestUrl } from "obsidian";
import { McpError } from "../../src/transport/errors";
import { McpClient } from "../../src/transport/mcp-client";

const rq = requestUrl as unknown as ReturnType<typeof rs.fn>;

const INIT_OK = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: "2025-06-18",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "halo-mcp-server", version: "1.2.0" },
  },
});

/** 记录每次请求参数，并按脚本返回响应 */
function stub(script: Array<{ status: number; text: string }>) {
  const calls: Array<Record<string, any>> = [];
  let i = 0;
  rq.mockImplementation(async (param: Record<string, any>) => {
    calls.push(param);
    const next = script[Math.min(i, script.length - 1)];
    i += 1;
    return { status: next.status, text: next.text, json: undefined };
  });
  return calls;
}

const options = { endpoint: "https://blog.example.com/mcp", token: "hmcp_demo" };

describe("McpClient.initialize", () => {
  beforeEach(() => {
    rq.mockReset();
  });

  it("Accept 头必须同时包含 application/json 与 text/event-stream", async () => {
    const calls = stub([{ status: 200, text: INIT_OK }]);
    await new McpClient(options).initialize();

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://blog.example.com/mcp");
    expect(calls[0].headers.Accept).toContain("application/json");
    expect(calls[0].headers.Accept).toContain("text/event-stream");
    expect(calls[0].headers.Authorization).toBe("Bearer hmcp_demo");
  });

  it("端点尾部斜杠被规整，不会拼出 //mcp", async () => {
    const calls = stub([{ status: 200, text: INIT_OK }]);
    await new McpClient({ ...options, endpoint: "https://blog.example.com/mcp/" }).initialize();

    expect(calls[0].url).toBe("https://blog.example.com/mcp");
  });

  it("请求体是合法的 initialize JSON-RPC", async () => {
    const calls = stub([{ status: 200, text: INIT_OK }]);
    await new McpClient(options).initialize();

    const body = JSON.parse(calls[0].body);
    expect(body.method).toBe("initialize");
    expect(body.jsonrpc).toBe("2.0");
    expect(body.params.protocolVersion).toBe("2025-06-18");
  });

  it("成功时返回 serverInfo", async () => {
    stub([{ status: 200, text: INIT_OK }]);
    const result = await new McpClient(options).initialize();

    expect(result.serverInfo.name).toBe("halo-mcp-server");
    expect(result.protocolVersion).toBe("2025-06-18");
  });

  it("400 空响应体 → 抛出 McpError，kind 为 protocol", async () => {
    stub([{ status: 400, text: "" }]);

    await expect(new McpClient(options).initialize()).rejects.toMatchObject({ kind: "protocol" });
  });

  it("401 → kind 为 auth", async () => {
    stub([{ status: 401, text: "" }]);

    await expect(new McpClient(options).initialize()).rejects.toMatchObject({ kind: "auth" });
  });

  it("200 但响应体是 HTML → kind 为 gateway", async () => {
    stub([{ status: 200, text: "<!DOCTYPE html><html><body>blocked</body></html>" }]);

    await expect(new McpClient(options).initialize()).rejects.toMatchObject({ kind: "gateway" });
  });

  it("initialize 失败后允许重试（不缓存失败结果）", async () => {
    const calls = stub([
      { status: 400, text: "" },
      { status: 200, text: INIT_OK },
    ]);
    const client = new McpClient(options);

    await expect(client.initialize()).rejects.toBeInstanceOf(McpError);
    const result = await client.initialize();

    expect(result.serverInfo.name).toBe("halo-mcp-server");
    expect(calls).toHaveLength(2);
  });

  it("重复调用 initialize 只发一次请求（成功结果被缓存）", async () => {
    const calls = stub([{ status: 200, text: INIT_OK }]);
    const client = new McpClient(options);

    await client.initialize();
    await client.initialize();

    expect(calls).toHaveLength(1);
  });
});
```

- [ ]  **Step 2: 运行测试确认失败**

```bash
pnpm test tests/transport/mcp-client.test.ts
```

预期：FAIL，报找不到模块 `../../src/transport/mcp-client`。

- [ ]  **Step 3: 写最小实现**

创建 `src/transport/mcp-client.ts`：

```typescript
import { requestUrl } from "obsidian";
import { assertJsonBody, classifyHttpFailure, McpError } from "./errors";
import type { JsonRpcResponse, McpInitializeResult } from "./types";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_NAME = "obsidian-halo-mcp";
const CLIENT_VERSION = "0.1.0";

export interface McpClientOptions {
  /** MCP 端点，形如 https://blog.example.com/mcp */
  endpoint: string;
  /** hmcp_ 访问密钥 */
  token: string;
}

/** 解析 JSON-RPC 外壳，取出 result；error 字段存在时抛错 */
function unwrap<T>(body: string, context: string): T {
  const json = assertJsonBody(body) as JsonRpcResponse<T>;

  if (json.error) {
    throw new McpError("unknown", `${context} 失败：${json.error.message}`);
  }
  if (json.result === undefined) {
    throw new McpError("unknown", `${context} 未返回结果。`);
  }
  return json.result;
}

export class McpClient {
  /** 成功的握手结果缓存；失败时会被清空以允许重试 */
  private handshake?: Promise<McpInitializeResult>;

  constructor(private readonly options: McpClientOptions) {}

  private get url(): string {
    return this.options.endpoint.trim().replace(/\/+$/, "");
  }

  private get headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      // 必须同时包含 text/event-stream：缺了会被服务端判为 400 且响应体为空
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.options.token}`,
    };
  }

  private async post(payload: unknown, context: string): Promise<string> {
    let response: { status: number; text: string };

    try {
      response = await requestUrl({
        url: this.url,
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(payload),
        throw: false,
      });
    } catch (error) {
      throw new McpError("network", `${context}网络请求失败：${(error as Error).message}`);
    }

    if (response.status >= 400) {
      throw classifyHttpFailure(response.status, response.text);
    }
    return response.text;
  }

  public initialize(): Promise<McpInitializeResult> {
    if (!this.handshake) {
      this.handshake = this.doInitialize().catch((error: unknown) => {
        this.handshake = undefined;
        throw error;
      });
    }
    return this.handshake;
  }

  private async doInitialize(): Promise<McpInitializeResult> {
    const body = await this.post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
        },
      },
      "MCP 握手",
    );

    return unwrap<McpInitializeResult>(body, "MCP 握手");
  }
}
```

> 注意 `requestUrl` 传了 `throw: false`。Obsidian 的 `requestUrl` 默认在非 2xx 时直接抛异常，那样我们就拿不到状态码与响应体，无法区分"400 空体"与"401"——而这两种恰恰需要给出完全不同的指引。

- [ ]  **Step 4: 运行测试确认通过**

```bash
pnpm test tests/transport/mcp-client.test.ts
```

预期：PASS（9 个用例）。

- [ ]  **Step 5: 提交**

```bash
git add src/transport/mcp-client.ts tests/transport/mcp-client.test.ts
git commit -m "feat(transport): 新增 McpClient 握手与错误分类"
```

---

## Task 4: tools/list 与 tools/call

**Files:**

- Modify: `src/transport/mcp-client.ts`
- Test: `tests/transport/mcp-client.test.ts`（追加）

**Interfaces:**

- Consumes: Task 3 的 `McpClient`
- Produces:
  - `McpClient.listTools(force?: boolean): Promise<McpTool[]>`
  - `McpClient.callTool<T = McpToolCallResult>(name: string, args?: Record<string, unknown>): Promise<T>`

- [ ]  **Step 1: 写失败的测试**

追加到 `tests/transport/mcp-client.test.ts`：

```typescript
const TOOLS_OK = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  result: {
    tools: [
      { name: "halo_create_post", inputSchema: { type: "object" } },
      { name: "halo_list_posts", inputSchema: { type: "object" } },
    ],
  },
});

const CALL_OK = JSON.stringify({
  jsonrpc: "2.0",
  id: 3,
  result: { content: [{ type: "text", text: "ok" }] },
});

describe("McpClient.listTools / callTool", () => {
  beforeEach(() => {
    rq.mockReset();
  });

  it("listTools 前会自动握手（连发 initialize + tools/list 两次请求）", async () => {
    const calls = stub([
      { status: 200, text: INIT_OK },
      { status: 200, text: TOOLS_OK },
    ]);
    const tools = await new McpClient(options).listTools();

    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].body).method).toBe("tools/list");
    expect(tools.map((t) => t.name)).toEqual(["halo_create_post", "halo_list_posts"]);
  });

  it("listTools 结果被缓存，第二次不再发请求", async () => {
    const calls = stub([
      { status: 200, text: INIT_OK },
      { status: 200, text: TOOLS_OK },
    ]);
    const client = new McpClient(options);

    await client.listTools();
    await client.listTools();

    expect(calls).toHaveLength(2);
  });

  it("listTools(true) 强制刷新", async () => {
    const calls = stub([
      { status: 200, text: INIT_OK },
      { status: 200, text: TOOLS_OK },
      { status: 200, text: TOOLS_OK },
    ]);
    const client = new McpClient(options);

    await client.listTools();
    await client.listTools(true);

    expect(calls).toHaveLength(3);
  });

  it("callTool 发送 tools/call 与 arguments", async () => {
    const calls = stub([
      { status: 200, text: INIT_OK },
      { status: 200, text: TOOLS_OK },
      { status: 200, text: CALL_OK },
    ]);
    await new McpClient(options).callTool("halo_create_post", { title: "标题" });

    const body = JSON.parse(calls[2].body);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("halo_create_post");
    expect(body.params.arguments).toEqual({ title: "标题" });
  });

  it("工具不在站点可用列表中时抛 missing-tool，且不发出 tools/call 请求", async () => {
    const calls = stub([
      { status: 200, text: INIT_OK },
      { status: 200, text: TOOLS_OK },
    ]);
    const client = new McpClient(options);

    await expect(client.callTool("halo_not_exists")).rejects.toMatchObject({ kind: "missing-tool" });
    expect(calls).toHaveLength(2);
  });

  it("callTool 的 arguments 缺省为空对象", async () => {
    const calls = stub([
      { status: 200, text: INIT_OK },
      { status: 200, text: TOOLS_OK },
      { status: 200, text: CALL_OK },
    ]);
    await new McpClient(options).callTool("halo_list_posts");

    expect(JSON.parse(calls[2].body).params.arguments).toEqual({});
  });

  it("JSON-RPC error 字段被转成 McpError", async () => {
    stub([
      { status: 200, text: INIT_OK },
      { status: 200, text: TOOLS_OK },
      { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32602, message: "invalid params" } }) },
    ]);

    await expect(new McpClient(options).callTool("halo_create_post")).rejects.toThrowError(/invalid params/);
  });
});
```

- [ ]  **Step 2: 运行测试确认失败**

```bash
pnpm test tests/transport/mcp-client.test.ts
```

预期：FAIL，报 `client.listTools is not a function`。

- [ ]  **Step 3: 补实现**

在 `src/transport/mcp-client.ts` 中：把 `types.ts` 的导入补全，并加入两个方法与工具缓存字段。

```typescript
import type { JsonRpcResponse, McpInitializeResult, McpTool, McpToolsListResult, McpToolCallResult } from "./types";
```

在类中加入字段与方法：

```typescript
  /** 工具列表缓存；站点侧工具集可变，必要时用 listTools(true) 强制刷新 */
  private toolCache?: McpTool[];

  public async listTools(force = false): Promise<McpTool[]> {
    if (this.toolCache && !force) {
      return this.toolCache;
    }

    await this.initialize();
    const body = await this.post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "获取工具列表");

    this.toolCache = unwrap<McpToolsListResult>(body, "获取工具列表").tools;
    return this.toolCache;
  }

  public async callTool<T = McpToolCallResult>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.initialize();

    const tools = await this.listTools();
    if (!tools.some((tool) => tool.name === name)) {
      throw missingToolError(name, tools.map((tool) => tool.name));
    }

    const body = await this.post(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } },
      `调用工具 ${name}`,
    );

    return unwrap<T>(body, `调用工具 ${name}`);
  }
```

同时把 `missingToolError` 加进 `./errors` 的导入。

- [ ]  **Step 4: 运行测试确认通过**

```bash
pnpm test tests/transport/mcp-client.test.ts
```

预期：PASS（16 个用例）。

- [ ]  **Step 5: 提交**

```bash
git add src/transport/mcp-client.ts tests/transport/mcp-client.test.ts
git commit -m "feat(transport): 支持 tools/list 与 tools/call"
```

---

## Task 5: 设置扩展与配置迁移

**Files:**

- Modify: `src/settings.ts`, `src/site-editing-modal.ts`, `src/i18n/locales/en.json`, `src/i18n/locales/zh-cn.json`, `src/i18n/locales/zh-tw.json`
- Test: `tests/settings.test.ts`（追加到上游已有文件）

**Interfaces:**

- Consumes: 无（独立于 transport）
- Produces:
  - `HaloSite` 新增 `mcpToken: string`（保留既有 `token`）
  - `HaloSetting` 新增 `settingsVersion: number`
  - `const CURRENT_SETTINGS_VERSION = 1`
  - `function mcpEndpointOf(site: HaloSite): string`
  - `interface MigrationNotice { key: "publishByDefault-true" }`（**只带键，不带文案**——文案由 UI 层用 i18next 解析，避免把中文字面量埋进逻辑层）
  - `function migrateSettings(raw: unknown): { settings: HaloSetting; notices: MigrationNotice[] }`

- [ ]  **Step 1: 写失败的测试**

追加到 `tests/settings.test.ts`：

```typescript
import { CURRENT_SETTINGS_VERSION, DEFAULT_SETTINGS, mcpEndpointOf, migrateSettings } from "../src/settings";

describe("mcpEndpointOf", () => {
  it("由站点 URL 推导出 /mcp 端点，并吃掉尾部斜杠", () => {
    expect(mcpEndpointOf({ url: "https://blog.example.com" } as never)).toBe("https://blog.example.com/mcp");
    expect(mcpEndpointOf({ url: "https://blog.example.com/" } as never)).toBe("https://blog.example.com/mcp");
  });
});

describe("migrateSettings", () => {
  it("空输入得到默认设置与新版本号", () => {
    const { settings, notices } = migrateSettings(undefined);
    expect(settings.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
    expect(settings.sites).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("上游历史配置（无 settingsVersion）且 publishByDefault 为 true → 产出一条迁移提示", () => {
    const { notices } = migrateSettings({ publishByDefault: true, sites: [], replaceImageLinks: true, imageUploadCache: {} });
    expect(notices).toHaveLength(1);
    expect(notices[0].key).toBe("publishByDefault-true");
  });

  it("publishByDefault 为 false 时不给提示", () => {
    expect(migrateSettings({ publishByDefault: false }).notices).toEqual([]);
  });

  it("迁移只提示、不改值 —— 必须由用户确认后才写入", () => {
    const { settings } = migrateSettings({ publishByDefault: true });
    expect(settings.publishByDefault).toBe(true);
  });

  it("已是当前版本时不再重复提示", () => {
    const { notices } = migrateSettings({
      settingsVersion: CURRENT_SETTINGS_VERSION,
      publishByDefault: true,
    });
    expect(notices).toEqual([]);
  });

  it("老站点配置缺 mcpToken 时补空串，不抛错", () => {
    const { settings } = migrateSettings({
      sites: [{ name: "Halo", url: "https://blog.example.com/", token: "pat", default: true }],
    });
    expect(settings.sites[0].mcpToken).toBe("");
    expect(settings.sites[0].url).toBe("https://blog.example.com");
  });

  it("settingsVersion 被写成当前版本，便于下次跳过迁移", () => {
    const { settings } = migrateSettings({ publishByDefault: true });
    expect(settings.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
  });

  it("缺 imageUploadCache 时补成空对象，避免下游读 undefined", () => {
    const { settings } = migrateSettings({ sites: [] });
    expect(settings.imageUploadCache).toEqual({});
    expect(settings.sites).toEqual([]);
  });
});
```

- [ ]  **Step 2: 运行测试确认失败**

```bash
pnpm test tests/settings.test.ts
```

预期：FAIL，`mcpEndpointOf` / `migrateSettings` 未定义。

- [ ]  **Step 3: 写实现**

修改 `src/settings.ts`：`HaloSite` 增字段、`HaloSetting` 增版本号、导出迁移函数。

```typescript
export interface HaloSite {
  name: string;
  url: string;
  /** Halo 个人访问令牌（PAT）。仅用于 >7MiB 图片的 REST 回退上传，MCP 路径不使用 */
  token: string;
  /** MCP 访问密钥，以 hmcp_ 开头。与 token 是两种不同凭据，不可互换 */
  mcpToken: string;
  default: boolean;
}

export const CURRENT_SETTINGS_VERSION = 1;

export interface HaloSetting {
  settingsVersion: number;
  sites: HaloSite[];
  publishByDefault: boolean;
  replaceImageLinks: boolean;
  imageUploadCache: Record<string, Record<string, ImageUploadCacheEntry>>;
}

export const DEFAULT_SETTINGS: HaloSetting = {
  settingsVersion: CURRENT_SETTINGS_VERSION,
  sites: [],
  publishByDefault: false,
  replaceImageLinks: true,
  imageUploadCache: {},
};

/** 站点 URL 与 MCP 端点的推导规则：<url 去尾斜杠>/mcp */
export function mcpEndpointOf(site: HaloSite): string {
  return `${normalizeSiteUrl(site.url)}/mcp`;
}

export function normalizeSite(site: HaloSite): HaloSite {
  return {
    ...site,
    url: normalizeSiteUrl(site.url),
    mcpToken: site.mcpToken ?? "",
  };
}

export interface MigrationNotice {
  key: "publishByDefault-true";
}

export interface MigrationResult {
  settings: HaloSetting;
  notices: MigrationNotice[];
}

/**
 * 把任意来源的原始设置迁移到当前版本。
 *
 * 纯函数：不读磁盘、不弹窗、不写盘，便于测试。
 * 只产出 notices，绝不静默修改用户已有的值 —— 默认值变更对已装用户无效，
 * 静默覆盖用户配置是难以察觉的坏行为。
 */
export function migrateSettings(raw: unknown): MigrationResult {
  const source = (raw ?? {}) as Partial<HaloSetting> & { settingsVersion?: number };
  const merged = Object.assign({}, DEFAULT_SETTINGS, source);
  const notices: MigrationNotice[] = [];

  const fromVersion = typeof source.settingsVersion === "number" ? source.settingsVersion : 0;

  if (fromVersion < CURRENT_SETTINGS_VERSION && merged.publishByDefault === true) {
    notices.push({ key: "publishByDefault-true" });
  }

  return {
    settings: {
      ...merged,
      settingsVersion: CURRENT_SETTINGS_VERSION,
      sites: (merged.sites ?? []).map(normalizeSite),
      imageUploadCache: { ...(merged.imageUploadCache ?? {}) },
    },
    notices,
  };
}
```

> **注意：`mcpToken` 属于「按站点」的凭据，不能放进 `HaloSettingTab`。** 上游把 `token` 放在站点编辑弹窗里（`site-editing-modal.ts` 的「个人访问令牌」一项），`mcpToken` 必须与它并列放在同一处。全局设置页 `HaloSettingTab.display()` **本任务不改**。

- [ ]  **Step 3b: 站点编辑弹窗增 mcpToken 输入项**

修改 `src/site-editing-modal.ts` 两处。

其一是新建站点时的默认字面量（`openSiteEditingModal` 内）——不加这个字段，新建站点的 `mcpToken` 会是 `undefined`：

```typescript
      site || { name: "", url: "", default: false, token: "", mcpToken: "" },
```

其二是 `renderContent()` 里，在既有的「个人访问令牌」块**之后**插入一块：

```typescript
      new Setting(contentEl)
        .setName(i18next.t("site_editing_modal.settings.mcpToken.name"))
        .setDesc(i18next.t("site_editing_modal.settings.mcpToken.description"))
        .addText((text) =>
          text.setValue(this.currentSite.mcpToken).onChange((value) => {
            this.currentSite.mcpToken = value.trim();
          }),
        );
```

同时把既有 `token` 那块的描述改为不与 MCP 混淆。`en.json` 里原值：

```json
        "token": {
          "name": "Personal Access Token",
          "description": "Can be created in user profile, need permissions for managing posts"
        },
```

改为（三个语言文件同步改，中文见下方 Step 3c）：

```json
        "token": {
          "name": "Personal Access Token (fallback only)",
          "description": "Only used to upload images larger than 7 MiB. The hmcp key does not work on the REST API, so this is a separate credential."
        },
```

- [ ]  **Step 3c: 三个语言文件同步加键**

`en.json` —— 在 `site_editing_modal.settings` 下、`default` 之前插入，并把上面的 `token` 描述一并改掉：

```json
        "mcpToken": {
          "name": "MCP access key",
          "description": "Starts with hmcp_, created in Halo console at Tools -> MCP Service"
        },
```

`zh-cn.json`：

```json
        "token": {
          "name": "个人访问令牌（仅回退用）",
          "description": "仅用于上传超过 7 MiB 的图片。hmcp 密钥在 REST API 上无效，两者是不同凭据。"
        },
        "mcpToken": {
          "name": "MCP 访问密钥",
          "description": "以 hmcp_ 开头，在 Halo 后台「工具 → MCP 服务」创建"
        },
```

`zh-tw.json`：

```json
        "token": {
          "name": "個人存取權杖（僅回退用）",
          "description": "僅用於上傳超過 7 MiB 的圖片。hmcp 金鑰在 REST API 上無效，兩者是不同憑證。"
        },
        "mcpToken": {
          "name": "MCP 存取金鑰",
          "description": "以 hmcp_ 開頭，在 Halo 後台「工具 → MCP 服務」建立"
        },
```

> 键路径必须三份完全一致（`site_editing_modal.settings.mcpToken.name` / `.description`），否则切换语言时会回落到 fallback 或显示原始键名。

- [ ]  **Step 4: 运行测试确认通过**

```bash
pnpm test tests/settings.test.ts
```

预期：PASS（上游既有用例 + 新增 8 个）。

- [ ]  **Step 5: 提交**

```bash
git add src/settings.ts src/site-editing-modal.ts src/i18n tests/settings.test.ts
git commit -m "feat(settings): 新增 mcpToken 与配置迁移"
```

---

## Task 6: 连通性自检

**Files:**

- Create: `src/mcp-self-check.ts`, `src/settings-migration-modal.ts`
- Modify: `src/main.ts`, `src/site-editing-modal.ts`, `src/i18n/locales/en.json`, `src/i18n/locales/zh-cn.json`, `src/i18n/locales/zh-tw.json`
- Test: `tests/mcp-self-check.test.ts`

**Interfaces:**

- Consumes: `McpClient`（Task 3/4）、`mcpEndpointOf` 与 `migrateSettings`（Task 5）
- Produces:
  - `const REQUIRED_TOOLS: readonly string[]`
  - `interface SelfCheckReport { ok: boolean; endpoint: string; server?: { name: string; version: string; protocolVersion: string }; availableCount: number; missing: string[]; error?: McpError }`
  - `function runSelfCheck(endpoint: string, token: string): Promise<SelfCheckReport>`
  - 新命令 id `mcp-self-check`

- [ ]  **Step 1: 写失败的测试**

创建 `tests/mcp-self-check.test.ts`：

```typescript
import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import { requestUrl } from "obsidian";
import { REQUIRED_TOOLS, runSelfCheck } from "../src/mcp-self-check";

const rq = requestUrl as unknown as ReturnType<typeof rs.fn>;

const INIT_OK = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "halo-mcp-server", version: "1.2.0" } },
});

function toolsBody(names: string[]) {
  return JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: names.map((name) => ({ name, inputSchema: {} })) } });
}

describe("runSelfCheck", () => {
  beforeEach(() => {
    rq.mockReset();
  });

  it("全部必需工具都在 → ok 为 true 且 missing 为空", async () => {
    rq.mockImplementation(async () => ({ status: 200, text: "" }));
    rq.mockResolvedValueOnce({ status: 200, text: INIT_OK });
    rq.mockResolvedValueOnce({ status: 200, text: toolsBody([...REQUIRED_TOOLS]) });

    const report = await runSelfCheck("https://blog.example.com/mcp", "hmcp_x");

    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.server?.name).toBe("halo-mcp-server");
    expect(report.availableCount).toBe(REQUIRED_TOOLS.length);
  });

  it("缺工具时列出缺失项且 ok 为 false", async () => {
    rq.mockResolvedValueOnce({ status: 200, text: INIT_OK });
    rq.mockResolvedValueOnce({ status: 200, text: toolsBody(["halo_list_posts"]) });

    const report = await runSelfCheck("https://blog.example.com/mcp", "hmcp_x");

    expect(report.ok).toBe(false);
    expect(report.missing.length).toBe(REQUIRED_TOOLS.length - 1);
    expect(report.missing).not.toContain("halo_list_posts");
  });

  it("握手失败时把错误带回报告而不是抛出", async () => {
    rq.mockResolvedValueOnce({ status: 401, text: "" });

    const report = await runSelfCheck("https://blog.example.com/mcp", "bad");

    expect(report.ok).toBe(false);
    expect(report.error?.kind).toBe("auth");
  });

  it("REQUIRED_TOOLS 覆盖阶段 0/1 依赖的工具，且不含运维类工具", () => {
    expect(REQUIRED_TOOLS).toContain("halo_create_post");
    expect(REQUIRED_TOOLS).toContain("halo_set_post_publish_state");
    expect(REQUIRED_TOOLS).toContain("halo_upload_attachment");
    expect(REQUIRED_TOOLS).not.toContain("halo_list_comments");
    expect(REQUIRED_TOOLS).not.toContain("halo_update_theme_setting_group");
  });
});
```

- [ ]  **Step 2: 运行测试确认失败**

```bash
pnpm test tests/mcp-self-check.test.ts
```

预期：FAIL，找不到模块 `../src/mcp-self-check`。

- [ ]  **Step 3: 写自检实现**

创建 `src/mcp-self-check.ts`：

```typescript
import type { McpError } from "./transport/errors";
import { McpClient } from "./transport/mcp-client";

/**
 * 阶段 0/1 依赖的 MCP 工具。
 * 只列本设计用到的内容创作类工具；评论与主题设置等运维类工具刻意不在其中。
 */
export const REQUIRED_TOOLS: readonly string[] = [
  "halo_get_post",
  "halo_create_post",
  "halo_update_post",
  "halo_set_post_publish_state",
  "halo_recycle_post",
  "halo_restore_post",
  "halo_list_categories",
  "halo_create_category",
  "halo_list_tags",
  "halo_create_tag",
  "halo_search_content",
  "halo_upload_attachment",
];

export interface SelfCheckReport {
  ok: boolean;
  endpoint: string;
  server?: { name: string; version: string; protocolVersion: string };
  availableCount: number;
  missing: string[];
  error?: McpError;
}

/** 探测站点 MCP 端点：握手 + 断言必需工具存在。不抛异常，一切结论走返回值。 */
export async function runSelfCheck(endpoint: string, token: string): Promise<SelfCheckReport> {
  const client = new McpClient({ endpoint, token });

  try {
    const info = await client.initialize();
    const names = (await client.listTools()).map((tool) => tool.name);

    return {
      ok: REQUIRED_TOOLS.every((tool) => names.includes(tool)),
      endpoint,
      server: {
        name: info.serverInfo.name,
        version: info.serverInfo.version,
        protocolVersion: info.protocolVersion,
      },
      availableCount: names.length,
      missing: REQUIRED_TOOLS.filter((tool) => !names.includes(tool)),
    };
  } catch (error) {
    return {
      ok: false,
      endpoint,
      availableCount: 0,
      missing: [...REQUIRED_TOOLS],
      error: error as McpError,
    };
  }
}
```

- [ ]  **Step 4: 写迁移弹窗**

创建 `src/settings-migration-modal.ts`：

```typescript
import i18next from "i18next";
import { type App, Modal, Setting } from "obsidian";
import type { MigrationNotice } from "./settings";

/** 迁移提示弹窗：只提供"改"与"不改"两个动作，绝不静默修改用户配置 */
export class SettingsMigrationModal extends Modal {
  constructor(
    app: App,
    private readonly notice: MigrationNotice,
    private readonly onDecide: (switchToDraft: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(i18next.t("settings_migration.title"));

    // 文案由键解析，逻辑层（migrateSettings）不携带任何中文字面量
    this.contentEl.createEl("p", { text: i18next.t(`settings_migration.${this.notice.key}`) });

    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText(i18next.t("settings_migration.button_switch"))
          .setCta()
          .onClick(() => {
            this.onDecide(true);
            this.close();
          }),
      )
      .addButton((button) =>
        button.setButtonText(i18next.t("settings_migration.button_keep")).onClick(() => {
          this.onDecide(false);
          this.close();
        }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

> `Modal` 的 `contentEl` / `titleEl` 在测试 mock 里只有 `createEl` 与 `empty`，因此这里不需要为弹窗写单测——决策逻辑已被 Task 5 的纯函数覆盖。

- [ ]  **Step 4b: 三个语言文件加键**

以下键必须**三份同步**加入对应文件，路径与层级按各文件既有结构放置（`settings_migration` 与 `command.mcp_self_check` 都为顶层键）。

`en.json`：

```json
  "settings_migration": {
    "title": "Halo publishing settings need confirmation",
    "publishByDefault-true": "「Publish post by default」is enabled, which conflicts with the current MCP workflow (draft first, review, then publish). Switch to draft-by-default?",
    "button_switch": "Switch to draft by default",
    "button_keep": "Keep as is"
  },
  "command": {
    "mcp_self_check": {
      "name": "MCP connection self-check",
      "error_no_sites": "Please configure a Halo site first.",
      "notice_checking": "Checking MCP connection...",
      "error_failed": "Self-check failed: {{message}}",
      "notice_ok": "Self-check passed: {{name}} v{{version}}, {{count}} tools available.",
      "notice_missing": "Self-check failed, {{count}} tool(s) missing: {{tools}}"
    }
  }
```

`zh-cn.json`：

```json
  "settings_migration": {
    "title": "Halo 发布设置需要确认",
    "publishByDefault-true": "检测到「发布时直接发布」处于开启状态，这与现行 MCP 工作流（先落草稿、复核后再发布）不一致。是否改为默认推草稿？",
    "button_switch": "改为默认推草稿",
    "button_keep": "保持不变"
  },
  "command": {
    "mcp_self_check": {
      "name": "MCP 连通性自检",
      "error_no_sites": "请先在设置中添加一个 Halo 站点。",
      "notice_checking": "正在自检 MCP 连接…",
      "error_failed": "自检失败：{{message}}",
      "notice_ok": "自检通过：{{name}} v{{version}}，可用工具 {{count}} 个。",
      "notice_missing": "自检未通过，缺少 {{count}} 个工具：{{tools}}"
    }
  }
```

`zh-tw.json`：

```json
  "settings_migration": {
    "title": "Halo 發佈設定需要確認",
    "publishByDefault-true": "偵測到「發佈時直接發佈」為開啟狀態，這與現行 MCP 工作流程（先存草稿、覆核後再發佈）不一致。是否改為預設推送草稿？",
    "button_switch": "改為預設推送草稿",
    "button_keep": "保持不變"
  },
  "command": {
    "mcp_self_check": {
      "name": "MCP 連線自檢",
      "error_no_sites": "請先在設定中新增一個 Halo 站點。",
      "notice_checking": "正在自檢 MCP 連線…",
      "error_failed": "自檢失敗：{{message}}",
      "notice_ok": "自檢通過：{{name}} v{{version}}，可用工具 {{count}} 個。",
      "notice_missing": "自檢未通過，缺少 {{count}} 個工具：{{tools}}"
    }
  }
```

> `{{...}}` 是 i18next 的插值占位符，与上游 `service.notice_upload_images_success` 的写法一致。**上架到社区插件市场时** `command.mcp_self_check.name` 要按官方惯例把插件名前缀去掉——现在写成「MCP 连通性自检」而非「Halo: MCP 连通性自检」，Obsidian 会自动加上插件名前缀。

- [ ]  **Step 5: 接入 main.ts**

在 `src/main.ts` 中：

1. 顶部补导入：

```typescript
import { mcpEndpointOf } from "./settings";
import { runSelfCheck } from "./mcp-self-check";
import { SettingsMigrationModal } from "./settings-migration-modal";
```

2. 把 `loadSettings()` 改为走迁移：

```typescript
  async loadSettings() {
    const { settings, notices } = migrateSettings(await this.loadData());
    this.settings = settings;

    if (notices.length > 0) {
      new SettingsMigrationModal(this.app, notices[0], (switchToDraft) => {
        if (switchToDraft) {
          this.settings.publishByDefault = false;
          this.saveSettings();
        }
      }).open();
    }
  }
```

（`migrateSettings` 一并加进 `./settings` 的导入列表。）

3. 在 `onload()` 末尾、`addSettingTab` 之前注册自检命令：

```typescript
    this.addCommand({
      id: "mcp-self-check",
      name: i18next.t("command.mcp_self_check.name"),
      callback: async () => {
        const site = this.settings.sites.find((item) => item.default) ?? this.settings.sites[0];

        if (!site) {
          new Notice(i18next.t("command.mcp_self_check.error_no_sites"));
          return;
        }

        new Notice(i18next.t("command.mcp_self_check.notice_checking"));

        const report = await runSelfCheck(mcpEndpointOf(site), site.mcpToken);

        if (report.error) {
          new Notice(i18next.t("command.mcp_self_check.error_failed", { message: report.error.message }));
          return;
        }

        if (report.ok) {
          new Notice(
            i18next.t("command.mcp_self_check.notice_ok", {
              name: report.server?.name,
              version: report.server?.version,
              count: report.availableCount,
            }),
          );
          return;
        }

        new Notice(
          i18next.t("command.mcp_self_check.notice_missing", {
            count: report.missing.length,
            tools: report.missing.join(", "),
          }),
        );
      },
    });
```

> 命令 `name` **不要**手写「Halo:」前缀 —— Obsidian 会在命令面板里自动加上插件名，手写会渲染成「Halo: Halo: …」。

4. 把站点编辑弹窗的「Validate」按钮从 REST 权限探测改为 MCP 自检。

上游 `src/site-editing-modal.ts` 里它现在是拿 **PAT** 去探 REST 权限接口：

```typescript
            requestUrl({
              url: `${site.url}/apis/api.console.halo.run/v1alpha1/users/-/permissions`,
              headers: { Authorization: `Bearer ${site.token}` },
            }).then((response) => {
              if (response.json.uiPermissions.includes("uc:posts:manage")) {
                new Notice(i18next.t("site_editing_modal.settings.validate.notice_validated"));
              } else {
                new Notice(i18next.t("site_editing_modal.settings.validate.error_no_permissions"));
              }
            })
```

这段校验的是 `token`（PAT）而对 `mcpToken` 毫无意义——用户填了 MCP 密钥却校验不出问题。整块替换为：

```typescript
          button.setButtonText(i18next.t("site_editing_modal.settings.validate.button")).onClick(async () => {
            const site = normalizeSite(this.currentSite);

            button.setDisabled(true);
            button.setButtonText(i18next.t("site_editing_modal.settings.validate.button_validating"));

            try {
              const report = await runSelfCheck(mcpEndpointOf(site), site.mcpToken);

              if (report.error) {
                new Notice(i18next.t("command.mcp_self_check.error_failed", { message: report.error.message }));
              } else if (report.ok) {
                new Notice(i18next.t("site_editing_modal.settings.validate.notice_validated"));
              } else {
                new Notice(
                  i18next.t("command.mcp_self_check.notice_missing", {
                    count: report.missing.length,
                    tools: report.missing.join(", "),
                  }),
                );
              }
            } finally {
              button.setDisabled(false);
              button.setButtonText(i18next.t("site_editing_modal.settings.validate.button"));
            }
          });
```

同时调整该文件顶部导入：`requestUrl` 在此文件中**仅**这一处使用，可以移除；补上新依赖：

```typescript
import { mcpEndpointOf } from "./settings";
import { runSelfCheck } from "./mcp-self-check";
```

并删除三个语言文件中已不再被引用的 `site_editing_modal.settings.validate.error_no_permissions` 键（实施前先用 `grep -rn "error_no_permissions" src/` 确认除该处外无引用）。`common.error_connection_failed` 仍被其它路径使用，**保留**。

- [ ]  **Step 6: 运行全部测试与构建**

```bash
pnpm test
pnpm build
```

预期：全部 PASS，构建成功。

- [ ]  **Step 7: 提交**

```bash
git add src/mcp-self-check.ts src/settings-migration-modal.ts src/main.ts src/site-editing-modal.ts src/i18n tests/mcp-self-check.test.ts
git commit -m "feat: 新增 MCP 连通性自检命令与配置迁移提示"
```

---

## Task 7: 契约测试与前置条件文档

**Files:**

- Create: `tests/contract/mcp-contract.test.ts`
- Modify: `README.md`, `package.json`

**Interfaces:**

- Consumes: `runSelfCheck`（Task 6）
- Produces: 一个在缺 `HALO_MCP_TOKEN` 时自动跳过、在提供时对真实站点断言的契约测试

- [ ]  **Step 1: 写契约测试**

创建 `tests/contract/mcp-contract.test.ts`：

```typescript
import { describe, expect, it } from "@rstest/core";
import { runSelfCheck } from "../../src/mcp-self-check";

/**
 * 对真实站点的契约测试。
 *
 * 站点侧的 MCP 工具集是可变的（管理员可在密钥里取消工具授权，官方也会新增），
 * 所以本设计依赖的每个工具都必须被断言存在 —— 否则站点侧一变，插件会静默失效。
 *
 * 未提供环境变量时自动跳过，不阻塞常规开发与 CI。
 */
const endpoint = process.env.HALO_MCP_ENDPOINT;
const token = process.env.HALO_MCP_TOKEN;
const enabled = Boolean(endpoint && token);

describe("MCP 契约（真实站点）", () => {
  it(
    "必需工具全部存在，且服务端为 halo-mcp-server",
    async () => {
      if (!enabled) {
        // 未配置环境变量时静默跳过：契约测试是可选验证，不阻塞常规开发与 CI
        return;
      }

      const report = await runSelfCheck(endpoint as string, token as string);

      expect(report.error).toBeUndefined();
      expect(report.server?.name).toBe("halo-mcp-server");
      expect(report.missing).toEqual([]);
      expect(report.ok).toBe(true);
    },
    30_000,
  );
});
```

> 这里**刻意用运行期守卫而不是 `describe.skipIf`**：rstest 对 `skipIf` 的支持不确定，而"缺少环境变量就静默 return"在任何测试运行器上都成立，也不会因为跳过机制失效而误报失败。

- [ ]  **Step 2: 加一条便捷脚本**

在 `package.json` 的 `scripts` 中加入（其余脚本不动）：

```json
"test:contract": "rstest run tests/contract"
```

- [ ]  **Step 3: 验证契约测试在无 token 时被跳过**

```bash
pnpm test:contract
```

预期：PASS 或 0 个用例被执行（跳过），**不得**因缺少环境变量而报错。

- [ ]  **Step 4: 有条件时对真实站点跑一次**

```bash
HALO_MCP_ENDPOINT=https://blog.liuhangyv.top/mcp pnpm test:contract
```

预期：PASS。若 FAIL，说明站点侧工具授权或版本与本设计前提不符，**先解决再继续**。

- [ ]  **Step 5: 写 README 前置条件**

在 `README.md` 顶部（标题之后）插入一节，说明本 fork 与上游的差异与硬性前置条件：

```markdown
> **本仓库是 `halo-sigs/obsidian-halo` 的 fork**，改造方向是把发布后端从直连 REST API
> 切换为 Halo 官方 MCP Server 插件。原上游的使用说明见下方，仍然有效。

## 前置条件

- 站点 Halo 版本 **≥ 2.26**
- 站点已安装并启用官方 [MCP Server 插件](https://github.com/halo-dev/plugin-mcp-server)
- 在 Halo 后台「工具 → MCP 服务」创建一个访问密钥（以 `hmcp_` 开头），
  并为其勾选文章、独立页面、分类、标签、附件、全文检索相关工具
- 可选：若需上传超过 7 MiB 的图片，另需一个 Halo 个人访问令牌（PAT，需附件管理权限）。
  `hmcp_` 密钥在 REST API 上无效，两者不可互换

## 插件的两个凭据

| 凭据 | 用途 | 是否必需 |
|---|---|---|
| `hmcp_` 访问密钥 | 所有 MCP 操作 | 必需 |
| 个人访问令牌（PAT） | 仅 >7 MiB 图片的 REST 回退上传 | 可选 |

## 连通性自检

在 Obsidian 命令面板执行 `Halo: MCP 连通性自检`，它会握手并检查所需工具是否齐备。

## License

GPL-3.0（沿用上游）
```

- [ ]  **Step 6: 运行全部验证并提交**

```bash
pnpm test
pnpm build
pnpm check
git add tests/contract README.md package.json
git commit -m "test: 新增 MCP 契约测试并补前置条件文档"
```

预期：单测全绿、构建成功、Biome 无报错。

---

## 阶段 0/1 完成后的验收

本计划完成后应当能观察到：

1. `pnpm build` 产出 `main.js`，`manifest.json` 的 `id` 为 `halo-mcp`；把它放进
   `<vault>/.obsidian/plugins/halo-mcp/` 后可在 Obsidian 中启用，**与既有的官方 `halo` 插件共存**。
2. 命令面板出现 `Halo: MCP 连通性自检`；配好 `hmcp_` 密钥后执行，报告服务端名称、版本与可用工具数。
3. 缺少工具、密钥无效、被网关拦截、握手顺序错误四种故障各自给出**可操作的**提示，
   且都不表现为"未知错误"。
4. `pnpm test` 全绿；`.gitignore` 生效，`data.json` 与 `main.js` 未被提交。
5. **既有命令（发布 / 上传图片 / 拉取 / 更新）行为完全未变**——本阶段只增不改，插件始终可用。

## 后续计划（不在本计划内）

阶段 1 剩余部分与阶段 2 各自独立成计划：

- **计划 2 · 发布管线重构**：抽取 `service/local-content.ts` 与 `service/image-upload.ts`、`frontmatter-map.ts`（6 个新字段双向映射）、发布预览弹窗、批量命令、路由规则
- **计划 3 · 内容能力对标**：查重、独立页面、附件管理、回收站
