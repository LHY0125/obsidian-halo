import { beforeAll, beforeEach, describe, expect, rs, test } from "@rstest/core";
import i18next from "i18next";
import type { RequestUrlParam, TFile } from "obsidian";
import * as obsidianRuntime from "obsidian";
import { resources } from "../../src/i18n";
import HaloService, { type PublishPlan, type PublishResult } from "../../src/service";
import { MCP_UPLOAD_MAX_BYTES } from "../../src/service/image-upload";
import type { McpCategoryItem, McpGetPostResult, McpPostItem, McpTagItem } from "../../src/service/post-mapping";
import { McpError } from "../../src/transport/errors";
import { createFakeClient } from "../helpers/mcp-mock";
import {
  createFile,
  createMockApp,
  createSettings,
  requestUrlMock,
  TEST_SITE as site,
} from "../helpers/obsidian-mocks";

/**
 * 按生产路径初始化 i18n（`main.ts` 的 onload 就是这么做的）。
 *
 * 不初始化的话 `i18next.t()` 返回 **undefined**，于是每条 `Notice` 的文本都是 undefined——
 * 「发布成功」与「发布失败」再也分不出来，notice 断言会退化成
 * 「弹了一条 notice」甚至 `expect(undefined).toBe(undefined)` 这种零判别力的形式。
 * 参数与 `main.ts` 保持一致（`returnNull: false`）。
 */
beforeAll(async () => {
  await i18next.init({ lng: "en", fallbackLng: "en", resources, returnNull: false });
});

/**
 * 读取与发布收口到 MCP 之后，服务层不该再发任何 REST 请求。
 *
 * 这里刻意不用 `mockReset()`：那只会让 `requestUrl` 返回 undefined，报错落在下游的 `.json` 上，
 * 看不出是「不该发 REST」还是「桩没配对」。直接抛 —— 错误信息本身就是原因。
 */
function forbidRest(): void {
  requestUrlMock().mockImplementation((request: RequestUrlParam) => {
    const url = typeof request === "string" ? request : request.url;

    throw new Error(`HaloService 不应再发 REST 请求: ${url}`);
  });
}

/**
 * 远端文章的**扁平**骨架 —— MCP 的 `halo_get_post` 与写工具返回的都是这个形状。
 *
 * 后半句是**核对过的**，不是推测：2026-10-04 对真实站点拉了一次 `tools/list`（44 个工具
 * **全部**声明了 `outputSchema`），`halo_create_post` / `halo_update_post` 的
 * `outputSchema.properties` 列的就是这套扁平字段（`name` / `slug` / `excerptRaw` /
 * `publishRequested` …），与 `halo_get_post` 的 `item` **同名同形**。
 * 也就是说「写工具也回扁平 post」是服务端声明的契约，而不只是观察到的个例。
 *
 * 但要说清写路径与它的关系：`halo_update_post` / `halo_create_post` 走 `callToolVoid`，
 * 返回值一概不消费（写与读解耦，见 `transport/mcp-client.ts`）。所以这个形状对写路径只是
 * 「服务端确实这么回」，**不是「我们依赖它」** —— 最新的 Post 一律由随后的 `getPost()` 取。
 */
function remoteItem(name: string, overrides: Partial<McpPostItem> = {}): McpPostItem {
  return {
    name,
    title: "Post title",
    slug: "post-title",
    excerpt: "",
    excerptRaw: "",
    autoGenerateExcerpt: true,
    cover: "",
    template: "",
    pinned: false,
    priority: 0,
    publishTime: "",
    allowComment: true,
    published: false,
    publishRequested: false,
    visible: "PUBLIC",
    categories: [],
    tags: [],
    ...overrides,
  };
}

/** `halo_get_post` 的完整返回体 */
function getPostResult(item: McpPostItem, raw = ""): McpGetPostResult {
  return { item, content: { snapshotName: "snapshot-1", rawType: "markdown", raw }, truncated: false };
}

interface FakeServiceOptions {
  /** 按 name 造远端文章。用例可在这里计数 —— 发布重试用例正是靠它断言「重试前先重读」 */
  itemFor?: (name: string) => McpPostItem;
  /** 正文。只有 updatePost / pullPost 会读它 */
  raw?: string;
  categories?: McpCategoryItem[];
  tags?: McpTagItem[];
  /** 写工具（create / update）被调用时执行；抛错即模拟写入失败 */
  onWrite?: (tool: string, args: Record<string, unknown>) => void;
  onPublishState?: (args: Record<string, unknown>) => void;
  /** 分类不存在时自动创建的返回项（`name` 即新建的 metadata.name） */
  onCreateCategory?: (args: Record<string, unknown>) => string | undefined;
  onCreateTag?: (args: Record<string, unknown>) => string | undefined;
  /**
   * 写工具的返回值，默认 `{}`。
   *
   * 可以覆盖是为了验证「写路径不消费返回体」：写路径不**需要**响应负载（写与读解耦），
   * 因此也不依赖它的形状 —— 回一句人读文案（字符串）或扁平对象都合理，
   * 两种都不该影响 frontmatter 的回写。
   */
  writeResult?: unknown;
}

/**
 * 服务层测试的统一假客户端。
 *
 * 一条发布事务会调到的工具都在这里应答：`halo_get_post`（更新分支读一次，写成功后还会再读
 * 一次）、`halo_create_post` / `halo_update_post`、`halo_set_post_publish_state`、
 * `halo_list_categories` / `halo_list_tags`（回填 frontmatter 的显示名）。
 * 漏答任何一个都会得到「Unexpected tool: xxx」—— 那正是本次迁移最容易漏的地方。
 */
function fakeService(options: FakeServiceOptions = {}) {
  const itemFor = options.itemFor ?? ((name: string) => remoteItem(name));

  return createFakeClient((name, args) => {
    switch (name) {
      case "halo_get_post":
        return getPostResult(itemFor(String(args.name)), options.raw ?? "");
      case "halo_list_categories":
        return { items: options.categories ?? [] };
      case "halo_list_tags":
        return { items: options.tags ?? [] };
      case "halo_create_category":
        return { name: options.onCreateCategory?.(args) };
      case "halo_create_tag":
        return { name: options.onCreateTag?.(args) };
      case "halo_create_post":
      case "halo_update_post":
        options.onWrite?.(name, args);
        return options.writeResult ?? {};
      case "halo_set_post_publish_state":
        options.onPublishState?.(args);
        return options.writeResult ?? {};
      default:
        throw new Error(`Unexpected tool: ${name}`);
    }
  });
}

/**
 * 按文件名给回相对 permalink 的假 MCP 客户端。
 *
 * 用文件名而不是调用序号来配对：断言就不依赖上传顺序，
 * 且未知文件会像旧版 `mockAttachmentUploads` 一样直接抛错，不会静默返回 undefined。
 */
function fakeUploads(permalinks: Record<string, string>) {
  return createFakeClient((name, args) => {
    if (name !== "halo_upload_attachment") {
      throw new Error(`Unexpected tool: ${name}`);
    }

    const permalink = permalinks[String(args.filename)];

    if (!permalink) {
      throw new Error(`Unexpected upload: ${String(args.filename)}`);
    }

    return { permalink };
  });
}

/**
 * `tests/setup.ts` 的 obsidian mock 把每条 `Notice` 文本推进 `__notices`。
 *
 * 两点必须注意：① 类型声明里没有这个字段，故取回时做一次断言；
 * ② 该数组**在文件级共享**，所以调用方只能取「本次测试新增的长度差」，不能整体断言。
 */
function capturedNotices(): string[] {
  return (obsidianRuntime as unknown as { __notices: string[] }).__notices;
}

/** 更新分支的 frontmatter：有 `halo.name` 才会走 `halo_update_post` */
function remoteFrontmatter(halo: Record<string, unknown> = {}): () => { frontmatter: Record<string, unknown> } {
  return () => ({
    frontmatter: {
      halo: {
        name: "post-1",
        site: site.url,
        ...halo,
      },
      title: "Post title",
    },
  });
}

