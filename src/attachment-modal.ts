import i18next from "i18next";
import { type App, Modal, Notice, Setting } from "obsidian";
import { type AttachmentItem, deleteAttachment, fetchAttachments, formatBytes } from "./attachment-model";
import { renderErrorMessage } from "./i18n/error-message";
import type HaloPlugin from "./main";
import { type HaloSite, mcpEndpointOf, normalizeSiteUrl } from "./settings";
import { McpClient } from "./transport/mcp-client";

/**
 * 站点地址 + permalink → **绝对**地址；没有 permalink 时回落空串。
 *
 * ⚠️ 必须拼成绝对地址，理由**不是**「相对路径粘到别处不方便」——
 * 本仓库有一个具体的判据会因此判错。`src/service/local-content.ts` 的 `isRemotePath()`：
 *
 * ```
 * /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//") || path.startsWith("#")
 * ```
 *
 * 实测（2026-10-05 对站点调 `halo_list_attachments`，page 1 / size 3）服务端回的 permalink
 * 形如 `/upload/QQ20261004-204734-1791118063183.webp` —— **以单个 `/` 开头**，
 * 上面三条**一条都不匹配**（`startsWith("//")` 要**两个**斜杠）。于是粘进笔记后它被判成
 * **本地路径**：`collectLocalImageReferences()` 会去 vault 里找这个文件、
 * `resolveImageFile()` 找不到就**静默跳过** —— 图片不上传、链接不替换，在 Obsidian 里也显示不出来。
 * 用户看到的是「我明明粘了链接」，而没有任何报错。
 *
 * 顺带归一化两边的斜杠：permalink 少一个前导 `/` 时，朴素的 `base + permalink` 会拼出
 * `https://blog.example.comupload/x.webp` 这种**看起来像成功、点开却是 404** 的地址，
 * 而这里没有任何东西能察觉它（按钮就在那儿，只是打不开）。
 *
 * **导出成函数而不是内联进 `onClick`**，是因为那个回调在测试脚手架里永远不会被触发
 *（`tests/setup.ts` 把 `obsidian` 整体 mock 了，`Modal.open()` 不调 `onOpen()`，
 * `Setting.addButton` 也不记录回调）。内联的话，把这里改回相对路径 —— 也就是本任务要防的
 * 那个缺陷 —— 全套测试照样全绿。与 Task 8 的 `buildSearchRows()` 是同一条约定，
 * 只是这一个的产物只有一个值，不值得再包一层与 `AttachmentItem` 字段重复的「行」类型。
 *
 * 与 `search-modal.ts` 的 `permalinkUrl()` 是同一套处置、同一段理由。**刻意没有合流**：
 * 那是 Task 8 的文件，把它的实现搬进一次「新增附件命令」的 diff 里就没法单独审阅了 ——
 * 与 `main.ts` 里 `pull-post` 刻意不改调 `pickSiteForPull` 是同一条取舍。合流留给专门的重构。
 * （这里与 `permalinkUrl()` 不同的是**归一化那一步已经合流**：两边都走
 * `settings.ts` 的 `normalizeSiteUrl()`，理由见下。）
 *
 * ⚠️ **站点归一化必须走 `normalizeSiteUrl()`，不能图省事抄一份 `trim().replace(/\/+$/, "")`。**
 * 那个函数在本仓库是**被明文引用为契约**的（`glob.ts` 的注释：「走的是 `normalizeSiteUrl()`，
 * 它只做 trim + 去尾斜杠，大小写敏感」），并且是 `isSameSiteUrl` / `mcpEndpointOf` /
 * `normalizeSite` / `site-routing` 的共同基础。抄一份等于给它开一个**不受保护的副本**：
 * 将来有人扩展它的语义（比如开始忽略大小写、或把 http 归一到 https），全仓一起变，
 * 只有「复制链接」这条路上拼出来的地址不变 —— 而那个地址是要粘进笔记的，错了看不出来。
 */
export function attachmentUrl(siteUrl: string, permalink: string): string {
  const base = normalizeSiteUrl(siteUrl);
  const path = permalink.replace(/^\/+/, "");

  return path === "" ? "" : `${base}/${path}`;
}

/**
 * 附件管理。
 *
 * **本阶段只做三件事**：列出、复制链接、删除。不做上传（已有 `Halo: 上传图片` 那条命令
 * 从笔记里扫描并上传）、不做重命名、不做移动分组 —— 那些是 Halo 后台的活，
 * 而插件这边「够得着」的收益远小于复杂度。
 *
 * ⚠️ **删除是不可逆的**（`halo_delete_attachment` 走的是 finalizer 清理流程，
 * **没有回收站**）。所以每一行都要**二次确认**，且确认文案里点名文件名与大小 ——
 * 用户要能确认自己删的是哪一个。这一条与文章/页面的「回收站」形成对照：
 * 那两者的回收是可恢复的，附件的删除不是。
 */
export class AttachmentManagerModal extends Modal {
  private readonly client: McpClient;
  private items: AttachmentItem[] = [];
  private truncated = false;

  constructor(
    plugin: HaloPlugin,
    private readonly site: HaloSite,
  ) {
    super(plugin.app);
    this.client = new McpClient({ endpoint: mcpEndpointOf(site), token: site.mcpToken });
  }

