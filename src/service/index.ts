import type { Category, Content, Post, Snapshot, Tag } from "@halo-dev/api-client";
import i18next from "i18next";
import { type App, Notice, type TFile, requestUrl } from "obsidian";
import { randomUUID } from "src/utils/id";
import markdownIt from "src/utils/markdown";
import { slugify } from "transliteration";
import { type HaloSetting, type HaloSite, isSameSiteUrl, mcpEndpointOf, normalizeSite } from "../settings";
import { McpClient } from "../transport/mcp-client";
import {
  type ImageUploadContext,
  type UploadImagesResult,
  restoreCachedLocalImageLinks,
  uploadImage,
  uploadImages,
} from "./image-upload";
import { type HaloPostFrontmatter, applyPostFrontmatter } from "./local-content";

const PUBLISH_RETRY_COUNT = 3;
const PUBLISH_RETRY_DELAY_MS = 500;

class HaloService {
  private readonly site: HaloSite;
  private readonly app: App;
  private readonly settings: HaloSetting;
  /**
   * MCP 客户端。**可注入**——测试传 `createFakeClient()` 造的对象，生产代码不传、用真实的。
   * 可注入是本计划全部服务层测试的前提：`McpClient` 内部走 `requestUrl`，
   * 而测试要断言的是「调了哪个工具、传了什么参数」，不是「发了什么 HTTP 请求」。
   */
  private readonly client: McpClient;
  private readonly headers: Record<string, string> = {};
  private readonly authHeaders: Record<string, string> = {};

  constructor(app: App, settings: HaloSetting, site: HaloSite, client?: McpClient) {
    this.app = app;
    this.settings = settings;
    this.site = normalizeSite(site);

    if (!this.settings.imageUploadCache) {
      this.settings.imageUploadCache = {};
    }

    this.authHeaders = {
      Authorization: `Bearer ${this.site.token}`,
    };

    this.headers = {
      "Content-Type": "application/json",
      ...this.authHeaders,
    };

    this.client = client ?? new McpClient({ endpoint: mcpEndpointOf(this.site), token: this.site.mcpToken });
  }

  /** 图片上传模块的运行上下文。三个调用点共用，避免各写一遍字段拼装 */
  private imageUploadContext(): ImageUploadContext {
    return {
      app: this.app,
      client: this.client,
      settings: this.settings,
      site: this.site,
    };
  }

  public async getPost(name: string): Promise<{ post: Post; content: Content } | undefined> {
    try {
      const post = await this.getPostResource(name);
      const snapshot = await this.getPostDraft(name);

      const { "content.halo.run/patched-content": patchedContent, "content.halo.run/patched-raw": patchedRaw } =
        snapshot.metadata.annotations || {};

      const { rawType } = snapshot.spec || {};

      const content: Content = {
        content: patchedContent,
        raw: patchedRaw,
        rawType,
      };

      return Promise.resolve({
        post,
        content,
      });
    } catch (error) {
      return Promise.resolve(undefined);
    }
  }

  private async getPostResource(name: string): Promise<Post> {
    return (await requestUrl({
      url: `${this.site.url}/apis/uc.api.content.halo.run/v1alpha1/posts/${name}`,
      headers: this.headers,
    }).json) as Post;
  }

  private async getPostDraft(name: string): Promise<Snapshot> {
    return (await requestUrl({
      url: `${this.site.url}/apis/uc.api.content.halo.run/v1alpha1/posts/${name}/draft?patched=true`,
      headers: this.headers,
    }).json) as Snapshot;
  }