describe("HaloService.uploadImages", () => {
  beforeEach(() => {
    requestUrlMock().mockReset();
  });

  test("uploads local markdown and wiki images, skips remote images, and writes replaced markdown", async () => {
    const note = createFile("posts/post.md");
    const logo = createFile("images/logo.png", 10, 100);
    const banner = createFile("images/banner.png", 20, 200);
    const markdown = [
      "![Logo](images/logo.png)",
      "![[images/banner.png|Hero]]",
      "![Remote](https://cdn.example.com/remote.png)",
      "[Normal link](images/logo.png)",
    ].join("\n");
    const { contents, vault, app } = createMockApp(markdown, note, [logo, banner]);
    const settings = createSettings();
    const { client, calls } = fakeUploads({
      "banner.png": "/uploads/banner.png",
      "logo.png": "/uploads/logo.png",
    });
    const service = new HaloService(app, settings, site, client);

    const result = await service.uploadImages({ silent: true }, note);

    const expectedMarkdown = [
      "![Logo](https://halo.example.com/uploads/logo.png)",
      "![Hero](https://halo.example.com/uploads/banner.png)",
      "![Remote](https://cdn.example.com/remote.png)",
      "[Normal link](images/logo.png)",
    ].join("\n");

    expect(result).toMatchObject({
      failedCount: 0,
      processedCount: 2,
      replaced: true,
      reusedCount: 0,
      uploadedCount: 2,
    });
    expect(result.markdown).toBe(expectedMarkdown);
    expect(contents.get(note.path)).toBe(expectedMarkdown);
    expect(vault.modify).toHaveBeenCalledTimes(1);
    // 原先断言的是 requestUrl 被调了 2 次；上传改走 MCP 后，同一事实表现为 2 次 halo_upload_attachment 调用
    expect(calls.map((call) => call.name)).toEqual(["halo_upload_attachment", "halo_upload_attachment"]);
    expect(settings.imageUploadCache["https://halo.example.com"]["images/logo.png"]).toMatchObject({
      linkType: "markdown",
      permalink: "https://halo.example.com/uploads/logo.png",
    });
    expect(settings.imageUploadCache["https://halo.example.com"]["images/banner.png"]).toMatchObject({
      linkType: "wiki",
      permalink: "https://halo.example.com/uploads/banner.png",
      wikiAlias: "Hero",
    });
  });

  test("leaves remote-only markdown from Halo updates untouched", async () => {
    const note = createFile("post.md");
    const markdown = [
      "![Halo](https://halo.example.com/uploads/logo.png)",
      "![Protocol relative](//cdn.example.com/banner.png)",
      "![Anchor](#local-anchor)",
    ].join("\n");
    const { contents, vault, app } = createMockApp(markdown, note, []);
    // 没有本地图片 → 一次工具调用都不该发生
    const { client, calls } = createFakeClient(() => {
      throw new Error("no images should be uploaded");
    });
    const service = new HaloService(app, createSettings(), site, client);

    const result = await service.uploadImages({ silent: true }, note);

    expect(result).toMatchObject({
      failedCount: 0,
      processedCount: 0,
      replaced: false,
      reusedCount: 0,
      uploadedCount: 0,
    });
    expect(result.markdown).toBe(markdown);
    expect(contents.get(note.path)).toBe(markdown);
    expect(vault.modify).not.toHaveBeenCalled();
    // 原先断言的是没发 HTTP 请求；上传改走 MCP 后，同一事实表现为没调 MCP 工具
    expect(calls).toHaveLength(0);
  });

  test("uploads encoded markdown image targets wrapped in angle brackets", async () => {
    const note = createFile("post.md");
    const logo = createFile("images/my logo.png", 10, 100);
    const markdown = "![Logo](<images/my%20logo.png>)";
    const { app } = createMockApp(markdown, note, [logo]);
    const { client } = fakeUploads({ "my logo.png": "/uploads/my-logo.png" });
    const service = new HaloService(app, createSettings(), site, client);

    const result = await service.uploadImages({ silent: true }, note);

    expect(result).toMatchObject({
      failedCount: 0,
      processedCount: 1,
      replaced: true,
      uploadedCount: 1,
    });
    expect(result.markdown).toBe("![Logo](<https://halo.example.com/uploads/my-logo.png>)");
  });

  test("returns uploaded markdown without modifying the note when replacement is disabled", async () => {
    const note = createFile("post.md");
    const logo = createFile("logo.png", 10, 100);
    const markdown = "![Logo](logo.png)";
    const { contents, vault, app } = createMockApp(markdown, note, [logo]);
    const { client } = fakeUploads({ "logo.png": "/uploads/logo.png" });
    const service = new HaloService(app, createSettings({ replaceImageLinks: false }), site, client);

    const result = await service.uploadImages({ silent: true }, note);

    expect(result).toMatchObject({
      failedCount: 0,
      processedCount: 1,
      replaced: false,
      uploadedCount: 1,
    });
    expect(result.markdown).toBe("![Logo](https://halo.example.com/uploads/logo.png)");
    expect(contents.get(note.path)).toBe(markdown);
    expect(vault.modify).not.toHaveBeenCalled();
  });

  test("reuses a valid local upload cache entry instead of uploading again", async () => {
    const note = createFile("post.md");
    const logo = createFile("logo.png", 10, 100);
    const settings = createSettings({
      imageUploadCache: {
        "https://halo.example.com": {
          "logo.png": {
            filePath: "logo.png",
            mtime: 100,
            permalink: "https://halo.example.com/uploads/cached-logo.png",
            size: 10,
            updatedAt: 123,
          },
        },
      },
    });
    const { app } = createMockApp("![Logo](logo.png)", note, [logo]);
    // 缓存命中 → 一次工具调用都不该发生
    const { client, calls } = createFakeClient(() => {
      throw new Error("cache should prevent uploads");
    });
    const service = new HaloService(app, settings, site, client);

    const result = await service.uploadImages({ silent: true }, note);

    expect(result).toMatchObject({
      failedCount: 0,
      processedCount: 1,
      reusedCount: 1,
      uploadedCount: 0,
    });
    expect(result.markdown).toBe("![Logo](https://halo.example.com/uploads/cached-logo.png)");
    // 原先断言的是没发 HTTP 请求；现在断言的是没调 MCP 工具——缓存命中在新架构下更该守住这一点
    expect(calls).toHaveLength(0);
  });

  test("ignores stale cache entries and refreshes the cache after upload", async () => {
    const note = createFile("post.md");
    const logo = createFile("logo.png", 10, 200);
    const settings = createSettings({
      imageUploadCache: {
        "https://halo.example.com": {
          "logo.png": {
            filePath: "logo.png",
            mtime: 100,
            permalink: "https://halo.example.com/uploads/old-logo.png",
            size: 10,
            updatedAt: 123,
          },
        },
      },
    });
    const { app } = createMockApp("![Logo](logo.png)", note, [logo]);
    const { client, calls } = fakeUploads({ "logo.png": "/uploads/new-logo.png" });
    const service = new HaloService(app, settings, site, client);

    const result = await service.uploadImages({ silent: true }, note);

    // 失效的缓存条目必须真的触发一次上传
    expect(calls.map((call) => call.name)).toEqual(["halo_upload_attachment"]);
    expect(result).toMatchObject({
      failedCount: 0,
      reusedCount: 0,
      uploadedCount: 1,
    });
    expect(result.markdown).toBe("![Logo](https://halo.example.com/uploads/new-logo.png)");
    expect(settings.imageUploadCache["https://halo.example.com"]["logo.png"]).toMatchObject({
      mtime: 200,
      permalink: "https://halo.example.com/uploads/new-logo.png",
      size: 10,
    });
  });

  test("does not write partial markdown when one image upload fails", async () => {
    const note = createFile("post.md");
    const logo = createFile("logo.png", 10, 100);
    const banner = createFile("banner.png", 20, 200);
    const markdown = ["![Logo](logo.png)", "![Banner](banner.png)"].join("\n");
    const { contents, vault, app } = createMockApp(markdown, note, [logo, banner]);
    const consoleError = rs.spyOn(console, "error").mockImplementation(() => undefined);
    // 第二张图（banner.png）的 MCP 上传失败
    const { client } = createFakeClient((name, args) => {
      if (name !== "halo_upload_attachment") {
        throw new Error(`Unexpected tool: ${name}`);
      }

      if (args.filename === "banner.png") {
        throw new Error("upload failed");
      }

      return { permalink: "/uploads/logo.png" };
    });
    const service = new HaloService(app, createSettings(), site, client);

    try {
      const result = await service.uploadImages({ silent: true }, note);

      expect(result).toMatchObject({
        failedCount: 1,
        processedCount: 1,
        replaced: false,
        uploadedCount: 1,
      });
      expect(result.markdown).toBe(
        ["![Logo](https://halo.example.com/uploads/logo.png)", "![Banner](banner.png)"].join("\n"),
      );
      expect(contents.get(note.path)).toBe(markdown);
      expect(vault.modify).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith("Error uploading image:", expect.any(Error));
    } finally {
      consoleError.mockRestore();
    }
  });

  test("超限图片失败时弹出可操作的原因，而不是只报一个数字", async () => {
    const note = createFile("post.md");
    const big = createFile("big.png");
    // 站点没配 PAT + 图片超过 MCP 的 7 MiB 上限：这条路径本地就能判定，不必发任何请求
    const noPatSite = { ...site, token: "" };
    const { app } = createMockApp("![Big](big.png)", note, [big], {
      readBinary: async () => new ArrayBuffer(MCP_UPLOAD_MAX_BYTES + 1),
    });
    const consoleError = rs.spyOn(console, "error").mockImplementation(() => undefined);
    const { client } = createFakeClient(() => ({}));
    const service = new HaloService(app, createSettings(), noPatSite, client);
    const notices = capturedNotices();
    const seen = notices.length;

    try {
      const result = await service.uploadImages({ silent: true }, note);

      expect(result.failedCount).toBe(1);
      // silent 只压常规汇总，「为什么失败」必须说出来 —— 否则用户只看到「1 张失败」，
      // 无从判断是该压缩图片，还是该去站点补一个 PAT
      expect(notices.slice(seen)).toEqual([i18next.t("service.error_image_too_large", { limit: 7, name: "big.png" })]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("上传被 MCP 拒绝时（例如密钥无效）也弹出可操作原因，而不是只进 console", async () => {
    const note = createFile("post.md");
    const image = createFile("a.png");
    const { app } = createMockApp("![A](a.png)", note, [image]);
    const consoleError = rs.spyOn(console, "error").mockImplementation(() => undefined);
    // 升级用户最可能撞上的那条：没填 `mcpToken` → 每张小图都 401。
    // 抛出的是 `McpError`（不是 `ImageUploadError`），正是原先只进 console 的那一类。
    const { client } = createFakeClient(() => {
      throw new McpError("unauthorized", { status: 401 });
    });
    const service = new HaloService(app, createSettings(), site, client);
    const notices = capturedNotices();
    const seen = notices.length;

    try {
      const result = await service.uploadImages({ silent: true }, note);

      expect(result.failedCount).toBe(1);
      // 关键：用户必须看到**为什么**。只报一个数字的话，他无从知道是密钥没填 ——
      // 而 `McpError` 的 key 本就是处置指引（核对密钥 / 为该密钥勾工具授权 / 检查端点）
      expect(notices.slice(seen)).toEqual([i18next.t("transport.error.unauthorized", { status: 401 })]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("file 给在 options 里时作用于那个文件，而不是活动编辑器", async () => {
    // 判别器：把转发改成 `{ ...options, file }`（位置参数优先）这条就红 ——
    // 那正是 `options.file ?? file` 的方向写反时的形态。
    //
    // 为什么非要钉它：批量路径（Task 10）的调用形态是
    // `uploadImages({ file: item.file, silent: true })` —— **只给 options、不给第二个参数**。
    // 方向写反的话，位置参数那个 `undefined` 会盖掉 `item.file` → 静默回落到活动编辑器 →
    // 每一篇的图片都传到当前打开的那篇上。**这是静默的**，批量跑完还会报"成功"。
    const explicit = createFile("notes/other.md");
    const active = createFile("active.md");
    const image = createFile("a.png");
    // 内容挂在 explicit 上：`vault.read` 按 `file.path` 查表，**查不到就返回空串**
    const { app, vault } = createMockApp("![A](a.png)", explicit, [image]);
    const { client } = fakeUploads({ "a.png": "/uploads/a.png" });

    // 活动编辑器指向**另一个**文件：options 里的 file 若被忽略，读到的就是它
    (app.workspace as unknown as { activeEditor: { file: TFile } }).activeEditor = { file: active };

    // `replaceImageLinks` 显式写出来：下面那条 `vault.modify` 断言只在它为真时成立。
    // 靠 `createSettings()` 的隐式默认值的话，将来谁翻转默认值，先红的会是这条
    // **看起来与默认值无关**的用例 —— 排查时会被误判成"无关失败"。
    const service = new HaloService(app, createSettings({ replaceImageLinks: true }), site, client);

    await service.uploadImages({ file: explicit, silent: true });

    expect(vault.read).toHaveBeenCalledWith(explicit);
    expect(vault.read).not.toHaveBeenCalledWith(active);
    // 也钉住**回写**落在同一个文件上：只看 `vault.read` 的话，
    // 一个「读了显式文件、却用活动编辑器回写」的实现照样绿
    expect(vault.modify).toHaveBeenCalledWith(explicit, "![A](https://halo.example.com/uploads/a.png)");
  });

  test("两种给法同时给出时，options 里的 file 优先", async () => {
    // 与上一条配对：把方向反过来（`file ?? options.file`）时这条红。
    // 单篇命令给的是位置参数、批量给的是 options —— 两者同时出现时以 options 为准。
    const fromOptions = createFile("notes/from-options.md");
    const fromArg = createFile("notes/from-arg.md");
    const image = createFile("a.png");
    const { app, vault } = createMockApp("![A](a.png)", fromOptions, [image]);
    const { client } = fakeUploads({ "a.png": "/uploads/a.png" });

    await new HaloService(app, createSettings(), site, client).uploadImages(
      { file: fromOptions, silent: true },
      fromArg,
    );

    expect(vault.read).toHaveBeenCalledWith(fromOptions);
    expect(vault.read).not.toHaveBeenCalledWith(fromArg);
  });

  test("不传 file 时回落到活动编辑器", async () => {
    // 这条钉的是 `options.file ?? ctx.app.workspace.activeEditor?.file` 的**右半边**。
    // 改造前那 9 条既有用例**全部**依赖这条回落（那是它们当时唯一的文件来源），
    // 改造后它们都显式传了文件 —— 于是这半边一度**零覆盖**，而 brief 明确要求
    // 「单篇路径不传 file 时行为一致」。零覆盖的回落分支是最容易在后续重构里被删掉的。
    //
    // ⚠️ 但别把它当成**生产受测路径**：这条回落今天已经**不可达**了 ——
    // `main.ts` 的两处调用点都传显式文件。它在测的是「万一将来有人不传，别退化成什么都不做」。
    const active = createFile("notes/active.md");
    const image = createFile("a.png");
    const { app, vault } = createMockApp("![A](a.png)", active, [image]);
    const { client } = fakeUploads({ "a.png": "/uploads/a.png" });

    const result = await new HaloService(app, createSettings({ replaceImageLinks: true }), site, client).uploadImages({
      silent: true,
    });

    expect(result.processedCount).toBe(1);
    expect(vault.read).toHaveBeenCalledWith(active);
    expect(vault.modify).toHaveBeenCalledWith(active, "![A](https://halo.example.com/uploads/a.png)");
  });
});

describe("HaloService.updatePost", () => {
  beforeEach(() => {
    forbidRest();
  });

  test("restores cached local image links when image link replacement is disabled", async () => {
    const note = createFile("post.md");
    const logo = createFile("images/logo.png", 10, 100);
    const spacedLogo = createFile("images/my logo.png", 20, 200);
    const pastedImage = createFile("Pasted image 20260624125124.png", 40, 400);
    const wikiImage = createFile("images/wiki image.png", 50, 500);
    const staleLogo = createFile("images/stale.png", 30, 300);
    const remoteMarkdown = [
      "![Logo](https://halo.example.com/uploads/logo.png)",
      "![Spaced](https://halo.example.com/uploads/my%20logo.png)",
      "![](https://halo.example.com/upload/Pasted%20image%2020260624125124.png)",
      "![[https://halo.example.com/uploads/wiki%20image.png|Remote Alias]]",
      "![Stale](https://halo.example.com/uploads/stale.png)",
      "![Unknown](https://halo.example.com/uploads/unknown.png)",
    ].join("\n");
    const { app, contents, metadataCache } = createMockApp("local markdown", note, [
      logo,
      spacedLogo,
      pastedImage,
      wikiImage,
      staleLogo,
    ]);
    // 远端正文改由 MCP 的 halo_get_post 提供（原先走 REST 的 draft 快照）
    const { client } = fakeService({ itemFor: () => remoteItem("post-1"), raw: remoteMarkdown });
    const service = new HaloService(
      app,
      createSettings({
        replaceImageLinks: false,
        imageUploadCache: {
          "https://halo.example.com": {
            "images/logo.png": {
              filePath: "images/logo.png",
              linkType: "markdown",
              mtime: 100,
              permalink: "https://halo.example.com/uploads/logo.png",
              size: 10,
              updatedAt: 1,
            },
            "images/my logo.png": {
              filePath: "images/my logo.png",
              linkType: "markdown",
              mtime: 200,
              permalink: "https://halo.example.com/uploads/my logo.png",
              size: 20,
              updatedAt: 2,
            },
            "Pasted image 20260624125124.png": {
              filePath: "Pasted image 20260624125124.png",
              mtime: 400,
              permalink: "https://halo.example.com/upload/Pasted image 20260624125124.png",
              size: 40,
              updatedAt: 3,
            },
            "images/wiki image.png": {
              filePath: "images/wiki image.png",
              linkType: "wiki",
              mtime: 500,
              permalink: "https://halo.example.com/uploads/wiki image.png",
              size: 50,
              updatedAt: 4,
              wikiAlias: "Original Alias",
            },
            "images/stale.png": {
              filePath: "images/stale.png",
              mtime: 999,
              permalink: "https://halo.example.com/uploads/stale.png",
              size: 30,
              updatedAt: 5,
            },
          },
        },
      }),
      site,
      client,
    );

    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: {
        halo: {
          name: "post-1",
          site: site.url,
        },
      },
    }));

    await service.updatePost();

    expect(contents.get(note.path)).toBe(
      [
        "![Logo](images/logo.png)",
        "![Spaced](<images/my logo.png>)",
        "![[Pasted image 20260624125124.png]]",
        "![[images/wiki image.png|Original Alias]]",
        "![Stale](https://halo.example.com/uploads/stale.png)",
        "![Unknown](https://halo.example.com/uploads/unknown.png)",
      ].join("\n"),
    );
  });

  test("keeps remote image links when image link replacement is enabled", async () => {
    const note = createFile("post.md");
    const logo = createFile("images/logo.png", 10, 100);
    const remoteMarkdown = "![Logo](https://halo.example.com/uploads/logo.png)";
    const { app, contents, metadataCache } = createMockApp("local markdown", note, [logo]);
    const { client } = fakeService({ itemFor: () => remoteItem("post-1"), raw: remoteMarkdown });
    const service = new HaloService(
      app,
      createSettings({
        replaceImageLinks: true,
        imageUploadCache: {
          "https://halo.example.com": {
            "images/logo.png": {
              filePath: "images/logo.png",
              mtime: 100,
              permalink: "https://halo.example.com/uploads/logo.png",
              size: 10,
              updatedAt: 1,
            },
          },
        },
      }),
      site,
      client,
    );

    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: {
        halo: {
          name: "post-1",
          site: site.url,
        },
      },
    }));

    await service.updatePost();

    expect(contents.get(note.path)).toBe(remoteMarkdown);
  });

  test("远端读取失败时弹出可自查的提示，且不动本地笔记", async () => {
    const note = createFile("post.md");
    const { app, contents, vault, metadataCache } = createMockApp("local markdown", note, []);
    // 上游把读取失败一律吞成 undefined，于是「网络不通」也被显示成「文章不存在」。
    // 现在 getPost 失败即抛，调用点必须把真实原因带出来。
    const { client } = createFakeClient(() => {
      throw new McpError("network", { context: "MCP handshake" }, "connect ECONNREFUSED");
    });
    const service = new HaloService(app, createSettings(), site, client);

    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { halo: { name: "post-1", site: site.url } },
    }));

    const notices = capturedNotices();
    const seen = notices.length;

    await service.updatePost();

    const raised = notices.slice(seen);
    expect(raised).toHaveLength(1);
    // 这条断言钉的就是「别把网络故障说成文章不存在」
    expect(raised[0]).toContain(i18next.t("transport.error.network"));
    // 服务端原文也要出现，否则用户依然无从自查
    expect(raised[0]).toContain("connect ECONNREFUSED");
    // 与文案无关的判别器：读取失败时本地笔记必须原样不动
    expect(vault.modify).not.toHaveBeenCalled();
    expect(contents.get(note.path)).toBe("local markdown");
  });
});

