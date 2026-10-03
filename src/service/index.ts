import type { Attachment, Category, Content, Post, Snapshot, Tag } from "@halo-dev/api-client";
import i18next from "i18next";
import { type App, Notice, TFile, getLinkpath, requestUrl } from "obsidian";
import { randomUUID } from "src/utils/id";
import markdownIt from "src/utils/markdown";
import { slugify } from "transliteration";
import { type HaloSetting, type HaloSite, type ImageUploadCacheEntry, isSameSiteUrl, normalizeSite } from "../settings";
import {
  type HaloPostFrontmatter,
  IMAGE_MIME_TYPES,
  type LocalImageReference,
  applyPostFrontmatter,
  collectLocalImageReferences,
  decodeMarkdownPath,
  formatMarkdownImagePath,
  formatWikiImageEmbed,
  getMarkdownImageAlt,
  getWikiImageAlias,
  isImageFile,
  isRemotePath,
  parseMarkdownImageTarget,
} from "./local-content";

interface UploadImagesResult {
  processedCount: number;
  uploadedCount: number;
  reusedCount: number;
  failedCount: number;
  markdown?: string;
  replaced: boolean;
}

const PUBLISH_RETRY_COUNT = 3;
const PUBLISH_RETRY_DELAY_MS = 500;

class HaloService {
  private readonly site: HaloSite;
  private readonly app: App;
  private readonly settings: HaloSetting;
  private readonly headers: Record<string, string> = {};
  private readonly authHeaders: Record<string, string> = {};

