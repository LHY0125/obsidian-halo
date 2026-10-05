import { beforeAll, expect, rs, test } from "@rstest/core";
import i18next from "i18next";
import * as obsidianRuntime from "obsidian";
import type { PluginManifest } from "obsidian";
import { initializeI18n } from "../src/i18n";
import HaloPlugin from "../src/main";
import HaloService from "../src/service";
import { TEST_SITE, createFile, createMockApp, createSettings, requestUrlMock } from "./helpers/obsidian-mocks";

/**
 * 初始化 i18n（生产同一条入口）：批量命令的两道空转守卫弹的是**两句不同的话**，
 * 判定它们必须靠文案本身 —— 不初始化时 `i18next.t()` 原样返回键名，
 * 「弹的是哪一句」这件事就只剩键名可比，而键名恰恰是被测代码自己传进来的。
 */
beforeAll(async () => {
  await initializeI18n("en");
});

/** `tests/setup.ts` 里那个 Notice 构造器会把每条文案推进这个数组 */
function capturedNotices(): string[] {
  return (obsidianRuntime as unknown as { __notices: string[] }).__notices;
}

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
  runBatchCommand(action: "draft" | "publish" | "unpublish"): Promise<void>;
  pushPageCommand(): Promise<void>;
  pullPageCommand(): Promise<void>;
  managePagesCommand(): Promise<void>;
  manageAttachmentsCommand(): Promise<void>;
  searchContentCommand(): Promise<void>;
  recycleContentCommand(kind: "post" | "page"): Promise<void>;
  pickSiteForPull(noSitesKey: string): Promise<{ url: string } | undefined>;
};

/**
 * `tests/setup.ts` 里那个 `Modal.open()` 是**空实现**（不调 `onOpen()`），所以「弹窗真的被
 * 打开了」这件事只能靠打桩才看得出来。这也是本文件里唯一能观察到的弹窗证据 ——
 * 弹窗内部渲染了什么，由 `tests/recycle-modal.test.ts` 直接调 `render()` 去覆盖。
 *
 * 之所以要观察它：`manage-pages` 在 Task 6 里是一句**占位** `Notice`，本任务把它换成真弹窗。
 * 两者在测试里都不抛错，不打桩的话「换了没换」完全不可见。
 */
function modalOpenSpy() {
  return rs.spyOn(obsidianRuntime.Modal.prototype, "open");
}

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

test("批量命令：没配站点时提示「先配站点」，且不碰 vault", async () => {
  // `batch.error_no_sites` 这个键在本任务之前**没有任何引用点** —— 它被造出来就是为了
  // 这一道守卫。没有这条用例，守卫被删掉也不会有人发现，而后果是用户在零站点时点下
  // 「批量发布」，拿到的是一个空的确认弹窗（或者一个报错），而不是一句告诉他去哪儿配的话。
  const { plugin } = makePlugin(createSettings({ sites: [] }));
  const getMarkdownFiles = rs.fn(() => []);
  plugin.app = { vault: { getMarkdownFiles } } as unknown;
  const before = capturedNotices().length;

  await plugin.runBatchCommand("publish");

  expect(capturedNotices().slice(before)).toEqual([i18next.t("batch.error_no_sites")]);
  // 对照物：这道守卫必须**早于**读 vault。少了它，上面那条断言在一个「先列文件、
  // 再发现没站点」的实现下照样为真 —— 而那意味着零站点时还是把整库文件列了一遍。
  expect(getMarkdownFiles).not.toHaveBeenCalled();
});

test("批量命令：配了站点但没有一篇能进批时，提示的是**另一句**", async () => {
  // 与上一条成对。两句话对应两种不同的用户动作：去配站点 / 去改笔记。
  // 合成一句「无法批量处理」，用户不知道该动哪边 —— 这正是本任务要保住的区分度。
  const { plugin } = makePlugin();
  const file = createFile("notes/gone.md");

  plugin.app = {
    vault: { getMarkdownFiles: () => [file] },
    // 笔记指向一个不在站点列表里的站点 → 进 skipped，候选数为 0
    metadataCache: {
      getFileCache: () => ({ frontmatter: { halo: { site: "https://gone.example.com" } } }),
    },
  } as unknown;
  const before = capturedNotices().length;

  await plugin.runBatchCommand("publish");

  expect(capturedNotices().slice(before)).toEqual([i18next.t("batch.error_no_candidates")]);
});

