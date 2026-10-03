# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这个仓库是什么

[`halo-sigs/obsidian-halo`](https://github.com/halo-sigs/obsidian-halo) 的 fork——一个把 Obsidian 笔记发布到 Halo 博客的插件。

- `origin` = `LHY0125/obsidian-halo`（本 fork，推送目标）
- `upstream` = `halo-sigs/obsidian-halo`（官方源，**只读参考**，不双向同步）
- 上游 v1.2.0 的完整历史是本仓库 `main` 的基底，因此同步上游修复走 `git fetch upstream && git cherry-pick <sha>`

**正在进行的工作**：把发布后端从「直连 Halo REST API」改造为「以 Halo 官方 MCP Server 插件为后端」。

- 设计文档：`docs/superpowers/specs/2026-10-03-obsidian-halo-mcp-reshape-design.md`
- 实现计划：`docs/superpowers/plans/2026-10-03-bootstrap-and-mcp-transport.md`

**接手前先读这两份**——计划里记录了三条实测出来的 MCP 协议硬约束（`Accept` 必须含 `text/event-stream`、必须先 `initialize`、无 session），弄错任何一条都只会得到「400 且响应体为空」，看不到原因。

## 常用命令

```bash
pnpm install          # 依赖（pnpm，见 packageManager 字段）
pnpm build            # rslib 构建 → 仓库根目录的 main.js
pnpm dev              # 同上但 watch 模式
pnpm test             # rstest 跑全部测试
pnpm test tests/service/index.test.ts    # 跑单个测试文件
pnpm test:watch       # 测试 watch
pnpm test:coverage    # 带覆盖率
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

### 唯一的业务层 — `src/service/index.ts`

`HaloService(app, settings, site)`，**单类、1085 行**，装下了全部 REST 业务逻辑：发布 / 更新 / 拉取 / 图片上传 / 分类标签解析 / 重试。没有接口抽象，没有 hook——想扩展能力基本就是改这个文件。

几个必须知道的细节：

- **`@halo-dev/api-client` 只当类型用**（`import type`）。实际 HTTP 全部走 Obsidian 的 `requestUrl`——插件跑在 Electron 渲染进程，`requestUrl` 是绕过 CORS 的通道。
- **`requestUrl` 默认在非 2xx 时直接抛异常**，拿不到状态码与响应体。需要区分「400 空体」与「401」时必须传 `throw: false`。
- **API 分了三套命名空间**，用错会 403：写文章走 `uc.api.content.halo.run`（user-center，令牌权限粒度细），读写分类/标签走 `content.halo.run`，传图走 `uc.api.storage.halo.run`（multipart）。
- **发布重试**：`withPublishRetry()` 包住整个发布事务，3 次重试、500ms 线性退避。不加 retry 时 draft 更新会偶发失败。
- 分类/标签**不存在会自动创建**，slug 用 `transliteration` 转拼音（所以中文标题的 permalink 是拼音）。副作用：一次手误的标签名会在站点上永久留下垃圾标签。

### 设置与弹窗

`src/settings.ts` 定义 `HaloSetting` / `HaloSite` 与设置面板；三个弹窗各司其职：

| 文件 | 作用 |
|---|---|
| `src/sites-modal.ts` | 站点列表（增删、设为默认） |
| `src/site-editing-modal.ts` | 编辑单个站点。内含「Validate」按钮，用 PAT 探测 REST 权限 |
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

`applyPostFrontmatter()` **只处理上面这 6 个字段**。Halo Post 的其余 spec 字段在 `publishPost()` 里被硬编码：`visible: "PUBLIC"`、`pinned: false`、`priority: 0`、`publishTime: ""`、`allowComment: true`、`template: ""`。frontmatter 够不着它们——这正是本次改造要打开的部分。

### 内容管线

```
frontmatter 之后的部分 → raw
  → createPostContent(raw) = { content: markdownIt.render(raw), raw, rawType: "markdown" }
  → 写入 Post 的 content.halo.run/content-json 注解
反向读取时取 draft 快照的 content.halo.run/patched-content 与 patched-raw
```

`src/utils/markdown.ts` 只是一个配置过的 markdown-it 实例（`html` / `breaks` / `linkify` / `typographer` 全开 + `markdown-it-anchor`）。

**关键事实：这份客户端渲染结果不是读者看到的东西。** Halo 存储的 `rawType` 是 `markdown`，前台 HTML 由 Halo 服务端自己的管线生成（实测线上页面的 mermaid 被渲染成 `<div class="bytemd-mermaid"><svg>`，裸 markdown-it 不可能产出该结构）。所以在插件里换渲染器对前台显示无效——要改渲染得改 Halo 侧的插件或主题。

### i18n

`src/i18n/index.ts` 把 `locales/{en,zh-cn,zh-tw}.json` 注册为 i18next 资源。语言取 `moment.locale()`，回落 `en`。取值走点号路径（`i18next.t("command.publish.name")`），支持 `{{var}}` 插值。**新增文案必须三个语言文件同步加键**，否则切语言时显示原始键名。

### 图片管线

用两条正则（`![](...)` 与 `![[]]`）扫描本地图片引用，跳过远程路径。`imageUploadCache` 是缓存：键为「站点 URL + 文件路径」，用 `size` + `mtime` 判断失效。反方向有 `restoreCachedLocalImageLinks()`，把远程链接还原成本地路径（`replaceImageLinks` 关闭时生效）。

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
- **`src/utils/id.ts` 的 `randomUUID()` 是手写实现**（不用 `crypto`），用于生成新文章的 resource name 与 multipart boundary。
- **License 以 `LICENSE` 文件为准：GPL-3.0**。`package.json` 里写的 `"license": "MIT"` 与仓库实际的 GPL-3.0 全文冲突，属于上游遗留错误——按 GPL-3.0 处理。
