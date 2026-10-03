# Obsidian plugin for Halo

> **本仓库是 `halo-sigs/obsidian-halo` 的 fork**，正在把发布后端从直连 REST API
> 迁移到 Halo 官方 MCP Server 插件。原上游的使用说明见下方，仍然有效。

## 当前进度与凭据要求

迁移是分阶段的，**两套凭据目前都需要**：

| 已就绪（走 MCP） | 尚未迁移（仍走 REST + PAT） |
|---|---|
| MCP 传输层、`Halo: MCP 连通性自检` 命令 | 发布、更新、拉取、**图片上传**等既有命令 |

- **`hmcp_` 访问密钥**：供 MCP 路径使用（连通性自检，以及后续阶段的发布能力）。
- **个人访问令牌 PAT**：**现阶段必需** —— 既有命令全部仍走 REST API，图片上传用的就是它。
  `hmcp_` 密钥在 REST API 上无效（实测返回 401），两者不可互换。

> REST 只在迁移完成后才会收窄到「超过 7 MiB 的图片回退上传」这一项用途；**那时** PAT 才成为可选
> （MCP 的 `halo_upload_attachment` 上限为 7 MiB）。在那之前请照常配置 PAT。

## 前置条件

- 站点 Halo 版本 **≥ 2.26**
- 站点已安装并启用官方 [MCP Server 插件](https://github.com/halo-dev/plugin-mcp-server)
- 在 Halo 后台「工具 → MCP 服务」创建一个访问密钥（以 `hmcp_` 开头），
  并为其勾选文章、独立页面、分类、标签、附件、全文检索相关工具

## 连通性自检

在 Obsidian 命令面板执行 `Halo: MCP 连通性自检`，它会握手并检查所需工具是否齐备。

## 契约测试（可选，需真实站点）

```bash
HALO_MCP_ENDPOINT=https://<你的站点>/mcp HALO_MCP_TOKEN="$HALO_MCP_TOKEN" pnpm test:contract
```

它对真实站点断言必需的 13 个工具都在。环境变量的设置情况分两种：

- **两个都没设**：这是预期的跳过，保持静默（输出 1 passed，但什么都没验证）。
- **只设了一个**：几乎肯定是配置失误，测试会往 stderr 打一行**点名缺失变量**的告警。看到告警就说明本次没有做任何断言，请把两个变量都设上。

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