  public async publishPost(options: { markdown?: string } = {}): Promise<void> {
    const { activeEditor } = this.app.workspace;

    if (!activeEditor || !activeEditor.file) {
      return;
    }

    const activeFile = activeEditor.file;

    let params: Post = {
      apiVersion: "content.halo.run/v1alpha1",
      kind: "Post",
      metadata: {
        annotations: {},
        name: "",
      },
      spec: {
        allowComment: true,
        baseSnapshot: "",
        categories: [],
        cover: "",
        deleted: false,
        excerpt: {
          autoGenerate: true,
          raw: "",
        },
        headSnapshot: "",
        htmlMetas: [],
        owner: "",
        pinned: false,
        priority: 0,
        publish: false,
        publishTime: "",
        releaseSnapshot: "",
        slug: "",
        tags: [],
        template: "",
        title: "",
        visible: "PUBLIC",
      },
    };

    const md = options.markdown ?? (await this.app.vault.read(activeFile));
    const matterData = this.app.metadataCache.getFileCache(activeFile)?.frontmatter as HaloPostFrontmatter | undefined;
    const frontmatterPosition = this.app.metadataCache.getFileCache(activeFile)?.frontmatterPosition;

    const raw = frontmatterPosition ? md.slice(frontmatterPosition?.end.offset) : md;

    // check site url
    if (matterData?.halo?.site && !isSameSiteUrl(matterData.halo.site, this.site.url)) {
      new Notice(i18next.t("service.error_site_not_match"));
      return;
    }

    let categoryNames: string[] | undefined;
    if (matterData?.categories) {
      categoryNames = await this.getCategoryNames(matterData.categories);
    }

    let tagNames: string[] | undefined;
    if (matterData?.tags) {
      tagNames = await this.getTagNames(matterData.tags);
    }

    let remotePostName = matterData?.halo?.name;

    try {
      params = await this.withPublishRetry(async () => {
        if (remotePostName) {
          const latestPost = await this.getPostResource(remotePostName);
          params = applyPostFrontmatter(latestPost, {
            activeFile,
            categoryNames,
            matterData,
            tagNames,
            useActiveFileDefaults: false,
          });

          await requestUrl({
            url: `${this.site.url}/apis/uc.api.content.halo.run/v1alpha1/posts/${remotePostName}`,
            method: "PUT",
            contentType: "application/json",
            headers: this.headers,
            body: JSON.stringify(params),
          });

          const snapshot = await this.getPostDraft(remotePostName);
          const content = this.createPostContent(raw, snapshot.spec?.rawType);

          snapshot.metadata.annotations = {
            ...snapshot.metadata.annotations,
            "content.halo.run/content-json": JSON.stringify(content),
          };

          await requestUrl({
            url: `${this.site.url}/apis/uc.api.content.halo.run/v1alpha1/posts/${remotePostName}/draft`,
            method: "PUT",
            contentType: "application/json",
            headers: this.headers,
            body: JSON.stringify(snapshot),
          });
        } else {
          if (!params.metadata.name) {
            params.metadata.name = randomUUID();
          }

          params = applyPostFrontmatter(params, {
            activeFile,
            categoryNames,
            matterData,
            tagNames,
            useActiveFileDefaults: true,
          });

          params.metadata.annotations = {
            ...params.metadata.annotations,
            "content.halo.run/content-json": JSON.stringify(this.createPostContent(raw)),
          };

          const post = await requestUrl({
            url: `${this.site.url}/apis/uc.api.content.halo.run/v1alpha1/posts`,
            method: "POST",
            contentType: "application/json",
            headers: this.headers,
            body: JSON.stringify(params),
          }).json;

          params = post;
          remotePostName = params.metadata.name;
        }

        // Publish post
        // biome-ignore lint: no
        if (matterData?.halo?.hasOwnProperty("publish")) {
          if (matterData?.halo?.publish) {
            await this.changePostPublish(params.metadata.name, true);
          } else {
            await this.changePostPublish(params.metadata.name, false);
          }
        } else {
          if (this.settings.publishByDefault) {
            await this.changePostPublish(params.metadata.name, true);
          }
        }

        return params;
      });

      params = (await this.getPost(params.metadata.name))?.post || params;
    } catch (error) {
      new Notice(i18next.t("service.error_publish_failed"));
      return;
    }

    const postCategories = await this.getCategoryDisplayNames(params.spec.categories);
    const postTags = await this.getTagDisplayNames(params.spec.tags);

    this.app.fileManager.processFrontMatter(activeFile, (frontmatter) => {
      frontmatter.title = params.spec.title;
      frontmatter.slug = params.spec.slug;
      frontmatter.cover = params.spec.cover;
      frontmatter.excerpt = params.spec.excerpt.autoGenerate ? undefined : params.spec.excerpt.raw;
      frontmatter.categories = postCategories;
      frontmatter.tags = postTags;
      frontmatter.halo = {
        site: this.site.url,
        name: params.metadata.name,
        publish: params.spec.publish,
      };
    });

    new Notice(i18next.t("service.notice_publish_success"));
  }

