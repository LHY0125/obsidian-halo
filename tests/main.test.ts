import { expect, rs, test } from "@rstest/core";
import type { PluginManifest } from "obsidian";
import HaloPlugin from "../src/main";
import { TEST_SITE, createFile, createMockApp, createSettings } from "./helpers/obsidian-mocks";

/**
 * `src/main.ts` 的编排层测试。
 *
 * 这一层此前**零覆盖**。Task 6 的核心保证是「发布与上传图片走**同一个**解析入口」，
 * 而这条保证原本只有人工 grep 作证 —— 把 `publishCommand` 改回自己挑站点，
 * 其余测试会全绿，而图片传到 A 站、文章发到 B 站。所以这里要的**不是**
 * 「解析优先级算得对」（那是 `tests/site-routing.test.ts` 的活），而是
 * 「这两条入口**确实调了**解析器」。
 *
 * 手法是 `rs.spyOn` 打桩，只断言「调了、传的是哪个文件」——
 * 编排层的价值就在「调了谁」，断言得更细只会把测试绑死在实现上。
 */
type Internals = {
  app: unknown;
  settings: unknown;
  publishCommand(): Promise<void>;
  getSiteForActiveFile(): Promise<unknown>;
  resolveSiteFor(file: unknown): unknown;
  uploadImagesForPublish(service: unknown): Promise<{ success: boolean }>;
};

function makePlugin(): { plugin: Internals; file: ReturnType<typeof createFile> } {
  const file = createFile("notes/a.md");
  const { app } = createMockApp("", file, []);
  const plugin = new HaloPlugin(app, {} as PluginManifest) as unknown as Internals;

  // 传了构造参数也**仍然**要显式赋值：测试里 `obsidian` 被整体 mock，`tests/setup.ts` 的
  // `Plugin` 构造函数**不接参数**，所以 `this.app` 是 undefined（真实 Obsidian 由框架注入）。
  // 上面那两个参数只为满足 tsc —— 真实 `Plugin` 的签名是 `(app, manifest)`，
  // 直接写 `new HaloPlugin()` 会报 TS2554「Expected 2 arguments, but got 0」。
  plugin.app = app;
  plugin.settings = createSettings();

  return { plugin, file };
}

test("publishCommand 经 resolveSiteFor 解析站点", async () => {
  const { plugin, file } = makePlugin();
  // 打桩成 no-sites：既走完"解析"这一步，又在建 service / 上传之前就返回，
  // 让这条测试只关心"有没有经过解析入口"，不牵扯任何网络或弹窗。
  const spy = rs.spyOn(plugin, "resolveSiteFor").mockReturnValue({ kind: "no-sites" });

  await plugin.publishCommand();

  expect(spy).toHaveBeenCalledWith(file);
});

test("getSiteForActiveFile 经 resolveSiteFor 解析站点", async () => {
  const { plugin, file } = makePlugin();
  const spy = rs.spyOn(plugin, "resolveSiteFor").mockReturnValue({ kind: "no-sites" });

  await plugin.getSiteForActiveFile();

  expect(spy).toHaveBeenCalledWith(file);
});

test("单站点时不再弹站点选择框，直接取该站点", async () => {
  const { plugin } = makePlugin();
  // 这里**不打桩** `resolveSiteFor`，让它真的算一遍：默认设置是单站点且 `default: true`，
  // 于是解析结果应当是「该站点」，而不是「让用户选」。
  const upload = rs.spyOn(plugin, "uploadImagesForPublish").mockResolvedValue({ success: false });

  await plugin.publishCommand();

  // 「后续步骤还能跑到」**本身就证明**没走弹窗分支：站点选择框的 Promise
  // 既不 resolve 也不 reject（`site-selection-modal.ts` 的 `onClose` 没有 resolve），
  // 一旦走进去这里就会永久挂起而不是断言失败。所以不需要去 spy 那个弹窗。
  expect(upload).toHaveBeenCalledTimes(1);
  const service = upload.mock.calls[0][0] as { site: { url: string } };
  expect(service.site.url).toBe(TEST_SITE.url);
});
