import i18next from "i18next";
import { Modal, Setting } from "obsidian";
import type { HaloPluginContext } from "../../plugin-context";
import type { PublishPreview } from "../models/publish-preview";

/** 打开预览并等用户决定。**取消返回 `false`**，调用方据此直接结束，不写任何东西 */
export function confirmPublishPreview(plugin: HaloPluginContext, preview: PublishPreview): Promise<boolean> {
  return new Promise((resolve) => {
    new PublishPreviewModal(plugin, preview, resolve).open();
  });
}

class PublishPreviewModal extends Modal {
  constructor(
    private readonly plugin: HaloPluginContext,
    private readonly preview: PublishPreview,
    private readonly onDecide: (confirmed: boolean) => void,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    const preview = this.preview;

    contentEl.createEl("h2", { text: i18next.t("publish_preview.title") });

    const row = (name: string, value: string): void => {
      new Setting(contentEl).setName(name).setDesc(value);
    };

    // 站点来源要说清是**哪一条规则**命中的：命错站点是没法从结果里反查的
    // （两边都会显示"发布成功"），只有在预览这一处还能看见。
    const siteSource =
      preview.site.source === "rule"
        ? i18next.t("publish_preview.site_from_rule", { pattern: preview.site.pattern })
        : i18next.t(`publish_preview.site_from_${preview.site.source}`);

    row(i18next.t("publish_preview.row_site"), `${preview.site.name}（${preview.site.url}）${siteSource}`);
    row(i18next.t("publish_preview.row_title"), preview.title);
    row(i18next.t("publish_preview.row_slug"), preview.slug || i18next.t("publish_preview.value_auto"));
    row(i18next.t("publish_preview.row_characters"), String(preview.characterCount));

    // 这一块是本阶段新增能力在界面上的落点：用户在这里第一次能看见这些值。
    row(i18next.t("publish_preview.row_visible"), preview.visible);
    row(
      i18next.t("publish_preview.row_pinned"),
      preview.pinned ? i18next.t("publish_preview.value_yes") : i18next.t("publish_preview.value_no"),
    );
    row(i18next.t("publish_preview.row_priority"), String(preview.priority));
    row(
      i18next.t("publish_preview.row_publish_time"),
      preview.publishTime || i18next.t("publish_preview.value_immediate"),
    );
    row(
      i18next.t("publish_preview.row_allow_comment"),
      preview.allowComment ? i18next.t("publish_preview.value_yes") : i18next.t("publish_preview.value_no"),
    );
    row(i18next.t("publish_preview.row_template"), preview.template || i18next.t("publish_preview.value_none"));

    if (preview.newCategories.length > 0) {
      row(i18next.t("publish_preview.row_new_categories"), preview.newCategories.join("、"));
    }

    if (preview.newTags.length > 0) {
      row(i18next.t("publish_preview.row_new_tags"), preview.newTags.join("、"));
    }

    row(
      i18next.t("publish_preview.row_images"),
      i18next.t("publish_preview.value_images", { pending: preview.images.pending, cached: preview.images.cached }),
    );

    if (preview.images.overLimit.length > 0) {
      // 超限的那几张是唯一需要 PAT 的，也是缺 PAT 时唯一会失败的 —— 点名它们，
      // 用户此刻能做的动作（压缩这几张 / 去补一个 PAT）取决于**是哪几张**。
      row(i18next.t("publish_preview.row_images_over_limit"), preview.images.overLimit.join("、"));
    }

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(i18next.t("common.button_cancel")).onClick(() => {
          this.onDecide(false);
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText(i18next.t("publish_preview.button_confirm"))
          .setCta()
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
