import { describe, expect, it, test } from "@rstest/core";
import { isSameSiteUrl, normalizeSite, normalizeSiteUrl } from "../src/settings";
import { CURRENT_SETTINGS_VERSION, DEFAULT_SETTINGS, mcpEndpointOf, migrateSettings } from "../src/settings";

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
