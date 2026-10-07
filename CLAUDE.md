# CLAUDE.md

本文件为 Claude Code 提供本仓库的工作指引。

## 这个仓库是什么

[`halo-sigs/obsidian-halo`](https://github.com/halo-sigs/obsidian-halo) 的 fork —— 把 Obsidian 笔记发布到 Halo 博客的插件。

- `origin` = `LHY0125/obsidian-halo`（本 fork，推送目标）
- `upstream` = `halo-sigs/obsidian-halo`（官方源，**只读参考**，不双向同步）
- 上游 v1.2.0 的历史是本仓库 `main` 的基底，同步上游修复走 `git fetch upstream && git cherry-pick <sha>`

**发布后端已从「直连 Halo REST API」切到「以官方 MCP Server 插件为后端」。** REST + PAT 只剩一条路（上传超过 7 MiB 的图片）。

**站点侧前置条件**：Halo **≥ 2.26** + 官方 [MCP Server 插件](https://github.com/halo-dev/plugin-mcp-server)。在后台「工具 → MCP 服务」创建的访问密钥以 `hmcp_` 开头，需为它勾选**四组共 23 个**工具：

| 组 | 个数 | 工具 |
|---|---|---|
| 文章 | 7 | 列表 / 读取 / 新建 / 修改 / 发布状态 / 回收 / 恢复 |
| 独立页面 | 7 | 与文章**同构的一套**（页面没有分类标签） |
| 分类与标签 | 4 | 两类的列举与创建各一 |
| 检索与附件 | 5 | 全文检索、附件列表 / 读取 / 删除、附件上传 |

评论、主题设置、`upload_attachment_from_url` 与插件贡献的工具（PluginMoments / image-stream）**刻意不在其中**。

> **`src/mcp-self-check.ts` 的 `REQUIRED_TOOLS` 才是权威**。文档列少了，用户照做后自检会误报「缺少工具」。`pnpm test:contract` 是它的自动化版本。

**设计文档**（接手前建议先读，里面有实测出来的 MCP 协议约束）：

- 设计：`docs/superpowers/specs/2026-10-03-obsidian-halo-mcp-reshape-design.md`
- 传输层：`docs/superpowers/plans/2026-10-03-bootstrap-and-mcp-transport.md`
- 发布链路切换：`docs/superpowers/plans/2026-10-03-mcp-pipeline-cutover.md`

## 常用命令

```bash
pnpm install          # 依赖（pnpm，版本见 packageManager 字段）
pnpm build            # rslib 构建 → 仓库根目录的 main.js
pnpm dev              # 同上但 watch 模式
pnpm test             # rstest 跑全部测试
pnpm test <path>      # 跑单个测试文件
pnpm test:coverage    # 带覆盖率
pnpm test:contract    # 仅跑契约测试（需 HALO_MCP_ENDPOINT + HALO_MCP_TOKEN，都缺则静默跳过）
pnpm check            # biome check --write src/
pnpm version          # 触发 version-bump.mjs，同步 manifest.json 与 versions.json
```

**手工联调**：把仓库放到 `<vault>/.obsidian/plugins/<manifest.id>/`，`pnpm dev` 持续重建，然后在 Obsidian 里「重新加载插件」。**插件 id 必须与目录名一致**。

## 架构

### 目录结构

`src/` 根目录只留**入口与全局单例**，其余按职责分目录。**`tests/` 逐目录镜像 `src/`。**

```
src/
├── main.ts            入口：HaloPlugin，注册 16 条命令与功能区图标
├── plugin-context.ts  HaloPluginContext —— UI 依赖的**最小契约**
├── settings.ts        HaloSetting / HaloSite + 设置面板
├── mcp-self-check.ts  MCP 连通性自检（REQUIRED_TOOLS 的权威定义）
├── icons.ts           Halo 图标注册
├── core/              零项目内依赖的叶子：glob / pagination / content-kind /
│                      frontmatter-map / site-routing
├── ui/
│   ├── modals/        12 个 Modal
│   └── models/        4 个取数与映射（无 UI）
├── commands/          batch-publish（批量规划与执行）
├── service/           MCP 业务层
├── transport/         MCP 传输层：mcp-client / errors / types
├── i18n/              i18next 初始化 + error-message + locales/
└── utils/             id.ts
```

**两条必须守住的边界**：

1. **`core/` 保持零项目内依赖。** 理由是一个真实的环：`site-routing.ts` 要用 `settings.ts` 的 `isSameSiteUrl()`，而 `settings.ts`（设置面板要显示每条规则命中多少篇）要用 `glob.ts` 的 `matchGlob()`。把 `matchGlob()` 的实现写进 `site-routing.ts` 就成了 `settings ⇄ site-routing` 的真环。**环在打包器里未必报错，而是在某些 import 顺序下让某个绑定变成 `undefined` —— 本地测试跑得通、发布出去的 `main.js` 才出问题。** 往 `core/` 加 `import` 前先读 `glob.ts` 顶部的说明。

2. **UI 文件不要 `import main.ts`。** 用 `plugin-context.ts` 的 `HaloPluginContext`（只有 `app` / `settings` / `saveSettings` 三个成员），`HaloPlugin implements HaloPluginContext`。给契约加成员**只在 UI 真要用新东西时**才做，不要照抄 `HaloPlugin` 的公开面。

   **唯一例外是 `settings.ts`**：`PluginSettingTab` 的构造签名是 `(app: App, plugin: Plugin)`，要 Obsidian 的基类 `Plugin`，而收窄的接口不满足它（报 TS2345）。这是类型系统的硬性要求，不是漏改。

### 入口与命令编排 — `src/main.ts`

`onload()` 做三件事：初始化 i18next、`loadSettings()`、注册命令与功能区图标。

命令本身很薄，编排在私有方法里，统一模式：**解析目标站点 → 规划（零写入）→ 预览确认 → 上传图片 → 执行**。

**16 条命令**（`id` 用于核对；`name` 是 `src/i18n/locales/` 里的取值，Obsidian 显示成 `<插件名>: <name>`）：

| id | 作用 | 类型 |
|---|---|---|
| `publish` | 发布当前笔记到解析出的站点 | 单篇 |
| `publish-with-defaults` | 发布到默认站点，**不经过路由规则** | 单篇 |
| `upload-images` | 上传笔记里的本地图片并替换链接 | 单篇 |
| `update-post` | 从 Halo 更新当前笔记内容 | 单篇 |
| `pull-post` | 从 Halo 拉取文章（含选文列表） | 单篇 |
| `push-page` | 把当前笔记推成独立页面 | 独立页面 |
| `pull-page` | 从站点拉一个独立页面到本地 | 独立页面 |
| `manage-pages` | 管理站点上不在回收站的独立页面 | 独立页面 |
| `recycle-post` / `recycle-page` | 回收站（文章 / 页面）：列出并恢复 | 远端管理 |
| `search-content` | 查重：搜站点上的内容（**含草稿**） | 远端管理 |
| `manage-attachments` | 管理附件：列出 / 复制链接 / 删除 | 远端管理 |
| `mcp-self-check` | MCP 连通性自检 | 自检 |
| `batch-draft` / `batch-publish` / `batch-unpublish` | 三个批量命令，共用 `runBatchCommand(action)` | 批量 |

**站点解析只有一处入口**：`HaloPlugin.resolveSiteFor(file)` 是薄胶水（从 `metadataCache` 取 `halo.site` 再转交，**不补 `?? ""`**），真正的规则在 `core/site-routing.ts` 的 `resolveSite()`（纯函数）。

- 优先级：frontmatter 的 `halo.site` → **路由规则表自上而下首个命中** → 设置里的默认站点 → 单站点直取 → 弹窗让用户选
- **没有本地文件的命令**（`pull-page` / `manage-pages` / 两条回收站 / `search-content` / `manage-attachments`）走不了 `resolveSiteFor(file)`（它要 `file.path` 才能匹配路由），改用 `pickSiteForPull()`（默认站点 / 唯一站点 / 弹窗）
- `resolveSite()` 返回带 `kind` 的**联合**而非 `HaloSite | undefined`，因为批量必须说清「这篇为什么没有站点」：`resolved` / `needs-choice` / `no-sites` / `unknown-site` / `unknown-rule-site`。`resolved` 上的 `source` 带 `rule` 与命中的 `pattern`，让预览如实标注站点是怎么定下来的
- **`unknown-site` / `unknown-rule-site` 报错而不是继续往下找**：继续找的后果是把笔记发到**另一个站**上，不可恢复；报错只是让用户改一行配置

**`core/glob.ts` 的匹配是大小写不敏感的**（用户在 Windows 上看到的目录名与实际大小写未必一致，而**没命中没有任何提示**）。`matchGlob()` 归一化的是**模式**、**不**归一化**路径** —— 传进来的 `filePath` 必须是 `/` 分隔的库内相对路径，传反斜杠路径**可能导致规则不命中，也可能命中本不该命中的规则**。

### 批量操作

三个命令共用 `HaloPlugin.runBatchCommand(action)`，只在 `action` 上分档。候选是**全库的 markdown 笔记**；规划与执行在 `commands/batch-publish.ts`，弹窗在 `ui/modals/batch-confirm-modal.ts`。

- **规划阶段零写入**，且分类标签是**按站点取一次的快照** —— 留着它才能让「将新建」跟着勾选实时重算，不必每勾一次就打一次 MCP
- **执行阶段失败不中断**：这是对上游「任一图片失败即中止发布」的**刻意偏离**，只用于批量路径 —— 118 篇里第 3 篇失败不该让后面 115 篇都不发。单篇命令仍保留中止语义
- **末尾汇总把三档分开报**（成功 / 失败 / 执行前跳过），失败项与跳过项**分两段**列：失败是「跑了但炸了」（要去站点确认那篇的状态），跳过是「压根没让它跑」（要去改配置）—— 混在一起时用户只能靠原因文字猜「这篇到底有没有被尝试过」
- 汇总标题按 `action` 分档，**不用**一句通用的「批量操作完成」—— 三个命令跑完都是同一句的话，用户点了「批量推草稿」看到「成功 118 篇」也分不清是草稿还是发出去了

**批量推草稿 / 批量发布会改写本地笔记**，而且**不止图片链接这一项**：`processFrontMatter()` **无条件**回写 `title` / `slug` / `cover` / `excerpt` / `categories` / `tags` 与整个 9 键 `halo` 块（含 `halo.publish`）—— **关掉「替换图片链接」也照写**。确认弹窗里有显式提示，门控在 `action` 上（撤回不显示），且必须出现在**确认之前**。

**批量撤回是例外**：只在远端把发布状态退回草稿，**不改写正文、不回写本地笔记**（`runBatch()` 的 unpublish 分支直接 `changePostPublish()` 后 `continue`）。所以撤回后笔记里的 `halo.publish` **仍是原值**。

> ⚠️ **措辞纪律：写「不改写正文」，不写「不读正文」。** 后者在推草稿 / 发布两条路径上是假的 —— `planBatch()` 会调 `summarizeImages(candidate)`，它靠读盘取正文；读不出来的笔记进不了批（记成 `batch.skip_unreadable`）。撤回是例外（不调 `summarizeImages`，为它读正文只会制造答非所问的跳过理由）。「**不改写**正文」在三条路径上都为真，**不会过期**；要写「读 / 不读」就必须按 action 分档。**动 `planBatch()` / `runBatch()` 的人必须同时改本段。**

**批量命令按命令名决定发布状态，不看笔记里的 `halo.publish`**：`publishOverride` 在批量路径上**永远 `!== undefined`**，所以第二档（`plan.publishFromFrontmatter`）在批量路径上**不可达**。用户侧含义：**笔记里写 `halo.publish: false` 挡不住批量发布** —— 想排除某一篇只能在确认弹窗里取消勾选。单篇 `Halo: 发布` 不传 override，仍读 `halo.publish`。

### 业务层 — `src/service/` 与 `src/transport/`

| 文件 | 唯一职责 |
|---|---|
| `service/index.ts` | `HaloServiceBase`（文章与页面**共用**的：站点/客户端字段、发布事务重试、正文切分、便签播报、失败文案）+ `HaloService`（编排：`planPublish` 零写入 / `executePublish` / 更新 / 拉取 / 分类标签解析） |
| `service/page-service.ts` | 独立页面的编排（`PageService extends HaloServiceBase`）：推 / 拉 / 发布状态 / 回收 / 恢复 |
| `service/local-content.ts` | 本地内容：frontmatter 应用（`applyPostFrontmatter`）、正文里的本地图片引用解析 |
| `service/image-upload.ts` | 图片上传：≤ 7 MiB 走 MCP base64，超出回退 REST multipart |
| `service/post-mapping.ts` | 适配：MCP 的**扁平** post 表示 ↔ `{metadata, spec}` 嵌套结构 |
| `service/page-mapping.ts` | 独立页面的映射 + **页面自己那一对前言函数** |
| `core/content-kind.ts` | 两类内容的工具名表（`CONTENT_TOOLSETS`）与 `ContentKind` |
| `core/pagination.ts` | 通用翻页取数器（`fetchAllPages` / `LIST_PAGE_SIZE` / `PagedResult`） |
| `core/frontmatter-map.ts` | frontmatter 契约的**唯一**定义处：6 个元数据字段的校验与回写 |
| `core/site-routing.ts` | 站点解析的唯一入口（`resolveSite`） |
| `core/glob.ts` | glob 模式匹配 |
| `ui/models/publish-preview.ts` | 发布预览的纯数据构造（`buildPublishPreview`） |
| `commands/batch-publish.ts` | 批量：候选收集（含跳过原因）、规划、按勾选算汇总、执行 |
| `transport/mcp-client.ts` | MCP JSON-RPC 客户端（`McpClient`，唯一出口） |
| `transport/errors.ts` | `McpError` 与 HTTP / 工具级失败的归一化 |

`McpClient` 可注入（构造函数第 4 个参数）—— 测试传假对象以断言「调了哪个工具、传了什么参数」；生产代码不传，走真实 `requestUrl`。

**几个必须知道的细节**：

- **读用 `callToolJson`，写用 `callToolVoid`**。写路径**不消费**返回体（写与读解耦），也不假设它可解析：若用 `callToolJson`，服务端写成功却回了人读文案时会抛错 → 触发整事务重试 → 新建分支拿同一个 name 再建一次被重名拒绝；用户看到「发布失败」而文章其实已经写好了。
- **`requestUrl` 默认在非 2xx 时直接抛异常**，拿不到状态码与响应体（MCP 传输层要区分「400 空体」与「401」，故固定传 `throw: false`）。
- **REST 的三套命名空间只剩图片回退上传还在用**，用错会 403：写文章走 `uc.api.content.halo.run`，读写分类/标签走 `content.halo.run`，传图走 `uc.api.storage.halo.run`。**MCP 路径完全不经过它们**（走 `/mcp` 单一端点）。
- **发布重试**：`withPublishRetry()` 包住整个发布事务，3 次重试、500ms 线性退避。**发布状态那一步必须留在重试闭包内**：移出去会同时丢掉重试覆盖与「建文章成功、发布状态失败」的自愈回填。
- 分类/标签**不存在会自动创建**，slug 用 `transliteration` 转拼音。副作用：一次手误的标签名会在站点上永久留下垃圾标签。
- **分类/标签的显示名解析失败要跳过该字段的回写**，绝不落回 `metadata.name`：消费方按 displayName 精确匹配，写入 name 会在下次发布时造出垃圾分类/标签。注意 `getCategoryDisplayNames()` 返回 `undefined`（无从解析）与 `[]`（确实没有）是两回事，签名已如实标注。

**列表取数一律「翻页取全」，只在触顶时才提示**：所有列表（分类 / 标签 / 文章 / 页面 / 附件 / 回收站）都走 `core/pagination.ts` 的 `fetchAllPages()`，按 `hasNext` 逐页取到没有下一页。页大小统一 `LIST_PAGE_SIZE`（100，schema 的 `maximum`），**默认最多 20 页**（= 2000 条）。

- **唯一的提示条件是「触顶 `maxPages`」**，那时回 `truncated: true`，调用方弹 `service.notice_list_truncated` / `post_selection_modal.notice_truncated`。判据是「真的不完整」，不是「还有下一页」—— `hasNext` 为真只是翻页过程中的正常中间状态。
- `maxPages` **不是为了省请求，是为了保证终止**：站点侧若给出永远为真的 `hasNext`，没有上限的循环会一直发请求直到 Obsidian 卡死。所以 `fetchAllPages()` 有**两条**终止保证，缺一不可 —— ① `hasNext` 为假；② 某一页返回空 `items`（即使 `hasNext` 还说有）。

**列表项的公共字段抽在 `McpContentItemBase` 里，但两种内容的 `required` 契约不同 —— 别把它当成一份完整契约**：文章与页面共有的字段只声明一次（`McpPostItem` 与 `McpSinglePageItem` 各自 `extends`），不抽的话两份声明必然在某次服务端改动后分叉，表现是「文章读得到、页面读不到」。

- `halo_list_posts` 的 item `required` 是 `["published","publishRequested","recycled","categories","tags"]`；`halo_list_single_pages` 的是 `["published","publishRequested","recycled"]`
- **`name` / `title` / `slug` 三者在两份里都不在 `required` 中**，所以随时可能缺席。两个选择器的规范化因此各写一份（`toSelectablePosts()` 与 `toSelectablePages()`，逐字同构但**刻意不复用**：合一会让签名退化成结构类型，丢掉「两种内容字段集不同」这条信息）：**缺 `name` 的项直接剔除**（那是拉取命令的唯一入参，列一个按了就坏的按钮比不列更糟）、**缺 `title` 回落成 `name`**（用 `||` 而非 `??` —— 空串同样是一行空白）、缺 `slug` 回落空串
- 同一族契约在另外两处**更宽**：`halo_list_attachments` 的 `required` 是**空数组**（全部可选，要逐项兜底）；`halo_search_content` 的 `required` 含 `type` 但 `name` / `title` / `excerpt` / `permalink` 都不在（同样剔除缺 `name` 的项）

### 独立页面

独立页面（Halo 的 `SinglePage`）与文章是**同一件事的两个实例**，不是两套实现。

**编排共用 `HaloServiceBase`**（`service/index.ts`）：站点/客户端字段、`withPublishRetry()`、正文切分、便签播报、失败文案。`PageService` 只覆盖**实质差异**：① 工具名换一套（`CONTENT_TOOLSETS.page` 的 7 个）；② 入参 8 键（create）/ 7 键（update）；③ 前言只认三个 `halo` 键。**重试策略共用是刻意的**：复制一份必然在某次改动后分叉，而分叉的表现是「文章会重试、页面不会」，本地完全看不出来。

**回写笔记用页面自己那一对函数**（`applyPageFrontmatter()` / `applyPageToFrontmatter()`，在 `service/page-mapping.ts`）。**刻意不复用文章那一对**：借文章那份来写会往每一篇页面笔记里塞进 **5 个 `undefined`**（`cover` / `halo.pinned` / `halo.priority` / `halo.publishTime` / `halo.template`）。

**两个前言契约的差别就是键数**：

| | `halo` 块 | 内容 |
|---|---|---|
| 文章 | **9 键** | `site` / `name` / `publish` + 6 个元数据字段 |
| 独立页面 | **3 键** | 只有 `site` / `name` / `publish` |

**独立页面没有的字段**：`categories` / `tags` / `pinned` / `priority` / `publishTime` / `template` / `cover` / `excerpt`。这不是「服务端没回」，是**页面这个资源本来就没有这些概念** —— 用户在页面笔记里写了这些字段**不会有任何结果**（`HaloPageFrontmatter` 因此一个都不收：为「写了也不会有结果」的字段造校验，只会让他以为自己写下的值生效了）。

`excerpt` 还要多说一句：**回写时整个键都不出现**（文章路径会写它），因为页面根本不发 `excerpt`，照文章那条判据写就是每次推送都把本地摘要赋成 `undefined`。

**其余与文章路径的异同**：

- **页面没有规划 / 预览 / 图片上传**：通常是「关于」「友链」这类短文档，所以 `pushPage()` 是**直写**路径，没有 `planPublish()` 那种零写入规划阶段。真需要传图先用「`Halo: 上传图片`」
- **防跨站误推的判据与文章相同**：前言的 `halo.site` 与目标站点不一致时**一个工具都不调**，直接返回失败
- **发布状态同样是三档**：命令的显式覆盖 > 前言的 `halo.publish` > 设置的 `publishByDefault`。第三档在开关为**假**时**不发**那次调用（而不是发 `publish: false`）—— 后者会把一篇已发布的页面悄悄退回草稿，而用户看到的是「推送成功」
- **`truncated` 为真时同样必须抛错**，绝不能把截断正文当完整页面写进本地笔记
- **`allowComment` 在入参里写死 `true`**：`halo_create_single_page` 收它，但 `halo_get_single_page` **不回它**，本地无从得知远端值。**不要**把它做成 frontmatter 可配的 —— 那会引入一个「写出去读不回来」的字段，而写出去读不回来的字段会静默漂移
- **页面的回收 / 恢复是与文章并列的两套工具**（不是带布尔参数的同一个），所以拆成两条命令，只在 `kind` 上分档

### MCP 协议硬约束

弄错任何一条，只会得到「400 且响应体为空」或「看起来成功其实写错」，都很难反查：

- **`Accept` 必须同时含 `text/event-stream`**（服务端返回 SSE）
- **必须先 `initialize`** 才能 `tools/list` / `tools/call`；**无 session**
- **`tools/call` 的工具级失败是 HTTP 200 + `result.isError: true`**，不是 4xx。只按 HTTP 状态码判成败会把失败当成功
- **`rawType` 必须显式传 `"markdown"`**：schema 默认值是 `"html"`，漏传会把 Markdown 当 HTML 存，站点渲染错乱而本地看不出异常
- **`publishTime` 空值传 `null`**（schema 是 `["string","null"]` + `format: date-time`），不能传空字符串
- **`truncated` 为 true 时必须抛错**，绝不能把截断正文当完整文章写进本地文件

### 设置与弹窗

`src/settings.ts` 定义 `HaloSetting` / `HaloSite` 与设置面板。站点相关的弹窗：

| 文件 | 作用 |
|---|---|
| `ui/modals/sites-modal.ts` | 站点列表（增删、设为默认） |
| `ui/modals/site-editing-modal.ts` | 编辑单个站点。内含「Validate」按钮，跑 **MCP 自检**（`runSelfCheck` + `mcpToken`）—— 校验的正是用户真正要填的那把密钥 |
| `ui/modals/site-selection-modal.ts` | 发布时选目标站点 |
| `ui/modals/post-selection-modal.ts` | 拉取时选远程文章 |
| `ui/modals/page-selection-modal.ts` | 同上，但选独立页面；取数走 `PageService.getPages()` 而不是自己造 client |

内容管理类的弹窗（查重 / 附件 / 回收站 / 独立页面管理）各自与自己的纯数据层配成一对，见「业务层」模块表。

### frontmatter 契约

这是「本地笔记 ↔ 远程文章」的锚点，**语义不可变**，否则已发布的笔记会失联：

```yaml
title / slug / excerpt / cover / categories / tags
halo:
  site: https://blog.example.com   # 防跨站误推，不匹配直接报错返回
  name: <post metadata.name>       # 判断「新建 or 更新」的唯一依据
  publish: true
  visible: PUBLIC                  # PUBLIC | INTERNAL | PRIVATE（只认这三个大写值）
  pinned: false                    # 置顶
  priority: 0                      # 排序权重，整数
  publishTime: ""                  # 空串 = 立即发布；非空 = 定时发布（RFC 3339）
  allowComment: true               # 单篇评论开关
  template: ""                     # 自定义渲染模板
```

6 个元数据字段**双向读写**：发布时由 `core/frontmatter-map.ts` 的 `parseHaloPostFields()` 校验、`service/local-content.ts` 的 `applyPostFrontmatter()` 稀疏展开进 `spec`；发布后由 `frontmatter-map.ts` 的 `applyPostToFrontmatter()` 从**服务端归一化之后的** `post.spec` 回写（发布 / 更新 / 拉取三处共用）。

> **两个方向分居两个文件**：展开进 `spec` 的那一半在 `service/local-content.ts`（它同时管正文里的图片引用），回写与校验同在 `frontmatter-map.ts`（契约的唯一定义处）。页面对应的一对见「独立页面」。

`publish` 的优先级是「命令的显式覆盖 > frontmatter 的 `publish` > 设置的 `publishByDefault`」，其中 frontmatter 那一档读的是**规划阶段**记下的 `plan.publishFromFrontmatter`，不是执行时现读笔记。

**稀疏是契约**（`HaloPostFields` 上的键「在不在」就是「写没写」）。**前提是这篇笔记已经存在远端文章** —— 对**新建**（从没发布过的笔记）没有对象：新建分支的底是 `createEmptyPost()` 那个字段齐全的字面量，没有远端可跟随，缺键时用的是**插件内置默认值**。（默认值的唯一定义在 `createEmptyPost()`，文档刻意不复述，避免第二份真值来源漂移。）

- **`null` 与「键不存在」同义**。判据是 `value !== undefined && value !== null`，**不是真假判断**。对 `pinned` / `allowComment` / `priority` / `template` 用真假判断，会把 `pinned: false` 变成「跟随远端」—— 用户取消置顶后发布，站上仍是置顶的，**而回写还会把 `true` 写回他的笔记**
- YAML 里 `visible:` 这种空值自然解析成 `null`，所以「写成空值」与「删掉这一行」同义。⚠️ 但 `visible: ""`（**一对引号**，显式空**字符串**）是显式值，会被取值校验拦下报错。两者在 YAML 里只差一对引号，而一行报错可能就是用户唯一能拿到的线索
- `false` / `0` / `""` 是**显式值**
- **`publishTime` 是唯一的例外**：`""` 是**合法值**，语义是「立即发布」。要清空已有的定时发布，必须写 `publishTime: ""`，**删掉那一行只会让它继续跟随远端**

**写入方向是穷尽的，读取方向才是稀疏的** —— 两者不对称，别误读：`applyPostToFrontmatter()` 每次回写都会把 6 个键**全部**写进 `halo`，所以一篇已发布的笔记发布完之后，笔记里必定出现完整的 6 个键、且带着显式空串的 `publishTime: ""`。稀疏语义管的是**读取**那一侧。

这 6 个字段在预览弹窗里逐行显示，而预览与执行读的是**同一份** `planned.plan.post.spec` —— 预览里给用户看过的取值就是最终会发出去的那份。

### 内容管线

```
frontmatter 之后的部分 → raw（原始 Markdown，客户端不渲染）
  → halo_create_post / halo_update_post 的 raw + 显式 rawType: "markdown"
  → 渲染交给 Halo 服务端（content 也由服务端按 raw 生成，客户端刻意不传）
反向读取：halo_get_post（version: HEAD、format: RAW）一次返回 { item, content, truncated }
  item 是扁平表示（经 post-mapping.ts 转成嵌套 Post），content.raw 是原文
```

**关键事实：客户端渲染结果不是读者看到的东西。** Halo 存储的 `rawType` 是 `markdown`，前台 HTML 由 Halo 服务端自己的管线生成（实测线上页面的 mermaid 被渲染成 `<div class="bytemd-mermaid"><svg>`，裸 markdown-it 不可能产出该结构）。**在插件里换渲染器对前台显示无效** —— 要改渲染得改 Halo 侧的插件或主题。

**客户端渲染那一步已删除**（`createPostContent()` 随 MCP 切换作废），连带两个死模块 `src/utils/markdown.ts` / `src/utils/yaml.ts` 与五个依赖（`markdown-it` / `markdown-it-anchor` / `gray-matter` / `js-yaml` / `builtin-modules`）**已清理**。

> **不要再把它们加回来。** 触发清理的是 Obsidian 官方审核报告：那五个依赖带来 7 条依赖漏洞告警，而它们**一个字节都没进产物**（实测 `main.js` 里出现次数均为 0）。**读 frontmatter 一律走 Obsidian 的 `metadataCache.getFileCache().frontmatter`。**

### 图片管线

扫描本地图片引用（`![](...)` 与 `![[]]` 两条正则，跳过远程路径）在 `service/local-content.ts`，上传在 `service/image-upload.ts`。

- **两条路径，阈值 7 MiB**（`MCP_UPLOAD_MAX_BYTES`）：≤ 7 MiB 走 MCP `halo_upload_attachment`（base64）；超过才回退 REST multipart（**这条路需要 PAT**）
- `imageUploadCache` 键为「站点 URL + 文件路径」，用 `size` + `mtime` 判断失效
- 反方向有 `restoreCachedLocalImageLinks()`，把远程链接还原成本地路径（「替换图片链接」关闭时生效）

**发布前统一前置**：`uploadImagesForPublish()` 静默上传，**只要有任意一张失败就中止发布**（`failedCount > 0` → `success: false`）。发布时把上传后的 markdown 作为 `{ markdown }` 传进去，避免重新读盘拿到未替换的旧内容。

**反向的那一步不在 `uploadImages()` 里**：它由「**从 Halo 更新内容**」在「替换图片链接」**关闭**时调 `restoreCachedLocalImageLinks()` 完成（`HaloService.updatePost()` 里那个三元分支 —— **不是**名字相邻的 `pullPost()`）。开着那个开关时反而是把远端正文原样落盘。

### i18n

`src/i18n/index.ts` 把 `locales/{en,zh-cn,zh-tw}.json` 注册为 i18next 资源。语言取 `moment.locale()`，回落 `en`。取值走点号路径，支持 `{{var}}` 插值。

> **新增文案必须三个语言文件同步加键**，否则切语言时显示原始键名。

## 测试

`tests/setup.ts` 用 `rs.mock("obsidian", ...)` **整体 mock 掉 obsidian 模块**（`TFile` / `TFolder` / `Notice` / `Modal` / `Setting` 等类，以及 `requestUrl`）。因此任何测试都能直接注入 HTTP 响应。

- 测试文件放 `tests/` 下，**逐目录镜像 `src/` 结构**，命名 `*.test.ts`。四处**有意的不对称**，别当成漏搬：`src/i18n/locales/`（数据，由 `i18n/index.test.ts` 覆盖）、`src/utils/id.ts`（无专属测试）、`tests/contract/`（对真实站点的契约测试）、`tests/helpers/`（测试脚手架本身）
- 断言 HTTP 行为用 `requestUrl as unknown as RequestUrlMock` 取到 mock，再 `mockImplementation` / `mockReset`
- rstest 的 mock API 是 Jest 风格的：`rs.fn(impl)` / `rs.spyOn(obj, k)` / `mock.calls` / `mockRestore()`
- 测 `HaloService` 的现成脚手架在 `tests/service/index.test.ts`：`createMockApp()` / `createFile()` / `createSettings()`
- ⚠️ **`rs.mock("...", ...)` 的路径参数不走 `from "..."`**，任何「批量替换 import 路径」的脚本都会漏掉它。症状是 `mockReset is not a function`（mock 没生效，拿到的是真模块的导出）。**改完路径后 `grep -rn 'rs\.mock(' tests/` 复核一遍。**

## 发布

### 版本号

**`manifest.json` 的 `version` 决定用户装到哪一份代码**：Obsidian 会去找 **tag 与它完全一致**的 release，从那里下载 `main.js` / `manifest.json` / `styles.css`。所以它与 release tag **必须一致**，且**不带 `v` 前缀**（`.npmrc` 设了 `tag-version-prefix=""`）。

- **现为 `0.1.1`**，是本 fork 的**自有版本序列**，不是上游的延续。上游最后是 `1.2.0`（tag `1.2.0` 仍在仓库里，但 release 内容是**上游原版代码**，没有 MCP 能力）。**绝不要把 version 写回 `1.2.0`** —— 那会让 Obsidian 下载上游那份 `main.js`，用户装到的是与描述不符的旧插件
- 版本号从 `0.1.0` 起步是刻意的：本 fork **改了插件 `id`**（`halo` → `halo-mcp`），在 Obsidian 眼里是**新插件**而非 `halo` 的更新，不该沿用上游序列。`versions.json` 因此只剩自有版本，上游那六条已删（留着会让 Obsidian 在低版本客户端上回落到上游版本）
- **`minAppVersion` 是 `1.13.0`**：设置面板用 `setDestructive()`（1.13.0 起取代废弃的 `setWarning()`）。**不要为了兼容更老的客户端降回去** —— 降了就得同时换回 `setWarning()`，而后者在 1.13.0+ 会报废弃警告
- `package.json` 的 `version` 与 `manifest.json` 的版本**没有联动关系**：那是 npm 包版本，而该包标了 `"private": true`、永不发布。**没有任何工具会比对这两个数字**
- **不要手工改 `manifest.json` / `versions.json` 的版本号**，走 `pnpm version`

### 发布流程

```bash
pnpm version 0.1.2          # 改 manifest.json + versions.json
git push origin main
git tag 0.1.2 && git push origin 0.1.2
```

推送 tag 会触发 `.github/workflows/workflow.yaml`，构建后把 **`manifest.json` + `main.js`** 作为 Release 产物。

- ⚠️ **不要「删除 tag 后立刻重建同名 tag」—— 那样不会触发 workflow。** 推全新 tag 是正常触发的；先 `gh release delete --cleanup-tag` 删掉再重建同名 tag，则**一条 push 触发的记录都没有**。**要改已发布的 tag，用新版本号，不要重建旧 tag**
- 万一确实没触发，手动补跑。**`--ref` 必须指向 tag，不是 `main`**：指向 main 会失败，报「⚠️ GitHub Releases requires a tag」—— `softprops/action-gh-release` 要靠当前 ref 推断往哪个 release 传产物，而 main 上没有 tag 上下文

  ```bash
  gh workflow run Release --repo LHY0125/obsidian-halo --ref 0.1.2
  ```

- **产物必须由 CI 构建。** Obsidian 审核器会把 release 上的 `main.js` 与「从源码重建的产物」逐字节比对，对不上就报 "Build output does not match the released main.js artifact"。workflow 里有 `Report artifact hash` 与 `Verify the build is reproducible` 两步，日志里能直接看到 sha256
- **产物里没有 `styles.css`**：`rslib.config.ts` 的 entry 只有 `src/main.ts`，也不打包 CSS —— 仓库根那个 `styles.css` 是给使用方本地覆盖的占位文件，改它不会被发布，也不会被更新覆盖

## 其它约定

- **import 一律用相对路径**（`./` / `../`）。`tsconfig.json` 设了 `baseUrl: "."`、技术上支持 `src/` 开头的写法，但全仓已统一为相对路径。混用两种风格会让搬文件时的批量改写漏掉一半（两者的解析基准不同）。**唯一的绝对形式在测试里**：`rs.mock("src/xxx", …)`
- **代码风格由 Biome 定**（`biome.json`）：120 列、LF、双引号、尾逗号 always、自动整理 import。`pnpm check` 会自动改，别手写格式化
- **`src/utils/id.ts` 的 `randomUUID()` 是手写实现**（不用 `crypto`），用于生成新文章的 resource name 与 multipart boundary
- **`command.*.name` 里不要带 `<插件名>: ` 前缀**：Obsidian 会自己拼 `<插件名>: <命令名>`，而 `manifest.json` 的 `name` 是 **`Halo-MCP`** —— 在 locale 里再写一遍前缀，命令面板就会显示成「Halo-MCP: Halo-MCP: 管理附件」。**只去掉开头那一个前缀**，名字里其它位置的 `Halo` 一律不动（那些指的是**站点软件**，不是插件名）。自查：`grep -n ': "Halo' src/i18n/locales/*.json` 应为空。⚠️ 要改的是 locale，**不是** `manifest.json` 的 `name`
- **`command.*.name` 只有一个消费者：`main.ts` 的 `addCommand({ id, name })`**。**不要**顺手拿命令名当别的用户文案 —— 命令名是**祈使句**（「管理独立页面」），而提示语需要的是陈述或处置指引。降级 / 占位提示请另建 `*.error_*` / `*.notice_*` 键
- **License 以 `LICENSE` 文件为准：GPL-3.0**。`package.json` 里写的 `"license": "MIT"` 与仓库实际的 GPL-3.0 全文冲突，属于上游遗留错误 —— 按 GPL-3.0 处理
- **`manifest.json` 的 `author` / `authorUrl` 是维护者署名，不是版权声明**（现为 `Serendipity` / `https://github.com/LHY0125`）。**不要「修」回上游的 `Ryan Wang`** —— 这个字段在 Obsidian 里是面向用户的显示值，回答「谁在维护」。**GPL-3.0 的署名要求落在别处**（`LICENSE` 全文、源码文件头、`README.md` 顶部的 fork 说明），改 `author` 不影响合规性
