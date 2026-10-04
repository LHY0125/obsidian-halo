import i18next from "i18next";
import { type App, Notice, TFile, getLinkpath, requestUrl } from "obsidian";
import { randomUUID } from "src/utils/id";
import { renderErrorMessage } from "../i18n/error-message";
import type { HaloSetting, HaloSite, ImageUploadCacheEntry } from "../settings";
import { McpError } from "../transport/errors";
import type { McpClient } from "../transport/mcp-client";
import {
  type LocalImageReference,
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

/**
 * 图片上传模块的运行上下文。
 *
 * 这些函数原先都是 `HaloService` 的私有方法，全部依赖 `this.app` / `this.settings` /
 * `this.site`。抽成模块后改为**显式传参**——依赖看得见，且测试不必再构造整个 service。
 */
export interface ImageUploadContext {
  app: App;
  settings: HaloSetting;
  site: HaloSite;
  /** MCP 客户端。测试注入假的，生产代码传真实实例 */
  client: McpClient;
}

export interface UploadImagesResult {
  processedCount: number;
  uploadedCount: number;
  reusedCount: number;
  failedCount: number;
  markdown?: string;
  replaced: boolean;
}

/**
 * 服务层错误：`key` + `params` 交给 UI 层用 `i18next.t()` 还原成**用户可见文案**。
 *
 * 为什么不用 `McpError`：它要求一个 `McpErrorKind`，而这是**本地前置条件**不满足
 * （图片超过 MCP 的 7 MiB 上限、站点又没配 PAT），不是传输层故障。`McpErrorKind` 是冻结的，
 * 硬塞进 `unknown` 只会让用户看到泛泛的「MCP 请求失败」——而这句本该告诉他去配 PAT。
 * `key` / `params` 的形态刻意与 `McpError` 一致，UI 层按同一套规则渲染。
 */
export class ImageUploadError extends Error {
  readonly key: string;

  constructor(
    key: string,
    readonly params: Record<string, string | number> = {},
  ) {
    super(key);
    this.name = "ImageUploadError";
    this.key = key;
  }
}

/** MCP base64 上传的硬上限：7 MiB。恰好等于它仍走 MCP，超出才回退 REST。 */
export const MCP_UPLOAD_MAX_BYTES = 7 * 1024 * 1024;

/** `MCP_UPLOAD_MAX_BYTES` 的 MiB 表示。提示语里说「7 MiB」比说 7340032 字节有用 */
export const MCP_UPLOAD_MAX_MIB = MCP_UPLOAD_MAX_BYTES / 1024 / 1024;

/** 单个 `String.fromCharCode` 调用的参数个数上限，避免 7 MiB 数组撑爆调用栈 */
const BASE64_CHUNK_SIZE = 0x8000;

export const IMAGE_MIME_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
};

/**
 * 分块编码 base64。
 *
 * 必须分块：`String.fromCharCode(...bytes)` 在 7 MiB 的数组上会因参数过多抛 RangeError，
 * 而这个上限正是我们要支持的大小。
 */
export function toBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_SIZE));
  }

  return btoa(binary);
}

/** 相对 permalink 补站点前缀；已是绝对 URL 的原样返回 */
function toAbsolutePermalink(permalink: string, siteUrl: string): string {
  if (permalink.startsWith("http://") || permalink.startsWith("https://")) {
    return permalink;
  }

  return `${siteUrl}${permalink}`;
}

function isSameImageFile(file: TFile, cacheEntry: ImageUploadCacheEntry): boolean {
  return cacheEntry.size === file.stat.size && cacheEntry.mtime === file.stat.mtime;
}

function getCachedImagePermalink(file: TFile, ctx: ImageUploadContext): string | undefined {
  const cacheEntry = ctx.settings.imageUploadCache[ctx.site.url]?.[file.path];

  if (!cacheEntry || !isSameImageFile(file, cacheEntry)) {
    return undefined;
  }

  return cacheEntry.permalink;
}

function cacheImagePermalink(
  file: TFile,
  permalink: string,
  imageReference: LocalImageReference,
  ctx: ImageUploadContext,
): void {
  const siteCache = ctx.settings.imageUploadCache[ctx.site.url] ?? {};
  siteCache[file.path] = {
    filePath: file.path,
    linkType: imageReference.linkType,
    size: file.stat.size,
    mtime: file.stat.mtime,
    permalink,
    updatedAt: Date.now(),
    wikiAlias: imageReference.wikiAlias,
  };
  ctx.settings.imageUploadCache[ctx.site.url] = siteCache;
}