test("批量命令：确认之前不发布、也不上传图片（预览在任何写操作之前）", async () => {
  // 确认弹窗的 Promise 在测试脚手架里**永不 settle**（`Modal.open()` 不调 `onOpen()`），
  // 所以 `runBatchCommand` 会挂在 `confirmBatchPlan` 上。这里刻意不 await：
  // 断言的是「它还停在那儿」—— 而停在确认上的意思就是站点与本地都还没被动过
  //（`uploadImages` 会真的改写笔记里的图片链接，它必须排在确认之后）。
  const { plugin } = makePlugin();
  const file = createFile("notes/a.md");

  plugin.app = {
    vault: { getMarkdownFiles: () => [file], read: rs.fn(async () => "") },
    metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
  } as unknown;

  const summarize = rs.spyOn(HaloService.prototype, "summarizeImages");
  const publish = rs.spyOn(HaloService.prototype, "publishPost");
  const upload = rs.spyOn(HaloService.prototype, "uploadImages");

  try {
    void plugin.runBatchCommand("publish");
    // 放一个宏任务让它跑到弹窗那一步（规划是异步的：先列分类标签，再逐篇扫图片）
    await new Promise((resolve) => setTimeout(resolve, 0));

    // **必须先把「流程真的走到了规划」证明掉**：否则下面两条「没调」也可能只是因为它在更早的
    // 地方就返回了（比如候选数为 0），那样这条用例永远为真 —— 一条不能失败的测试比一个
    // 记录在案的缺口更糟。
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0][0]).toBe(file);

    expect(publish).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  } finally {
    summarize.mockRestore();
    publish.mockRestore();
    upload.mockRestore();
  }
});

/**
 * 独立页面三条命令（`push-page` / `pull-page` / `manage-pages`）的编排层。
 *
 * 这里断言的是**接线**（命令调了哪个入口、在哪一步返回），不是服务行为 ——
 * 推送与拉取本身由 `tests/service/page-service.test.ts` 覆盖。
 */
test("push-page 命令在没有活动文件时静默返回，不弹任何提示", async () => {
  // 「静默」是刻意的：打开一个空库就点命令，不该挨一句「没有活动文件」的报错。
  // 与 `publishCommand` 同款（它也在这一步直接 return）。
  //
  // ⚠️ 断言取**增量**而不是 `expect(capturedNotices()).toHaveLength(0)`：那个数组由
  // `tests/setup.ts` 的模块级 mock 持有，**本文件内所有用例共享**，前面的批量用例已经推进去
  // 4 条。写成绝对值的话，这条用例的成败取决于它在文件里的位置 —— 一条会随无关改动变红/变绿的
  // 断言。本文件其余用例用的都是同一个增量写法。
  const { plugin } = makePlugin(createSettings({ skipPreviewOnPublish: true }));
  (plugin.app as { workspace: { activeEditor: unknown } }).workspace.activeEditor = null;
  const before = capturedNotices().length;

  await plugin.pushPageCommand();

  expect(capturedNotices().slice(before)).toEqual([]);
});

test("pickSiteForPull：单站点时直取该站点，不经过选择弹窗", async () => {
  // 「没走弹窗」的判据是**它能返回**：站点选择弹窗的 Promise 既不 resolve 也不 reject
  //（`site-selection-modal.ts` 的 `onClose` 没有 resolve），一旦走进去这里会永久挂起，
  // 而不是断言失败。所以不需要去 spy 那个弹窗。
  const { plugin } = makePlugin();

  const site = await plugin.pickSiteForPull("command.pull_page.error_no_sites");

  expect(site?.url).toBe(TEST_SITE.url);
});

test("pickSiteForPull：零站点时弹的是**调用方传进来的**那句，不是写死的", async () => {
  // 这里刻意传一个**文案不同**的既有键（`mcp_self_check` 那句以句号结尾）。
  // 传 `pull_page.error_no_sites` 的话，一个把键写死在 helper 里的实现会给出**同样的字符串**，
  // 断言就变成零判别力 —— 本仓 `error-message.test.ts` 用同一种手法区分「具体原因 vs 泛化兜底」。
  const { plugin } = makePlugin(createSettings({ sites: [] }));
  const before = capturedNotices().length;

  const site = await plugin.pickSiteForPull("command.mcp_self_check.error_no_sites");

  expect(site).toBeUndefined();
  expect(capturedNotices().slice(before)).toEqual([i18next.t("command.mcp_self_check.error_no_sites")]);
});

