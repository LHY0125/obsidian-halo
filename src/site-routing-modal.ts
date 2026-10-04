import i18next from "i18next";
import { Modal, Setting } from "obsidian";
// 从 "glob" 而不是 "site-routing" 取符号：glob.ts 是零项目内依赖的叶子，
// 从 site-routing.ts 取会把 settings.ts 一起拉进本模块的依赖图（那边 import 了 settings）。
import { type SiteRoutingRule, normalizeRulePattern } from "./glob";
import type HaloPlugin from "./main";

export function openSiteRoutingModal(plugin: HaloPlugin, rule?: SiteRoutingRule): Promise<SiteRoutingRule | undefined> {
  return new Promise((resolve) => {
    new SiteRoutingModal(plugin, rule ?? { pattern: "", site: plugin.settings.sites[0]?.url ?? "" }, resolve).open();
  });
}

class SiteRoutingModal extends Modal {
  /**
   * 本弹窗自己的草案副本。**必须复制，不能直接持有调用方传进来的那个对象。**
   *
   * 编辑既有规则时，传进来的是 `plugin.settings.siteRouting` 里的**活对象**，而下面每个
   * `onChange` 都是就地写它。不复制的话，「取消」只丢弃了返回值，内存里的改动**还在** ——
   * 用户之后做任何触发 `saveSettings()` 的事（哪怕只是切一下别的开关）就会把这次已被
   * 放弃的编辑落进 `data.json`：他以为没改，实际改了路由目标，下次发布发到另一个站。
   * 这属于静默 + 延迟的数据变更，比报错难查得多。
   *
   * 复制放在构造函数而非各调用点：这条不变量该由**拥有草案的对象**自己保证，
   * 放在调用方意味着每多一个调用点就多一次「记得先复制」的机会。
   */
  private readonly draft: SiteRoutingRule;

  constructor(
    private readonly plugin: HaloPlugin,
    draft: SiteRoutingRule,
    private readonly onSubmit: (rule: SiteRoutingRule | undefined) => void,
  ) {
    super(plugin.app);

    this.draft = { ...draft };
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.createEl("h2", { text: i18next.t("site_routing_modal.title") });

    new Setting(contentEl)
      .setName(i18next.t("site_routing_modal.pattern.name"))
      .setDesc(i18next.t("site_routing_modal.pattern.description"))
      .addText((text) =>
        text.setValue(this.draft.pattern).onChange((value) => {
          this.draft.pattern = value;
        }),
      );

    new Setting(contentEl)
      .setName(i18next.t("site_routing_modal.site.name"))
      .setDesc(i18next.t("site_routing_modal.site.description"))
      .addDropdown((dropdown) => {
        // 只列出**已配置**的站点：规则指向一个不存在的站点时 `resolveSite` 会直接报错，
        // 让用户在弹窗里就能选到一个真实存在的站点，是这条错误唯一的可预防来源。
        for (const site of this.plugin.settings.sites) {
          dropdown.addOption(site.url, site.name || site.url);
        }

        dropdown.setValue(this.draft.site).onChange((value) => {
          this.draft.site = value;
        });
      });

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(i18next.t("common.button_cancel")).onClick(() => {
          this.onSubmit(undefined);
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText(i18next.t("site_routing_modal.save.button"))
          .setCta()
          .onClick(() => {
            const pattern = normalizeRulePattern(this.draft.pattern);

            // 空模式绝不入表：`matchGlob` 会把它当"永不命中"，但一条什么都不匹配的规则
            // 在设置里看着像生效的，会让人以为已经配好了。
            if (pattern === "") {
              return;
            }

            this.onSubmit({ pattern, site: this.draft.site });
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