/**
 * 复用缓存命中时刷新引用形态。
 *
 * 同一个文件可能先以 `![](path)` 出现、后被 `![[path]]` 引用（或反之），
 * 而缓存只存一份 permalink——所以命中缓存也要把 linkType / wikiAlias 更新成当前这次引用的。
 */
function cacheImageReference(file: TFile, imageReference: LocalImageReference, ctx: ImageUploadContext): void {
  const siteCache = ctx.settings.imageUploadCache[ctx.site.url] ?? {};
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
  ctx.settings.imageUploadCache[ctx.site.url] = siteCache;
}

function getCachedLocalImageEntry(permalink: string, ctx: ImageUploadContext): ImageUploadCacheEntry | undefined {
  const siteCache = ctx.settings.imageUploadCache[ctx.site.url] ?? {};
  const normalizedPermalink = normalizePermalink(permalink, ctx.site.url);

  for (const cacheEntry of Object.values(siteCache)) {
    if (normalizePermalink(cacheEntry.permalink, ctx.site.url) !== normalizedPermalink) {
      continue;
    }

    const file = ctx.app.vault.getAbstractFileByPath(cacheEntry.filePath);

    if (file instanceof TFile && isImageFile(file) && isSameImageFile(file, cacheEntry)) {
      return cacheEntry;
    }
  }

  return undefined;
}

/**
 * 把 permalink 归一化成可比较的绝对形式。
 *
 * 远程 markdown 里的链接可能带百分号编码（`my%20logo.png`），而缓存里存的是解码后的路径；
 * 另外 permalink 可能没有前导斜杠。三处差异都要抹平才能判等。
 */