describe("HaloService.publishPost", () => {
  beforeEach(() => {
    forbidRest();
  });

  test("retries draft update failures before showing publish failure", async () => {
    const note = createFile("post.md");
    const { app, fileManager, metadataCache } = createMockApp("published markdown", note, []);
    let updateAttempts = 0;
    let latestPostFetches = 0;
    // 每次发起写入时远端已被读取过几次。上游那条 version 断言（["1", "2"]）钉的就是这个性质：
    // **重试前先重新拉一次最新 Post**，而不是拿旧对象原样重放。
    const fetchesBeforeAttempt: number[] = [];
    const { client } = fakeService({
      // 计数点从 REST 桩挪到 halo_get_post：读取收口到 MCP 之后，「远端被读了几次」
      // 就是它的调用次数
      itemFor: (name) => {
        latestPostFetches += 1;
        return remoteItem(name);
      },
      onWrite: () => {
        updateAttempts += 1;
        fetchesBeforeAttempt.push(latestPostFetches);

        // 上游让 `PUT .../draft` 的第一次失败。MCP 之后 draft 那一步没有了，但
        // 「重试包住整个发布事务」的语义不变，所以让唯一那次写入的首次调用失败。
        if (updateAttempts === 1) {
          throw new Error("The post draft is locked");
        }
      },
    });
    const service = new HaloService(app, createSettings(), site, client);

    metadataCache.getFileCache.mockImplementation(remoteFrontmatter());

    await service.publishPost(note);

    // 红线：首次失败 + 一次重试成功 ⇒ 恰好 2 次写入，且重试前重新读了远端状态
    expect(updateAttempts).toBe(2);
    expect(fetchesBeforeAttempt).toEqual([1, 2]);
    // 调用方看到的是成功：frontmatter 被回写一次
    expect(fileManager.processFrontMatter).toHaveBeenCalledTimes(1);
  });

  test("exhausts retries then shows publish failure with the server detail", async () => {
    const note = createFile("post.md");
    const { app, fileManager, metadataCache } = createMockApp("published markdown", note, []);
    let updateAttempts = 0;
    const { client } = fakeService({
      onWrite: (tool) => {
        updateAttempts += 1;
        throw new McpError("unknown", { tool }, "The post draft is locked");
      },
    });
    const service = new HaloService(app, createSettings(), site, client);

    metadataCache.getFileCache.mockImplementation(remoteFrontmatter());

    const notices = capturedNotices();
    const seen = notices.length;

    // 退避是 500 + 1000 + 1500 = 3000ms，把时钟快进掉，免得一条用例拖慢整个套件
    rs.useFakeTimers();

    try {
      const pending = service.publishPost(note);
      await rs.advanceTimersByTimeAsync(5_000);
      await pending;
    } finally {
      rs.useRealTimers();
    }

    // 首次 + 3 次重试 = 4 次写入 —— 这就是 PUBLISH_RETRY_COUNT = 3 的确切含义
    expect(updateAttempts).toBe(4);
    expect(fileManager.processFrontMatter).not.toHaveBeenCalled();

    const raised = notices.slice(seen);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toContain(i18next.t("service.error_publish_failed"));
    // 服务端原文必须一起显示，否则用户拿着「发布失败，请重试」无从自查
    expect(raised[0]).toContain("The post draft is locked");
  });

  test("发布状态调用瞬时失败时会被重试，而不是直接报发布失败", async () => {
    const note = createFile("post.md");
    const { app, fileManager, metadataCache } = createMockApp("published markdown", note, []);
    let stateAttempts = 0;
    const { client, calls } = fakeService({
      onPublishState: () => {
        stateAttempts += 1;

        // 只有发布状态这一步抖动，写入全程成功
        if (stateAttempts < 3) {
          throw new McpError("unknown", { tool: "halo_set_post_publish_state" }, "The publish state is locked");
        }
      },
    });
    const service = new HaloService(app, createSettings(), site, client);

    // frontmatter 没有 halo.name（首次走新建分支），但明确 publish: true 以触发发布状态调用
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { halo: { publish: true }, title: "Post title" },
    }));

    const notices = capturedNotices();
    const seen = notices.length;

    // 两次退避 500 + 1000 = 1500ms
    rs.useFakeTimers();

    try {
      const pending = service.publishPost(note);
      await rs.advanceTimersByTimeAsync(5_000);
      await pending;
    } finally {
      rs.useRealTimers();
    }

    expect(stateAttempts).toBe(3);
    // 自愈：首次建文章后 remotePostName 已回填，两次重试都走更新分支 —— 不会再建出第二篇
    expect(calls.filter((call) => call.name === "halo_create_post")).toHaveLength(1);
    expect(calls.filter((call) => call.name === "halo_update_post")).toHaveLength(2);

    // 重试把发布状态那步救回来了，所以只有一条成功提示，没有失败提示
    const raised = notices.slice(seen);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toBe(i18next.t("service.notice_publish_success"));
    expect(raised).not.toContain(i18next.t("service.error_publish_failed"));
    // 与文案无关的判别器：发布真的走完了才会回写 frontmatter（失败分支在那之前就 return 了）
    expect(fileManager.processFrontMatter).toHaveBeenCalledTimes(1);
  });

  test("publishes the provided markdown instead of rereading the local note", async () => {
    const note = createFile("post.md");
    const { app, metadataCache, vault } = createMockApp("local markdown ![Logo](logo.png)", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: {
        title: "Post title",
      },
    }));
    const { client, calls } = fakeService();
    const service = new HaloService(app, createSettings(), site, client);

    const publishedMarkdown = "published markdown ![Logo](https://halo.example.com/uploads/logo.png)";

    await service.publishPost(note, { markdown: publishedMarkdown });

    // 写出去的 `raw` 就是传进来的 markdown，而不是重新读盘拿到的那份
    const create = calls.find((call) => call.name === "halo_create_post");
    expect(create?.args.raw).toBe(publishedMarkdown);
    expect(vault.read).not.toHaveBeenCalled();
  });
});

