import { beforeEach, describe, expect, rs, test } from "@rstest/core";
import type { RequestUrlParam } from "obsidian";
import HaloService from "../../src/service";
import { createFakeClient } from "../helpers/mcp-mock";
import {
  createFile,
  createMockApp,
  createSettings,
  requestUrlMock,
  TEST_SITE as site,
} from "../helpers/obsidian-mocks";

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
    const service = new HaloService(app, createSettings(), site);
    const createRemotePost = (version: string) => ({
      apiVersion: "content.halo.run/v1alpha1",
      kind: "Post",
      metadata: {
        annotations: {},
        name: "post-1",
        version,
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
    });
    const snapshot = {
      metadata: {
        annotations: {},
      },
      spec: {
        rawType: "markdown",
      },
    };
    let draftUpdateAttempts = 0;
    let latestPostFetches = 0;
    let postUpdateAttempts = 0;
    const postUpdateVersions: string[] = [];

    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: {
        halo: {
          name: "post-1",
          site: site.url,
        },
        title: "Post title",
      },
    }));
    requestUrlMock().mockImplementation((request: RequestUrlParam) => {
      const url = typeof request === "string" ? request : request.url;
      const method = typeof request === "string" ? "GET" : request.method || "GET";

      if (url.endsWith("/posts/post-1/draft?patched=true")) {
        return {
          json: snapshot,
        };
      }

      if (url.endsWith("/posts/post-1/draft") && method === "PUT") {
        draftUpdateAttempts += 1;

        if (draftUpdateAttempts === 1) {
          throw new Error("The post draft is locked");
        }

        return {
          json: snapshot,
        };
      }

      if (url.endsWith("/posts/post-1") && method === "PUT") {
        postUpdateAttempts += 1;
        const body = JSON.parse(
          typeof request === "string" || typeof request.body !== "string" ? "{}" : request.body,
        ) as {
          metadata?: { version?: string };
        };
        postUpdateVersions.push(body.metadata?.version || "");
        return {
          json: createRemotePost(body.metadata?.version || ""),
        };
      }

      if (url.endsWith("/posts/post-1")) {
        latestPostFetches += 1;
        return {
          json: createRemotePost(`${latestPostFetches}`),
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

    await service.publishPost();

    expect(postUpdateAttempts).toBe(2);
    expect(postUpdateVersions).toEqual(["1", "2"]);
    expect(draftUpdateAttempts).toBe(2);
    expect(fileManager.processFrontMatter).toHaveBeenCalledTimes(1);
  });

  test("publishes the provided markdown instead of rereading the local note", async () => {
    const note = createFile("post.md");
    const { app, metadataCache, vault } = createMockApp("local markdown ![Logo](logo.png)", note, []);
    const service = new HaloService(app, createSettings(), site);
    let createdPostBody: Record<string, unknown> | undefined;

    metadataCache.getFileCache.mockImplementation(() => ({
      frontmatter: {
        title: "Post title",
      },
    }));
    requestUrlMock().mockImplementation((request: RequestUrlParam) => {
      const url = typeof request === "string" ? request : request.url;

      if (typeof request !== "string" && request.method === "POST" && url.endsWith("/posts")) {
        createdPostBody = JSON.parse(typeof request.body === "string" ? request.body : "{}") as Record<string, unknown>;
        return {
          json: createdPostBody,
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

    await service.publishPost({
      markdown: "published markdown ![Logo](https://halo.example.com/uploads/logo.png)",
    });

    const metadata = createdPostBody?.metadata as { annotations?: Record<string, string> };
    const content = JSON.parse(metadata.annotations?.["content.halo.run/content-json"] || "{}") as {
      raw?: string;
    };

    expect(vault.read).not.toHaveBeenCalled();
    expect(content.raw).toBe("published markdown ![Logo](https://halo.example.com/uploads/logo.png)");
  });
});
