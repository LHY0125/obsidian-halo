import { beforeAll, beforeEach, describe, expect, rs, test } from "@rstest/core";
import i18next from "i18next";
import type { RequestUrlParam } from "obsidian";
import * as obsidianRuntime from "obsidian";
import { resources } from "../../src/i18n";
import HaloService from "../../src/service";
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

function mockUpdatePostRequests(raw: string): void {
  requestUrlMock().mockImplementation((request: RequestUrlParam) => {
    const url = typeof request === "string" ? request : request.url;

    if (url.endsWith("/posts/post-1")) {
      return {
        json: {
          metadata: {
            name: "post-1",
          },
          spec: {
            categories: [],
            cover: "",
            excerpt: {
              autoGenerate: true,
              raw: "",
            },
            publish: false,
            slug: "post-title",
            tags: [],
            title: "Post title",
          },
        },
      };
    }

    if (url.endsWith("/posts/post-1/draft?patched=true")) {
      return {
        json: {
          metadata: {
            annotations: {
              "content.halo.run/patched-content": "",
              "content.halo.run/patched-raw": raw,
            },
          },
          spec: {
            rawType: "markdown",
          },
        },
      };
    }

    if (url.includes("/categories") || url.includes("/tags")) {
      return {
        json: {
          items: [],
        },
      };
    }

    throw new Error(`Unexpected request: ${url}`);
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

/** Halo 远端 Post 的骨架。字段给全，发布尾段的 frontmatter 回写才不会读到 undefined */
function makeRemotePost(name: string, spec: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: "content.halo.run/v1alpha1",
    kind: "Post",
    metadata: {
      annotations: {},
      name,
    },
    spec: {
      allowComment: true,
      categories: [],
      cover: "",
      excerpt: {
        autoGenerate: true,
        raw: "",
      },
      pinned: false,
      priority: 0,
      publish: false,
      publishTime: "",
      slug: "post-title",
      tags: [],
      template: "",
      title: "Post title",
      visible: "PUBLIC",
      ...spec,
    },
  };
}

/**
 * 把 MCP 入参投影回 Post。
 *
 * 真实的 `halo_create_post` / `halo_update_post` 返回站点上的 Post，而不是入参回显；
 * 但服务层随后要读 `params.metadata.name` 与 `params.spec.*`，所以假客户端必须返回
 * **形状真实**的 Post —— 否则「name 从哪来」这类断言会在无关的地方失真
 * （例如 `changePostPublish` 悄悄拿到 undefined）。
 */
function postFromToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  return makeRemotePost(String(args.name ?? ""), {
    categories: args.categories ?? [],
    tags: args.tags ?? [],
    title: args.title ?? "",
  });
}

/** 只认发布相关三个工具的假客户端；未知工具名直接抛错，与既有 `fakeUploads` 同风格 */
function fakePublisher() {
  return createFakeClient((name, args) => {
    if (name === "halo_create_post" || name === "halo_update_post") {
      return postFromToolArgs(args);
    }

    if (name === "halo_set_post_publish_state") {
      return {};
    }

    throw new Error(`Unexpected tool: ${name}`);
  });
}

/**
 * 发布路径的 REST 侧桩。
 *
 * 本任务结束时发布是**刻意的混合态**：写走 MCP，读仍走 REST（Task 5 才收口）。
 * 因此即使写入已由 MCP 驱动，`publishPost` 仍会发 REST 请求：`getPostResource`（更新分支），
 * 以及 `getCategoryDisplayNames` / `getTagDisplayNames`（两条分支都会走到，且在 try/catch
 * **之外**——桩里不给，`publishPost` 会直接抛出而不是弹失败提示）。
 */
function mockPublishRest(post: () => Record<string, unknown>): void {
  requestUrlMock().mockImplementation((request: RequestUrlParam) => {
    const url = typeof request === "string" ? request : request.url;

    if (url.includes("/categories") || url.includes("/tags")) {
      return { json: { items: [] } };
    }

    if (url.endsWith("/draft?patched=true")) {
      return {
        json: {
          metadata: { annotations: {} },
          spec: { rawType: "markdown" },
        },
      };
    }

    if (url.includes("/posts/")) {
      return { json: post() };
    }

    throw new Error(`Unexpected request: ${url}`);
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
});

describe("HaloService.updatePost", () => {
  beforeEach(() => {
    requestUrlMock().mockReset();
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
    );

    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: {
        halo: {
          name: "post-1",
          site: site.url,
        },
      },
    }));
    mockUpdatePostRequests(remoteMarkdown);

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
    );

    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: {
        halo: {
          name: "post-1",
          site: site.url,
        },
      },
    }));
    mockUpdatePostRequests(remoteMarkdown);

    await service.updatePost();

    expect(contents.get(note.path)).toBe(remoteMarkdown);
  });
});