test("pull-page 命令零站点时提示「先配站点」，且不停在弹窗上", async () => {
  // 拉取类命令手上没有本地文件，走不了 `resolveSite`（那个要 `file.path`），所以这条守卫
  // 是它们**唯一**的提前出口。少掉它，用户拿到的是一条永远不 resolve 的弹窗 —— Obsidian 里
  // 表现为「点了没反应」。
  const { plugin } = makePlugin(createSettings({ sites: [] }));
  const before = capturedNotices().length;

  await plugin.pullPageCommand();

  expect(capturedNotices().slice(before)).toEqual([i18next.t("command.pull_page.error_no_sites")]);
});

test("manage-pages 命令零站点时提示「先配站点」", async () => {
  // Task 6 那条占位用例（「尚未实现：弹一条占位提示」）在本任务被**替换**掉了 ——
  // 它钉住的是一个刻意的中间态，而中间态到这里结束了。替它留下这一条：占位可以删，
  // 「零站点」这道**守卫**不能跟着删（删掉之后用户拿到的是一个开不出来的弹窗，
  // Obsidian 里表现为「点了没反应」）。
  const { plugin } = makePlugin(createSettings({ sites: [] }));
  const before = capturedNotices().length;

  await plugin.managePagesCommand();

  expect(capturedNotices().slice(before)).toEqual([i18next.t("command.manage_pages.error_no_sites")]);
});

test("manage-pages 命令有站点时打开管理弹窗，且不再弹占位提示", async () => {
  // 这条是 Task 6 那条占位用例的**直接替身**：它当初存在的理由是「Task 12 忘了接上时
  // 要有一条会红的测试」，所以这里断言的是**接上了**（`Modal.open` 被调用一次），
  // 并且**占位那句已经不在**（通知数组增量为空）。
  //
  // 不这么写的话就没有任何一条用例能区分「真弹窗」与「占位 Notice」——
  // 而为让旧用例继续通过去保留占位，恰恰是它在防的事。
  //
  // 单站点是刻意的：多站点会先停在站点选择弹窗上（在脚手架里永不 resolve），断言等不到。
  const { plugin } = makePlugin();
  const open = modalOpenSpy();
  const before = capturedNotices().length;

  try {
    await plugin.managePagesCommand();

    expect(open).toHaveBeenCalledTimes(1);
    expect(capturedNotices().slice(before)).toEqual([]);
  } finally {
    open.mockRestore();
  }
});

/**
 * 回收站两条命令的编排层。
 *
 * 两条命令**只在 `kind` 上分档**（与三个批量命令同一取舍），所以这里要的是一条
 * 「kind 真的分档了」的证据 —— 写死其中一句、或把 `kind` 丢在路上的实现，
 * 只有成对的两条断言能拆穿。
 */
test("recycle-post 命令零站点时提示「先配站点」", async () => {
  const { plugin } = makePlugin(createSettings({ sites: [] }));
  const before = capturedNotices().length;

  await plugin.recycleContentCommand("post");

  expect(capturedNotices().slice(before)).toEqual([i18next.t("command.recycle_post.error_no_sites")]);
});

test("recycle-page 命令零站点时提示的是**它自己**那句", async () => {
  // 与上一条成对：两句文案不同，所以「kind → 文案键」的映射写错时这里会红。
  // 合成一句（或把 kind 丢掉）时，上一条照样绿 —— 这正是要防的那种「看起来对」。
  const { plugin } = makePlugin(createSettings({ sites: [] }));
  const before = capturedNotices().length;

  await plugin.recycleContentCommand("page");

  expect(capturedNotices().slice(before)).toEqual([i18next.t("command.recycle_page.error_no_sites")]);
});

test("recycle-content 命令有站点时打开回收站弹窗，不弹任何提示", async () => {
  // 零站点那两条守卫之外的另一半：有站点时必须**走到弹窗**，而不是静默返回。
  const { plugin } = makePlugin();
  const open = modalOpenSpy();
  const before = capturedNotices().length;

  try {
    await plugin.recycleContentCommand("page");

    expect(open).toHaveBeenCalledTimes(1);
    expect(capturedNotices().slice(before)).toEqual([]);
  } finally {
    open.mockRestore();
  }
});