  public async changePostPublish(name: string, publish: boolean): Promise<void> {
    await requestUrl({
      url: `${this.site.url}/apis/uc.api.content.halo.run/v1alpha1/posts/${name}/${publish ? "publish" : "unpublish"}`,
      method: "PUT",
      contentType: "application/json",
      headers: this.headers,
    });
  }

  private createPostContent(raw: string, rawType = "markdown"): Content {
    return {
      content: markdownIt.render(raw),
      raw,
      rawType,
    };
  }

  private async withPublishRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let retryCount = 0; ; retryCount++) {
      try {
        return await operation();
      } catch (error) {
        if (retryCount >= PUBLISH_RETRY_COUNT) {
          throw error;
        }

        await this.sleep(PUBLISH_RETRY_DELAY_MS * (retryCount + 1));
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  public async getCategories(): Promise<Category[]> {
    const data = await requestUrl({
      url: `${this.site.url}/apis/content.halo.run/v1alpha1/categories`,
      headers: this.headers,
    });
    return Promise.resolve(data.json.items);
  }

  public async getTags(): Promise<Tag[]> {
    const data = await requestUrl({
      url: `${this.site.url}/apis/content.halo.run/v1alpha1/tags`,
      headers: this.headers,
    });
    return Promise.resolve(data.json.items);
  }

  public async updatePost(): Promise<void> {
    const { activeEditor } = this.app.workspace;

    if (!activeEditor || !activeEditor.file) {
      return;
    }

    const matterData = this.app.metadataCache.getFileCache(activeEditor.file)?.frontmatter;

    if (!matterData?.halo?.name) {
      new Notice(i18next.t("service.error_not_published"));
      return;
    }

    const post = await this.getPost(matterData.halo.name);

    if (!post) {
      new Notice(i18next.t("service.error_post_not_found"));
      return;
    }

    const postCategories = await this.getCategoryDisplayNames(post.post.spec.categories);
    const postTags = await this.getTagDisplayNames(post.post.spec.tags);

    const raw = this.settings.replaceImageLinks
      ? `${post.content.raw}`
      : restoreCachedLocalImageLinks(`${post.content.raw}`, this.imageUploadContext());

    await this.app.vault.modify(activeEditor.file, raw);

    this.app.fileManager.processFrontMatter(activeEditor.file, (frontmatter) => {
      frontmatter.title = post.post.spec.title;
      frontmatter.slug = post.post.spec.slug;
      frontmatter.cover = post.post.spec.cover;
      frontmatter.excerpt = post.post.spec.excerpt.autoGenerate ? undefined : post.post.spec.excerpt.raw;
      frontmatter.categories = postCategories;
      frontmatter.tags = postTags;
      frontmatter.halo = {
        site: this.site.url,
        name: post.post.metadata.name,
        publish: post.post.spec.publish,
      };
    });
  }

  public async pullPost(name: string): Promise<void> {
    const post = await this.getPost(name);

    if (!post) {
      new Notice(i18next.t("service.error_post_not_found"));
      return;
    }

    const postCategories = await this.getCategoryDisplayNames(post.post.spec.categories);
    const postTags = await this.getTagDisplayNames(post.post.spec.tags);

    const file = await this.app.vault.create(`${post.post.spec.title}.md`, `${post.content.raw}`);
    this.app.workspace.getLeaf().openFile(file);

    this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter.title = post.post.spec.title;
      frontmatter.slug = post.post.spec.slug;
      frontmatter.cover = post.post.spec.cover;
      frontmatter.excerpt = post.post.spec.excerpt.autoGenerate ? undefined : post.post.spec.excerpt.raw;
      frontmatter.categories = postCategories;
      frontmatter.tags = postTags;
      frontmatter.halo = {
        site: this.site.url,
        name: name,
        publish: post.post.spec.publish,
      };
    });
  }

  /**
   * 上传当前笔记里的图片，必要时回写 markdown。
   *
   * 实现在 `./image-upload`——这里只负责拼出运行上下文。
   */
  public async uploadImages(
    options: { silent?: boolean; replaceMarkdown?: boolean } = {},
  ): Promise<UploadImagesResult> {
    return uploadImages(options, this.imageUploadContext());
  }

  /**
   * 上传单张图片并返回 permalink。
   *
   * 实现在 `./image-upload`——这里只负责拼出运行上下文。
   */
  public async uploadImage(file: TFile): Promise<string> {
    return uploadImage(file, this.imageUploadContext());
  }

  public async getCategoryNames(displayNames: string[]): Promise<string[]> {
    const allCategories = await this.getCategories();

    const notExistDisplayNames = displayNames.filter(
      (name) => !allCategories.find((item) => item.spec.displayName === name),
    );

    const promises = notExistDisplayNames.map((name, index) =>
      requestUrl({
        url: `${this.site.url}/apis/content.halo.run/v1alpha1/categories`,
        method: "POST",
        contentType: "application/json",
        headers: this.headers,
        body: JSON.stringify({
          spec: {
            displayName: name,
            slug: slugify(name, { trim: true }),
            description: "",
            cover: "",
            template: "",
            priority: allCategories.length + index,
            children: [],
          },
          apiVersion: "content.halo.run/v1alpha1",
          kind: "Category",
          metadata: { name: "", generateName: "category-" },
        }),
      }),
    );

    const newCategories = await Promise.all(promises);

    const existNames = displayNames
      .map((name) => {
        const found = allCategories.find((item) => item.spec.displayName === name);
        return found ? found.metadata.name : undefined;
      })
      .filter(Boolean) as string[];

    return [...existNames, ...newCategories.map((item) => item.json.metadata.name)];
  }

  public async getCategoryDisplayNames(names?: string[]): Promise<string[]> {
    const categories = await this.getCategories();
    return names
      ?.map((name) => {
        const found = categories.find((item) => item.metadata.name === name);
        return found ? found.spec.displayName : undefined;
      })
      .filter(Boolean) as string[];
  }

  public async getTagNames(displayNames: string[]): Promise<string[]> {
    const allTags = await this.getTags();

    const notExistDisplayNames = displayNames.filter((name) => !allTags.find((item) => item.spec.displayName === name));

    const promises = notExistDisplayNames.map((name) =>
      requestUrl({
        url: `${this.site.url}/apis/content.halo.run/v1alpha1/tags`,
        method: "POST",
        contentType: "application/json",
        headers: this.headers,
        body: JSON.stringify({
          spec: {
            displayName: name,
            slug: slugify(name, { trim: true }),
            color: "#ffffff",
            cover: "",
          },
          apiVersion: "content.halo.run/v1alpha1",
          kind: "Tag",
          metadata: { name: "", generateName: "tag-" },
        }),
      }),
    );

    const newTags = await Promise.all(promises);

    const existNames = displayNames
      .map((name) => {
        const found = allTags.find((item) => item.spec.displayName === name);
        return found ? found.metadata.name : undefined;
      })
      .filter(Boolean) as string[];

    return [...existNames, ...newTags.map((item) => item.json.metadata.name)];
  }

  public async getTagDisplayNames(names?: string[]): Promise<string[]> {
    const tags = await this.getTags();
    return names
      ?.map((name) => {
        const found = tags.find((item) => item.metadata.name === name);
        return found ? found.spec.displayName : undefined;
      })
      .filter(Boolean) as string[];
  }
}

export default HaloService;