describe("HaloService.publishPost", () => {
  beforeEach(() => {
    requestUrlMock().mockReset();
  });

  test("retries draft update failures before showing publish failure", async () => {
    const note = createFile("post.md");
    const { app, fileManager, metadataCache } = createMockApp("published markdown", note, []);
    let updateAttempts = 0;
    let latestPostFetches = 0;
    // 每次发起写入时远端已被拉取过几次。上游那条 version 断言（["1", "2"]）钉的就是这个性质：
    // **重试前先重新拉一次最新 Post**，而不是拿旧对象原样重放。
    const fetchesBeforeAttempt: number[] = [];
    const { client } = createFakeClient((name, args) => {
      if (name !== "halo_update_post") {
        throw new Error(`Unexpected tool: ${name}`);
      }

      updateAttempts += 1;
      fetchesBeforeAttempt.push(latestPostFetches);

      // 上游让 `PUT .../draft` 的第一次失败。MCP 之后 draft 那一步没有了，但
      // 「重试包住整个发布事务」的语义不变，所以让唯一那次写入的首次调用失败。
      if (updateAttempts === 1) {
        throw new Error("The post draft is locked");
      }

      return postFromToolArgs(args);
    });
    const service = new HaloService(app, createSettings(), site, client);

    metadataCache.getFileCache.mockImplementation(remoteFrontmatter());
    mockPublishRest(() => {
      latestPostFetches += 1;
      return makeRemotePost("post-1");
    });

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
    const { client } = createFakeClient((name) => {
      if (name !== "halo_update_post") {
        throw new Error(`Unexpected tool: ${name}`);
      }

      updateAttempts += 1;
      throw new McpError("unknown", { tool: name }, "The post draft is locked");
    });
    const service = new HaloService(app, createSettings(), site, client);

    metadataCache.getFileCache.mockImplementation(remoteFrontmatter());
    mockPublishRest(() => makeRemotePost("post-1"));

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
    const { client, calls } = createFakeClient((name, args) => {
      if (name === "halo_create_post" || name === "halo_update_post") {
        return postFromToolArgs(args);
      }

      if (name === "halo_set_post_publish_state") {
        stateAttempts += 1;

        // 只有发布状态这一步抖动，写入全程成功
        if (stateAttempts < 3) {
          throw new McpError("unknown", { tool: name }, "The publish state is locked");
        }

        return {};
      }

      throw new Error(`Unexpected tool: ${name}`);
    });
    const service = new HaloService(app, createSettings(), site, client);

    // frontmatter 没有 halo.name（首次走新建分支），但明确 publish: true 以触发发布状态调用
    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: { halo: { publish: true }, title: "Post title" },
    }));
    mockPublishRest(() => makeRemotePost("post-1"));

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
    mockPublishRest(() => makeRemotePost("post-1"));
    const { client, calls } = fakePublisher();
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
    requestUrlMock().mockReset();
  });

  test("新建文章时调 halo_create_post，且 rawType 显式传 markdown", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({ frontmatter: { title: "Post title" } }));
    mockPublishRest(() => makeRemotePost("post-1"));
    const { client, calls } = fakePublisher();
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
    mockPublishRest(() => makeRemotePost("post-1"));
    const { client, calls } = fakePublisher();
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
    mockPublishRest(() => makeRemotePost("post-1"));
    const { client, calls } = fakePublisher();
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
    mockPublishRest(() => makeRemotePost("post-1"));
    const { client, calls } = fakePublisher();
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
    mockPublishRest(() => makeRemotePost("post-1"));
    const { client, calls } = fakePublisher();
    const service = new HaloService(app, createSettings(), site, client);

    await service.publishPost();

    const state = calls.find((call) => call.name === "halo_set_post_publish_state");
    expect(state?.args).toEqual({ name: expect.any(String), publish: true });
  });

  test("frontmatter 无 publish 且 publishByDefault 为 false 时不调发布状态工具", async () => {
    const note = createFile("post.md");
    const { app, metadataCache } = createMockApp("hello world", note, []);
    metadataCache.getFileCache.mockImplementation(() => ({ frontmatter: { title: "Post title" } }));
    mockPublishRest(() => makeRemotePost("post-1"));
    const { client, calls } = fakePublisher();
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
    mockPublishRest(() => makeRemotePost("post-1"));
    const { client, calls } = fakePublisher();
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
    mockPublishRest(() => makeRemotePost("post-1"));
    const { client, calls } = fakePublisher();
    const service = new HaloService(app, createSettings({ publishByDefault: true }), site, client);

    await service.publishPost();

    const state = calls.find((call) => call.name === "halo_set_post_publish_state");
    expect(state?.args).toEqual({ name: expect.any(String), publish: true });
  });
});

describe("changePostPublish 走 MCP", () => {
  beforeEach(() => {
    requestUrlMock().mockReset();
  });

  test("publish 为 false 时调 halo_set_post_publish_state 并传 publish: false", async () => {
    const note = createFile("post.md");
    const { app } = createMockApp("", note, []);
    const { client, calls } = fakePublisher();
    const service = new HaloService(app, createSettings(), site, client);

    await service.changePostPublish("abc", false);

    expect(calls).toEqual([{ name: "halo_set_post_publish_state", args: { name: "abc", publish: false } }]);
  });
});
