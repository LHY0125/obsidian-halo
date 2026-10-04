import { expect, rs, test } from "@rstest/core";
import type { PluginManifest } from "obsidian";
import HaloPlugin from "../src/main";
import HaloService from "../src/service";
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
  publishFile(file: unknown): Promise<void>;
  publishToDefaultSite(file: unknown): Promise<void>;
  getSiteForActiveFile(): Promise<unknown>;
  resolveSiteFor(file: unknown): unknown;
  uploadImagesForPublish(service: unknown, file: unknown): Promise<{ success: boolean }>;
};

/**
 * 造一个插件实例。
 *
 * `settings` 可以覆盖：预览弹窗在测试脚手架里**永不 resolve**（`tests/setup.ts` 的
 * `Modal.open()` 不调 `onOpen`，也没有任何地方会去点按钮），所以凡是不关心预览的用例
 * 都要显式把它关掉（`createSettings({ skipPreviewOnPublish: true })`），
 * 否则流程会停在弹窗上、断言永远等不到。
 */
function makePlugin(settings: ReturnType<typeof createSettings> = createSettings()): {
  plugin: Internals;
  file: ReturnType<typeof createFile>;
} {
  const file = createFile("notes/a.md");
  const { app } = createMockApp("", file, []);
  const plugin = new HaloPlugin(app, {} as PluginManifest) as unknown as Internals;

  // 传了构造参数也**仍然**要显式赋值：测试里 `obsidian` 被整体 mock，`tests/setup.ts` 的
  // `Plugin` 构造函数**不接参数**，所以 `this.app` 是 undefined（真实 Obsidian 由框架注入）。
  // 上面那两个参数只为满足 tsc —— 真实 `Plugin` 的签名是 `(app, manifest)`，
  // 直接写 `new HaloPlugin()` 会报 TS2554「Expected 2 arguments, but got 0」。
  plugin.app = app;
  plugin.settings = settings;

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
  // 关掉预览：这条用例只关心**站点选择**，而预览弹窗与站点选择框一样，其 Promise 在测试
  // 脚手架里永不 resolve（见 `makePlugin` 的说明）—— 开着它，下面两行断言会因为流程停在
  // 弹窗上而永远等不到。发布预览本身由「预览开启时……」那两条用例负责。
  const { plugin } = makePlugin(createSettings({ skipPreviewOnPublish: true }));
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

test("预览开启时先规划、然后停在预览弹窗：不上传图片，也不发布", async () => {
  // 这条钉住本阶段新增的**顺序**：预览发生在规划之后、任何写操作之前。
  // `uploadImages` 也会改笔记（把本地图片链接换成远程地址），所以它必须排在确认之后 ——
  // 否则用户点了「取消」，笔记里的图片链接已经被换掉了：一次「什么都没发生」的取消，
  // 实际改动了整库笔记里的图片链接。
  const { plugin, file } = makePlugin(); // 默认 `skipPreviewOnPublish: false` = 显示预览
  const plan = rs.spyOn(HaloService.prototype, "planPublish");
  const upload = rs.spyOn(plugin, "uploadImagesForPublish");

  try {
    // **刻意不 await**：预览弹窗的 Promise 在测试脚手架里永不 resolve，所以这里断言的是
    // 「它停在那儿了」。放一个宏任务（在所有微任务之后触发）让它把规划跑完。
    void plugin.publishFile(file);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 必须证明流程**真的走到了**规划：否则「没上传」可能只是因为它压根没开始
    //（例如站点没解析出来就提前返回了）—— 那样这条用例就是一条永远为真的假绿。
    expect(plan).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
  } finally {
    plan.mockRestore();
  }
});

test("publish-with-defaults 不经过路由解析，直接用默认站点", async () => {
  // `publish-with-defaults` 的语义就是「用默认站点」：让路由规则来改写目标会与命令名直接
  // 冲突。这条性质此前**零覆盖** —— 它内联在命令回调里，而命令回调在测试中跑不到
  //（`onload()` 不执行，测试是直接调私有方法的）。
  const { plugin, file } = makePlugin(createSettings({ skipPreviewOnPublish: true }));
  const resolve = rs.spyOn(plugin, "resolveSiteFor");
  const upload = rs.spyOn(plugin, "uploadImagesForPublish").mockResolvedValue({ success: false });

  await plugin.publishToDefaultSite(file);

  // 与 `publishCommand` 那条分叉的**唯一**判别点：这条路径一次都不该经过路由解析
  expect(resolve).not.toHaveBeenCalled();
  expect(upload).toHaveBeenCalledTimes(1);
  const service = upload.mock.calls[0][0] as { site: { url: string } };
  expect(service.site.url).toBe(TEST_SITE.url);
});