  onOpen(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    const { contentEl } = this;

    contentEl.empty();
    contentEl.createEl("h2", { text: i18next.t("attachment_modal.title") });

    try {
      const result = await fetchAttachments(this.client);
      this.items = result.items;
      this.truncated = result.truncated;
    } catch (error) {
      // 取数失败**不抛**：命令入口不该把异常放给 Obsidian（它只会记进控制台，
      // 用户在界面上什么都看不到）。弹一条带服务端原文的提示，然后把列表当空的渲染。
      new Notice(renderErrorMessage(error));
      this.items = [];
    }

    if (this.items.length === 0) {
      // 「一个附件都没有」是一条**结论**，不是一片空白 —— 用户打开弹窗看到空的，
      // 会怀疑是插件坏了，而不是「站点上确实还没传过附件」。
      contentEl.createEl("p", { text: i18next.t("attachment_modal.empty") });
    }

    if (this.truncated) {
      // 触顶时才提示 —— 与「列表不完整」同一条纪律（`post_selection_modal.notice_truncated`、
      // `service.notice_list_truncated` 都是这么做的）：静默截断是本阶段反复处理的那类问题。
      contentEl.createEl("p", { text: i18next.t("attachment_modal.notice_truncated") });
    }

    for (const item of this.items) {
      const copyUrl = attachmentUrl(this.site.url, item.permalink);
      const setting = new Setting(contentEl)
        .setName(item.displayName)
        // 空 mediaType 用「未知类型」那一档兜底：直接显示成 ` · 42.3 KB` 会让人以为
        // 副标题渲染坏了，而真相是服务端没给这个字段（它的 `required` 是空数组，全部可选）。
        .setDesc(`${item.mediaType || i18next.t("attachment_modal.unknown_type")} · ${formatBytes(item.size)}`);

      if (copyUrl) {
        setting.addButton((button) =>
          button.setButtonText(i18next.t("attachment_modal.button_copy_link")).onClick(async () => {
            // 写的是 `attachmentUrl()` 算好的**绝对**地址 —— 相对路径粘进笔记后
            // 会被本地图片管线当成 vault 内的文件而静默丢掉，理由见那个函数。
            await navigator.clipboard.writeText(copyUrl);
            new Notice(i18next.t("attachment_modal.notice_link_copied"));
          }),
        );
      }

      setting.addButton((button) =>
        button
          .setButtonText(i18next.t("attachment_modal.button_delete"))
          // 标成危险操作：Obsidian 会把它渲染成醒目的红色。附件删除**不可逆**。
          //
          // `setDestructive()` 而不是已废弃的 `setWarning()`：两者渲染结果相同（都是红色），
          // 但 `setWarning` 自 1.13.0 起被标记为 deprecated。本插件的 `minAppVersion` 已是 1.13.0，
          // 用新 API 不会挡住任何用户。
          .setDestructive()
          .onClick(async () => {
            const confirmed = await confirmDelete(this.app, item);

            if (!confirmed) {
              return;
            }

            try {
              await deleteAttachment(this.client, item);
              new Notice(i18next.t("attachment_modal.notice_deleted", { name: item.displayName }));
              // 重取一遍，而不是从 `this.items` 里就地删掉那一项：服务端才是权威 ——
              // 列表可能在这期间被别人改过，而且重取会把每个附件的 `version`（删除时
              // 要当乐观锁凭据传回去的那个）刷新一遍。就地改数组则会让余下各项
              // 带着一份可能已经过期的版本号继续留在屏幕上。
              await this.render();
            } catch (error) {
              new Notice(renderErrorMessage(error));
            }
          }),
      );
    }

    new Setting(contentEl).addButton((button) =>
      button.setButtonText(i18next.t("common.button_close")).onClick(() => this.close()),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * 删除前的二次确认。
 *
 * 确认文案里点名文件名与大小 —— 用户要能确认自己删的是哪一个，而不是对着一句
 * 「确定删除这个附件吗？」点下去。传的是**原项**（带 `name` / `version`），
 * 所以确认之后直接拿它去删，不必再回列表里找。
 *
 * ⚠️ 参数是 `App` 而**不是** `HaloPlugin`：这个确认框除了 `app`（`Modal` 的构造入参）
 * 之外什么都不用，没有理由让它依赖整个插件。外面那个弹窗本身就是 `Modal`，
 * `this.app` 现成 —— 不必为了转发它而在 `AttachmentManagerModal` 上存一个用不到的
 * `plugin` 字段（那种字段会让「这个类到底用不用插件」变成读代码才能回答的问题）。
 */
function confirmDelete(app: App, item: AttachmentItem): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmDeleteModal(app, item, resolve).open();
  });
}

class ConfirmDeleteModal extends Modal {
  constructor(
    app: App,
    private readonly item: AttachmentItem,
    private readonly onDecide: (confirmed: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: i18next.t("attachment_modal.confirm_title") });
    contentEl.createEl("p", {
      text: i18next.t("attachment_modal.confirm_body", {
        name: this.item.displayName,
        size: formatBytes(this.item.size),
      }),
    });
    // 说清「不可逆」是必须的：文章和页面有回收站，附件**没有** —— 用户对前两者养成的
    // 「删了还能捞回来」的印象在这里会直接变成数据丢失。
    contentEl.createEl("p", { text: i18next.t("attachment_modal.confirm_irreversible") });

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(i18next.t("common.button_cancel")).onClick(() => {
          this.onDecide(false);
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText(i18next.t("attachment_modal.button_delete"))
          // 与上面那个删除按钮同款：危险操作标红，用 1.13.0 起的 `setDestructive()`。
          .setDestructive()
          .onClick(() => {
            this.onDecide(true);
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