describe("publishPost 走 MCP", () => {
  beforeEach(() => {
    forbidRest();
  });

  test("新建文章时调 halo_create_post，且 rawType 显式传 markdown", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({ frontmatter: { title: "Post title" } }));
    const { client, calls } = fakeService();
    const service = new HaloService(app, createSettings(), site, client);

    await service.publishPost(note);

    const create = calls.find((call) => call.name === "halo_create_post");
    expect(create).toBeDefined();
    // schema 默认值是 "html"，漏传会把 Markdown 当 HTML 存，站点渲染错乱而本地看不出来
    expect(create?.args.rawType).toBe("markdown");
  });

  test("新建文章不传 content，交给服务端渲染", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({ frontmatter: { title: "Post title" } }));
    const { client, calls } = fakeService();
    const service = new HaloService(app, createSettings(), site, client);

    await service.publishPost(note);

    const create = calls.find((call) => call.name === "halo_create_post");
    // 先钉住调用真的发生了，否则下一行在「压根没调工具」的实现下也会通过（判决力为零）
    expect(create).toBeDefined();
    expect(create?.args.content).toBeUndefined();
  });

  test("publishTime 为空时传 null 或省略，绝不留空字符串", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({ frontmatter: { title: "Post title" } }));
    const { client, calls } = fakeService();
    const service = new HaloService(app, createSettings(), site, client);

    await service.publishPost(note);

    const create = calls.find((call) => call.name === "halo_create_post");
    // 先钉住调用真的发生了，否则下面读一个 undefined 上的字段也会「通过」
    expect(create).toBeDefined();
    const value = create?.args.publishTime;
    // schema 是 ["string","null"] + format: date-time —— 空字符串非法，null 才是「立即发布」
    expect(value === null || value === undefined).toBe(true);
  });

  test("已发布文章走 halo_update_post，而不是再建一篇", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(remoteFrontmatter());
    const { client, calls } = fakeService();
    const service = new HaloService(app, createSettings(), site, client);

    await service.publishPost(note);

    const names = calls.map((call) => call.name);
    expect(names).toContain("halo_update_post");
    expect(names).not.toContain("halo_create_post");
  });

  test("frontmatter 有 publish: true 时调 halo_set_post_publish_state 且 publish 为 true", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { halo: { publish: true }, title: "Post title" },
    }));
    const { client, calls } = fakeService();
    const service = new HaloService(app, createSettings(), site, client);

    await service.publishPost(note);

    const state = calls.find((call) => call.name === "halo_set_post_publish_state");
    expect(state?.args).toEqual({ name: expect.any(String), publish: true });
  });

  test("frontmatter 无 publish 且 publishByDefault 为 false 时不调发布状态工具", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({ frontmatter: { title: "Post title" } }));
    const { client, calls } = fakeService();
    const service = new HaloService(app, createSettings(), site, client);

    await service.publishPost(note);

    // 先钉住发布路径真的跑到了写入那一步：否则「没调状态工具」在「什么都没调」的实现下同样成立
    expect(calls.map((call) => call.name)).toContain("halo_create_post");
    expect(calls.some((call) => call.name === "halo_set_post_publish_state")).toBe(false);
  });

  test("frontmatter 显式 publish: false 时退回草稿，不被 publishByDefault 翻盘", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { halo: { publish: false }, title: "Post title" },
    }));
    const { client, calls } = fakeService();
    // publishByDefault 为 true 也不能覆盖显式的 false —— 「写了就听它的，没写才看默认值」
    const service = new HaloService(app, createSettings({ publishByDefault: true }), site, client);

    await service.publishPost(note);

    const state = calls.find((call) => call.name === "halo_set_post_publish_state");
    expect(state?.args).toEqual({ name: expect.any(String), publish: false });
  });

  test("frontmatter 无 publish 且 publishByDefault 为 true 时发布", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({ frontmatter: { title: "Post title" } }));
    const { client, calls } = fakeService();
    const service = new HaloService(app, createSettings({ publishByDefault: true }), site, client);

    await service.publishPost(note);

    const state = calls.find((call) => call.name === "halo_set_post_publish_state");
    expect(state?.args).toEqual({ name: expect.any(String), publish: true });
  });

  test("写工具返回扁平对象时，frontmatter 回写仍拿到正确的 name 与 title", async () => {
    const note = createFile("post.md");
    const { app, fileManager, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({ frontmatter: { title: "Post title" } }));

    // 写路径不**需要**响应负载（写与读解耦），所以返回什么形状都不该被消费 —— 服务层走 callToolVoid。
    // 这里让写工具回一个与远端真值**矛盾**的扁平对象：回写若取了它，title 会变成 "WRONG TITLE"。
    // 判别力就来自这个矛盾 —— 名称取自随后那次 halo_get_post，而不是写入的返回体。
    let fetchedName = "";
    const { client, calls } = fakeService({
      writeResult: { categories: [], name: "WRONG", slug: "wrong", tags: [], title: "WRONG TITLE" },
      itemFor: (name) => {
        fetchedName = name;
        return remoteItem(name);
      },
    });

    let written: Record<string, unknown> | undefined;
    fileManager.processFrontMatter.mockImplementation(
      (_file: unknown, callback: (frontmatter: Record<string, unknown>) => void) => {
        written = {};
        callback(written);
      },
    );

    const service = new HaloService(app, createSettings(), site, client);

    // 建文章成功后重试退避会跑满（RED 状态下闭包直接抛错），快进掉
    rs.useFakeTimers();

    try {
      const pending = service.publishPost(note);
      await rs.advanceTimersByTimeAsync(5_000);
      await pending;
    } finally {
      rs.useRealTimers();
    }

    const createdName = calls.find((call) => call.name === "halo_create_post")?.args.name;
    // 先确认建文章确实发生且带上了 name —— 否则下面的断言在「压根没调工具」的实现下也会通过
    expect(createdName).toEqual(expect.any(String));
    expect(createdName).not.toEqual("");

    // 关键断言：本地笔记里的 title 与 halo.name 都必须是真值
    expect(written?.title).toBe("Post title");
    expect((written?.halo as { name?: string } | undefined)?.name).toEqual(createdName);

    // 支撑断言：回写用的 name 就是建文章时传出去的那个（而不是被扁平响应体冲成 undefined）
    expect(fetchedName).toEqual(createdName);
  });

  test("写工具返回非 JSON 确认文案时，发布仍然成功且 frontmatter 正常回写", async () => {
    const note = createFile("post.md");
    const { app, fileManager, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { halo: { publish: true }, title: "Post title" },
    }));

    // 写路径不**需要**响应负载（写与读解耦），「回一句人读确认文案」是合理形态。
    // 若写路径走 callToolJson（它要求返回体是可解析的 JSON 负载），这里会在
    // **服务端已经写成功之后**抛错 —— 触发整事务重试、用户看到「发布失败」。
    const { client, calls } = fakeService({ writeResult: "Created post" });

    let written: Record<string, unknown> | undefined;
    fileManager.processFrontMatter.mockImplementation(
      (_file: unknown, callback: (frontmatter: Record<string, unknown>) => void) => {
        written = {};
        callback(written);
      },
    );

    const service = new HaloService(app, createSettings(), site, client);
    const notices = capturedNotices();
    const seen = notices.length;

    await service.publishPost(note);

    expect(notices.slice(seen)).not.toContain(i18next.t("service.error_publish_failed"));

    // 两个写工具都走了「不解析返回体」的入口
    const writeCalls = calls.filter(
      (call) => call.name === "halo_create_post" || call.name === "halo_set_post_publish_state",
    );
    expect(writeCalls.map((call) => call.name)).toEqual(["halo_create_post", "halo_set_post_publish_state"]);
    expect(writeCalls.map((call) => call.method)).toEqual(["callToolVoid", "callToolVoid"]);

    // frontmatter 正常回写
    expect(written?.title).toBe("Post title");
    expect(written?.slug).toBe("post-title");
    expect((written?.halo as { name?: string } | undefined)?.name).toEqual(expect.any(String));
  });

  test("frontmatter 的 halo.visible 被送进写工具的参数", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    let writtenArgs: Record<string, unknown> | undefined;
    const { client } = fakeService({
      onWrite: (_name, args) => {
        writtenArgs = args;
      },
    });
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { visible: "INTERNAL" } },
    }));

    await new HaloService(app, createSettings(), site, client).publishPost(note);

    expect(writtenArgs?.visible).toBe("INTERNAL");
  });

  test("显式 false 不被默认值翻盘：halo.allowComment: false 送出 allowComment: false", async () => {
    // 为什么是 allowComment 而不是 pinned：五个「有意义的假值」字段里，**只有它的默认值与它相反**
    //（`publishPost` 的 params 字面量给的是 `allowComment: true`），所以它是唯一既能守住
    //「显式假值不被默认值翻盘」的原意、又**同时**能判别接线的一条。
    //
    // `pinned: false` / `priority: 0` / `template: ""` 三条的默认值恰与断言值相同，
    // 接线在不在都绿 —— 拿它们做端到端判别器等于放一条空洞测试在这儿（本轮修复前正是如此）。
    // 那三条的语义已由 `tests/frontmatter-map.test.ts` 的表驱动用例在**单元层**守住，
    // 端到端这一层只需要管接线。
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    let writtenArgs: Record<string, unknown> | undefined;
    const { client } = fakeService({
      onWrite: (_name, args) => {
        writtenArgs = args;
      },
    });
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { allowComment: false } },
    }));

    await new HaloService(app, createSettings(), site, client).publishPost(note);

    expect(writtenArgs?.allowComment).toBe(false);
  });

  test("更新分支同样消费 halo.* 字段", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    let writtenArgs: Record<string, unknown> | undefined;
    const { client, calls } = fakeService({
      onWrite: (_name, args) => {
        writtenArgs = args;
      },
    });
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { name: "post-1", priority: 9 } },
    }));

    await new HaloService(app, createSettings(), site, client).publishPost(note);

    // 走的是更新分支（有 halo.name），参数走 halo_update_post
    expect(calls.some((call) => call.name === "halo_update_post")).toBe(true);
    expect(writtenArgs?.priority).toBe(9);
  });

  test("halo.publishTime 有值时原样送进写工具的参数", async () => {
    // 这里**不能**拿空串做判别器：空串既是 params 字面量的默认值，又经 `toUpdateArgs` 的
    // `|| null` 与「压根没写」收敛到同一个 `null` —— 接线在不在都绿，结构上不可能判别接线。
    // 换成一个真实时间才判别得了：默认值是 `""`，这条会送出一个非空字符串。
    // 「空串 → null」那个映射另有特征化用例，见下一条。
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    let writtenArgs: Record<string, unknown> | undefined;
    const { client } = fakeService({
      onWrite: (_name, args) => {
        writtenArgs = args;
      },
    });
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { publishTime: "2026-10-06 10:00" } },
    }));

    await new HaloService(app, createSettings(), site, client).publishPost(note);

    expect(writtenArgs?.publishTime).toBe("2026-10-06 10:00");
  });

  test("特征化：halo.publishTime 为空串时送 null，不是空字符串", async () => {
    // 特征化测试，钉的是**既有契约**而非本次接线：schema 是 ["string","null"] +
    // format: date-time，空字符串会被服务端拒绝，所以 `toUpdateArgs` 用 `|| null` 折成 null。
    //
    // ⚠️ 它**无法**判别接线 —— 空串与 params 字面量默认值相同，且两条路径都收敛到 `null`，
    // 把 `haloFields` 从调用点删掉这条照样绿。要判别接线请看上面那条非空串的用例。
    // 留着它是因为「用户写的空串不会被原样送出去」这件事值得有断言钉住。
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    let writtenArgs: Record<string, unknown> | undefined;
    const { client } = fakeService({
      onWrite: (_name, args) => {
        writtenArgs = args;
      },
    });
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { publishTime: "" } },
    }));

    await new HaloService(app, createSettings(), site, client).publishPost(note);

    expect(writtenArgs?.publishTime).toBeNull();
  });

  test("halo.visible 非法时**中止发布**，一个写工具都不调，并报出具体原因", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    const { client, calls } = fakeService();
    const notices = capturedNotices();
    const seen = notices.length;
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { visible: "public" } },
    }));

    await new HaloService(app, createSettings(), site, client).publishPost(note);

    // 一个 MCP 工具都不该被调到 —— 校验必须发生在分类/标签解析（会真的建分类）之前。
    //
    // ⚠️ 这一条守的是**顺序**，不是接线：把 `haloFields` 从两个 `applyPostFrontmatter`
    // 调用点上删掉，它照样绿（校验那一步独立于 `haloFields` 的消费点）。
    // 别把它的绿读成「接线没坏」—— 那是上面 `visible` / `allowComment` / `publishTime` /
    // `priority` 那几条的职责。
    expect(calls).toEqual([]);
    expect(notices.slice(seen)).toHaveLength(1);
    expect(notices[seen]).toContain("public");
  });

  test("回写 halo.publishTime 用的是服务端归一化后的值，不是本地送出去的那个", async () => {
    // 判别器：把回写改成从 `matterData.halo.publishTime` 取值就会红。
    // 本地送的是 "2026-10-06 10:00"（服务端会归一成带时区的形式），
    // 若回写用了本地值，笔记里留下的是一个服务端并不认可原样的字符串 —— 下次发布再送一遍，
    // 而用户在站点前台看到的时间与笔记里写的不一致。
    const note = createFile("posts/post.md");
    const { app, fileManager, metadataCache } = createMockApp("local markdown", note, []);
    const { client } = fakeService({
      // 服务端归一化后的形态与本地写的不同
      itemFor: (name) => remoteItem(name, { publishTime: "2026-10-06T10:00:00.000Z" }),
    });
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { name: "post-1", publishTime: "2026-10-06 10:00" } },
    }));

    let written: Record<string, unknown> | undefined;
    fileManager.processFrontMatter.mockImplementation(
      (_file: unknown, callback: (frontmatter: Record<string, unknown>) => void) => {
        written = {};
        callback(written);
      },
    );

    await new HaloService(app, createSettings(), site, client).publishPost(note);

    expect((written?.halo as { publishTime?: string } | undefined)?.publishTime).toBe("2026-10-06T10:00:00.000Z");
  });

  test("publishPost 作用于显式传入的那个文件，而不是活动编辑器", async () => {
    // 判别器：把实现改成 `this.app.workspace.activeEditor?.file ?? file`，这条就红。
    //
    // 为什么必须让**正文内容**成为判别力所在：本文件的 mock 里 `processFrontMatter` **忽略
    // file 参数**（见 `tests/helpers/obsidian-mocks.ts`），所以任何 frontmatter 断言对
    // 「用了哪个文件」都是零判别力。唯一能作证的是「读出来的正文」—— 内容挂在显式文件上，
    // 写工具的 `raw` 就必须带着它。
    //
    // 这条契约在本计划里**没有第二个见证**：Task 10 的批量循环调的正是 `publishPost(item.file, …)`，
    // 而 Task 10 自己的测试把 `HaloService` 整个 stub 掉了，永远走不到这一层。
    // 其余 29 处调用点的 `createMockApp` activeFile **恰好就是**传进去的那个文件，
    // 所以「改成读活动编辑器」的错实现在它们那里全都是绿的 —— 这条是唯一的拦路者。
    const explicit = createFile("notes/other.md");
    const active = createFile("notes/active.md");
    const { app, metadataCache } = createMockApp("hello world", explicit, []);
    const { client, calls } = fakeService();
    metadataCache.getFileCache.mockImplementation(() => ({ frontmatter: { title: "Post title" } }));

    // 活动编辑器指向**另一个**文件：显式 file 若被忽略，读到的就是它（内容是空串）
    (app.workspace as unknown as { activeEditor: { file: TFile } }).activeEditor = { file: active };

    await new HaloService(app, createSettings(), site, client).publishPost(explicit);

    // 先钉住写入真的发生了 —— 否则下面的断言在「压根没调工具」的实现下也会通过
    const create = calls.find((call) => call.name === "halo_create_post");
    expect(create).toBeDefined();
    expect(create?.args.raw).toBe("hello world");
  });
});

