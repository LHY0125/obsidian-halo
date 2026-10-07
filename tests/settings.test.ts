import { describe, expect, it, rs, test } from "@rstest/core";
import { Modal } from "obsidian";
import { isSameSiteUrl, normalizeSite, normalizeSiteUrl } from "../src/settings";
import { CURRENT_SETTINGS_VERSION, DEFAULT_SETTINGS, mcpEndpointOf, migrateSettings } from "../src/settings";
import { openSiteRoutingModal } from "../src/ui/modals/site-routing-modal";

describe("settings URL normalization", () => {
  test("trims whitespace and removes trailing slashes", () => {
    expect(normalizeSiteUrl(" https://halo.example.com/// ")).toBe("https://halo.example.com");
  });

  test("normalizes a site without changing other fields", () => {
    expect(
      normalizeSite({
        name: "Blog",
        url: "https://halo.example.com/",
        token: "token",
        mcpToken: "",
        default: true,
      }),
    ).toEqual({
      name: "Blog",
      url: "https://halo.example.com",
      token: "token",
      mcpToken: "",
      default: true,
    });
  });

  test("compares site URLs after normalization", () => {
    expect(isSameSiteUrl(" https://halo.example.com/ ", "https://halo.example.com")).toBe(true);
    expect(isSameSiteUrl("https://halo.example.com/blog", "https://halo.example.com")).toBe(false);
  });
});

describe("mcpEndpointOf", () => {
  it("由站点 URL 推导出 /mcp 端点，并吃掉尾部斜杠", () => {
    expect(mcpEndpointOf({ url: "https://blog.example.com" } as never)).toBe("https://blog.example.com/mcp");
    expect(mcpEndpointOf({ url: "https://blog.example.com/" } as never)).toBe("https://blog.example.com/mcp");
  });
});

