# Obsidian Halo 插件 MCP 化改造 — 设计文档


| 项       | 值                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| 日期     | 2026-10-03                                                                                                 |
| 状态     | 待评审                                                                                                     |
| 项目目录 | `D:/Code/doing_exercises/programs/Obsidian-Halo`                                                           |
| 上游基座 | [`halo-sigs/obsidian-halo`](https://github.com/halo-sigs/obsidian-halo) v1.2.0（GPL-3.0）                  |
| 后端     | [`halo-dev/plugin-mcp-server`](https://github.com/halo-dev/plugin-mcp-server) v1.2.0（站点实测 44 个工具） |
| 目标站点 | `https://blog.liuhangyv.top`（Halo ≥ 2.26，已装 MCP Server 插件）                                         |

---

## 1. 背景

官方 Obsidian 插件 `halo-sigs/obsidian-halo` 通过直连 Halo 的 REST API（`uc.api.content.halo.run` / `content.halo.run`）发布笔记。当前站点已部署官方 MCP Server 插件（`halo-dev/plugin-mcp-server`），日常内容运营已迁移到 MCP 路径（见 `D:/Code/Obsidian/CLAUDE.md`：2026-08 起 `@halo-dev/cli` 已卸载）。

两条路径并存带来了三类问题：

1. **能力不对等**：MCP 有 44 个工具覆盖文章、独立页面、分类标签、附件、回收站；Obsidian 插件只有 5 个命令，够不着的部分（独立页面、附件复用、查重、回收站）成为真实缺口。
2. **字段被写死**：插件构造 Post 时把 `visible` / `pinned` / `priority` / `publishTime` / `allowComment` / `template` 全部硬编码，frontmatter 无法触及。
3. **默认行为矛盾**：插件设置 `publishByDefault: true`（配置于 2026-04-28）意味着"发布即上线"，而现行 MCP 工作流是"先建草稿 → 复核 → 再发布"。两条路径的默认行为相反，误用会跳过复核。

本设计把 Obsidian 插件改造为**以 MCP 为后端的客户端**，在统一后端的前提下消除上述矛盾，同时把本地文件侧逻辑（MCP 最不擅长的部分）保留为自主实现。

---

## 2. 目标与非目标

### 2.1 目标


| 编号   | 目标                 | 说明                                                                      |
| -------- | ---------------------- | --------------------------------------------------------------------------- |
| **G1** | 元数据字段开放       | 把 6 个被写死的字段开放到 frontmatter 双向读写                            |
| **G2** | 发布状态机与批量操作 | 草稿/发布/退回草稿；批量推草稿、批量发布、批量撤回；发布前预览            |
| **G3** | 多站点路由与新建确认 | 按目录/frontmatter 规则路由到站点与分类标签；自动建分类标签前必须预览确认 |
| **G4** | 与 MCP 工作流对齐    | 统一 frontmatter 契约与草稿策略，消除`publishByDefault` 矛盾              |
| **G5** | 内容能力对标         | 全文查重、独立页面、附件管理与复用、回收站/恢复                           |

### 2.2 非目标（明确不做，含理由）


| 编号   | 不做                        | 理由                                                                                                                                                               |
| -------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **N1** | 渲染能力增强                | 已证伪：渲染发生在 Halo 服务端（见 F1），客户端换渲染器对前台显示无效；且本地 118 篇文章中 Dataview / Tasks / Callout / Mermaid / Wiki 嵌入**全部为 0 次**，无痛点 |
| **N2** | 评论与回复审核              | 站点运维，不属于写作工具。用户在 Obsidian 里的注意力在笔记上                                                                                                       |
| **N3** | 主题设置组 / 主题模板       | 同上，纯运维                                                                                                                                                       |
| **N4** | `htmlMetas` 自定义 SEO meta | MCP 未暴露该字段（见 F5），技术上够不着                                                                                                                            |

---

## 3. 设计前提（已实测验证的事实）

这些是设计的依赖事实，均经实际探测确认，不是推测。


| 编号    | 事实                                                                                                                                                            | 证据                                                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1**  | **渲染发生在 Halo 服务端，不在 Obsidian 客户端**。插件里的 `markdownIt.render(raw)` 不是读者看到的 HTML                                                         | 线上页面 mermaid 渲染为`<div class="bytemd-mermaid"><svg>`，裸 markdown-it 不可能产出该结构；Halo 存储的 `rawType` 为 `markdown`，`raw` 为原始 Markdown                                            |
| **F2**  | 线上渲染当前正常：代码高亮（Shiki）✅、mermaid ✅、表格 ✅                                                                                                      | 抓取`https://blog.liuhangyv.top/archives/halo-dark-mode-plugin`：`shiki` 24 处、`bytemd-mermaid` 395 处、`<table>` 4 处                                                                            |
| **F3**  | 本地内容形态为「纯 Markdown + 表格 + 代码块」，几乎不使用 Obsidian 私有语法                                                                                     | 118 篇剔除代码块后：表格 1372 行/60 篇；Dataview / Tasks / Callout / Mermaid / Wiki 嵌入 / Wiki 链接**均为 0**；真实行内公式仅 1 篇                                                                |
| **F4**  | MCP 握手有三条硬性要求                                                                                                                                          | 实测：①`Accept` **必须**同时含 `text/event-stream`，只写 `application/json` 返回 **400 且响应体为空**；② 必须先 `initialize` 才能调其他方法，否则同样 400 空体；③ 无 `Mcp-Session-Id`（无状态） |
| **F5**  | `halo_create_post` / `halo_update_post` 的入参已覆盖 G1 所需字段；两者字段集相同，`publish` 单独由 `halo_set_post_publish_state` 管理；**`htmlMetas` 不在其中** | 实测`tools/list` 的 inputSchema 交叉比对                                                                                                                                                           |
| **F6**  | `halo_upload_attachment` 只收 base64 且**上限 7 MiB**                                                                                                           | 工具描述原文："Upload Base64 content ... (maximum 7 MiB)"                                                                                                                                          |
| **F7**  | 站点前置阿里云 ESA + WAF                                                                                                                                        | 响应头`Server: ESA`、`via: ens-cache*`、`Set-Cookie: acw_tc=...`；`x-site-cache-status: DYNAMIC`（POST 未被缓存）                                                                                  |
| **F8**  | MCP 服务端为无状态 JSON 响应，非 SSE                                                                                                                            | `initialize` 响应 `Content-Type: application/json`                                                                                                                                                 |
| **F9**  | 上游 License 自相矛盾                                                                                                                                           | 仓库`LICENSE` 为 GPL-3.0 全文（35149 字节），但 `package.json` 写 `"license": "MIT"`。**分发时按 GPL-3.0 处理**                                                                                    |
| **F10** | **`hmcp_` 密钥在 REST API 上无效**——它与 Halo 个人访问令牌（PAT）是两种不同凭据                                                                               | 实测把`hmcp_` 密钥作为 Bearer 请求 `uc.api.content.halo.run` 与 `content.halo.run`，均返回 **401**，与传入无效令牌表现完全一致。长度也对不上：`hmcp_` 约 85 字符，PAT 约 969 字符（JWT）           |
| **F11** | 上游`DEFAULT_SETTINGS.publishByDefault` 本就是 `false`                                                                                                          | 源码`src/settings.ts`：`publishByDefault: false`。目标站点那份 `true` 是用户自己拨的，**改代码默认值是空操作**，只有配置迁移有效                                                                   |

> **F1 的设计含义**：既然客户端渲染结果与前台显示无关，插件就不应在这条线上投入；用户已确认把渲染线降级（对应 N1）。

---

## 4. 架构

### 4.1 分层

沿用上游目录风格，**只增不重排**，降低与上游的 diff 面积：

```
src/
├── main.ts                      入口与命令注册（扩展命令集）
├── settings.ts                  站点配置：新增 mcpToken（hmcp_）；保留 token（PAT，仅回退用）
├── transport/
│   ├── mcp-client.ts            ★ 新增：MCP JSON-RPC 客户端
│   └── errors.ts                ★ 新增：错误归一化
├── service/
│   ├── index.ts                 ★ 改造：分流门面（本地自主 / 走 MCP）
│   ├── local-content.ts         ★ 抽取：frontmatter、图片扫描与替换、raw 提取
│   └── image-upload.ts          ★ 抽取：MCP base64 主路径 + REST multipart 超限回退
├── frontmatter-map.ts           ★ 新增：frontmatter ⇄ MCP 参数双向映射（纯函数）
├── publish-preview-modal.ts     ★ 新增：发布前预览与确认
├── post-selection-modal.ts      保留：扩展支持独立页面与查重
├── sites-modal.ts / site-editing-modal.ts / site-selection-modal.ts  保留：字段改为 MCP
├── icons.ts / i18n/ / utils/    保留
```

### 4.2 分流规则（本方案的核心约定）

按「这份数据在哪一侧」决定实现位置，**这是判断新功能归属的唯一标准**：


| 操作                                  | 实现方        | 理由                                                                       |
| --------------------------------------- | --------------- | ---------------------------------------------------------------------------- |
| frontmatter 读写与双向映射            | **本地自主**  | 操作的是 vault 文件，MCP 看不见                                            |
| 图片引用扫描、链接回填、raw 提取      | **本地自主**  | 同上                                                                       |
| slug 生成（`transliteration` 转拼音） | **本地自主**  | 与现有 permalink 生成规则保持一致                                          |
| 发布状态机编排、批量选择              | **本地自主**  | 编排逻辑，不是数据操作                                                     |
| **本地图片上传（≤ 7 MiB）**          | **走 MCP**    | `halo_upload_attachment`（base64）                                         |
| **本地图片上传（> 7 MiB）**           | **回退 REST** | MCP 有硬上限，见 4.4                                                       |
| 文章/页面的列表、详情、创建、更新     | **走 MCP**    | `halo_*_post` / `halo_*_single_page`                                       |
| 发布 / 退回草稿                       | **走 MCP**    | `halo_set_post_publish_state`                                              |
| 回收站 / 恢复                         | **走 MCP**    | `halo_recycle_*` / `halo_restore_*`                                        |
| 分类 / 标签的列表与新建               | **走 MCP**    | `halo_list_categories` / `halo_create_tag` 等                              |
| 全文查重                              | **走 MCP**    | `halo_search_content`                                                      |
| 附件列表 / 复用 / 删除                | **走 MCP**    | `halo_list_attachments` / `halo_get_attachment` / `halo_delete_attachment` |
| 站点连通性自检                        | **走 MCP**    | `initialize` + `tools/list`                                                |

### 4.3 MCP 客户端设计

**握手**：无 session，故无需会话管理，但每次插件会话必须至少成功 `initialize` 一次。策略：**惰性握手 + 结果缓存**——首次调用任意工具时握手，成功后缓存；失败按错误分类重试或提示。

```
initialize(protocolVersion: "2025-06-18", clientInfo) → 200 + capabilities
notifications/initialized  → 无需等待（服务端无会话，可不发，但发送更合规范）
tools/call({name, arguments})  → 200 + result
```

**请求头（硬性）**：

```
Content-Type:  application/json
Accept:        application/json, text/event-stream     ← 缺 text/event-stream 会 400 空体
Authorization: Bearer <hmcp_ 密钥>
```

**错误归一化**（`transport/errors.ts`）——这是本设计里最容易被低估的部分，MCP 的失败模式比 REST 更隐晦：


| 现象                       | 判定                          | 处理                                                                                |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------------------------- |
| 400 + 空响应体             | 握手顺序或`Accept` 头错误     | 归类为「协议错误」，提示重新握手；**空体必须单独处理，否则会得到"未知错误"**        |
| 401 / 403                  | 密钥无效或该密钥未授权此工具  | 提示到 Halo 后台「工具 → MCP 服务」核对密钥的工具授权                              |
| 200 但响应体是 HTML        | 被 ESA/WAF 拦截（返回拦截页） | 归类为「网关拦截」，提示检查站点可达性与 WAF 规则；**不能直接把 HTML 当 JSON 解析** |
| 工具名不存在于`tools/list` | 站点侧版本或授权变更          | 归类为「能力缺失」，提示所需工具名                                                  |
| 超时 / 网络失败            | 与上游一致                    | 沿用上游的`withPublishRetry`（3 次，500ms 线性退避）                                |

### 4.4 图片上传策略

主路径走 MCP base64，**超过 7 MiB 时回退到现有的 REST multipart 路径**（该路径已在 `HaloService.uploadImage()` 中存在，不需新写）。

```
读取文件二进制 → 是否 > 7 MiB？
    否 → base64 编码 → halo_upload_attachment(filename, mediaType, contentBase64) → permalink
    是 → 是否有 PAT？
           有 → REST multipart → /apis/uc.api.storage.halo.run/v1alpha1/attachments/-/upload
           无 → 报错「图片 X 超过 7 MiB 且未配置个人访问令牌，无法上传」并列出全部超限文件
```

**必须两套凭据（实测 F10）**：`hmcp_` 密钥（85 字符左右）与 Halo 个人访问令牌（PAT，约 969 字符）是**两种不同凭据**。实测用 `hmcp_` 密钥请求 `uc.api.content.halo.run` 与 `content.halo.run` 均返回 **401**，与传入无效令牌表现一致。因此回退路径**必须**由用户额外配置一个 PAT（需附件管理权限）。

**优雅降级**：PAT 未配置时，7 MiB 以内的图片照常工作（走 MCP），只有超限图片失败并给出明确提示。**不得**因为缺 PAT 而阻断整个发布流程。

**保留现有能力**：`imageUploadCache`（缓存键 = 站点 URL + 文件路径，用 `size` + `mtime` 判失效）、`restoreCachedLocalImageLinks`（反向还原远程链接为本地路径）、wiki 与标准两种图片语法支持——全部保留不动。

**新增**：上传前按 `file.stat.size` 预判，避免白编码一次 base64 才发现超限（base64 会让内存占用额外 +33%）。

---

## 5. 数据契约

### 5.1 frontmatter 扩展（只加不改）

`halo.name` 是「本地笔记 ↔ 远程文章」的唯一锚点，`halo.site` 用于防跨站误推。**这两者语义不可变**，否则已有已发布笔记会失联。

```yaml
title: 文章标题
slug: article-slug
excerpt: 摘要                      # 显式给出时 autoGenerateExcerpt=false
cover: /upload/xxx.webp
categories: [编程与工具]
tags: [Halo, MCP]
halo:
  site: https://blog.liuhangyv.top
  name: <post metadata.name>
  publish: true
  # ↓↓↓ 本次新增，映射到 MCP 入参
  visible: PUBLIC                  # PUBLIC | INTERNAL | PRIVATE
  pinned: false                    # 置顶
  priority: 0                      # 排序权重
  publishTime: ""                  # 空 = 立即；非空 = 定时发布
  allowComment: true               # 单篇评论开关
  template: ""                     # 自定义渲染模板
```

**映射规则**：`frontmatter-map.ts` 提供 `toMcpArgs(frontmatter) → 工具入参` 与 `fromMcpResult(post) → frontmatter` 两个**纯函数**，全部字段缺省时取 Halo 侧默认值（不写死），确保「没写就跟随远程」而非「没写就覆盖成 0/false」。

### 5.2 与 MCP 工作流的契约统一（G4）


| 项           | 现行（冲突）                                                                                                                          | 改造后                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认发布状态 | 插件`publishByDefault: true`（**注意：上游官方默认值本就是 `false`，站点这份 `true` 是用户自己拨的**）→ 发布即上线；MCP 流程 → 草稿 | **统一为草稿**。代码默认值无需改动（已是 `false`），真正要做的是**配置迁移**：检测到已存储的 `true` 时弹一次性提示（见下）                      |
| 预览弹窗     | 无                                                                                                                                    | 新增独立开关`skipPreviewOnPublish`（默认 `false`）。**不复用 `publishByDefault` 的键来承载预览语义**——键名含 "publish" 却管弹窗会造成长期误读 |
| 远程锚点字段 | 插件用`halo.name`，MCP 无约定                                                                                                         | 沿用`halo.name`，MCP 路径亦读写同一字段                                                                                                         |
| 分类标签     | 插件自动创建，无确认                                                                                                                  | 发布预览中列出「将新建」项，可取消（G3）                                                                                                        |

**配置迁移（否则 G4 会落空）**：目标站点的 `data.json` 里已持久化了 `"publishByDefault": true`，**改代码里的默认值对已装用户无效**——默认值只在首次安装时写入。因此阶段 1 必须包含一次性迁移：

1. 读取 settings 时用 `settingsVersion` 之类的标记判断是否为旧配置；
2. 旧配置下 `publishByDefault === true` 时，在插件加载后弹一次说明（不是静默改），告知「与 MCP 草稿流程不一致，是否改为默认推草稿」；
3. 用户确认后才写入新值，避免静默覆盖用户意图。

这条同样适用于其它新增字段：新增的设置项必须有默认值，且不得让旧配置读取时抛错。

---

## 6. 命令与交互面


| 命令                           | 来源    | 说明                                   |
| -------------------------------- | --------- | ---------------------------------------- |
| Halo: 发布到 MCP               | 改造    | 预览确认 → 推草稿（或按设置直接发布） |
| Halo: 发布到默认站点           | 保留    | 同上，跳过站点选择                     |
| Halo: 上传图片                 | 保留    | 走 4.4 策略                            |
| Halo: 从 Halo 拉取文章         | 保留    |                                        |
| Halo: 更新当前笔记内容         | 保留    |                                        |
| **Halo: 查重（搜索线上内容）** | ★ 新增 | `halo_search_content`，发布前置检查    |
| **Halo: 批量推草稿**           | ★ 新增 | 按目录/标签筛选，逐个预览或静默        |
| **Halo: 批量发布 / 批量撤回**  | ★ 新增 | `halo_set_post_publish_state`          |
| **Halo: 管理独立页面**         | ★ 新增 | 推/拉/发布独立页面                     |
| **Halo: 管理附件**             | ★ 新增 | 列出/复用/删除远程附件                 |
| **Halo: 回收站**               | ★ 新增 | 移入/恢复                              |
| **Halo: 连通性自检**           | ★ 新增 | 握手 + 断言所需工具存在，报告缺失项    |

**发布预览弹窗**（`publish-preview-modal.ts`）内容：目标站点、标题/slug、分类标签（含**将新建**的项）、要上传的图片数与被回退到 REST 的图片、字符数、以及 `visible`/`publishTime` 等新字段的最终取值。

---

## 7. 测试策略


| 层                   | 方式                          | 覆盖重点                                                                         |
| ---------------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| `mcp-client.ts`      | rstest 单测，mock`requestUrl` | 握手顺序、`Accept` 缺省导致 400 空体、401/403、返回 HTML 的 WAF 拦截页、超时重试 |
| `frontmatter-map.ts` | 表驱动纯函数测试              | 字段缺省语义（不写 ≠ 覆盖）、往返一致性、`publishTime` 空值                     |
| `image-upload.ts`    | 单测 + 边界                   | 7 MiB 边界的上下两侧各一例；base64 编码正确性；缓存命中/失效                     |
| `service/index.ts`   | 单测，mock transport          | 分流规则表的每一行                                                               |
| **契约测试**         | 对真实端点跑`tools/list`      | **断言本设计依赖的每个工具都存在**，站点侧升级/改授权后静默失效能被发现          |

沿用上游技术栈：Rslib 构建、rstest 测试、Biome lint、pnpm。

---

## 8. 交付阶段

本 spec **覆盖阶段 0 与阶段 1**；阶段 2 待阶段 1 落地后另行 spec。

### 阶段 0 · 基座

- 从上游 v1.2.0 建仓，确立与上游的关系（见 §10 风险 R3）
- **插件 id 必须改名**（见 §10 风险 R4）
- 构建链路打通（`rslib build` / `rstest` / `biome`），确认产出的 `main.js` 可被 Obsidian 加载
- 建立 `README` / 契约测试骨架

### 阶段 1 · 发布管线重构（G1 + G2 + G3 + G4）

一次重构完成，因为四者改的是同一批代码（`publishPost` 的 200 行方法与 `applyPostFrontmatter`）：

- 引入 `transport/mcp-client.ts` 与错误归一化
- 从 `service/index.ts` 抽出 `local-content.ts` 与 `image-upload.ts`
- 实现 `frontmatter-map.ts`（6 个新字段双向映射）
- 实现发布预览弹窗、批量命令、路由规则
- 统一草稿策略，消除 `publishByDefault` 矛盾

### 阶段 2 · 内容能力对标（G5）

查重、独立页面、附件管理、回收站。

---

## 9. 风险与开放问题


| 编号   | 风险 / 问题                                                                                        | 处理                                                                                                                                                                                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | **强依赖**：要求站点 Halo ≥ 2.26 且已装 MCP Server 插件。不满足时插件完全不可用                   | 连通性自检命令在激活时提示；文档明确写出前置条件。不设计 REST 回退（除 4.4 的图片路径），因为单站点且已满足                                                                                                                                                                            |
| **R2** | 密钥形态变化：从 Halo PAT 改为`hmcp_` 密钥，且密钥的**工具授权粒度在站点侧**配置。插件无法自行扩权 | 设置页给出明确指引；错误归一化把 403 映射到「到 Halo 后台核对工具授权」                                                                                                                                                                                                                |
| **R3** | **上游同步策略**：本次改造深度替换传输层，与上游 merge 会大量冲突                                  | **决定**：保留 `upstream` remote 仅作参考源，本仓库走独立 `main`，不做双向同步；上游的安全与兼容性修复按需 `cherry-pick`。理由：改造点集中在传输层与 `service/`，冲突面大而收益主要是零星的 bug 修复                                                                                   |
| **R4** | **插件 id**：官方占用 `halo`。同 id 无法与已安装的官方插件共存，且若上架社区市场会冲突             | **决定**：改用 **`halo-mcp`**（显示名可仍为「Halo」）。收益：本地开发时可与官方插件共存做 A/B 对比，且为将来上架留出空间。**注意**：现 vault 里那份已配置的官方插件（含 hmcp 密钥配置）是独立实例，不会自动迁移，需在新插件里重新填一次站点配置；官方插件暂不卸载，阶段 1 完成后再决定 |
| **R5** | License：上游`LICENSE` 是 GPL-3.0 而 `package.json` 写 MIT                                         | 按**GPL-3.0** 处理。若分发，本 fork 必须同样以 GPL-3.0 开源                                                                                                                                                                                                                            |
| **R6** | 是否上架 Obsidian 社区插件市场未定                                                                 | 影响：i18n 完整度要求、命名与描述、审慎度（不能破坏已有用户）。建议阶段 1 先自用，稳定后再评估                                                                                                                                                                                         |
| **R7** | MCP 工具集是站点侧可变的（管理员可在密钥里取消工具授权，官方也会新增）                             | 契约测试 + 运行时工具存在性检查，缺失时降级并提示具体工具名                                                                                                                                                                                                                            |

---

## 附录 A：MCP 工具清单（站点实测 44 个）

```
[list]   9  posts, single_pages, categories, tags, comments, comment_replies,
            attachments, theme_setting_groups, theme_templates
[get]    5  post, single_page, attachment, theme_setting_group, theme_template
[update] 5  post, single_page, category, tag, theme_setting_group
[delete] 5  category, tag, comment, reply, attachment
[create] 4  post, single_page, category, tag
[set]    4  post_publish_state, single_page_publish_state, comment_approval, reply_approval
[recycle]2  post, single_page
[restore]2  post, single_page
[upload] 2  attachment, attachment_from_url
[search] 1  search_content
[插件贡献] 5  PluginMoments×(list/get/create), image-stream×(search_images/prepare_unsplash_download)
```

本设计**使用**其中 23 个：文章 CRUD + 发布状态 + 回收/恢复（8）、独立页面同构一套（7）、分类与标签的列表与新建（4）、附件 list/get/delete（3）、`search_content`（1）；图片上传另计 1 个，已在 8 内。

**不使用**其余 21 个：评论与回复（6）、主题设置组与模板（5）、分类标签的 update/delete（4）、`upload_attachment_from_url`（1）、插件贡献的 PluginMoments 与 image-stream（5，属站点内容而非写作流程）。前两类对应 N2 / N3。

## 附录 B：关键实测记录

```bash
# 握手（成功）
POST https://blog.liuhangyv.top/mcp
Accept: application/json, text/event-stream      # ← 缺 text/event-stream 会 400 空体
Authorization: Bearer $HALO_MCP_TOKEN
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion":"2025-06-18","capabilities":{},
  "clientInfo":{"name":"probe","version":"1.0"}}}
→ 200  application/json  serverInfo: halo-mcp-server v1.2.0  无 Mcp-Session-Id
```

```
# 本地内容形态（118 篇，已剔除围栏代码块与行内代码）
表格            1372 行 / 60 篇
行内数学          54 次 / 3 篇（去重后真实公式仅 1 篇）
GFM 任务列表       3 次 / 1 篇
Dataview / Tasks / Callout / Mermaid / Wiki 嵌入 / Wiki 链接   0 / 0
```