describe("changePostPublish 走 MCP", () => {
  beforeEach(() => {
    forbidRest();
  });

  test("publish 为 false 时调 halo_set_post_publish_state 并传 publish: false", async () => {
    const note = createFile("post.md");
    const { app } = createMockApp("", note, []);
    const { client, calls } = fakeService();
    const service = new HaloService(app, createSettings(), site, client);

    await service.changePostPublish("abc", false);

    // 整体 toEqual 而不是取末元素：顺带钉住「没有多余的调用」，以及走的是不解析返回体的入口
    expect(calls).toEqual([
      { args: { name: "abc", publish: false }, method: "callToolVoid", name: "halo_set_post_publish_state" },
    ]);
  });
});

describe("getPost 走 MCP", () => {
  beforeEach(() => {
    forbidRest();
  });

  test("一次取回元数据与正文：扁平字段被还原成嵌套结构", async () => {
    const note = createFile("post.md");
    const { app } = createMockApp("", note, []);
    const { client, calls } = fakeService({
      itemFor: () => remoteItem("post-1", { categories: ["category-a"], title: "标题" }),
      raw: "# 正文",
    });
    const service = new HaloService(app, createSettings(), site, client);

    const result = await service.getPost("post-1");

    expect(result.post.metadata.name).toBe("post-1");
    expect(result.post.spec.title).toBe("标题");
    expect(result.post.spec.categories).toEqual(["category-a"]);
    expect(result.content.raw).toBe("# 正文");
    expect(result.content.rawType).toBe("markdown");

    // 参数必须钉住：HEAD 才是可编辑的最新快照（RELEASE 是已发布版本），RAW 才是原文
    expect(calls).toEqual([
      { args: { format: "RAW", name: "post-1", version: "HEAD" }, method: "callToolJson", name: "halo_get_post" },
    ]);
  });

  test("服务端截断正文时拒绝返回，绝不把残缺正文当文章", async () => {
    const note = createFile("post.md");
    const { app } = createMockApp("", note, []);
    const { client } = createFakeClient((name) => {
      if (name !== "halo_get_post") {
        throw new Error(`Unexpected tool: ${name}`);
      }

      return { content: { raw: "前一半…", rawType: "markdown" }, item: remoteItem("post-1"), truncated: true };
    });
    const service = new HaloService(app, createSettings(), site, client);

    // 截断的正文一旦写进本地文件就是静默损坏用户的笔记，必须抛，而不是「尽量给一份」
    // 断言 detail 而不是 message：McpError 的 message 是 i18n 键，具体线索在 detail 里
    const error = await service.getPost("post-1").then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).detail).toBe("content truncated: post-1");
  });
});