describe("migrateSettings", () => {
  it("空输入得到默认设置与新版本号", () => {
    const { settings, notices } = migrateSettings(undefined);
    expect(settings.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
    expect(settings.sites).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("上游历史配置（无 settingsVersion）且 publishByDefault 为 true → 产出一条迁移提示", () => {
    const { notices } = migrateSettings({
      publishByDefault: true,
      sites: [],
      replaceImageLinks: true,
      imageUploadCache: {},
    });
    expect(notices).toHaveLength(1);
    expect(notices[0].key).toBe("publishByDefault-true");
  });

  it("publishByDefault 为 false 时不给提示", () => {
    expect(migrateSettings({ publishByDefault: false }).notices).toEqual([]);
  });

  it("迁移只提示、不改值 —— 必须由用户确认后才写入", () => {
    const { settings } = migrateSettings({ publishByDefault: true });
    expect(settings.publishByDefault).toBe(true);
  });

  it("已是当前版本时不再重复提示", () => {
    const { notices } = migrateSettings({
      settingsVersion: CURRENT_SETTINGS_VERSION,
      publishByDefault: true,
    });
    expect(notices).toEqual([]);
  });

  it("老站点配置缺 mcpToken 时补空串，不抛错", () => {
    const { settings } = migrateSettings({
      sites: [{ name: "Halo", url: "https://blog.example.com/", token: "pat", default: true }],
    });
    expect(settings.sites[0].mcpToken).toBe("");
    expect(settings.sites[0].url).toBe("https://blog.example.com");
  });

  it("settingsVersion 被写成当前版本，便于下次跳过迁移", () => {
    const { settings } = migrateSettings({ publishByDefault: true });
    expect(settings.settingsVersion).toBe(CURRENT_SETTINGS_VERSION);
  });

  it("缺 imageUploadCache 时补成空对象，避免下游读 undefined", () => {
    const { settings } = migrateSettings({ sites: [] });
    expect(settings.imageUploadCache).toEqual({});
    expect(settings.sites).toEqual([]);
  });
});

describe("siteRouting 迁移", () => {
  it("老配置没有 siteRouting 时补成空数组，不抛错", () => {
    const { settings } = migrateSettings({ sites: [], publishByDefault: false });
    expect(settings.siteRouting).toEqual([]);
  });

  it("已有的规则被原样保留（顺序就是优先级，绝不能在迁移里重排或去重）", () => {
    // 这一条是**规范钉子**，不是**变更探测器** —— 它**在实现之前就是绿的**，
    // 所以不能用它判断「迁移写没写对」。原因：`migrateSettings` 里的
    // `Object.assign({}, DEFAULT_SETTINGS, source)` 本来就会把 `source.siteRouting` 原样带过去，
    // 本断言在 `normalizeRoutingRules()` 存在与否两种情况下都成立。
    //
    // 它守的是**将来**：谁要给迁移加「去重」「按站点归并」「按模式排序」之类的"整理"，
    // 这条会立刻变红 —— 而那种整理正是本阶段明令禁止的。数组顺序就是优先级，
    // 被重排或被悄悄丢掉的规则会把笔记发到另一个站上，且全程没有任何提示。
    const rules = [
      { pattern: "博客/日记/**", site: "https://a.example.com" },
      { pattern: "博客/**", site: "https://b.example.com" },
    ];
    const { settings } = migrateSettings({ siteRouting: rules });

    expect(settings.siteRouting).toEqual(rules);
  });

  it("用户把 siteRouting 写成了非数组（手改 data.json）时回落成空数组，不抛错", () => {
    // data.json 是用户能直接编辑的文件。抛出会让插件整个加载不了 —— 比丢一条规则严重得多。
    expect(migrateSettings({ siteRouting: "博客/**" }).settings.siteRouting).toEqual([]);
  });

  it("规则里的未知字段不被迁移剥掉（将来给类型加字段时不会静默丢配置）", () => {
    // 迁移会**重建**每条规则（模式要归一化、类型要收敛成字符串），所以"重建"很容易写成
    // 「只搬 pattern 与 site 两个已知字段」。今天 `SiteRoutingRule` 恰好只有这两个字段，
    // 那样写零损失；但将来谁给类型加了第三个字段却忘了改这里，那个字段会**每次加载都被剥掉、
    // 再被 saveData() 永久写掉** —— 用户看到的是「我改的配置自己没了」，而全程没有任何提示。
    const withExtraField = [{ pattern: "博客/**", site: "https://a.example.com", futureField: "keep me" }];

    expect(migrateSettings({ siteRouting: withExtraField }).settings.siteRouting).toEqual([
      { pattern: "博客/**", site: "https://a.example.com", futureField: "keep me" },
    ]);
  });
});

describe("站点路由弹窗的草案", () => {
  /**
   * 拦下弹窗实例以检查它的草案。
   *
   * 不用跑 `onOpen()`：本仓 `tests/setup.ts` 的 `Modal.open()` 是**同步**的
   * （`open(): void {}` 定义在 prototype 上），而 `openSiteRoutingModal()` 里
   * `new SiteRoutingModal(...).open()` 也是同步执行的 —— 对 prototype 打一个 spy 就能在
   * 调用点同步拿到实例。这条路径刻意**不**碰 `onOpen()`：真去跑它会在第二个 `Setting`
   * 处就撞上 mock 缺口（`Setting` 没有 `addDropdown`），那是另一件事（见账本 F4），
   * 与本断言无关。
   */
  function captureModal(rule: { pattern: string; site: string }): unknown {
    let captured: unknown;
    const spy = rs.spyOn(Modal.prototype, "open").mockImplementation(function (this: unknown) {
      captured = this;
    });

    try {
      void openSiteRoutingModal({ app: undefined } as never, rule);
    } finally {
      // 必须还原：`Modal.prototype` 是**全局共享**的，泄漏出去的 spy 会让后续所有弹窗
      // 都不再真的 open()，那种故障会以别的测试失败的形式出现，极难反查。
      spy.mockRestore();
    }

    return captured;
  }

  it("弹窗不得把调用方的规则对象当作草案（否则「取消」取消不掉内存里的改动）", () => {
    // 编辑既有规则时传进来的就是 plugin.settings.siteRouting 里的**活对象**。弹窗若直接
    // 持有它，`onChange` 就会就地改写设置；用户点「取消」只丢弃了返回值，改动还留在内存里，
    // 之后任何一次 saveSettings() 都会把它落盘 —— 用户以为没改，实际改了路由。
    const rule = { pattern: "博客/**", site: "https://a.example.com" };
    const draft = (captureModal(rule) as { draft: typeof rule }).draft;

    // 判别力所在：复制之前，draft 与 rule 是同一个对象，这一行必红。
    expect(draft).not.toBe(rule);
    // 不能省：万一 `draft` 被改名成别的字段，上面那行会拿到 `undefined`，
    // `undefined !== rule` 恒真 —— 这条把「字段找错了」与「没复制」区分开。
    expect(draft).toEqual(rule);
  });
});
