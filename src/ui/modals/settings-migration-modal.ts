import i18next from "i18next";
import { type App, Modal, Setting } from "obsidian";
import type { MigrationNotice } from "../../settings";

/** 迁移提示弹窗：只提供"改"与"不改"两个动作，绝不静默修改用户配置 */
export class SettingsMigrationModal extends Modal {
  constructor(
    app: App,
    private readonly notice: MigrationNotice,
    private readonly onDecide: (switchToDraft: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(i18next.t("settings_migration.title"));

    // 文案由键解析，逻辑层（migrateSettings）不携带任何中文字面量
    this.contentEl.createEl("p", { text: i18next.t(`settings_migration.${this.notice.key}`) });

    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText(i18next.t("settings_migration.button_switch"))
          .setCta()
          .onClick(() => {
            this.onDecide(true);
            this.close();
          }),
      )
      .addButton((button) =>
        button.setButtonText(i18next.t("settings_migration.button_keep")).onClick(() => {
          this.onDecide(false);
          this.close();
        }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