describe("HaloService.pullPost", () => {
  beforeEach(() => {
    forbidRest();
  });

  test("用远端正文建本地笔记，并回写 frontmatter（含分类显示名）", async () => {
    const note = createFile("post.md");
    const { app, fileManager, vault } = createMockApp("", note, []);
    const { client } = fakeService({
      categories: [{ name: "category-a", displayName: "技术思考" }],
      itemFor: () => remoteItem("post-1", { categories: ["category-a"], title: "标题" }),
      raw: "# 远端正文",
    });

    let written: Record<string, unknown> | undefined;
    fileManager.processFrontMatter.mockImplementation(
      (_file: unknown, callback: (frontmatter: Record<string, unknown>) => void) => {
        written = {};
        callback(written);
      },
    );

    const service = new HaloService(app, createSettings(), site, client);

    await service.pullPost("post-1");

    expect(vault.create).toHaveBeenCalledWith("标题.md", "# 远端正文");
    expect(written?.title).toBe("标题");
    // 显示名来自扁平的 displayName（REST 那边是 spec.displayName）
    expect(written?.categories).toEqual(["技术思考"]);
    expect((written?.halo as { name?: string } | undefined)?.name).toBe("post-1");
  });

  test("读取失败时不建文件，只弹一条带原因的提示", async () => {
    const note = createFile("post.md");
    const { app, vault } = createMockApp("", note, []);
    const { client } = createFakeClient(() => {
      throw new McpError("forbidden", { status: 403 });
    });
    const service = new HaloService(app, createSettings(), site, client);

    const notices = capturedNotices();
    const seen = notices.length;

    await service.pullPost("post-1");

    const raised = notices.slice(seen);
    expect(raised).toHaveLength(1);
    // 403 被说成「文章不存在」的话，用户会去站点上反复找那篇文章
    expect(raised[0]).toContain(i18next.t("transport.error.forbidden"));
    // 与文案无关的判别器：失败时绝不能在库里留下一个空文件
    expect(vault.create).not.toHaveBeenCalled();
  });

  test("服务端返回的 item 没带 name 时，halo.name 仍写成请求时用的那个 name", async () => {
    // 判别器：把 pullPost 里那个 `name,` 换成 `name: post.post.metadata.name`
    // （一个看起来更"整洁"的写法）就会红 —— 而既有那条用例**不会**红：它的 fixture 里
    // item 是带着 name 的，两种写法结果相同。
    // 红掉之后的表现才是重点：halo.name 变成 ""，下次发布读不到它，于是**再建一篇重复文章**，
    // 而用户两次都看到「发布成功」。
    const note = createFile("post.md");
    const { app, fileManager } = createMockApp("", note, []);
    const { client } = createFakeClient((name) => {
      if (name !== "halo_get_post") {
        throw new Error(`Unexpected tool: ${name}`);
      }

      // `remoteItem` 的 overrides 是展开覆盖，传 `undefined` 就能真的把 name 抹掉。
      // 这不是人为构造：`halo_get_post` 的 outputSchema 里 name **不是** required 字段。
      return { item: remoteItem("placeholder", { name: undefined }), content: { raw: "" } };
    });

    let written: Record<string, unknown> | undefined;
    fileManager.processFrontMatter.mockImplementation(
      (_file: unknown, callback: (frontmatter: Record<string, unknown>) => void) => {
        written = {};
        callback(written);
      },
    );

    await new HaloService(app, createSettings(), site, client).pullPost("post-1");

    expect((written?.halo as { name?: string } | undefined)?.name).toBe("post-1");
  });
});

describe("发布成功后的回读", () => {
  beforeEach(() => {
    forbidRest();
  });

  test("回读失败不会被报成「发布失败」，frontmatter 仍用本地 params 回写", async () => {
    const note = createFile("post.md");
    const { app, fileManager, metadataCache } = createMockApp("hello world", note, []);
    // 本次**明确要求发布**（frontmatter 写了 `halo.publish: true`）—— 下面那条断言要钉的正是
    // 「回读失败时写回的 publish 是不是这个意图」，没有意图就无从判别。
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { publish: true } },
    }));

    let writeDone = false;
    const publishStates: Record<string, unknown>[] = [];
    const { client, calls } = fakeService({
      onWrite: () => {
        writeDone = true;
      },
      onPublishState: (args) => {
        publishStates.push(args);
      },
      // 新建分支只在**写成功之后**回读一次。让它在那之后失败，
      // 模拟的就是「文章已经落库、回读时网络抖了一下」。
      itemFor: (name) => {
        if (writeDone) {
          throw new McpError("network", { context: "tools/call halo_get_post" }, "socket hang up");
        }

        return remoteItem(name);
      },
    });

    let written: Record<string, unknown> | undefined;
    fileManager.processFrontMatter.mockImplementation(
      (_file: unknown, callback: (frontmatter: Record<string, unknown>) => void) => {
        written = {};
        callback(written);
      },
    );

    const service = new HaloService(app, createSettings(), site, client);
    const notices = capturedNotices();
    const seen = notices.length;

    await service.publishPost(note);

    // 写已经落库，用户必须看到成功 —— 报失败会让他重发一遍
    expect(notices.slice(seen)).toEqual([i18next.t("service.notice_publish_success")]);

    // 前提：本次确实要求了发布。上面那条断言要靠它才有意义
    expect(publishStates).toEqual([{ name: expect.any(String), publish: true }]);

    // 回读失败只是少了服务端归一化，frontmatter 仍要用本地 params 回写（不能整个跳过）
    const createdName = calls.find((call) => call.name === "halo_create_post")?.args.name;
    expect(createdName).toEqual(expect.any(String));
    expect(written?.title).toBe("Post title");
    expect((written?.halo as { name?: string } | undefined)?.name).toEqual(createdName);

    // 而 `publish` **不能**沿用本地 params 里那个陈旧值：新建分支的 params 来自字面量，
    // `spec.publish` 恒为 false（`applyPostFrontmatter` 不碰它）。把它写进 frontmatter 后，
    // **下一次**发布会读到 `halo.publish: false` → `changePostPublish(name, false)` →
    // 把这篇已发布的文章**静默退回草稿**，而用户再次看到「发布成功」。
    expect((written?.halo as { publish?: boolean } | undefined)?.publish).toBe(true);
  });

  test("更新已发布文章时回读失败：publish 取本次意图，而不是改状态之前的服务端值", async () => {
    const note = createFile("post.md");
    const { app, fileManager, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { name: "post-1", publish: true } },
    }));

    let writeDone = false;
    const { client } = fakeService({
      onWrite: () => {
        writeDone = true;
      },
      // 更新分支的 params 来自 `getPost` → `toPost`，其 `publish` 取 `publishRequested` ——
      // 而那是**改发布状态之前**的服务端值。这里刻意让它为 false，正是陈旧值的来源。
      itemFor: (name) => {
        if (writeDone) {
          throw new McpError("network", { context: "tools/call halo_get_post" }, "socket hang up");
        }

        return remoteItem(name, { publishRequested: false, published: false });
      },
    });

    let written: Record<string, unknown> | undefined;
    fileManager.processFrontMatter.mockImplementation(
      (_file: unknown, callback: (frontmatter: Record<string, unknown>) => void) => {
        written = {};
        callback(written);
      },
    );

    const service = new HaloService(app, createSettings(), site, client);

    await service.publishPost(note);

    // 两条分支的陈旧值来源不同（新建＝本地字面量，更新＝服务端改状态前的值），
    // 但都必须被本次意图覆盖 —— 否则下一次发布会把文章退回草稿
    expect((written?.halo as { publish?: boolean } | undefined)?.publish).toBe(true);
  });

  test("写后读失败时，分类/标签字段保持用户原值，不被 metadata name 覆盖", async () => {
    const note = createFile("post.md");
    const { app, fileManager, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { categories: ["技术思考"], tags: ["Rust"], title: "Post title" },
    }));

    let writeDone = false;
    const { client, calls } = createFakeClient((name, args) => {
      // 写之前那两次列举必须成功（否则发布根本不会开始），写之后那两次才失败 ——
      // 这正是「文章已经写进 Halo 了，只是收尾读时又网络抖了一下」。
      if (writeDone && (name === "halo_list_categories" || name === "halo_list_tags")) {
        throw new McpError("network", { context: `tools/call ${name}` }, "socket hang up");
      }

      switch (name) {
        case "halo_list_categories":
        case "halo_list_tags":
          return { items: [] };
        case "halo_create_category":
          return { name: "category-new" };
        case "halo_create_tag":
          return { name: "tag-new" };
        case "halo_create_post":
          writeDone = true;
          return {};
        case "halo_get_post":
          return getPostResult(remoteItem(String(args.name), { categories: ["category-new"], tags: ["tag-new"] }), "");
        default:
          throw new Error(`Unexpected tool: ${name}`);
      }
    });

    let written: Record<string, unknown> | undefined;
    fileManager.processFrontMatter.mockImplementation(
      (_file: unknown, callback: (frontmatter: Record<string, unknown>) => void) => {
        // 模拟真实的 processFrontMatter：回调拿到的是**笔记里已有的** frontmatter，
        // 没被赋值的键保持原样（title 特意给一个旧值，这样「标题被回写」才验得出来）
        written = { categories: ["技术思考"], tags: ["Rust"], title: "旧标题" };
        callback(written);
      },
    );

    const service = new HaloService(app, createSettings(), site, client);
    const notices = capturedNotices();
    const seen = notices.length;

    await service.publishPost(note);

    // 写已经落库 —— 收尾读失败既不能被报成「发布失败」，更不能把异常放出去：
    // 放出去的话 Obsidian 只把它记进控制台，用户什么都看不到，frontmatter 也不会回写。
    expect(notices.slice(seen)).toEqual([i18next.t("service.notice_publish_success")]);

    const createdName = calls.find((call) => call.name === "halo_create_post")?.args.name;
    expect(createdName).toEqual(expect.any(String));
    // 其余字段照常回写 —— 证明整次回写没有被跳过
    expect(written?.title).toBe("Post title");
    expect((written?.halo as { name?: string } | undefined)?.name).toEqual(createdName);

    // 这两个字段保持笔记里的**显示名**：解析不出显示名时干脆不写。
    // 落回 metadata.name（category-new / tag-new）会更糟 —— `getCategoryNames` 只按
    // displayName 精确匹配，下次发布会把它当成新的显示名去找、找不到就建到站点上，
    // 正是 CLAUDE.md 警告的「垃圾标签永久留存」。
    expect(written?.categories).toEqual(["技术思考"]);
    expect(written?.tags).toEqual(["Rust"]);
  });
});

