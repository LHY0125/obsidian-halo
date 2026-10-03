# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这个仓库是什么

[`halo-sigs/obsidian-halo`](https://github.com/halo-sigs/obsidian-halo) 的 fork——一个把 Obsidian 笔记发布到 Halo 博客的插件。

- `origin` = `LHY0125/obsidian-halo`（本 fork，推送目标）
- `upstream` = `halo-sigs/obsidian-halo`（官方源，**只读参考**，不双向同步）
- 上游 v1.2.0 的完整历史是本仓库 `main` 的基底，因此同步上游修复走 `git fetch upstream && git cherry-pick <sha>`

**已经完成的工作**：发布后端已从「直连 Halo REST API」切到「以 Halo 官方 MCP Server 插件为后端」。
REST + PAT 只剩两条路（>7 MiB 图片上传、拉取文章的选文列表），现状见 `README.md` 的「当前进度与凭据要求」。

- 设计文档：`docs/superpowers/specs/2026-10-03-obsidian-halo-mcp-reshape-design.md`
- 实现计划：`docs/superpowers/plans/2026-10-03-bootstrap-and-mcp-transport.md`

**接手前先读这两份**——计划里记录了三条实测出来的 MCP 协议硬约束（`Accept` 必须含 `text/event-stream`、必须先 `initialize`、无 session），弄错任何一条都只会得到「400 且响应体为空」，看不到原因。其余协议约束见下方「MCP 协议硬约束」一节。

**站点侧前置条件**：Halo **≥ 2.26**，且已安装并启用官方 [MCP Server 插件](https://github.com/halo-dev/plugin-mcp-server)；在后台「工具 → MCP 服务」创建的访问密钥以 `hmcp_` 开头，并需为它勾选文章 / 分类 / 标签 / 附件 / 全文检索相关工具。

## 常用命令

```bash
pnpm install          # 依赖（pnpm，见 packageManager 字段）
pnpm build            # rslib 构建 → 仓库根目录的 main.js
pnpm dev              # 同上但 watch 模式
pnpm test             # rstest 跑全部测试
pnpm test tests/service/index.test.ts    # 跑单个测试文件
pnpm test:watch       # 测试 watch
pnpm test:coverage    # 带覆盖率
pnpm test:contract    # 仅跑契约测试（需 HALO_MCP_ENDPOINT + HALO_MCP_TOKEN，两个都缺则静默跳过）
pnpm check            # biome check --write src/（格式化 + lint + organize imports）
pnpm version          # 触发 version-bump.mjs，同步 manifest.json 与 versions.json
```

**手工联调**：把本仓库放到 `<vault>/.obsidian/plugins/<manifest.id>/`，`pnpm dev` 持续重建，然后在 Obsidian 里「重新加载插件」。插件 id 必须与目录名一致。

## 架构

### 入口与命令编排 — `src/main.ts`

`HaloPlugin extends Plugin`。`onload()` 里做三件事：初始化 i18next、`loadSettings()`、注册命令与功能区图标。

命令本身很薄，真正的编排在私有方法里，统一模式是：**解析目标站点 → 上传图片 → 发布**。

- 站点解析优先级：frontmatter 的 `halo.site` → 设置里的默认站点 → 单站点直取 → 弹窗让用户选
- `uploadImagesForPublish()` 是发布前的统一前置：静默上传图片，**只要有任意一张失败就中止发布**（`failedCount > 0` → 返回 `success: false`）
- 发布时把上传后的 markdown 作为 `{ markdown }` 传进 `service.publishPost()`，避免重新读盘拿到未替换的旧内容

### 业务层 — `src/service/` 与 `src/transport/`

后端已从「直连 REST API」切到 MCP，`src/service/index.ts` 现在只做**编排**（`HaloService`，约 765 行），
具体职责拆在同级文件与 `src/transport/` 里：

| 文件 | 唯一职责 |
|---|---|
| `service/index.ts` | 编排：发布 / 更新 / 拉取 / 分类标签解析 / 重试 / 失败文案 |
| `service/local-content.ts` | 本地内容：frontmatter 应用（`applyPostFrontmatter`）、正文里的本地图片引用解析 |
| `service/image-upload.ts` | 图片上传：≤ 7 MiB 走 MCP base64，超出回退 REST multipart |
| `service/post-mapping.ts` | 适配：MCP 的**扁平** post 表示 ↔ `{metadata, spec}` 嵌套结构 |
| `transport/mcp-client.ts` | MCP JSON-RPC 客户端（`McpClient`，唯一出口） |
| `transport/errors.ts` | `McpError` 与 HTTP/工具级失败的归一化 |

`McpClient` 可注入（构造函数第 4 个参数）——测试传假对象以断言「调了哪个工具、传了什么参数」；
生产代码不传，走真实的 `requestUrl`。

几个必须知道的细节：

- **`@halo-dev/api-client` 只当类型用**（`import type`）—— MCP 返回的是扁平结构，要 `post-mapping.ts` 转成嵌套的 `Post`。
  ⚠️ 代价是 **tsc 看不见字段名写错**：该包的类型解析不了（`moduleResolution: "node"` 忽略 `exports`），`Post` 退化成 `any`。字段名校验只有 `tests/service/post-mapping.test.ts` 一层，所以那里每个被映射的字段都必须有断言。
- **读用 `callToolJson`，写用 `callToolVoid`**。写路径**不消费**返回体（写与读解耦），因此也不假设它可解析：若用 `callToolJson`，服务端写成功却回了人读文案时会抛错 → 触发整事务重试 → 新建分支拿同一个 name 再建一次，被重名拒绝；用户看到「发布失败」而文章其实已经写好了。
- **`requestUrl` 默认在非 2xx 时直接抛异常**，拿不到状态码与响应体（MCP 传输层需要区分「400 空体」与「401」，故固定传 `throw: false`）。
- **REST 的三套命名空间只剩图片回退上传还在用**，用错会 403：写文章走 `uc.api.content.halo.run`，读写分类/标签走 `content.halo.run`，传图走 `uc.api.storage.halo.run`（multipart）。**MCP 路径完全不经过这些命名空间**（走 `/mcp` 单一端点）。
- **发布重试**：`withPublishRetry()` 包住整个发布事务，3 次重试、500ms 线性退避。不加 retry 时 draft 更新会偶发失败。
  发布状态那一步必须留在重试闭包**内**：移出去会同时丢掉重试覆盖与「建文章成功、发布状态失败」的自愈回填。
- 分类/标签**不存在会自动创建**，slug 用 `transliteration` 转拼音（所以中文标题的 permalink 是拼音）。副作用：一次手误的标签名会在站点上永久留下垃圾标签。
- 分类/标签的**显示名解析失败要跳过该字段的回写**，绝不落回 `metadata.name`：消费方按 displayName 精确匹配，写入 name 会在下次发布时造出垃圾分类/标签。注意 `getCategoryDisplayNames()` / `getTagDisplayNames()` 返回 `undefined`（无从解析）与 `[]`（确实没有）是两回事，签名已如实标注。

### MCP 协议硬约束

弄错任何一条，只会得到「400 且响应体为空」或「看起来成功其实写错」，都很难反查：

- **`Accept` 必须同时含 `text/event-stream`**（服务端返回 SSE）。
- **必须先 `initialize`** 才能 `tools/list` / `tools/call`；**无 session**（不带 session id）。
- **`tools/call` 的工具级失败是 HTTP 200 + `result.isError: true`**，不是 4xx。只按 HTTP 状态码判成败会把失败当成功。
- **`rawType` 必须显式传 `"markdown"`**：schema 的默认值是 `"html"`，漏传会把 Markdown 当 HTML 存，站点渲染错乱而本地看不出任何异常。
- `publishTime` 空值传 `null`（schema 是 `["string","null"]` + `format: date-time`），**不能传空字符串**。
- `halo_get_post` 的 `truncated` 为 true 时**必须抛错**，绝不能把截断正文当完整文章写进本地文件。

协议事实的来源：`docs/superpowers/plans/2026-10-03-bootstrap-and-mcp-transport.md`（三条约束）+ 本次切换的实现经验（后三条）。

### 设置与弹窗

`src/settings.ts` 定义 `HaloSetting` / `HaloSite` 与设置面板；三个弹窗各司其职：

| 文件 | 作用 |
|---|---|
| `src/sites-modal.ts` | 站点列表（增删、设为默认） |
| `src/site-editing-modal.ts` | 编辑单个站点。内含「Validate」按钮，已改为跑 **MCP 自检**（`runSelfCheck` + `mcpToken`）——校验的正是用户真正要填的那把密钥 |
| `src/site-selection-modal.ts` | 发布时选目标站点 |
| `src/post-selection-model.ts` | 拉取时选远程文章。⚠️ **文件名是 `-model` 不是 `-modal`**，容易写错，但它是个 Modal |

### frontmatter 契约

这是「本地笔记 ↔ 远程文章」的锚点，**语义不可变**，否则已有已发布笔记会失联：

```yaml
title / slug / excerpt / cover / categories / tags
halo:
  site: https://blog.example.com   # 防跨站误推，不匹配直接报错返回
  name: <post metadata.name>       # 判断「新建 or 更新」的唯一依据
  publish: true
```

`applyPostFrontmatter()` **只处理上面这 6 个字段**。Halo Post 的其余 spec 字段由 `publishPost()` 里那个 `params` 字面量给出默认值（`visible: "PUBLIC"`、`pinned: false`、`priority: 0`、`publishTime: ""`、`allowComment: true`、`template: ""`），再由写工具显式传给 MCP。**frontmatter 仍然够不着它们**——MCP 切换只换了后端，并没有扩大 frontmatter 的表达力。

### 内容管线

```
frontmatter 之后的部分 → raw（原始 Markdown，客户端不渲染）
  → halo_create_post / halo_update_post 的 raw + 显式 rawType: "markdown"
  → 渲染交给 Halo 服务端（content 也由服务端按 raw 生成，客户端刻意不传）
反向读取：halo_get_post（version: HEAD、format: RAW）一次返回 { item, content, truncated }
  item 是扁平表示（经 post-mapping.ts 转成嵌套 Post），content.raw 是原文
```

**客户端渲染那一步已被删除**：`createPostContent(raw) = { content: markdownIt.render(raw), … }` 随 MCP 切换作废，
`src/utils/markdown.ts`（配置过的 markdown-it 实例，`html` / `breaks` / `linkify` / `typographer` 全开 + `markdown-it-anchor`）
**现在没有任何地方引用它**——`grep -r "utils/markdown" src tests` 只剩 `service/index.ts` 里一句注释。
它是死代码，与 `src/utils/yaml.ts` 同类；清理前先确认没有外部引用（`markdown-it` / `markdown-it-anchor` 两个依赖也是只为它存在）。

**关键事实：客户端渲染结果不是读者看到的东西。** Halo 存储的 `rawType` 是 `markdown`，前台 HTML 由 Halo 服务端自己的管线生成（实测线上页面的 mermaid 被渲染成 `<div class="bytemd-mermaid"><svg>`，裸 markdown-it 不可能产出该结构）。所以在插件里换渲染器对前台显示无效——要改渲染得改 Halo 侧的插件或主题。

### i18n

`src/i18n/index.ts` 把 `locales/{en,zh-cn,zh-tw}.json` 注册为 i18next 资源。语言取 `moment.locale()`，回落 `en`。取值走点号路径（`i18next.t("command.publish.name")`），支持 `{{var}}` 插值。**新增文案必须三个语言文件同步加键**，否则切语言时显示原始键名。

### 图片管线

扫描本地图片引用（`![](...)` 与 `![[]]` 两条正则，跳过远程路径）的代码在 `service/local-content.ts`
（`collectLocalImageReferences()` / `parseMarkdownImageTarget()`），上传在 `service/image-upload.ts`。

**上传有两条路径，阈值是 7 MiB**（`MCP_UPLOAD_MAX_BYTES`）：≤ 7 MiB 走 MCP `halo_upload_attachment`（base64）；
超过才回退 REST multipart（`uc.api.storage.halo.run`，**这条路需要 PAT**）。

`imageUploadCache` 是缓存：键为「站点 URL + 文件路径」，用 `size` + `mtime` 判断失效。
反方向有 `restoreCachedLocalImageLinks()`（也在 `image-upload.ts`），把远程链接还原成本地路径（`replaceImageLinks` 关闭时生效）。

## 测试约定

`tests/setup.ts` 用 `rs.mock("obsidian", ...)` **整体 mock 掉 obsidian 模块**，包括 `TFile` / `TFolder` / `Notice` / `Modal` / `Setting` 等类，以及 `requestUrl`（一个 `rs.fn()`）。因此任何测试都能直接注入 HTTP 响应。

- 测试文件放 `tests/` 下，镜像 `src/` 结构，命名 `*.test.ts`
- 断言 HTTP 行为用 `requestUrl as unknown as RequestUrlMock` 取到 mock，再 `mockImplementation` / `mockReset`
- rstest 的 mock API 是 Jest 风格的：`rs.fn(impl)` / `rs.spyOn(obj, k)` / `mock.calls` / `mockRestore()` 都可用
- 测 `HaloService` 的现成脚手架在 `tests/service/index.test.ts`：`createMockApp()` / `createFile()` / `createSettings()`，照抄用法即可

## 发布机制

打 tag 触发 `.github/workflows/workflow.yaml`：构建后把 **`manifest.json` + `main.js`** 作为 Release 产物。

- **产物里没有 `styles.css`**。`rslib.config.ts` 的 entry 只有 `src/main.ts`，也不打包 CSS——所以仓库根那个 `styles.css` 是给使用方本地覆盖用的占位文件（164 字节注释），改它不会被发布，也不会被更新覆盖。
- **tag 不带 `v` 前缀**（`1.2.0` 而非 `v1.2.0`），因为 `.npmrc` 里设了 `tag-version-prefix=""`。
- `pnpm version` 会跑 `version-bump.mjs`，把 `manifest.json` 的 `version` 与 `versions.json` 一起更新——**不要手工改这两个文件里的版本号**。
- ⚠️ CI 用 **pnpm 8 / Node 18**，而 `package.json` 的 `packageManager` 是 `pnpm@10.34.4`。两者不一致，动构建脚本时要留意。

## 其它需要注意的地方

- **`tsconfig.json` 设了 `baseUrl: "."`**，所以源码里用 `import { randomUUID } from "src/utils/id"` 这种以 `src/` 开头的路径，而不是相对路径。跟着写。
- **代码风格由 Biome 定**（`biome.json`）：120 列、LF、双引号、尾逗号 always、自动整理 import。`pnpm check` 会自动改，别手写格式化。
- **`src/utils/yaml.ts` 是死代码**：导出的 `readMatter()` 没有任何地方引用，`gray-matter` 与 `js-yaml` 这两个依赖只为它而存在。代码实际读 frontmatter 走 Obsidian 的 `metadataCache.getFileCache().frontmatter`。清理前先确认没有外部引用。
- **`src/utils/markdown.ts` 同样是死代码**（随 MCP 切换作废，见「内容管线」）：无人 import，`markdown-it` 与 `markdown-it-anchor` 这两个 `dependencies` 只为它而存在。**本次改造没有动 `package.json`**，清理时记得把这两个依赖一起处理。
- **`src/utils/id.ts` 的 `randomUUID()` 是手写实现**（不用 `crypto`），用于生成新文章的 resource name 与 multipart boundary。
- **`biome check src/` 报的 15 个 format 错误不是你的问题**：本仓库 `core.autocrlf=true` 且没有 `.gitattributes`，所以 Windows 检出后所有上游文件在工作区是 CRLF，而 `.editorconfig` 与 `biome.json` 都要求 LF。**这些报错纯属换行符冲突**——实测对 `src/` 全量跑 `biome check --write` 后 `git diff` 为空，因为 git 会把换行归一化掉。因此不必"修复"它们，也不会产生无关 diff。（新文件请按 `.editorconfig` 写成 LF。）
- **License 以 `LICENSE` 文件为准：GPL-3.0**。`package.json` 里写的 `"license": "MIT"` 与仓库实际的 GPL-3.0 全文冲突，属于上游遗留错误——按 GPL-3.0 处理。