/**
 * 查重命令（`search-content`）的编排层。
 *
 * ⚠️ 这条命令在脚手架里**只有「零站点」那一支能走完**：再往后就是问关键词的输入弹窗，
 * 而 `tests/setup.ts` 的 `Modal.open()` 不调 `onOpen()` —— 那个 Promise 既不 resolve
 * 也不 reject，`await` 会永久挂起（表现为超时，不是断言失败）。所以「用户取消输入后静默返回」
 * 那一支在这里**测不到**；它的判据（空串 → `undefined`）落在 `normalizeQuery()` 上，
 * 由 `tests/search-modal.test.ts` 覆盖。
 */
test("search-content 命令零站点时提示「先配站点」，且不停在输入弹窗上", async () => {
  // 这条同时钉住了**顺序**：站点判定必须早于问关键词。反过来的实现会先打开输入弹窗，
  // 于是永远走不到这句提示 —— 表现为 5000ms 超时（实测过），而用户那边则是
  // 「先打一段字、再被告知还没配站点」，两件坏事都从同一个顺序来。
  const { plugin } = makePlugin(createSettings({ sites: [] }));
  const before = capturedNotices().length;

  await plugin.searchContentCommand();

  expect(capturedNotices().slice(before)).toEqual([i18next.t("command.search_content.error_no_sites")]);
});

test("search-content 命令：站点定了、关键词还没输入时，一个请求都不发", async () => {
  // 先证明流程**真的走到了**站点那一步 —— 否则「没发请求」也可能只是它在更早的地方就返回了
  //（比如零站点），那样这条用例永远为真，比一个记录在案的缺口更糟。
  const { plugin } = makePlugin();
  const pick = rs.spyOn(plugin, "pickSiteForPull");
  requestUrlMock().mockReset();

  try {
    // **刻意不 await**：它停在输入弹窗上（见上面那段说明）。放一个宏任务把站点那步跑完。
    void plugin.searchContentCommand();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pick).toHaveBeenCalledTimes(1);
    expect(requestUrlMock().mock.calls).toHaveLength(0);
  } finally {
    pick.mockRestore();
  }
});

/**
 * 附件管理命令（`manage-attachments`）的编排层。
 *
 * 与查重命令同款：这条命令在脚手架里**只有「零站点」那一支能走完** —— 再往后就是
 * `AttachmentManagerModal`，而 `tests/setup.ts` 的 `Modal.open()` 不调 `onOpen()`，
 * 弹窗里的取数与逐行渲染一行都跑不到。所以「渲染成什么样」的判据全部落在
 * `buildAttachmentRows()` 上，由 `tests/attachment-modal.test.ts` 覆盖。
 */
test("manage-attachments 命令零站点时提示「先配站点」，且不停在弹窗上", async () => {
  // 与 `pull-page` / `search-content` 那两条成对：附件管理同样作用于**远端**，
  // 手上没有本地文件，走不了 `resolveSite`，所以这道守卫是它唯一的提前出口。
  // 少掉它，用户拿到的是一条永远不 resolve 的弹窗 —— 在 Obsidian 里表现为「点了没反应」。
  const { plugin } = makePlugin(createSettings({ sites: [] }));
  const before = capturedNotices().length;

  await plugin.manageAttachmentsCommand();

  expect(capturedNotices().slice(before)).toEqual([i18next.t("command.manage_attachments.error_no_sites")]);
});

test("manage-attachments 命令：单站点时直接进附件弹窗，不弹任何提示", async () => {
  // 「进的是**附件**弹窗而不是别的」这件事必须单独钉住：站点选择弹窗在测试脚手架里
  // 会让流程永久挂起（`onClose` 不 resolve），所以「能返回」只证明没走那条分支，
  // 证明不了它开的是哪一个弹窗。单站点时 `pickSiteForPull` 直取该站点、不弹选择框，
  // 于是这一步唯一会 `open()` 的就是 `AttachmentManagerModal`。
  const { plugin } = makePlugin();
  const pick = rs.spyOn(plugin, "pickSiteForPull");
  // `AttachmentManagerModal extends Modal` 且没有覆写 `open()`，所以它走的正是原型上这一个。
  const open = rs.spyOn(obsidianRuntime.Modal.prototype, "open");
  const before = capturedNotices().length;

  try {
    await plugin.manageAttachmentsCommand();

    expect(pick).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(capturedNotices().slice(before)).toEqual([]);
  } finally {
    pick.mockRestore();
    open.mockRestore();
  }
});
