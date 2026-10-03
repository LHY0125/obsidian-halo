import { beforeAll, beforeEach, describe, expect, rs, test } from "@rstest/core";
import i18next from "i18next";
import type { RequestUrlParam } from "obsidian";
import * as obsidianRuntime from "obsidian";
import { resources } from "../../src/i18n";
import HaloService from "../../src/service";
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

/** 远端文章的**扁平**骨架 —— MCP 的 `halo_get_post` 与写工具返回的都是这个形状 */
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

    const result = await service.uploadImages({ silent: true });

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

    const result = await service.uploadImages({ silent: true });

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

    const result = await service.uploadImages({ silent: true });

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

    const result = await service.uploadImages({ silent: true });

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

    const result = await service.uploadImages({ silent: true });

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

    const result = await service.uploadImages({ silent: true });

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
      const result = await service.uploadImages({ silent: true });

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
      const result = await service.uploadImages({ silent: true });

      expect(result.failedCount).toBe(1);
      // silent 只压常规汇总，「为什么失败」必须说出来 —— 否则用户只看到「1 张失败」，
      // 无从判断是该压缩图片，还是该去站点补一个 PAT
      expect(notices.slice(seen)).toEqual([i18next.t("service.error_image_too_large", { limit: 7, name: "big.png" })]);
    } finally {
      consoleError.mockRestore();
    }
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

    await service.publishPost();

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
      const pending = service.publishPost();
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
      const pending = service.publishPost();
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

    await service.publishPost({ markdown: publishedMarkdown });

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

    await service.publishPost();

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

    await service.publishPost();

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

    await service.publishPost();

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

    await service.publishPost();

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

    await service.publishPost();

    const state = calls.find((call) => call.name === "halo_set_post_publish_state");
    expect(state?.args).toEqual({ name: expect.any(String), publish: true });
  });

  test("frontmatter 无 publish 且 publishByDefault 为 false 时不调发布状态工具", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({ frontmatter: { title: "Post title" } }));
    const { client, calls } = fakeService();
    const service = new HaloService(app, createSettings(), site, client);

    await service.publishPost();

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

    await service.publishPost();

    const state = calls.find((call) => call.name === "halo_set_post_publish_state");
    expect(state?.args).toEqual({ name: expect.any(String), publish: false });
  });

  test("frontmatter 无 publish 且 publishByDefault 为 true 时发布", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({ frontmatter: { title: "Post title" } }));
    const { client, calls } = fakeService();
    const service = new HaloService(app, createSettings({ publishByDefault: true }), site, client);

    await service.publishPost();

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
      const pending = service.publishPost();
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

    await service.publishPost();

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
});

describe("发布成功后的回读", () => {
  beforeEach(() => {
    forbidRest();
  });

  test("回读失败不会被报成「发布失败」，frontmatter 仍用本地 params 回写", async () => {
    const note = createFile("post.md");
    const { app, fileManager, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({ frontmatter: { title: "Post title" } }));

    let writeDone = false;
    const { client, calls } = fakeService({
      onWrite: () => {
        writeDone = true;
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

    await service.publishPost();

    // 写已经落库，用户必须看到成功 —— 报失败会让他重发一遍
    expect(notices.slice(seen)).toEqual([i18next.t("service.notice_publish_success")]);

    // 回读失败只是少了服务端归一化，frontmatter 仍要用本地 params 回写（不能整个跳过）
    const createdName = calls.find((call) => call.name === "halo_create_post")?.args.name;
    expect(createdName).toEqual(expect.any(String));
    expect(written?.title).toBe("Post title");
    expect((written?.halo as { name?: string } | undefined)?.name).toEqual(createdName);
  });

  test("收尾的显示名解析失败时，不抛出、frontmatter 仍用本地值回写", async () => {
    const note = createFile("post.md");
    const { app, fileManager, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { categories: ["技术思考"], title: "Post title" },
    }));

    let writeDone = false;
    const { client, calls } = createFakeClient((name, args) => {
      // 写之前那次列分类必须成功（否则发布根本不会开始），写之后那次才失败 ——
      // 这正是「文章已经写进 Halo 了，只是收尾读时又网络抖了一下」。
      if (name === "halo_list_categories" && writeDone) {
        throw new McpError("network", { context: "tools/call halo_list_categories" }, "socket hang up");
      }

      switch (name) {
        case "halo_list_categories":
          return { items: [] };
        case "halo_list_tags":
          return { items: [] };
        case "halo_create_category":
          return { name: "category-new" };
        case "halo_create_post":
          writeDone = true;
          return {};
        case "halo_get_post":
          return getPostResult(remoteItem(String(args.name), { categories: ["category-new"] }), "");
        default:
          throw new Error(`Unexpected tool: ${name}`);
      }
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

    await service.publishPost();

    // 写已经落库 —— 收尾读失败既不能被报成「发布失败」，更不能把异常放出去：
    // 放出去的话 Obsidian 只把它记进控制台，用户什么都看不到，frontmatter 也不会回写。
    expect(notices.slice(seen)).toEqual([i18next.t("service.notice_publish_success")]);

    const createdName = calls.find((call) => call.name === "halo_create_post")?.args.name;
    expect(createdName).toEqual(expect.any(String));
    expect(written?.title).toBe("Post title");
    expect((written?.halo as { name?: string } | undefined)?.name).toEqual(createdName);
    // 回落到本地的 metadata.name 列表，而不是整个跳过这次回写
    expect(written?.categories).toEqual(["category-new"]);
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
