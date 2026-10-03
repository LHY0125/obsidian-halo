import i18next from "i18next";
import { Modal, Notice, Setting } from "obsidian";
import type HaloPlugin from "./main";
import { describeSelfCheckFailure, runSelfCheck } from "./mcp-self-check";
import { type HaloSite, mcpEndpointOf, normalizeSite } from "./settings";

export function openSiteEditingModal(
  plugin: HaloPlugin,
  site?: HaloSite,
  index = -1,
): Promise<{ site: HaloSite; index?: number }> {
  return new Promise((resolve, reject) => {
    const modal = new SiteEditingModal(
      plugin,
      site || { name: "", url: "", default: false, token: "", mcpToken: "" },
      index,
      (site, index) => {
        resolve({
          site,
          index,
        });
      },
    );
    modal.open();
  });
}

export class SiteEditingModal extends Modal {
  private readonly currentSite: HaloSite;

  constructor(
    private readonly plugin: HaloPlugin,
    private readonly site: HaloSite,
    private readonly index: number,
    private readonly onSubmit: (site: HaloSite, index?: number) => void,
  ) {
    super(plugin.app);

    this.currentSite = normalizeSite(site);
  }
  onOpen(): void {
    const { contentEl } = this;

    const renderContent = () => {
      contentEl.empty();

      contentEl.createEl("h2", { text: i18next.t("site_editing_modal.title") });

      new Setting(contentEl)
        .setName(i18next.t("site_editing_modal.settings.name.name"))
        .setDesc(i18next.t("site_editing_modal.settings.name.description"))
        .addText((text) =>
          text.setValue(this.currentSite.name).onChange((value) => {
            this.currentSite.name = value;
          }),
        );

      new Setting(contentEl)
        .setName(i18next.t("site_editing_modal.settings.url.name"))
        .setDesc(i18next.t("site_editing_modal.settings.url.description"))
        .addText((text) =>
          text.setValue(this.currentSite.url).onChange((value) => {
            this.currentSite.url = value;
          }),
        );

      new Setting(contentEl)
        .setName(i18next.t("site_editing_modal.settings.token.name"))
        .setDesc(i18next.t("site_editing_modal.settings.token.description"))
        .addText((text) =>
          text.setValue(this.currentSite.token).onChange((value) => {
            this.currentSite.token = value;
          }),
        );

      new Setting(contentEl)
        .setName(i18next.t("site_editing_modal.settings.mcpToken.name"))
        .setDesc(i18next.t("site_editing_modal.settings.mcpToken.description"))
        .addText((text) =>
          text.setValue(this.currentSite.mcpToken).onChange((value) => {
            this.currentSite.mcpToken = value.trim();
          }),
        );

      new Setting(contentEl)
        .setName(i18next.t("site_editing_modal.settings.default.name"))
        .setDesc(i18next.t("site_editing_modal.settings.default.description"))
        .addToggle((toggle) =>
          toggle.setValue(this.currentSite.default).onChange((value) => {
            this.currentSite.default = value;
          }),
        );

      new Setting(contentEl)
        .addButton((button) => {
          button.setButtonText(i18next.t("site_editing_modal.settings.validate.button")).onClick(async () => {
            const site = normalizeSite(this.currentSite);

            button.setDisabled(true);
            button.setButtonText(i18next.t("site_editing_modal.settings.validate.button_validating"));

            try {
              const report = await runSelfCheck(mcpEndpointOf(site), site.mcpToken);

              if (report.error) {
                // 与命令面板的自检共用同一个文案函数（含服务端原文）—— 见 describeSelfCheckFailure
                new Notice(describeSelfCheckFailure(report.error));
              } else if (report.ok) {
                new Notice(i18next.t("site_editing_modal.settings.validate.notice_validated"));
              } else {
                new Notice(
                  i18next.t("command.mcp_self_check.notice_missing", {
                    count: report.missing.length,
                    tools: report.missing.join(", "),
                  }),
                );
              }
            } catch {
              // runSelfCheck 目前契约上不抛，但万一这里抛出而无人接住，用户会得到零反馈 ——
              // 这个按钮的全部职责就是告诉用户哪儿不对。复用通用连接失败文案，不新增键。
              new Notice(i18next.t("common.error_connection_failed"));
            } finally {
              button.setDisabled(false);
              button.setButtonText(i18next.t("site_editing_modal.settings.validate.button"));
            }
          });
        })
        .addButton((button) =>
          button
            .setButtonText(i18next.t("site_editing_modal.settings.save.button"))
            .setCta()
            .onClick(() => {
              this.onSubmit(normalizeSite(this.currentSite), this.index);
              this.close();
            }),
        );
    };

    renderContent();
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