  constructor(app: App, settings: HaloSetting, site: HaloSite) {
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
      : this.restoreCachedLocalImageLinks(`${post.content.raw}`);

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

  public async uploadImages(
    options: { silent?: boolean; replaceMarkdown?: boolean } = {},
  ): Promise<UploadImagesResult> {
    const { activeEditor } = this.app.workspace;

    if (!activeEditor || !activeEditor.file) {
      return {
        processedCount: 0,
        uploadedCount: 0,
        reusedCount: 0,
        failedCount: 0,
        replaced: false,
      };
    }

    const md = await this.app.vault.read(activeEditor.file);
    const imageReferences = collectLocalImageReferences(md, activeEditor.file, this.app);
    const replaceMarkdown = options.replaceMarkdown ?? this.settings.replaceImageLinks;

    if (imageReferences.length === 0) {
      if (!options.silent) {
        new Notice(i18next.t("service.notice_no_images_to_upload"));
      }
      return {
        processedCount: 0,
        uploadedCount: 0,
        reusedCount: 0,
        failedCount: 0,
        markdown: md,
        replaced: false,
      };
    }

    const uploadedPermalinks = new Map<string, string>();
    const replacements: { start: number; end: number; value: string }[] = [];
    let uploadedCount = 0;
    let reusedCount = 0;
    let failedCount = 0;

    for (const imageReference of imageReferences) {
      try {
        let permalink = uploadedPermalinks.get(imageReference.file.path);

        if (!permalink) {
          permalink = this.getCachedImagePermalink(imageReference.file);

          if (permalink) {
            this.cacheImageReference(imageReference.file, imageReference);
            reusedCount++;
          } else {
            permalink = await this.uploadImage(imageReference.file);
            this.cacheImagePermalink(imageReference.file, permalink, imageReference);
            uploadedCount++;
          }

          uploadedPermalinks.set(imageReference.file.path, permalink);
        }

        replacements.push({
          start: imageReference.start,
          end: imageReference.end,
          value: imageReference.replacement(permalink),
        });
      } catch (error) {
        console.error("Error uploading image:", error);
        failedCount++;
      }
    }

    const updatedMarkdown =
      replacements.length > 0
        ? replacements
            .sort((a, b) => b.start - a.start)
            .reduce((markdown, replacement) => {
              return markdown.slice(0, replacement.start) + replacement.value + markdown.slice(replacement.end);
            }, md)
        : md;

    const shouldReplaceMarkdown = replaceMarkdown && failedCount === 0 && updatedMarkdown !== md;

    if (shouldReplaceMarkdown) {
      await this.app.vault.modify(activeEditor.file, updatedMarkdown);
    }

    if (!options.silent) {
      if (failedCount > 0) {
        new Notice(
          i18next.t("service.notice_upload_images_partial", { count: replacements.length, failed: failedCount }),
        );
      } else {
        new Notice(i18next.t("service.notice_upload_images_success", { count: replacements.length }));
      }
    }

    return {
      processedCount: replacements.length,
      uploadedCount,
      reusedCount,
      failedCount,
      markdown: updatedMarkdown,
      replaced: shouldReplaceMarkdown,
    };
  }

  public async uploadImage(file: TFile): Promise<string> {
    const fileData = await this.app.vault.readBinary(file);
    const body = this.createMultipartBody(file.name, file.extension, fileData);
    const attachment = (await requestUrl({
      url: `${this.site.url}/apis/uc.api.storage.halo.run/v1alpha1/attachments/-/upload`,
      method: "POST",
      contentType: body.contentType,
      headers: this.authHeaders,
      body: body.data,
    }).json) as Attachment;

    const permalink = attachment.status?.permalink;

    if (!permalink) {
      throw new Error("Halo attachment response has no permalink");
    }

    if (permalink.startsWith("http://") || permalink.startsWith("https://")) {
      return permalink;
    }

    return `${this.site.url}${permalink}`;
  }

  private getCachedImagePermalink(file: TFile): string | undefined {
    const cacheEntry = this.settings.imageUploadCache[this.site.url]?.[file.path];

    if (!cacheEntry || !this.isSameImageFile(file, cacheEntry)) {
      return undefined;
    }

    return cacheEntry.permalink;
  }

  private cacheImagePermalink(file: TFile, permalink: string, imageReference: LocalImageReference): void {
    const siteCache = this.settings.imageUploadCache[this.site.url] ?? {};
    siteCache[file.path] = {
      filePath: file.path,
      linkType: imageReference.linkType,
      size: file.stat.size,
      mtime: file.stat.mtime,
      permalink,
      updatedAt: Date.now(),
      wikiAlias: imageReference.wikiAlias,
    };
    this.settings.imageUploadCache[this.site.url] = siteCache;
  }

  private cacheImageReference(file: TFile, imageReference: LocalImageReference): void {
    const siteCache = this.settings.imageUploadCache[this.site.url] ?? {};
    const cacheEntry = siteCache[file.path];

    if (!cacheEntry) {
      return;
    }

    siteCache[file.path] = {
      ...cacheEntry,
      linkType: imageReference.linkType,
      updatedAt: Date.now(),
      wikiAlias: imageReference.wikiAlias,
    };
    this.settings.imageUploadCache[this.site.url] = siteCache;
  }

  private isSameImageFile(file: TFile, cacheEntry: ImageUploadCacheEntry): boolean {
    return cacheEntry.size === file.stat.size && cacheEntry.mtime === file.stat.mtime;
  }

  private restoreCachedLocalImageLinks(markdown: string): string {
    const markdownImageRegex = /!\[[^\]\n]*\]\(([^)\n]+)\)/g;
    const wikiEmbedRegex = /!\[\[([^\]\n]+)\]\]/g;
    const replacements: { start: number; end: number; value: string }[] = [];
    let match = markdownImageRegex.exec(markdown);

    while (match !== null) {
      const target = parseMarkdownImageTarget(match[1]);

      if (!target || !isRemotePath(target.path)) {
        match = markdownImageRegex.exec(markdown);
        continue;
      }

      const cacheEntry = this.getCachedLocalImageEntry(target.path);

      if (!cacheEntry) {
        match = markdownImageRegex.exec(markdown);
        continue;
      }

      if (cacheEntry.linkType === "markdown") {
        const targetOffset = match[0].indexOf(match[1]) + target.start;

        replacements.push({
          start: match.index + targetOffset,
          end: match.index + targetOffset + target.rawPath.length,
          value: formatMarkdownImagePath(cacheEntry.filePath),
        });
      } else {
        replacements.push({
          start: match.index,
          end: match.index + match[0].length,
          value: formatWikiImageEmbed(cacheEntry, getMarkdownImageAlt(match[0])),
        });
      }

      match = markdownImageRegex.exec(markdown);
    }

    match = wikiEmbedRegex.exec(markdown);

    while (match !== null) {
      const linkText = match[1].trim();
      const linkPath = decodeMarkdownPath(getLinkpath(linkText));

      if (!isRemotePath(linkPath)) {
        match = wikiEmbedRegex.exec(markdown);
        continue;
      }

      const cacheEntry = this.getCachedLocalImageEntry(linkPath);

      if (!cacheEntry) {
        match = wikiEmbedRegex.exec(markdown);
        continue;
      }

      replacements.push({
        start: match.index,
        end: match.index + match[0].length,
        value: formatWikiImageEmbed(cacheEntry, getWikiImageAlias(linkText)),
      });

      match = wikiEmbedRegex.exec(markdown);
    }

    return replacements
      .sort((a, b) => b.start - a.start)
      .reduce((updatedMarkdown, replacement) => {
        return updatedMarkdown.slice(0, replacement.start) + replacement.value + updatedMarkdown.slice(replacement.end);
      }, markdown);
  }

  private getCachedLocalImageEntry(permalink: string): ImageUploadCacheEntry | undefined {
    const siteCache = this.settings.imageUploadCache[this.site.url] ?? {};
    const normalizedPermalink = this.normalizePermalink(permalink);

    for (const cacheEntry of Object.values(siteCache)) {
      if (this.normalizePermalink(cacheEntry.permalink) !== normalizedPermalink) {
        continue;
      }

      const file = this.app.vault.getAbstractFileByPath(cacheEntry.filePath);

      if (file instanceof TFile && isImageFile(file) && this.isSameImageFile(file, cacheEntry)) {
        return cacheEntry;
      }
    }

    return undefined;
  }

  private normalizePermalink(permalink: string): string {
    const absolutePermalink =
      permalink.startsWith("http://") || permalink.startsWith("https://")
        ? permalink
        : `${this.site.url}${permalink.startsWith("/") ? "" : "/"}${permalink}`;

    try {
      const url = new URL(absolutePermalink);
      return `${url.origin}${decodeURI(url.pathname)}${decodeURI(url.search)}${decodeURI(url.hash)}`;
    } catch {
      try {
        return decodeURI(absolutePermalink);
      } catch {
        return absolutePermalink;
      }
    }
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

  private createMultipartBody(
    filename: string,
    extension: string,
    fileData: ArrayBuffer,
  ): { contentType: string; data: ArrayBuffer } {
    const boundary = `----obsidian-halo-${randomUUID()}`;
    const mimeType = IMAGE_MIME_TYPES[extension.toLowerCase()] || "application/octet-stream";
    const safeFilename = filename.replace(/["\r\n]/g, "_");
    const encoder = new TextEncoder();
    const header = encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFilename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    );
    const footer = encoder.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(header.length + fileData.byteLength + footer.length);

    body.set(header, 0);
    body.set(new Uint8Array(fileData), header.length);
    body.set(footer, header.length + fileData.byteLength);

    return {
      contentType: `multipart/form-data; boundary=${boundary}`,
      data: body.buffer,
    };
  }
}

export default HaloService;
