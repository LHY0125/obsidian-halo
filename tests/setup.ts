import { rs } from "@rstest/core";

rs.mock("obsidian", () => {
  const notices: string[] = [];

  class TAbstractFile {
    vault: unknown;
    path = "";
    name = "";
    parent: TFolder | null = null;
  }

  class TFile extends TAbstractFile {
    stat = {
      ctime: 0,
      mtime: 0,
      size: 0,
    };
    basename = "";
    extension = "";
  }

  class TFolder extends TAbstractFile {
    children: TAbstractFile[] = [];

    isRoot(): boolean {
      return this.path === "/";
    }
  }

  class Notice {
    constructor(message: string) {
      notices.push(message);
    }
  }

  class Modal {
    contentEl = {
      createEl: () => undefined,
      empty: () => undefined,
    };

    constructor(readonly app: unknown) {}

    open(): void {}

    close(): void {}
  }

  class Plugin {
    app: unknown;

    async loadData(): Promise<unknown> {
      return {};
    }

    async saveData(): Promise<void> {}

    addCommand(): void {}

    addRibbonIcon(): void {}

    addSettingTab(): void {}
  }

  class PluginSettingTab {
    containerEl = {
      empty: () => undefined,
    };

    constructor(
      readonly app: unknown,
      readonly plugin: unknown,
    ) {}
  }

  class Setting {
    constructor(readonly containerEl?: unknown) {}

    setName(): this {
      return this;
    }

    setDesc(): this {
      return this;
    }

    addButton(callback: (button: Button) => void): this {
      callback(new Button());
      return this;
    }

    addExtraButton(callback: (button: Button) => void): this {
      callback(new Button());
      return this;
    }

    addText(callback: (text: TextComponent) => void): this {
      callback(new TextComponent());
      return this;
    }

    addToggle(callback: (toggle: ToggleComponent) => void): this {
      callback(new ToggleComponent());
      return this;
    }
  }

  class Button {
    setButtonText(): this {
      return this;
    }

    setDisabled(): this {
      return this;
    }

    setCta(): this {
      return this;
    }

    setIcon(): this {
      return this;
    }

    /**
     * 真实 `ButtonComponent` 有 `setTooltip`，桩里原本缺这一条。
     *
     * 必须补上而不是绕开：查重弹窗里有两个**只显示图标、没有文字**的按钮
     *（类型图标、草稿标记），tooltip 是唯一能表达「这个图标是什么意思」的地方 ——
     * 为了省掉这一行而把按钮改成带文字的，等于为了测试脚手架削弱真实 UI。
     */
    setTooltip(): this {
      return this;
    }

    /**
     * 同理，真实 `ButtonComponent` 的 `setWarning()` 在这一版桩里也缺。
     *
     * 附件弹窗的「删除」按钮用它把自己标成危险操作（Obsidian 渲染成红色）——
     * 那是**附件删除不可逆**这条性质在 UI 上唯一的表达，不能为了省掉这一行而拿掉。
     */
    setWarning(): this {
      return this;
    }

    onClick(): this {
      return this;
    }
  }

  class TextComponent {
    setValue(): this {
      return this;
    }

    onChange(): this {
      return this;
    }
  }

  class ToggleComponent {
    setValue(): this {
      return this;
    }

    onChange(): this {
      return this;
    }
  }

  const normalizePath = (path: string): string => {
    return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  };

  const getLinkpath = (linktext: string): string => {
    return linktext.split("|")[0].split("#")[0].trim();
  };

  return {
    getLinkpath,
    Modal,
    moment: {
      locale: () => "en",
    },
    normalizePath,
    Notice,
    Plugin,
    PluginSettingTab,
    requestUrl: rs.fn(),
    Setting,
    TAbstractFile,
    TFile,
    TFolder,
    __notices: notices,
  };
});
