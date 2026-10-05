# Obsidian plugin for Halo

> **本仓库是 `halo-sigs/obsidian-halo` 的 fork**，发布后端已从直连 REST API
> 迁移到 Halo 官方 MCP Server 插件。原上游的使用说明见下方，仍然有效。

## 当前进度与凭据要求

发布后端已经切到 MCP：**发布 / 更新 / 拉取（含选文列表）/ 小图上传 / 连通性自检**，
以及新增的**独立页面（推 / 拉 / 管理）、线上查重、附件管理、回收站（文章 / 页面）**全部走 MCP，
站点侧只需要填 `hmcp_` 访问密钥。

**REST + PAT 只剩一条路**：上传**超过 7 MiB** 的图片 —— MCP 的 `halo_upload_attachment` 上限就是 7 MiB，
超出才会回退 REST 的分片上传。

- **`hmcp_` 访问密钥（必需）**：上面那些功能全靠它。在站点编辑弹窗里填 `mcpToken`。
- **个人访问令牌 PAT（可选）**：只有上传超过 7 MiB 的图片时才需要，用不到可以留空。
  `hmcp_` 密钥在 REST API 上无效（实测返回 401），两者不可互换。

### ⚠️ 从旧版本升级：请补填 `hmcp_` 密钥

旧安装只配了 PAT、没有 `mcpToken`。切换之后**小图上传也会失败**（小图已改走 MCP），
而任意一张图上传失败都会**中止整次发布** —— 用户看到的只是「发布失败」，
从这句话里看不出真正的原因是密钥没填。

请到「设置 → Halo → 编辑站点」补填 `mcpToken`，再执行命令 `Halo: MCP 连通性自检`：
它会握手并逐项列出站点侧缺少的工具（密钥无效时会直接说明密钥无效）。

## 前置条件

