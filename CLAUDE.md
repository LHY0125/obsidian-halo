# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这个仓库是什么

[`halo-sigs/obsidian-halo`](https://github.com/halo-sigs/obsidian-halo) 的 fork——一个把 Obsidian 笔记发布到 Halo 博客的插件。

- `origin` = `LHY0125/obsidian-halo`（本 fork，推送目标）
- `upstream` = `halo-sigs/obsidian-halo`（官方源，**只读参考**，不双向同步）
- 上游 v1.2.0 的完整历史是本仓库 `main` 的基底，因此同步上游修复走 `git fetch upstream && git cherry-pick <sha>`

**已经完成的工作**：发布后端已从「直连 Halo REST API」切到「以 Halo 官方 MCP Server 插件为后端」。
**REST + PAT 只剩一条路**（上传超过 7 MiB 的图片），现状见 `README.md` 的「当前进度与凭据要求」。

- 设计文档：`docs/superpowers/specs/2026-10-03-obsidian-halo-mcp-reshape-design.md`
- 阶段 0 / 传输层计划：`docs/superpowers/plans/2026-10-03-bootstrap-and-mcp-transport.md`
- **本次切换（发布链路整体改走 MCP）的实现计划**：`docs/superpowers/plans/2026-10-03-mcp-pipeline-cutover.md`

**接手前先读这三份**——计划里记录了三条实测出来的 MCP 协议硬约束（`Accept` 必须含 `text/event-stream`、必须先 `initialize`、无 session），弄错任何一条都只会得到「400 且响应体为空」，看不到原因。其余协议约束见下方「MCP 协议硬约束」一节。

**站点侧前置条件**：Halo **≥ 2.26**，且已安装并启用官方 [MCP Server 插件](https://github.com/halo-dev/plugin-mcp-server)；在后台「工具 → MCP 服务」创建的访问密钥以 `hmcp_` 开头，并需为它勾选下面**四组共 23 个**工具（分组与计数以 `src/mcp-self-check.ts` 的 `REQUIRED_TOOLS` 为准 —— **它才是自检断言的权威**；文档列少了，用户照做后自检会误报「缺少工具」）：

| 组 | 个数 | 工具 |
|---|---|---|
| 文章 | 7 | 列表 / 读取 / 新建 / 修改 / 发布状态 / 回收 / 恢复 |
| 独立页面 | 7 | 与文章**同构的一套**（没有分类标签 —— 页面本来就没这两个字段） |
| 分类与标签 | 4 | 两类的列举与创建各一 |
| 检索与附件 | 5 | 全文检索、附件列表 / 读取 / 删除、附件上传 |

评论、主题设置、`upload_attachment_from_url` 以及插件贡献的工具（PluginMoments / image-stream）**刻意不在其中** —— 插件不调用它们，勾了也用不上。（2026-10-05 对真实站点拉过一次 `tools/list`，51 个工具里上述 23 个逐条命中；`pnpm test:contract` 是它的自动化版本。）

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

**批量命令会改写本地笔记**：`Halo: 批量推草稿` / `批量发布` 在「替换图片链接」打开时会把笔记里的
本地图片地址换成 Halo 地址。三条命令都从**全库**取候选，
所以在一整个 vault 上跑之前先想清楚范围（确认弹窗里可以按篇取消勾选）。

⚠️ **`Halo: 批量撤回` 不写回本地笔记**（只在远端把发布状态退回草稿，见下方「批量操作」）。而 `Halo: 批量发布`
对每一篇都强制传「发布」、不看笔记里的 `halo.publish`，所以**撤回后再跑一次批量发布会让这些文章复活**。

## 架构

### 入口与命令编排 — `src/main.ts`

`HaloPlugin extends Plugin`。`onload()` 里做三件事：初始化 i18next、`loadSettings()`、注册命令与功能区图标。

命令本身很薄，真正的编排在私有方法里，统一模式是：**解析目标站点 → 规划（零写入）→ 预览确认 →
上传图片 → 执行**。

**命令清单**（16 条；`id` 用于核对，`name` 是 `src/i18n/locales/` 里的取值，Obsidian 会把它们显示成 `<插件名>: <name>`）：

| id | 作用 | 类型 |
|---|---|---|
| `publish` | 发布当前笔记到解析出的站点 | 单篇 |
| `publish-with-defaults` | 发布到默认站点，**不经过路由规则** | 单篇 |
| `upload-images` | 上传笔记里的本地图片并替换链接 | 单篇 |
| `update-post` | 从 Halo 更新当前笔记内容 | 单篇 |
| `pull-post` | 从 Halo 拉取文章（含选文列表） | 单篇 |
| `push-page` | 把当前笔记**推成独立页面** | 独立页面 |
| `pull-page` | 从站点拉一个独立页面到本地 | 独立页面 |
| `manage-pages` | 管理站点上**不在回收站**的独立页面 | 独立页面 |
| `recycle-post` | 回收站（文章）：列出并恢复 | 远端管理 |
| `recycle-page` | 回收站（页面）：列出并恢复 | 远端管理 |
| `search-content` | 查重：搜站点上的内容（**含草稿**） | 远端管理 |
| `manage-attachments` | 管理附件：列出 / 复制链接 / 删除 | 远端管理 |
| `mcp-self-check` | MCP 连通性自检（握手 + 断言 `REQUIRED_TOOLS`） | 自检 |
| `batch-draft` / `batch-publish` / `batch-unpublish` | 三个批量命令，共用 `runBatchCommand(action)` | 批量 |

后七条（`push-page` 起的独立页面与远端管理两组）是**「内容能力对齐」阶段新增**的。它们与前面那批的差别不只是功能：
`push-page` 走 `PageService`（见下方「独立页面」一节），而 `pull-page` / `manage-pages` / 两条回收站 /
`search-content` / `manage-attachments` **手上没有本地文件** —— 站点只能靠 `pickSiteForPull()`
（默认站点 / 唯一站点 / 弹窗）拿，走不了 `resolveSiteFor(file)`（那个要 `file.path` 才能匹配路由规则）。

- 站点解析优先级：frontmatter 的 `halo.site` → **路由规则表自上而下首个命中** → 设置里的默认站点 →
  单站点直取 → 弹窗让用户选
- `uploadImagesForPublish()` 是发布前的统一前置：静默上传图片，**只要有任意一张失败就中止发布**（`failedCount > 0` → 返回 `success: false`）
- 发布时把上传后的 markdown 作为 `{ markdown }` 传进去，避免重新读盘拿到未替换的旧内容

**站点解析只有一处入口 —— 不要另行解析**：`src/main.ts` 的 `HaloPlugin.resolveSiteFor(file)` 一层薄胶水
（只负责从 `metadataCache` 取 `halo.site` 再转交，**不补 `?? ""`**），真正的规则在 `src/site-routing.ts`
的 `resolveSite(sites, rules, filePath, frontmatterUrl)`（纯函数）。**发布与上传图片共用它**，
批量路径（`src/batch-publish.ts` 的 `collectBatchCandidates()`）也走它，只是把结果当**数据**收着
（批量不能一篇一弹窗）而不是就地处置。

`resolveSite` 返回带 `kind` 的**联合**而不是 `HaloSite | undefined`，因为批量必须能说清
「这篇为什么没有站点」：`resolved` / `needs-choice` / `no-sites` / `unknown-site` / `unknown-rule-site`。
`resolved` 上的 `source` 还带一档 `rule` 与它命中的 `pattern`，好让预览如实标注站点是怎么定下来的。
两处「**报错而不是继续往下找**」（`unknown-site` / `unknown-rule-site`）是刻意的：继续往下找的后果是
把笔记发到**另一个站**上，而那是不可恢复的；报错只是让用户去改一行配置。

`src/glob.ts` 是 glob 匹配的**零项目内依赖叶子**（`matchGlob()` / `normalizeRulePattern()`）。
拆出去是为了破一个真 import 环：`settings.ts`（设置面板要显示每条规则命中几篇）要用 `matchGlob()`，
而 `site-routing.ts` 要用 `settings.ts` 的 `isSameSiteUrl()`。**往 `glob.ts` 加任何 `import` 之前先读它顶部的说明** ——
环在打包器里未必直接报错，而是在某些 import 顺序下让某个绑定变成 `undefined`（本地测试跑得通，发出去的 `main.js` 才出问题）。
匹配**大小写不敏感**（`globToRegExp` 构造正则时带 `i` 标志），因为用户在 Windows 上看到的目录名与实际
大小写未必一致，而**没命中是没有任何提示的**。`matchGlob()` 归一化的是**模式**、**不**归一化**路径**：
传进来的 `filePath` 必须是 `/` 分隔的库内相对路径 —— 传反斜杠路径**可能导致规则不命中，
也可能命中本不该命中的规则**。细节见 `src/glob.ts` 的 `matchGlob()` 文档。

**批量操作**：三个命令（推草稿 / 发布 / 撤回）共用 `HaloPlugin.runBatchCommand(action)`，只在 `action` 上分档。
候选是**全库的 markdown 笔记**；规划（`planBatch()`）与执行（`runBatch()`）都在 `src/batch-publish.ts`，
确认与两处弹窗在 `src/batch-confirm-modal.ts`。三条必须记住的性质：

- **规划阶段零写入**，且 `planBatch()` 的分类标签是**按站点取一次的快照** —— 留着它才能让
  「将新建」跟着勾选实时重算，而不必每勾一次就打一次 MCP。
- **执行阶段失败不中断**：这是对上游「任一图片失败即中止发布」的**刻意偏离**，只用于批量路径 ——
  118 篇里第 3 篇失败不该让后面 115 篇一篇都不发。单篇命令仍保留中止语义。
- **末尾汇总把三档分开报，且执行前跳过的也逐条列出原因**（此前这里只有一个数字、没有原因）：
  汇总行是「成功 N 篇，失败 N 篇，另有 N 篇在执行前就被跳过」，随后**分两段**列明细 ——
  先**失败项**（`路径 —— 原因`），再**另起一段**（标题「执行前跳过的 N 篇」）并**逐条列出**执行前跳过的那几篇及原因。
  两段**刻意不合成一张清单**：失败是「跑了但炸了」（用户要去站点上确认那篇现在的状态），而跳过是
  「压根没让它跑」（用户要去改配置或补发布）—— 混在一起时用户只能靠原因文字猜「这一篇到底有没有
  被尝试过」，猜错的代价是把一篇**从没动过**的文章当成半成品去站点上找。
  确认弹窗里**本来就有**这份跳过清单（那是用户在按下「执行」之前看的），末尾这份不是重复，而是补上时机：
  跑完之后确认弹窗已经关了，用户此刻手上只有汇总。两处渲染的是**同一份** `BatchSkip`（带 key/params，
  由弹窗渲染），所以用的是**同一套** `batch.skip_*` 文案键，同一个原因在两处不会说法不一致。
  汇总标题按 `action` 分档（`batch.summary_title_${action}`），**不用**一句通用的「批量操作完成」——
  三个命令跑完都是同一句的话，用户点了「批量推草稿」看到「成功 118 篇」，弹窗没说是草稿还是已经发出去了。

**批量推草稿与批量发布也会改写本地笔记**，不是只动远端，而且**不止图片链接这一项**：
`executePublish()` 里的 `processFrontMatter()` **无条件**回写 `title` / `slug` / `cover` / `excerpt` /
`categories` / `tags` 与整个 9 键 `halo` 块（发布状态 `halo.publish` 也在其中）—— **关掉「替换图片链接」
也照写**；`uploadImages()` 另外在「替换图片链接」**打开**时把笔记里的本地图片地址换成 Halo 地址。
反向的那一步（把远程链接还原成本地）**不在** `uploadImages()` 里：它由「**从 Halo 更新内容**」
那条命令在「替换图片链接」**关闭**时调 `restoreCachedLocalImageLinks()` 完成
（`HaloService.updatePost()` 里那个三元分支 —— 注意**不是**名字相邻的 `pullPost()`，
那是另一条命令「从 Halo 拉取文档」）。开着那个开关时反而是把远端正文原样落盘。
批量路径碰不到它：那条命令只作用于当前活动文档。
确认弹窗里有一条显式提示（`batch.notice_rewrites_notes`），它**门控在 action 上**（撤回不显示，
因为撤回一个字节都不改），且必须出现在**确认之前**。
**批量撤回是个例外：它只在远端把发布状态退回草稿**，不**改写**正文、
也**不回写本地笔记** —— `runBatch()` 的 unpublish 分支直接 `changePostPublish()` 后 `continue`，
从不进 `executePublish()`（`applyPostToFrontmatter` 的三个调用点里没有它）。
所以撤回后笔记里的 `halo.publish` **仍是原值**，而 `batch-publish` 对每一篇强制传
`publishOverride: true`、不看本地值 —— **撤回后再跑一次批量发布会把这些文章重新发出去**。
（`tests/batch-publish.test.ts` 有用例钉住「撤回不碰 `publishPost`」。）

⚠️ **措辞纪律：这里写「不改写正文」，不写「不读正文」。** 后者在**推草稿 / 发布**两条路径上仍是假的 ——
`planBatch()` 在那两条路径上会在循环里调 `deps.summarizeImages(candidate)`（`src/batch-publish.ts`），
而它经 `summarizeImages(file)` 落到 `summarizeLocalImages`，**靠读盘取正文**；读不出来的笔记进不了批
（记成 `batch.skip_unreadable`，理由是「读不出这篇笔记的内容」）。
**撤回是例外**：`planBatch()` 的 `unpublish` 分支不调 `summarizeImages` —— 撤回不改写正文、也不上传图片，
为它读一遍正文只会制造一条**答非所问**的跳过理由（用户会以为自己这篇撤回不了，而去查一个与本次操作无关的问题）。
所以「**不改写**正文」在三条路径上都为真，它**不会过期**；要写「读 / 不读」就必须按 action 分档。
**这段是行为描述，动 `planBatch()` / `runBatch()` 的人必须同时改本段。**

**批量命令按命令名决定发布状态，不看笔记里的 `halo.publish`**：`publishOverride` 在批量路径上
**永远是 `!== undefined`**（`publish` 给 `true`、`draft` 给 `false`、`unpublish` 走另一分支），
所以 `executePublish()` 里那条第二档（`plan.publishFromFrontmatter`）在批量路径上**不可达**。
用户侧的含义：**笔记里写 `halo.publish: false` 挡不住 `Halo: 批量发布`** ——
想排除某一篇只能在确认弹窗里取消勾选。单篇 `Halo: 发布` 不传 override，仍读 `halo.publish`。

### 业务层 — `src/service/` 与 `src/transport/`

后端已从「直连 REST API」切到 MCP。原先那个「单类 1085 行、装下全部 REST 业务逻辑」的 `src/service/index.ts` 现在**只剩编排**（`HaloService`），
具体职责拆在同级文件与 `src/transport/` 里：

| 文件 | 唯一职责 |
|---|---|
| `service/index.ts` | `HaloServiceBase`（文章与页面**共用**的那部分：站点/客户端字段、发布事务重试、正文切分、便签播报、发布失败文案）+ `HaloService`（编排：规划 `planPublish` 零写入 / 执行 `executePublish` / 更新 / 拉取 / 分类标签解析） |
| `service/local-content.ts` | 本地内容：frontmatter 应用（`applyPostFrontmatter`）、正文里的本地图片引用解析 |
| `service/image-upload.ts` | 图片上传：≤ 7 MiB 走 MCP base64，超出回退 REST multipart |
| `service/post-mapping.ts` | 适配：MCP 的**扁平** post 表示 ↔ `{metadata, spec}` 嵌套结构 |
| `service/page-mapping.ts` | 独立页面的映射：扁平表示 ↔ `SinglePage`（`toSinglePage`）、入参投影（`toPageCreateArgs` / `toPageUpdateArgs`）、**页面自己那一对前言函数**（`applyPageFrontmatter` / `applyPageToFrontmatter`） |
| `service/page-service.ts` | 独立页面的编排（`PageService`，继承 `HaloServiceBase`）：推 / 拉 / 发布状态 / 回收 / 恢复 |
| `content-kind.ts` | 两类内容的**工具名表**（`CONTENT_TOOLSETS`）与 `ContentKind`。**零项目内依赖的叶子**，拆出去是为破 import 环（`service/index.ts` 要按它分派工具名，而 `service/page-service.ts` 又要用 `service/index.ts` 的编排基类） |
| `pagination.ts` | 通用翻页取数器（`fetchAllPages` / `LIST_PAGE_SIZE` / `PagedResult`）。**零项目内依赖的叶子**；所有列表取数共用同一个页大小与同一套终止保证 |
| `frontmatter-map.ts` | frontmatter 契约的**唯一**一处：6 个元数据字段的校验（`parseHaloPostFields`）与回写（`applyPostToFrontmatter`） |
| `site-routing.ts` | 站点解析的唯一入口（`resolveSite`）；重导出 `glob.ts` 的 `matchGlob` / `normalizeRulePattern` |
| `glob.ts` | glob 模式匹配（路径 → 站点的路由规则用）。**零项目内依赖的叶子**，拆出去是为破 import 环 |
| `publish-preview.ts` | 发布预览的纯数据构造（`buildPublishPreview`），弹窗只负责 `createEl` |
| `publish-preview-modal.ts` | 发布预览弹窗；**取消返回 `false`** |
| `batch-publish.ts` | 批量：候选收集（`collectBatchCandidates`，含跳过原因）、规划（`planBatch`）、按勾选算汇总（`summarizeSelection`）、执行（`runBatch`） |
| `batch-confirm-modal.ts` | 批量确认弹窗（`BatchConfirmModal`）+ 末尾汇总弹窗（`BatchSummaryModal`） |
| `page-selection-model.ts` | 拉取独立页面时选远程页面。⚠️ 与 `post-selection-model.ts` 同为 `-model` 后缀的 Modal。映射是纯函数 `toSelectablePages(items)`，**取数走 `PageService.getPages()`**（刻意不自己造 client —— 翻页与触顶提示都已经在服务层里，抄第二遍漏掉的表现是「选择器里少了一部分页面」） |
| `search-preview.ts` | 查重的纯数据层：`McpSearchItem` → `SearchResult`、`<B>` 高亮剥离（`stripHighlight`）、取数（`searchContent`） |
| `search-modal.ts` | 查重结果弹窗（`SearchResultsModal`）+ 关键词输入弹窗。行数据由纯函数 `buildSearchRows()` 算好，弹窗只做 `createEl` |
| `attachment-model.ts` | 附件的纯数据层：翻页取全（`fetchAttachments`）、字段规范化、`formatBytes`、删除（带乐观锁 `expectedVersion`） |
| `attachment-modal.ts` | 附件管理弹窗（`AttachmentManagerModal`）：列表 / 复制链接 / 删除（**二次确认且不可逆**） |
| `recycle-model.ts` | 回收站的纯数据层：按 `kind` + `recycled` 取数（`fetchRecycled` / `fetchActivePages` 共用一份私有实现）、恢复 |
| `recycle-modal.ts` | 回收站弹窗（`RecycleBinModal`，恢复）+ 独立页面管理弹窗（`PageManagerModal`，移入回收站）。**两个弹窗的动作刻意不重叠** |
| `site-routing-modal.ts` | 编辑单条路由规则（模式 + 目标站点） |
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
- **列表取数一律「翻页取全」，只在触顶时才提示**：`HaloService.getCategories()` / `getTags()`、`post-selection-model.ts` 的 `fetchSelectablePosts()`、`service/page-service.ts` 的 `getPages()`、`attachment-model.ts` 的 `fetchAttachments()`、`recycle-model.ts` 的 `fetchRecycled()` / `fetchActivePages()` 全部走 `pagination.ts` 的 `fetchAllPages()`，按 `hasNext` 逐页取到没有下一页为止。页大小统一是 `LIST_PAGE_SIZE`（100，schema 的 `maximum`），**默认最多 20 页**（= 2000 条）。此前的两种坏处置都已消灭：分类/标签写死 `size: 100` 且**静默**漏掉后面的；拉取列表读 `hasNext` 但**只用它提示不完整**、不翻页（会在列表**已经完整**时谎报不完整 —— `hasNext` 为真只是翻页过程中的正常中间状态）。
  **唯一的提示条件是「触顶 `maxPages`」**，那时 `fetchAllPages()` 回 `truncated: true`，调用方据此弹 `service.notice_list_truncated` / `post_selection_modal.notice_truncated`（自检之外唯一的「列表不完整」出口）。`maxPages` 这个上限**不是为了省请求，是为了保证终止**：站点侧若给出一个永远为真的 `hasNext`，没有上限的循环会一直发请求直到 Obsidian 卡死。所以 `fetchAllPages()` 有**两条**终止保证，缺一不可 —— ① `hasNext` 为假（正常出口）；② 某一页返回空 `items`（即使 `hasNext` 还说有）。判据判「真的不完整」而不是「还有下一页」，是这一节的要点。
- **列表项的公共字段抽在 `McpContentItemBase` 里，但两种内容的 `required` 契约不同 —— 别把它当成一份完整契约**：文章与页面共有的 `name` / `title` / `slug` / `excerpt` / `published` / `publishRequested` / `recycled` / `visible` / `permalink` 只声明一次（`service/post-mapping.ts` 的 `McpContentItemBase`，`McpPostItem` 与 `McpSinglePageItem` 各自 `extends` 它），不抽的话两份声明必然在某次服务端改动后分叉，表现是「文章读得到、页面读不到」。**差异在 `required` 上**：`halo_list_posts` 的 item `required` 是 `["published","publishRequested","recycled","categories","tags"]`，`halo_list_single_pages` 的是 `["published","publishRequested","recycled"]`（页面没有 categories/tags）—— 而 **`name` / `title` / `slug` 三者在两份里都不在其中**，所以它们随时可能缺席。两个选择器的规范化因此各写一份（`toSelectablePosts()` 与 `toSelectablePages()`，逐字同构但**刻意不复用**同一个函数：合一会让签名退化成结构类型，从而丢掉「两种内容字段集不同」这条信息）：**缺 `name` 的项直接剔除**（那是拉取命令的唯一入参，列一个按了就坏的按钮比不列更糟）、**缺 `title` 的回落成 `name`**（用 `||` 而非 `??` —— 空串同样是一行空白，显示场景要的是「非空」而不是「非 null」）、缺 `slug` 回落空串（它只是副标题）。
  同一族契约在另外两处**更宽**：`halo_list_attachments` 的 item `required` 是**空数组 `[]`**（全部字段可选，所以 `toAttachmentItems()` 要逐项兜底）；`halo_search_content` 的 `required` 含 `type` 但 **`name` / `title` / `excerpt` / `permalink` 都不在里面**（`toSearchResults()` 同样剔除缺 `name` 的项）。

### 独立页面 — `src/service/page-service.ts`

独立页面（Halo 的 `SinglePage`）与文章是**同一件事的两个实例**，不是两套实现：

- **编排共用 `HaloServiceBase`**（定义在 `src/service/index.ts`）：站点/客户端字段、
  `withPublishRetry()` 的 3 次 500ms 退避、正文切分 `bodyOf()`、便签播报、发布失败文案。
  `PageService` 只覆盖**实质差异**：① 工具名换一套（`CONTENT_TOOLSETS.page` 的 7 个）；
  ② 入参只有 8 键（create）/ 7 键（update）；③ 前言只认三个 `halo` 键。重试策略共用是刻意的：
  复制一份必然在某次改动后分叉，而分叉的表现是「文章会重试、页面不会」，本地完全看不出来。
- **回写笔记用的是页面自己那一对函数**：`applyPageFrontmatter()`（本地前言 → 页面 `spec`）与
  `applyPageToFrontmatter()`（服务端页面 → 本地前言），都在 `service/page-mapping.ts`。
  **刻意不复用文章那一对**（`applyPostFrontmatter()` / `applyPostToFrontmatter()`）：
  借文章那份来写会往每一篇页面笔记里塞进 **5 个 `undefined`**（`cover` / `halo.pinned` /
  `halo.priority` / `halo.publishTime` / `halo.template`）。「一个函数写两份契约」正是这一轮改造要消灭的分叉。

**两个前言契约的差别就是键数**：

| | `halo` 块 | 内容 |
|---|---|---|
| 文章 | **9 键** | `site` / `name` / `publish` + 6 个元数据字段 `visible` / `pinned` / `priority` / `publishTime` / `allowComment` / `template` |
| 独立页面 | **3 键** | 只有 `site` / `name` / `publish` |

**独立页面没有的字段**：`categories` / `tags` / `pinned` / `priority` / `publishTime` / `template` /
`cover` / `excerpt`。这不是「服务端没回」，是**页面这个资源本来就没有这些概念** —— 所以
`toPageUpdateArgs()` 发出去的 7 个键里一个都没有它们，用户在页面笔记里写了这些字段也**不会有任何结果**
（`HaloPageFrontmatter` 因此一个都不收：为「写了也不会有结果」的字段造一层校验，只会让他以为自己写下的值生效了）。
`excerpt` 还要多说一句：**回写时整个键都不出现**（文章路径会写它），因为页面根本不发 `excerpt`，
照文章那条判据写就是每次推送都把本地摘要赋成 `undefined` —— 两个方向都是在丢用户写下的内容。

其余与文章路径的异同：

- **页面没有规划 / 预览 / 图片上传**：它们通常是「关于」「友链」这类短文档，所以 `pushPage()` 是一条
  **直写**路径，没有 `planPublish()` 那种「零写入规划」阶段。真需要传图的页面，用户可以先用
  「`Halo: 上传图片`」那条命令。
- **防跨站误推的判据与文章相同**：前言的 `halo.site` 与目标站点不一致时**一个工具都不调**，直接返回失败。
- **发布状态同样是三档**：命令的显式覆盖 > 前言的 `halo.publish` > 设置里的 `publishByDefault`。
  第三档在开关为**假**时**不发**那次调用（而不是发一次 `publish: false`）—— 后者会把一篇已发布的页面
  悄悄退回草稿，而本地看不出任何异常，用户看到的是「推送成功」。
- **`halo_get_single_page` 的 `truncated` 为真时同样必须抛错**，绝不能把截断正文当完整页面写进本地笔记。
- `allowComment` 在入参里**写死 `true`**：`halo_create_single_page` 收它，但 `halo_get_single_page`
  **不回它**，本地无从得知远端值。**不要**把它做成 frontmatter 可配的 —— 那会引入一个「写出去读不回来」
  的字段，而 1-B 的教训正是「写出去读不回来的字段会静默漂移」。
- **页面的回收 / 恢复是与文章并列的两套工具**（`halo_recycle_single_page` / `halo_restore_single_page`，
  不是带布尔参数的同一个），所以 `recycle-post` / `recycle-page` 拆成两条命令，只在 `kind` 上分档。

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

`src/settings.ts` 定义 `HaloSetting` / `HaloSite` 与设置面板。站点相关的四个弹窗各司其职：

| 文件 | 作用 |
|---|---|
| `src/sites-modal.ts` | 站点列表（增删、设为默认） |
| `src/site-editing-modal.ts` | 编辑单个站点。内含「Validate」按钮，已改为跑 **MCP 自检**（`runSelfCheck` + `mcpToken`）——校验的正是用户真正要填的那把密钥 |
| `src/site-selection-modal.ts` | 发布时选目标站点 |
| `src/post-selection-model.ts` | 拉取时选远程文章，列表走 MCP 的 `halo_list_posts`。⚠️ **文件名是 `-model` 不是 `-modal`**，容易写错，但它是个 Modal。取数（`fetchSelectablePosts(client)`，含翻页，失败与触顶由它自己弹 Notice）与映射（`toSelectablePosts(items)`，纯函数）已抽开，UI 层刻意不做 client 注入 |
| `src/page-selection-model.ts` | 同上，但选的是**独立页面**（`toSelectablePages(items)`）。同样 `-model` 后缀、同样是 Modal；取数走 `PageService.getPages()` 而不是自己造 client |

内容管理类的弹窗（查重 / 附件 / 回收站 / 独立页面管理）不在这里逐条列 —— 它们各自与自己的
纯数据层配成一对，见上方「业务层」模块表。

### frontmatter 契约

这是「本地笔记 ↔ 远程文章」的锚点，**语义不可变**，否则已有已发布笔记会失联：

```yaml
title / slug / excerpt / cover / categories / tags
halo:
  site: https://blog.example.com   # 防跨站误推，不匹配直接报错返回
  name: <post metadata.name>       # 判断「新建 or 更新」的唯一依据
  publish: true
  # ↓ 阶段 1-B 起开放：6 个元数据字段
  visible: PUBLIC                  # PUBLIC | INTERNAL | PRIVATE（只认这三个大写值）
  pinned: false                    # 置顶
  priority: 0                      # 排序权重，整数
  publishTime: ""                  # 空串 = 立即发布；非空 = 定时发布（RFC 3339）
  allowComment: true               # 单篇评论开关
  template: ""                     # 自定义渲染模板
```

这 6 个字段**双向读写**：发布时由 `src/frontmatter-map.ts` 的 `parseHaloPostFields()` 校验、
`src/service/local-content.ts` 的 `applyPostFrontmatter()` 稀疏展开进 `spec`；发布后由
`src/frontmatter-map.ts` 的 `applyPostToFrontmatter()` 从**服务端归一化之后的** `post.spec` 回写进笔记
（发布 / 更新 / 拉取三处共用它）。注意**两个方向分居两个文件**（不是同一个文件）：展开进 `spec` 的那一半在
`service/local-content.ts`（它同时管正文里的图片引用），回写的那一半与校验同在 `frontmatter-map.ts`
（契约的唯一定义处）。页面对应的一对是 `applyPageFrontmatter()` / `applyPageToFrontmatter()`，
**契约只有三键** —— 见上方「独立页面」一节。
`publish: true` 的优先级是「命令的显式覆盖 > frontmatter 的 `publish` > 设置里的 `publishByDefault`」，
其中 frontmatter 那一档读的是**规划阶段**记下的 `plan.publishFromFrontmatter`，不是执行时现读笔记。

**稀疏是契约**（`HaloPostFields` 上的键「在不在」就是「写没写」）。**前提是这篇笔记已经存在远端文章**
—— 下面这些「跟随远端」的说法对**新建**（从没发布过的笔记）没有对象：新建分支的底是
`createEmptyPost()` 那个字段齐全的字面量（`src/service/index.ts`），没有远端可跟随，
所以缺键时用的是**插件内置默认值**。（那份默认值的唯一定义在 `createEmptyPost()`，
文档刻意不复述，避免第二份真值来源随代码漂移。）

- **`null` 与「键不存在」同义**。判据是 `value !== undefined && value !== null`，**不是真假判断**。
  对 `pinned` / `allowComment` / `priority` / `template` 用真假判断，会把 `pinned: false` 变成
  「跟随远端」—— 用户在本地取消置顶后发布，站上仍是置顶的，**而回写还会把 `true` 写回他的笔记**。
- YAML 里 `visible:` 这种空值自然解析成 `null`，所以「写成空值」与「删掉这一行」同义，都表示「跟随远端」。
  ⚠️ 但 `visible: ""`（**一对引号**，显式空**字符串**）是显式值，会被 `visible` 的取值校验拦下报错。
  「空值」在这里专指**不写值**（`js-yaml` 解析成 `null`），不是空字符串 —— 两者在 YAML 里只差一对引号，
  而一行报错提示可能就是用户唯一能拿到的线索。
- `false` / `0` / `""` 是**显式值**。
- **`publishTime` 是唯一的例外**：`""`（空串）是**合法值**，语义是「立即发布」。
  要清空一个已有的定时发布，必须写 `publishTime: ""`，**删掉那一行只会让它继续跟随远端**。
  `parseHaloPostFields()` 为此在 `Date.parse` 之前先短路空串（`Date.parse("")` 是 NaN）。

**写入方向是穷尽的，读取方向才是稀疏的** —— 两者不对称，别误读：`applyPostToFrontmatter()` 每次回写
都会把 6 个键**全部**写进 `halo`（值取自 `post.spec`），所以一篇已发布的笔记发布完之后，笔记里必定
出现完整的 6 个键、且带着显式空串的 `publishTime: ""`。稀疏语义管的是**读取**那一侧：
只有真正写下的键进 `haloFields`，其余保留远端值。因此「删掉一行」只影响这一次的读取语义，
它不会、也不需要把那一行从笔记里抹掉。

这 6 个字段在预览弹窗里逐行显示（`src/publish-preview.ts` 的 `buildPublishPreview()`），
而预览与执行读的是**同一份** `planned.plan.post.spec`（`src/service/index.ts` 的 `planPublish()` /
`executePublish()`）—— 预览里给用户看过的取值就是最终会发出去的那份。

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
**现在没有任何地方引用它** —— `grep -rn "utils/markdown" src tests` **零命中**（连注释都没有）。
它是死代码，与 `src/utils/yaml.ts` 同类；清理前先确认没有外部引用（`markdown-it` / `markdown-it-anchor` 两个依赖只为它存在）。
（复核时注意区分**路径**与**符号名**：`grep -rn "markdownIt" src tests` 共 **4 处** ——
`src/service/index.ts:331` 的一句注释（说的是「客户端跑 `markdownIt.render()` 的结果不是读者看到的 HTML」），
加上死模块自身的 `src/utils/markdown.ts:4` / `:12` / `:14`。**无任何一处是 import**，故它确是死代码。）

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
- **`command.*.name` 里不要带 `<插件名>: ` 前缀**：Obsidian 会自己拼 `<插件名>: <命令名>`，而
  `manifest.json` 的 `name` 是 `Halo` —— 在 locale 里再写一遍 `Halo: `，命令面板就会显示成
  「Halo: Halo: 管理附件」。本阶段新增的 7 条命令曾这样写（计划里就是这么给的），**现已修**：
  只去掉了**开头**那一个前缀，名字里其它位置的 `Halo` 一律不动
  （例如 `publish_with_defaults` 的 `Publish to Halo (use default settings)`、以及
  `publish` 的「发布到 Halo」）。自查一条命令：`grep -n ': "Halo: ' src/i18n/locales/*.json` 应为空。
  ⚠️ 要改的是 locale，**不是** `manifest.json` 的 `name`（那会一并改掉设置面板与所有命令的显示名）。
- **`command.*.name` 只有一个消费者：`main.ts` 的 `addCommand({ id, name })`**
  （`grep -rn 'command\.[a-z_]*\.name' src/` 的命中全在 `main.ts`）。因此**不要**顺手拿命令名去当别的
  用户文案 —— 命令名是**祈使句**（「管理独立页面」），而提示语需要的是陈述或处置指引；
  早先 `manage-pages` 的未实现占位提示就是借 `command.manage_pages.name` 顶的，改成真弹窗
  （`PageManagerModal`）时一并去掉了。降级 / 占位提示请另建 `*.error_*` / `*.notice_*` 键。
- **`biome check src/` 报的 15 个 format 错误不是你的问题**：本仓库 `core.autocrlf=true` 且没有 `.gitattributes`，所以 Windows 检出后所有上游文件在工作区是 CRLF，而 `.editorconfig` 与 `biome.json` 都要求 LF。**这些报错纯属换行符冲突**——实测对 `src/` 全量跑 `biome check --write` 后 `git diff` 为空，因为 git 会把换行归一化掉。因此不必"修复"它们，也不会产生无关 diff。（新文件请按 `.editorconfig` 写成 LF。）
- **License 以 `LICENSE` 文件为准：GPL-3.0**。`package.json` 里写的 `"license": "MIT"` 与仓库实际的 GPL-3.0 全文冲突，属于上游遗留错误——按 GPL-3.0 处理。
