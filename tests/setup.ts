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
     * 同理，真实 `ButtonComponent` 的 `setDestructive()` 在这一版桩里也缺。
     *
     * 附件弹窗的「删除」按钮用它把自己标成危险操作（Obsidian 渲染成红色）——
     * 那是**附件删除不可逆**这条性质在 UI 上唯一的表达，不能为了省掉这一行而拿掉。
     */
    setDestructive(): this {
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

  /**
   * Obsidian 的 `activeWindow` —— 生产代码用它取定时器（`HaloServiceBase.sleep()`）。
   *
   * ⚠️ **它是 `declare global` 里的真全局，不是 `obsidian` 模块的导出** ——
   * 所以必须挂在 `globalThis` 上，**不能**放进下面那个 return 对象里。
   * 放进去的话 `activeWindow.setTimeout` 在测试里仍是 `undefined`，
   * 而症状是「重试次数恒为 1」（退避一进入就抛），只会看到一个数字对不上。
   *
   * 为什么生产代码不用 `globalThis` 兜底：Obsidian 审核器会报
   * 「Avoid using 'globalThis'. Use 'window' or 'activeWindow' for popout window compatibility」。
   * 在桩里补比在生产代码里放宽语义正确 —— 后者是为测试便利牺牲产品正确性。
   *
   * 只给 `setTimeout` / `clearTimeout`：`sleep()` 只用到前者，而桩应当只提供被用到的面
   * （多给会让「生产代码悄悄多用了别的 API」在测试里不被发现）。
   */
  (globalThis as Record<string, unknown>).activeWindow = {
    setTimeout: (handler: () => void, timeout?: number) => setTimeout(handler, timeout),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
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