- 站点 Halo 版本 **≥ 2.26**
- 站点已安装并启用官方 [MCP Server 插件](https://github.com/halo-dev/plugin-mcp-server)
- 在 Halo 后台「工具 → MCP 服务」创建一个访问密钥（以 `hmcp_` 开头），
  并为其勾选下面**四组共 23 个**工具：

  - **文章**（7 个）：列表 / 读取 / 新建 / 修改、发布状态、回收、恢复
  - **独立页面**（7 个）：与文章同构的一套
  - **分类与标签**（4 个）：两类各自的列举与创建
  - **检索与附件**（5 个）：全文检索、附件列表 / 读取 / 删除、附件上传

  这份清单与 `src/mcp-self-check.ts` 的 `REQUIRED_TOOLS` 一致：**勾少了，连通性自检会报「缺少 N 个工具」**，
  而自检正是排错时唯一的验证手段。评论、主题设置、主题模板、图片搜索这一类插件用不到，不必勾选。

## 连通性自检

在 Obsidian 命令面板执行 `Halo: MCP 连通性自检`，它会握手并检查所需工具是否齐备。

## 契约测试（可选，需真实站点）

```bash
HALO_MCP_ENDPOINT=https://<你的站点>/mcp HALO_MCP_TOKEN="$HALO_MCP_TOKEN" pnpm test:contract
```

它对真实站点断言 `REQUIRED_TOOLS`（见 `src/mcp-self-check.ts`）里的工具全部存在。
环境变量的设置情况分两种：

- **两个都没设**：这是预期的跳过，保持静默（输出 1 passed，但什么都没验证）。
- **只设了一个**：几乎肯定是配置失误，测试会往 stderr 打一行**点名缺失变量**的告警。看到告警就说明本次没有做任何断言，请把两个变量都设上。

## 元数据字段

下面 6 个字段写在 `halo:` 下，发布时**双向**生效 —— 发布会把它们传给站点，发布完的回写会把站点上的实际值写回笔记：

```yaml
halo:
  site: https://blog.example.com
  name: <post metadata.name>
  publish: true
  visible: PUBLIC                  # PUBLIC | INTERNAL | PRIVATE
  pinned: false                    # 置顶
  priority: 0                      # 排序权重，整数
  publishTime: ""                  # 空串 = 立即发布；非空 = 定时发布（RFC 3339）
  allowComment: true               # 单篇评论开关
  template: ""                     # 自定义渲染模板
```

**删掉一行 ≠ 清空它。** 对**已经发布过**的笔记，删掉 `halo.pinned:` 那一行表示「跟随远端当前的值」；
要取消置顶必须写 `pinned: false`。写成空值（`pinned:` 后面什么都不写）与删掉这一行同义。
这条规则对 `visible` / `pinned` / `priority` / `allowComment` / `template` 都成立。

对**从没发布过**的笔记，没有「远端当前的值」可跟随（它还没有对应的远端文章）——
这些字段用插件内置的默认值；这些默认值不在本文档里逐项列出，请以代码为准，免得两份说法分叉。

**「空值」指的是不写值，不是写一对引号。** `visible:`（冒号后留空）在 YAML 里解析为「没有值」，
所以它和删掉那一行一样表示「跟随远端」；而 `visible: ""`（一对引号）是一个**显式字符串**，
会被当成写错的值而拦下 —— 想跟随远端就留空，不要写引号。

**唯一的例外是 `publishTime`**：写 `""`（空串）表示「立即发布」，是一条**有内容**的指令 ——
要取消一篇已排定的定时发布，必须显式写 `publishTime: ""`，光删掉那一行只会让它继续跟随远端。

写错的值会在发布**之前**被拦下（本地校验，一次网络请求都不会发），例如 `visible: public`（小写）
会告诉你哪一行、写了什么、该写什么。`visible` 只认三个大写取值。

## 站点路由规则

在「设置 → Halo → 站点路由规则」里按**笔记在库内的相对路径**指定目标站点：

| 模式 | 含义 |
|---|---|
| `博客/**` | `博客/` 下的所有笔记（`**` 跨目录） |
| `日记/*.md` | `日记/` 下一层的 markdown（`*` 不跨 `/`） |
| `草稿?.md` | `?` 匹配单个非 `/` 字符 |

模式**大小写不敏感**（`Blog/**` 与 `blog/**` 等效），开头的 `./`、`/` 与反斜杠会被自动规整。
规则自上而下取首个命中；设置页每一行会显示它当前命中了多少篇笔记。

**命中一个已被删除的站点时，插件会停下来报错，而不是改用默认站点。** 这是刻意的：
把笔记发到另一个站是不可逆的（目标站上可能已经建了同名文章），而报错只是让你去改一行配置。

站点的解析优先级是：

```
笔记里的 halo.site  >  路由规则首个命中  >  设置里的默认站点  >  唯一站点  >  弹窗让你选
```

注意「发布到 Halo（使用默认配置）」这条命令**不经过**路由规则 —— 它的语义就是用默认站点。

## 批量操作

三个批量命令都从**当前库里的全部 markdown 笔记**取候选，按站点分组后在确认弹窗里列出：

- **Halo: 批量推草稿**：逐篇建/更新文章，并把发布状态设为草稿。
- **Halo: 批量发布**：逐篇建/更新文章，并把发布状态设为已发布。
- **Halo: 批量撤回**：只把已发布文章的发布状态退回草稿，不读正文、不改写正文、不上传图片。

确认弹窗里每一篇都有勾选框（默认全勾），「将处理 N 篇」会**跟着你的勾选实时变化**。
没有站点、没有 `halo.name`（撤回时）、正文读不出来（**只有推草稿 / 发布会这样 —— 撤回不读正文**）
等进不了批的笔记，会单独列在「已跳过」里并逐条给出原因 —— 它们不会被算进失败。

**批量推草稿与批量发布也会改写本地笔记**（不是只动远端）：执行过程中会把文章元数据
（`title` / `slug` / `cover` / `excerpt` / `categories` / `tags`）与整个 `halo` 块回写进笔记 ——
包括发布状态 `halo.publish`。这一步**与「替换图片链接」开关无关**，关着它照样发生；
开了那个开关时，笔记里的本地图片地址还会被换成 Halo 地址。

**批量撤回只动远端，不写回本地笔记。** 它把站点上那几篇退回草稿，而笔记本地的 `halo.publish`
**仍是原值**（撤回只调发布状态接口，不改写正文）。这一点要留意，因为
「批量发布」的语义是「把这批文章发布」—— 它对每一篇都显式传「发布」，**不看本地 `halo.publish`**。
所以**撤回之后再跑一次批量发布，这些文章会全部重新发出去**。想让它保持草稿，就别把它们纳入
批量发布，或先跑一次「批量推草稿」把它推回草稿。

**批量命令按命令名决定发布状态，不看笔记里的 `halo.publish`。** `Halo: 批量发布` 会把清单里每一篇
都设为已发布，`Halo: 批量推草稿` 会把每一篇都设为草稿 —— 哪怕那篇笔记自己写着
`halo.publish: false`。**想排除某一篇，唯一的办法是在确认弹窗里取消勾选它。**
（单篇的 `Halo: 发布` 命令不受此影响，它仍然读笔记里的 `halo.publish`。）

批量执行**失败不中断**：某一篇失败了，后面的继续跑，跑完在一个汇总弹窗里报
「成功 N 篇，失败 N 篇，另有 N 篇在执行前就被跳过」，并**分两段**列出明细 ——
先逐条列出失败项及原因，再另起一段逐条列出**执行前被跳过的那几篇及原因**。

## 独立页面、查重、附件与回收站

除发布文章之外，插件还能管**站点上的其它内容**。先分清哪几条会动你的本地笔记
（`Halo: 管理附件` / `Halo: 查重（搜索线上内容）` / 两条回收站命令**完全不动本地笔记**，
它们只读远端、只在远端做动作）：

| 命令 | 做什么 | 动不动本地笔记 |
|---|---|---|
| `Halo: 推为独立页面` | 把当前笔记推成一篇**独立页面**（Halo 的「页面」，不是文章） | **会**：回写当前笔记的 frontmatter |
| `Halo: 拉取独立页面` | 从站点拉一个独立页面到本地 | **会**：新建一篇笔记 |
| `Halo: 管理独立页面` | 列出站点上**不在回收站**的独立页面，可逐条**移入回收站** | 不动 |
| `Halo: 查重（搜索线上内容）` | 用关键词搜站点上的内容，看这一篇是不是已经写过了 | 不动 |
| `Halo: 管理附件` | 列出站点上的全部附件，可复制链接、**删除** | 不动 |
| `Halo: 回收站（文章）` / `Halo: 回收站（页面）` | 列出回收站里的内容并**恢复** | 不动 |

几条必须知道的行为：

- **查重会查到草稿。** 它刻意不过滤发布状态 —— 查重的用途是「我是不是已经写过这个」，
  而一篇还没发布的草稿正是最需要被查出来的（否则你会写第二遍）。草稿那一行会多出一个**铅笔图标**
  （鼠标悬停显示「草稿」）；有 permalink 的条目还带一个「打开」按钮，用系统浏览器打开站点上那一篇。
- **删除附件是不可逆的。** 附件**没有回收站** —— 删掉之后无法恢复，引用了它的笔记会显示为图片损坏。
  所以每一行的删除都要求**二次确认**，确认文案里点名你要删的那个文件名与大小。
  （文章与独立页面的「移入回收站」是可恢复的，两者不一样，别把这条经验套过去。）
- **独立页面的 frontmatter 只有三个 `halo` 键**：`site` / `name` / `publish`。文章那 6 个元数据字段
  （`visible` / `pinned` / `priority` / `publishTime` / `allowComment` / `template`）以及
  `cover` / `excerpt` / `categories` / `tags` **对页面没有意义** —— 页面这个资源本来就没有这些概念，
  写了也不会有任何结果。推完一篇页面之后，笔记里只会出现那三个键，**不会**被塞进多余的字段。
- **推页面没有预览弹窗，也不上传图片。** 页面通常是「关于」「友链」这类短文档；真需要传图的页面，
  先跑一次 `Halo: 上传图片` 即可。
- **页面与文章的回收站是两个分开的入口**（各一条命令）：列表里没有哪一列能告诉你某一行是文章还是页面，
  与其混在一起让你猜，不如按内容类型分开 —— 「我的文章误删了」和「我的页面误删了」本来就是两个动作。

## 端到端手工验证清单

上面这些行为里有一部分只有真实的 Obsidian 与真实站点才验得到（弹窗、勾选框、图片链接回写）。
逐项清单见 **[docs/e2e-manual-checklist.md](./docs/e2e-manual-checklist.md)**。

This plugin allows you to publish your Obsidian documents to [Halo](https://github.com/halo-dev/halo).

[中文文档](./README.zh-CN.md)

## Preview

![settings](./images/settings-en.png)

![commands](./images/commands-en.png)

## Usage

1. Search for "Halo" in Obsidian's community plugins browser.
2. Click **Install**.
3. Go to **Settings** -> **Community Plugins** -> **Halo** and configure the settings.
4. Create a new site:
   1. Site name: the name of the site, optional.
   2. Site URL: the URL of the site, e.g. `https://example.com`.
   3. Personal access token:
      The personal access token of your Halo site, needs `Post Manage` permission.

       ![PAT](./images/pat-en.png)

       More information about personal access token: [Personal Access Token](https://docs.halo.run/user-guide/user-center#%E4%B8%AA%E4%BA%BA%E4%BB%A4%E7%89%8C)

   4. Set as default: set the site as the default site.
5. Open a note you want to publish, and run the command `Halo: Publish to Halo`.
6. All available commands:
   - **Halo: Publish to Halo**: publish the current note to Halo.
   - **Halo: Publish to Halo (use default settings)**: publish the current note to the default site.
   - **Halo: Upload images to Halo**: upload local images in the current note to Halo and replace them with remote URLs.
   - **Halo: Pull posts from Halo**: pull posts from Halo to Obsidian.
   - **Halo: Update content from Halo**: update the content of the current note from Halo.
   - **Halo: Push as page**: push the current note as a single page (not a post). The page's frontmatter keeps only three `halo` keys: `site` / `name` / `publish`.
   - **Halo: Pull page**: pull a single page from Halo to Obsidian as a new note.
   - **Halo: Manage pages**: list the site's single pages (those not in the recycle bin) and move them to the recycle bin one by one.
   - **Halo: Search site content**: full-text search the site to check whether you have already written something. **Drafts are included** in the results.
   - **Halo: Manage attachments**: list all attachments on the site, copy their links, or **delete** them. **Deleting an attachment is irreversible** (attachments have no recycle bin).
   - **Halo: Recycle bin (posts)** / **Halo: Recycle bin (pages)**: list the recycled content and restore it.
   - **Halo: MCP connection self-check**: handshake with the site and list any required tools that are missing.
   - **Halo: Batch push as drafts / Batch publish / Batch unpublish**: act on the whole vault after one aggregate confirmation. See 「批量操作」 above.

## Development

1. [Create a new Obisidian vault](https://help.obsidian.md/Getting+started/Create+a+vault) for development.
2. Clone this repo to the **plugins folder** of the newly created vault.

   ```bash
   cd path/to/vault/.obsidian/plugins

   git clone https://github.com/ruibaby/obsidian-halo
   ```

3. Install dependencies

   ```bash
   cd obsidian-halo

   npm install
   ```

4. Build the plugin

   ```bash
   npm run dev
   ```

5. Reload Obsidian and enable the plugin in Settings.

## Credits

- [obsidian-wordpress](https://github.com/devbean/obsidian-wordpress): the original idea came from this repo.

## TODO

- [x] i18n
- [x] Upload images
- [x] Publish this plugin to Obsidian community

## License

GPL-3.0（沿用上游）