describe("分类与标签走 MCP", () => {
  beforeEach(() => {
    forbidRest();
  });

  test("getCategories / getTags 读扁平的 name 与 displayName，并按 schema 上限取一页", async () => {
    const note = createFile("post.md");
    const { app } = createMockApp("", note, []);
    const { client, calls } = fakeService({
      categories: [{ displayName: "技术思考", name: "category-a" }],
      tags: [{ displayName: "Rust", name: "tag-a" }],
    });
    const service = new HaloService(app, createSettings(), site, client);

    expect(await service.getCategories()).toEqual([{ displayName: "技术思考", name: "category-a" }]);
    expect(await service.getTags()).toEqual([{ displayName: "Rust", name: "tag-a" }]);

    // 100 是 schema 的 maximum：钉住它，将来 schema 变了或有人改成翻页时能看见
    expect(calls).toEqual([
      { args: { size: 100 }, method: "callToolJson", name: "halo_list_categories" },
      { args: { size: 100 }, method: "callToolJson", name: "halo_list_tags" },
    ]);
  });

  test("返回体缺 items 时回落成空数组，不抛错", async () => {
    const note = createFile("post.md");
    const { app } = createMockApp("", note, []);
    const { client } = createFakeClient(() => ({}));
    const service = new HaloService(app, createSettings(), site, client);

    expect(await service.getCategories()).toEqual([]);
    expect(await service.getTags()).toEqual([]);
  });

  test("显示名已存在时按 displayName 命中现有 name，不重复创建，且保持入参顺序", async () => {
    const note = createFile("post.md");
    const { app } = createMockApp("", note, []);
    const { client, calls } = fakeService({
      categories: [
        { displayName: "技术思考", name: "category-a" },
        { displayName: "协会进行时", name: "category-b" },
      ],
    });
    const service = new HaloService(app, createSettings(), site, client);

    // 顺序跟着入参走：上游会重排成「已存在在前、新建在后」，那会丢掉与入参的对应关系
    expect(await service.getCategoryNames(["协会进行时", "技术思考"])).toEqual(["category-b", "category-a"]);
    expect(calls.some((call) => call.name === "halo_create_category")).toBe(false);
  });

  test("分类不存在时本地生成 name 再创建，slug 走拼音", async () => {
    const note = createFile("post.md");
    const { app } = createMockApp("", note, []);
    const created: Record<string, unknown>[] = [];
    const { client } = fakeService({
      categories: [{ displayName: "技术思考", name: "category-a" }],
      onCreateCategory: (args) => {
        created.push(args);
        return "category-new";
      },
    });
    const service = new HaloService(app, createSettings(), site, client);

    expect(await service.getCategoryNames(["新分类"])).toEqual(["category-new"]);

    expect(created).toHaveLength(1);
    // REST 的 metadata.generateName 在 MCP 没有等价物，name 改由客户端生成 ——
    // 形态必须与站点现存数据（category-sc9pomuo）一致，否则一眼就能看出是外来货
    expect(created[0].name).toMatch(/^category-[a-z0-9]{8}$/);
    expect(created[0].displayName).toBe("新分类");
    expect(created[0].slug).toBe("xin-fen-lei");
    // priority 接着现有分类数排（现有 1 个）
    expect(created[0].priority).toBe(1);
  });

  test("标签同构：走 halo_create_tag，且不带 priority（schema 里没有这个字段）", async () => {
    const note = createFile("post.md");
    const { app } = createMockApp("", note, []);
    const created: Record<string, unknown>[] = [];
    const { client } = fakeService({
      onCreateTag: (args) => {
        created.push(args);
        return "tag-new";
      },
      tags: [{ displayName: "Rust", name: "tag-a" }],
    });
    const service = new HaloService(app, createSettings(), site, client);

    expect(await service.getTagNames(["Rust", "学习笔记"])).toEqual(["tag-a", "tag-new"]);

    expect(created).toHaveLength(1);
    expect(created[0]).toEqual({
      displayName: "学习笔记",
      name: expect.stringMatching(/^tag-[a-z0-9]{8}$/),
      slug: "xue-xi-bi-ji",
    });
  });

  test("创建分类但服务端没回 name 时弹出提示，而不是静默丢掉这一项", async () => {
    const note = createFile("post.md");
    const { app } = createMockApp("", note, []);
    // `halo_create_category` 的 outputSchema.required 只有 ["hideFromList"] —— 不回 name 是契约允许的
    const { client } = fakeService({ onCreateCategory: () => undefined });
    const service = new HaloService(app, createSettings(), site, client);
    const notices = capturedNotices();
    const seen = notices.length;

    expect(await service.getCategoryNames(["新分类"])).toEqual([]);

    // 静默丢掉的话：文章少一个分类，尾部的回写还会把 frontmatter 里的分类名一并抹掉，
    // 而用户看到的是「发布成功」
    expect(notices.slice(seen)).toEqual([i18next.t("service.error_term_not_applied", { name: "新分类" })]);
  });

  test("创建标签但服务端没回 name 时同样弹出提示（同构的那一份也不能漏）", async () => {
    const note = createFile("post.md");
    const { app } = createMockApp("", note, []);
    const { client } = fakeService({ onCreateTag: () => undefined });
    const service = new HaloService(app, createSettings(), site, client);
    const notices = capturedNotices();
    const seen = notices.length;

    expect(await service.getTagNames(["学习笔记"])).toEqual([]);
    expect(notices.slice(seen)).toEqual([i18next.t("service.error_term_not_applied", { name: "学习笔记" })]);
  });

  test("getCategoryDisplayNames / getTagDisplayNames 读扁平的 displayName，未知 name 直接丢掉", async () => {
    const note = createFile("post.md");
    const { app } = createMockApp("", note, []);
    const { client } = fakeService({
      categories: [{ displayName: "技术思考", name: "category-a" }],
      tags: [{ displayName: "Rust", name: "tag-a" }],
    });
    const service = new HaloService(app, createSettings(), site, client);

    expect(await service.getCategoryDisplayNames(["category-a", "category-missing"])).toEqual(["技术思考"]);
    expect(await service.getTagDisplayNames(["tag-a"])).toEqual(["Rust"]);
    // 入参缺席（frontmatter 没写 categories / tags）时给 undefined，不是空数组
    expect(await service.getCategoryDisplayNames(undefined)).toBeUndefined();
  });
});

/**
 * 三处「分类/标签解析失败 = 静默什么都不发生」的收口。
 *
 * 立意与 `describe("发布成功后的回读")` 相同：失败要看得见。区别在于**主目的有没有达成**——
 * 发布那处主目的（文章落库）已完成，故尾部读失败只跳过两个字段、不额外弹提示；
 * 这三处主目的（中止发布 / 更新笔记 / 拉取笔记）尚未达成或只达成一半，故必须让用户知道。
 *
 * 判别器都刻意让两种可能产生**不同的观测**：要么断言「写工具一次都没调用」（真中止了），
 * 要么断言「这两个字段没变**且**其余字段已写」（部分成功，而不是整体跳过）。
 * 异常一律用 `.catch()` 收回，由断言而不是一个裸 rejection 来说明问题。
 */
describe("分类/标签解析失败时的三处收口", () => {
  beforeEach(() => {
    forbidRest();
  });

  test("发布前解析失败：弹提示并中止，两个写工具一次都没调用", async () => {
    const note = createFile("post.md");
    const { app, fileManager, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { categories: ["技术思考"], title: "Post title" },
    }));

    // 分类的列举发生在**写入之前**，此时站点上还什么都没有
    const { client, calls } = createFakeClient(() => {
      throw new McpError("forbidden", { status: 403 });
    });

    const service = new HaloService(app, createSettings(), site, client);
    const notices = capturedNotices();
    const seen = notices.length;

    const result = await service.publishPost(note).catch((error: unknown) => error);

    // 异常不再穿出 —— 穿出去的话 Obsidian 只把它记进控制台，用户什么都看不到。
    //
    // ⚠️ 这条原先断言的是 `undefined`（返回值是 `Promise<void>` 时的「没抛异常」代理）。
    // 返回值改成 `PublishResult` 之后，同一个性质由**这一条**继续钉住：真抛了的话 `result`
    // 会是那个 Error，`toEqual` 立刻红。所以它没有变松，反而顺带钉住了「原因从返回值交出来」。
    expect(result).toEqual({ ok: false, reason: i18next.t("transport.error.forbidden", { status: 403 }) });
    // 且不是「提示了但照写不误」：两个写工具一次都没被调用，frontmatter 也没动
    expect(calls.filter((call) => call.name === "halo_create_post" || call.name === "halo_update_post")).toEqual([]);
    expect(fileManager.processFrontMatter).not.toHaveBeenCalled();
    // 用户看得见真实原因（这里是权限，不是泛泛的「发布失败」）——
    // 与上面那条合起来，「便签」与「返回值」两条通道说的是同一件事
    expect(notices.slice(seen)).toEqual([i18next.t("transport.error.forbidden", { status: 403 })]);
  });

  test("updatePost 解析失败：分类/标签保持笔记原值，其余 frontmatter 照常回写", async () => {
    const note = createFile("post.md");
    const { app, fileManager, metadataCache } = createMockApp("local markdown", note, []);
    metadataCache.getFileCache.mockImplementation(remoteFrontmatter());

    const { client } = createFakeClient((name) => {
      if (name === "halo_get_post") {
        return getPostResult(remoteItem("post-1", { categories: ["category-a"], tags: ["tag-a"] }), "# 远端正文");
      }

      // 文章读到了，但分类/标签的列举失败 —— 例如这个密钥没被勾选这两个工具的权限
      throw new McpError("forbidden", { status: 403 });
    });

    let written: Record<string, unknown> | undefined;
    fileManager.processFrontMatter.mockImplementation(
      (_file: unknown, callback: (frontmatter: Record<string, unknown>) => void) => {
        // 模拟真实语义：回调拿到笔记里已有的 frontmatter（title 特意给旧值）
        written = { categories: ["技术思考"], tags: ["Rust"], title: "旧标题" };
        callback(written);
      },
    );

    const service = new HaloService(app, createSettings(), site, client);
    const notices = capturedNotices();
    const seen = notices.length;

    const thrown = await service.updatePost().catch((error: unknown) => error);

    expect(thrown).toBeUndefined();
    // 其余字段照常回写 —— 证明整次更新没有被跳过
    expect(written?.title).toBe("Post title");
    expect((written?.halo as { name?: string } | undefined)?.name).toBe("post-1");
    // 这两个字段保持笔记原值（解析不出来就不写，绝不落回 metadata.name）
    expect(written?.categories).toEqual(["技术思考"]);
    expect(written?.tags).toEqual(["Rust"]);
    // 键必须真的在 locale 里 —— 否则 i18next 原样返回键名，上面那条断言就成了
    // 「键名与键名相比」，永远成立（假绿）
    expect(i18next.t("service.notice_taxonomy_not_resolved")).not.toBe("service.notice_taxonomy_not_resolved");
    // 一次提示，两段：这次操作变成了什么样 + 为什么
    expect(notices.slice(seen)).toEqual([
      `${i18next.t("service.notice_taxonomy_not_resolved")}\n${i18next.t("transport.error.forbidden", { status: 403 })}`,
    ]);
  });

  test("pullPost 解析失败：笔记照样建出来，分类/标签不写，其余 frontmatter 照常回写", async () => {
    const note = createFile("post.md");
    const { app, fileManager, vault } = createMockApp("", note, []);
    const { client } = createFakeClient((name) => {
      if (name === "halo_get_post") {
        return getPostResult(
          remoteItem("post-1", { categories: ["category-a"], tags: ["tag-a"], title: "标题" }),
          "# 远端正文",
        );
      }

      throw new McpError("forbidden", { status: 403 });
    });

    let written: Record<string, unknown> | undefined;
    fileManager.processFrontMatter.mockImplementation(
      (_file: unknown, callback: (frontmatter: Record<string, unknown>) => void) => {
        // 新建的笔记没有 frontmatter，回调拿到的是空对象 —— 所以这里没有「原值」可保留，
        // 观测结果是「这两个键不存在」（故提示语说「保持原样（未写入）」而不是「保留原值」）
        written = {};
        callback(written);
      },
    );

    const service = new HaloService(app, createSettings(), site, client);
    const notices = capturedNotices();
    const seen = notices.length;

    const thrown = await service.pullPost("post-1").catch((error: unknown) => error);

    expect(thrown).toBeUndefined();
    // 笔记仍然建出来了：分类解析失败不该让整次拉取白做（正文才是用户要的）
    expect(vault.create).toHaveBeenCalledWith("标题.md", "# 远端正文");
    expect(written?.title).toBe("标题");
    expect((written?.halo as { name?: string } | undefined)?.name).toBe("post-1");
    expect(written).not.toHaveProperty("categories");
    expect(written).not.toHaveProperty("tags");
    expect(notices.slice(seen)).toEqual([
      `${i18next.t("service.notice_taxonomy_not_resolved")}\n${i18next.t("transport.error.forbidden", { status: 403 })}`,
    ]);
  });
});

