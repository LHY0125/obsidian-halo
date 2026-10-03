# Obsidian plugin for Halo

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