function normalizePermalink(permalink: string, siteUrl: string): string {
  const absolutePermalink =
    permalink.startsWith("http://") || permalink.startsWith("https://")
      ? permalink
      : `${siteUrl}${permalink.startsWith("/") ? "" : "/"}${permalink}`;

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

/**
 * 把 markdown 里的远程图片链接还原成本地路径（`replaceImageLinks` 关闭时使用）。
 *
 * 只还原**能对上缓存且本地文件仍新鲜**的那些，其余远程链接原样保留。
 */
export function restoreCachedLocalImageLinks(markdown: string, ctx: ImageUploadContext): string {
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

    const cacheEntry = getCachedLocalImageEntry(target.path, ctx);

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

    const cacheEntry = getCachedLocalImageEntry(linkPath, ctx);

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

interface AttachmentResult {
  /** `halo_upload_attachment` 把 permalink 放在**扁平字段**上（不同于 REST 的 `status.permalink`） */
  permalink?: string;
}

/** 走 MCP base64 上传（≤ 7 MiB 的主路径） */
async function uploadImageViaMcp(file: TFile, data: ArrayBuffer, ctx: ImageUploadContext): Promise<string> {
  const attachment = await ctx.client.callToolJson<AttachmentResult>("halo_upload_attachment", {
    filename: file.name,
    contentBase64: toBase64(data),
    mediaType: IMAGE_MIME_TYPES[file.extension.toLowerCase()] || "application/octet-stream",
  });

  if (!attachment?.permalink) {
    throw new Error("Halo MCP attachment response has no permalink");
  }

  return toAbsolutePermalink(attachment.permalink, ctx.site.url);
}

/** 走 REST multipart 上传：仅用于超过 7 MiB 的图片，需要 PAT */
async function uploadImageViaRest(file: TFile, data: ArrayBuffer, ctx: ImageUploadContext): Promise<string> {
  const body = createMultipartBody(file.name, file.extension, data);
  const attachment = (await requestUrl({
    url: `${ctx.site.url}/apis/uc.api.storage.halo.run/v1alpha1/attachments/-/upload`,
    method: "POST",
    contentType: body.contentType,
    headers: { Authorization: `Bearer ${ctx.site.token}` },
    body: body.data,
  }).json) as { status?: { permalink?: string } };

  const permalink = attachment.status?.permalink;

  if (!permalink) {
    throw new Error("Halo attachment response has no permalink");
  }

  return toAbsolutePermalink(permalink, ctx.site.url);
}

/**
 * 上传单张图片并返回 permalink。
 *
 * 分流：≤ 7 MiB 走 MCP；> 7 MiB 回退 REST（MCP 有硬上限，见 spec §4.4）。
 * 回退需要 PAT —— 没配就给出错误，而不是发一个注定 401 的请求。
 *
 * 二进制只读一次，读回来的 `ArrayBuffer` 直接交给被选中的那条路径：
 * 判大小与真正上传用的是同一份字节，文件在中途被改动也不会出现「按旧尺寸分流、传新内容」。
 */
export async function uploadImage(file: TFile, ctx: ImageUploadContext): Promise<string> {
  const data = await ctx.app.vault.readBinary(file);

  if (data.byteLength > MCP_UPLOAD_MAX_BYTES) {
    if (!ctx.site.token) {
      // 如实说清「为什么」与「怎么办」：用户据此判断是该压缩图片，还是去站点补一个 PAT。
      // 泛泛的「请求失败」会让他以为是网络问题，反复重试同一张永远传不上去的图。
      throw new ImageUploadError("service.error_image_too_large", {
        limit: MCP_UPLOAD_MAX_MIB,
        name: file.name,
      });
    }

    return uploadImageViaRest(file, data, ctx);
  }

  return uploadImageViaMcp(file, data, ctx);
}

/**
 * 上传一篇笔记里的全部本地图片，可选地回写 markdown。
 *
 * 目标笔记由 `options.file` 显式给出；缺席时才回落到活动编辑器（单篇命令的路径）。
 *
 * 逐张容错：某一张失败只累加 `failedCount`，不影响其余图片。
 * 但只要有任何一张失败，就**整体不写回**本地文件——避免把「有的链接是远程、有的是本地」的
 * 半成品 markdown 落盘。
 */
export async function uploadImages(
  options: { silent?: boolean; replaceMarkdown?: boolean; file?: TFile },
  ctx: ImageUploadContext,
): Promise<UploadImagesResult> {
  // 显式传入的文件优先。批量操作走的就是这条路 —— 它手上是**一个目录里的一批文件**，
  // 而「活动编辑器」只有一个，且与批量的进度毫无关系：若回落到它，批量操作会把每一篇
  // 都当成当前打开的那一篇来上传与回写。
  //
  // `?? ` 而不是真值判断：`TFile` 是对象，但契约上「缺席」只由 `undefined` / `null` 表达，
  // 与全仓的 `null ≡ 缺席` 保持一致。
  const targetFile = options.file ?? ctx.app.workspace.activeEditor?.file;

  if (!targetFile) {
    return {
      processedCount: 0,
      uploadedCount: 0,
      reusedCount: 0,
      failedCount: 0,
      replaced: false,
    };
  }

  const md = await ctx.app.vault.read(targetFile);
  const imageReferences = collectLocalImageReferences(md, targetFile, ctx.app);
  const replaceMarkdown = options.replaceMarkdown ?? ctx.settings.replaceImageLinks;

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
        permalink = getCachedImagePermalink(imageReference.file, ctx);

        if (permalink) {
          cacheImageReference(imageReference.file, imageReference, ctx);
          reusedCount++;
        } else {
          permalink = await uploadImage(imageReference.file, ctx);
          cacheImagePermalink(imageReference.file, permalink, imageReference, ctx);
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

      // 带可操作原因的失败逐条说出来：汇总提示只给一个数字，用户对着「N 张失败」无从下手。
      // **刻意不受 `silent` 约束** —— silent 管的是常规汇总（成功/部分成功），不是「为什么失败」；
      // 发布流程正是以 silent 调用它，而那里的中止提示同样只报数字，这个原因更需要被说出来。
      if (error instanceof ImageUploadError) {
        new Notice(i18next.t(error.key, error.params));
      } else if (error instanceof McpError) {
        // MCP 侧的失败（密钥无效 / 未授权调用该工具 / 网络）原先只进 console —— 而**最可能撞上它的
        // 恰恰是刚升级的用户**：没填 `mcpToken` 时每张小图都 401，用户却只看到「N 张失败」。
        // 走共享渲染器，拿到的是可操作的处置指引（核对密钥 / 为该密钥勾工具授权 / 检查端点）。
        new Notice(renderErrorMessage(error));
      }
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
    await ctx.app.vault.modify(targetFile, updatedMarkdown);
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

function createMultipartBody(
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