/**
 * 批量路径赖以为生的两条新契约，以及它们与便签的关系：
 *
 * - `quiet` 让**返回值**成为唯一通道 —— 批量不能用 118 条便签报进度；
 * - `publishOverride` 是**新增的最高优先级**，不是替换掉原有那两级规则；
 * - 「返回值与便签说的是同一件事」—— 否则单篇与批量会对同一次失败给出两种说法，
 *   用户无从判断哪个是真的。
 */
describe("publishPost 的返回值、quiet 与 publishOverride", () => {
  beforeEach(() => {
    forbidRest();
  });

  test("quiet 时不弹成功便签，但返回值仍是 ok", async () => {
    // 判别器：把 quiet 判断删掉 → 这条红。它钉的是「批量路径不会被 118 条提示淹掉」。
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    const { client } = fakeService();
    const notices = capturedNotices();
    const seen = notices.length;
    metadataCache.getFileCache.mockImplementation(() => ({ frontmatter: { title: "Post title" } }));

    const result = await new HaloService(app, createSettings(), site, client).publishPost(note, { quiet: true });

    expect(result).toEqual({ ok: true });
    expect(notices.slice(seen)).toEqual([]);
  });

  test("失败时返回的 reason 与便签文案**逐字一致**", async () => {
    // 不要断言 reason 等于 `i18next.t("service.error_publish_failed")`：那条路上
    // `publishFailureMessage` 还会拼上服务端原文（`withErrorDetail`），逐字相等本来就是错的。
    // 真正要钉的不变式是「返回值与便签说的是同一件事」—— 否则单篇与批量两条路径
    // 会对**同一次失败**给出两种说法，用户无从判断哪个是真的。
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    const { client } = fakeService({
      onWrite: () => {
        throw new McpError("unauthorized", {});
      },
    });
    const notices = capturedNotices();
    const seen = notices.length;
    metadataCache.getFileCache.mockImplementation(() => ({ frontmatter: { title: "Post title" } }));

    // 写失败会被 `withPublishRetry` 重试满 3 次（退避 500+1000+1500ms = 3 秒真实等待）。
    // 快进掉 —— 与本文件另外三条重试用例同一处置（样板见「发布状态调用瞬时失败时会被重试」）。
    rs.useFakeTimers();

    let result: PublishResult | undefined;

    try {
      const pending = new HaloService(app, createSettings(), site, client).publishPost(note);
      await rs.advanceTimersByTimeAsync(5_000);
      result = await pending;
    } finally {
      rs.useRealTimers();
    }

    expect(result?.ok).toBe(false);
    // 与便签**逐字一致**（不断言它等于某个 key —— `publishFailureMessage` 会拼上服务端原文）
    expect(notices.slice(seen)).toEqual([(result as { reason: string }).reason]);
  });

  test("publishOverride 压过 frontmatter 里的 publish: true", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    const { client, calls } = fakeService();
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { name: "post-1", publish: true } },
    }));

    await new HaloService(app, createSettings(), site, client).publishPost(note, { publishOverride: false });

    const states = calls.filter((call) => call.name === "halo_set_post_publish_state");
    expect(states[states.length - 1]?.args?.publish).toBe(false);
  });

  test("单篇路径不传 override 时，frontmatter 的 publish 仍然说了算", async () => {
    // 与上一条成对：override 是**新增的最高优先级**，不是替换掉原有规则。
    // 缺了这条，一个「永远听 override」的错误实现也能全绿。
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    const { client, calls } = fakeService();
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { name: "post-1", publish: true } },
    }));

    await new HaloService(app, createSettings(), site, client).publishPost(note);

    const states = calls.filter((call) => call.name === "halo_set_post_publish_state");
    expect(states[states.length - 1]?.args?.publish).toBe(true);
  });
});

/**
 * 「规划阶段零写入」—— 本阶段新增的核心不变式，也是预览能成立的**全部**依据。
 *
 * `planPublish` 存在的意义就在这里：它必须在**任何写操作之前**把「这次会发生什么」算完，
 * 因为用户在预览弹窗里点「取消」时，站点与本地都必须与打开弹窗之前一模一样。
 * 违反它的代价不是"预览算得不准"，而是"用户取消了、东西却已经写下去了"——
 * 一次什么都没发生的取消，在站点上留下几个新建的空分类标签。
 *
 * 两条判别器各自盯着**一类**写入机制，缺一不可：
 * - `halo_create_category` / `halo_create_tag` 走的是 `callToolJson`（它们要读回资源名），
 *   所以只有「工具名前缀」那一条拦得住它们；
 * - 写文章 / 改发布状态走的是 `callToolVoid`，它们**不**带 `halo_create_` 前缀，
 *   所以只有「入口是 callToolVoid」那一条拦得住它们。
 * 任何单独一条都留着另一半的口子 —— 这正是要用两条、而不是一条 `expect(calls).toEqual([])`
 * 的原因（规划阶段本来就会调只读工具，整体为空是做不到的）。
 */
describe("planPublish 的「零写入」不变式", () => {
  beforeEach(() => {
    forbidRest();
  });

  /** 规划阶段**允许**出现的全部工具：一律只读。白名单比黑名单更难被将来新增的写工具绕过 */
  const READ_ONLY_TOOLS = new Set(["halo_get_post", "halo_list_categories", "halo_list_tags"]);

  test("planPublish 不建分类标签，也不调任何写工具", async () => {
    // 判别器：把 `getCategories()`（只列）换回 `getCategoryNames()`（会建）就会红。
    // 这条是预览能成立的全部依据：用户在弹窗里点「取消」之后，站点上不能多出任何东西。
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    const { client, calls } = fakeService();
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", categories: ["还没有的分类"] },
    }));

    const result = await new HaloService(app, createSettings(), site, client).planPublish(note);

    expect(result.ok).toBe(true);
    expect((result as { plan: PublishPlan }).plan.newCategories).toEqual(["还没有的分类"]);
    expect(calls.filter((call) => call.name.startsWith("halo_create_"))).toEqual([]);
    expect(calls.filter((call) => call.method === "callToolVoid")).toEqual([]);
    // 第三层，也是最严的一层：规划阶段出现的工具必须**全部**在只读白名单里。
    // 前两条分别盯死"建分类标签"与"void 写入"两类机制，这一条盯死"将来新增的写工具"：
    // 前两条是黑名单，新写一个走 callToolJson 的写工具就能从两条之间溜过去。
    //
    // 顺带钉住「规划不产生任何请求副作用」的另一半：图片只做概览，**不上传**
    // （`halo_upload_attachment` 也不在白名单里，而它同样是 callToolJson）。
    //
    // ⚠️ 自证这一层的判别力时踩过一个坑，记在这里：拿 `halo_upload_attachment` 做变异，
    // 用例**确实红了，但红得不是地方** —— `fakeService()` 不认识那个工具，报的是
    // `Unexpected tool: halo_upload_attachment`，白名单这条断言根本轮不到执行。
    // **红得不是地方，与不红一样没有信息量**：它证明的是「假客户端很严格」，不是
    // 「白名单拦得住」。要自证这一层，必须同时让假客户端应答那个工具，再确认红的**是这一行**。
    expect(calls.map((call) => call.name).filter((name) => !READ_ONLY_TOOLS.has(name))).toEqual([]);
    // 反空洞的伴随断言：它是**「证明某件事本来可以发生」**的那一条。
    //
    // 上面三条断言说的都是「某件事没有发生」，而它们对「一次工具调用都没有」这种情形
    // **全部恒真** —— 实测过：让 planPublish 一次 MCP 调用都不发（但规划仍然成功），
    // 那三条**全绿**。于是只要 planPublish 提前 bail、或漏调只读工具，整个「零写入」
    // 就是一条永远为真的假绿，而它恰恰是预览能成立的唯一依据。
    //
    // 推广开来：**「断言某件事没有发生」需要一条「证明它本来可以发生」的伴随断言。**
    // 本仓另一处同款守卫见 `tests/i18n/index.test.ts`（断言"不含 &#x2F;"必须配"含那个字面量"）。
    expect(calls.length).toBeGreaterThan(0);
  });

  test("planPublish 失败时不抛，把原因放进 reason", async () => {
    // 预览路径的调用方是命令回调。异常穿到 Obsidian 只会进控制台 ——
    // 用户点了「发布」，什么都没发生，也没有任何提示。
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("local markdown", note, []);
    const { client } = fakeService({
      itemFor: () => {
        throw new McpError("network", {});
      },
    });
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { title: "Post title", halo: { name: "post-1" } },
    }));

    const service = new HaloService(app, createSettings(), site, client);

    // 更新分支的规划要读远端，而那次读**带发布级重试** —— 改动前它就在 `withPublishRetry`
    // 的闭包里，一次网络抖动不该从「重试后成功」变成「直接报发布失败」。所以这条用例会跑满
    // 三次退避（500+1000+1500ms），快进掉：与本文件另外三条重试用例同一处置，
    // 免得一条用例把整个套件拖慢三秒。
    rs.useFakeTimers();

    let result: Awaited<ReturnType<HaloService["planPublish"]>> | undefined;

    try {
      const pending = service.planPublish(note);
      await rs.advanceTimersByTimeAsync(5_000);
      result = await pending;
    } finally {
      rs.useRealTimers();
    }

    // 用收窄而不是类型断言：断言会把「ok 为真时没有 reason」这个事实抹掉，
    // 而这条用例要钉的恰恰是「失败这一支**带着**原因交出来」。
    const reason = result && !result.ok ? result.reason : "";

    expect(result?.ok).toBe(false);
    expect(reason).toBeTruthy();
  });
});
