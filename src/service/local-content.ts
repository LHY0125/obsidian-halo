import type { Post } from "@halo-dev/api-client";
import { type App, TFile, getLinkpath, normalizePath } from "obsidian";
import { slugify } from "transliteration";
import type { ImageUploadCacheEntry } from "../settings";

export interface LocalImageReference {
  file: TFile;
  linkType: "markdown" | "wiki";
  start: number;
  end: number;
  replacement: (permalink: string) => string;
  wikiAlias?: string;
}

export interface MarkdownImageTarget {
  path: string;
  rawPath: string;
  start: number;
}

export interface HaloPostFrontmatter {
  title?: string;
  slug?: string;
  excerpt?: string;
  cover?: string;
  categories?: string[];
  tags?: string[];
  halo?: {
    site?: string;
    name?: string;
    publish?: boolean;
  };
}

export interface ApplyPostFrontmatterOptions {
  activeFile: TFile;
  categoryNames?: string[];
  matterData?: HaloPostFrontmatter;
  tagNames?: string[];
  useActiveFileDefaults: boolean;
}

export const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "tif",
  "tiff",
  "webp",
]);

export function applyPostFrontmatter(post: Post, options: ApplyPostFrontmatterOptions): Post {
  const { activeFile, categoryNames, matterData, tagNames, useActiveFileDefaults } = options;
  const nextPost: Post = {
    ...post,
    metadata: {
      ...post.metadata,
      annotations: {
        ...post.metadata.annotations,
      },
    },
    spec: {
      ...post.spec,
      categories: [...(post.spec.categories || [])],
      excerpt: {
        ...post.spec.excerpt,
      },
      htmlMetas: [...(post.spec.htmlMetas || [])],
      tags: [...(post.spec.tags || [])],
    },
  };

  if (matterData?.title) {
    nextPost.spec.title = matterData.title;
  } else if (useActiveFileDefaults) {
    nextPost.spec.title = activeFile.basename;
  }

  if (matterData?.slug) {
    nextPost.spec.slug = matterData.slug;
  } else if (useActiveFileDefaults) {
    nextPost.spec.slug = slugify(nextPost.spec.title, { trim: true });
  }

  if (matterData?.excerpt) {
    nextPost.spec.excerpt.raw = matterData.excerpt;
    nextPost.spec.excerpt.autoGenerate = false;
  }

  if (matterData?.cover) {
    nextPost.spec.cover = matterData.cover;
  }

  if (categoryNames) {
    nextPost.spec.categories = categoryNames;
  }

  if (tagNames) {
    nextPost.spec.tags = tagNames;
  }

  return nextPost;
}

export function formatMarkdownImagePath(path: string): string {
  if (/[\s()<>]/.test(path)) {
    return `<${path}>`;
  }

  return path;
}

export function formatWikiImageEmbed(cacheEntry: ImageUploadCacheEntry, fallbackAlias = ""): string {
  const alias = cacheEntry.wikiAlias || fallbackAlias;

  if (!alias) {
    return `![[${cacheEntry.filePath}]]`;
  }

  return `![[${cacheEntry.filePath}|${alias.replace(/\|/g, "\\|")}]]`;
}

export function getMarkdownImageAlt(markdownImage: string): string {
  const altEnd = markdownImage.indexOf("](");

  if (!markdownImage.startsWith("![") || altEnd <= 2) {
    return "";
  }

  return markdownImage.slice(2, altEnd).replace(/\\]/g, "]");
}

export function collectLocalImageReferences(markdown: string, sourceFile: TFile, app: App): LocalImageReference[] {
  const references: LocalImageReference[] = [];
  const markdownImageRegex = /!\[[^\]\n]*\]\(([^)\n]+)\)/g;
  const wikiEmbedRegex = /!\[\[([^\]\n]+)\]\]/g;

  let match = markdownImageRegex.exec(markdown);

  while (match !== null) {
    const target = parseMarkdownImageTarget(match[1]);

    if (!target || isRemotePath(target.path)) {
      match = markdownImageRegex.exec(markdown);
      continue;
    }

    const file = resolveImageFile(target.path, sourceFile, app);

    if (!file) {
      match = markdownImageRegex.exec(markdown);
      continue;
    }

    const targetOffset = match[0].indexOf(match[1]) + target.start;

    references.push({
      file,
      linkType: "markdown",
      start: match.index + targetOffset,
      end: match.index + targetOffset + target.rawPath.length,
      replacement: (permalink) => permalink,
    });

    match = markdownImageRegex.exec(markdown);
  }

  match = wikiEmbedRegex.exec(markdown);

  while (match !== null) {
    const linkText = match[1].trim();
    const linkPath = decodeMarkdownPath(getLinkpath(linkText));

    if (isRemotePath(linkPath)) {
      match = wikiEmbedRegex.exec(markdown);
      continue;
    }

    const file = resolveImageFile(linkPath, sourceFile, app);

    if (!file) {
      match = wikiEmbedRegex.exec(markdown);
      continue;
    }

    references.push({
      file,
      linkType: "wiki",
      start: match.index,
      end: match.index + match[0].length,
      replacement: (permalink) => `![${getWikiImageAlt(linkText)}](${permalink})`,
      wikiAlias: getWikiImageAlias(linkText),
    });

    match = wikiEmbedRegex.exec(markdown);
  }

  return references;
}

export function parseMarkdownImageTarget(rawTarget: string): MarkdownImageTarget | undefined {
  const trimmedStart = rawTarget.search(/\S/);

  if (trimmedStart === -1) {
    return undefined;
  }

  const trimmed = rawTarget.trim();

  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");

    if (end <= 1) {
      return undefined;
    }

    const rawPath = trimmed.slice(1, end);
    return {
      rawPath,
      path: decodeMarkdownPath(rawPath),
      start: trimmedStart + 1,
    };
  }

  return {
    rawPath: trimmed,
    path: decodeMarkdownPath(trimmed),
    start: trimmedStart,
  };
}

export function decodeMarkdownPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function resolveImageFile(path: string, sourceFile: TFile, app: App): TFile | undefined {
  const linkPath = getLinkpath(path);
  const linkDestination = app.metadataCache.getFirstLinkpathDest(linkPath, sourceFile.path);

  if (linkDestination && isImageFile(linkDestination)) {
    return linkDestination;
  }

  const normalizedPath = normalizePath(linkPath.replace(/^\/+/, ""));
  const absoluteFile = app.vault.getAbstractFileByPath(normalizedPath);

  if (absoluteFile instanceof TFile && isImageFile(absoluteFile)) {
    return absoluteFile;
  }

  const sourceDirectory = sourceFile.parent?.path || "";
  const relativePath = normalizePath(`${sourceDirectory}/${linkPath}`);
  const relativeFile = app.vault.getAbstractFileByPath(relativePath);

  if (relativeFile instanceof TFile && isImageFile(relativeFile)) {
    return relativeFile;
  }

  return undefined;
}

export function isImageFile(file: TFile): boolean {
  return IMAGE_EXTENSIONS.has(file.extension.toLowerCase());
}

export function isRemotePath(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//") || path.startsWith("#");
}

export function getWikiImageAlt(linkText: string): string {
  const alias = getWikiImageAlias(linkText);

  if (!alias || /^\d+(x\d+)?$/.test(alias)) {
    return "";
  }

  return alias.replace(/]/g, "\\]");
}

export function getWikiImageAlias(linkText: string): string {
  return linkText.split("|").slice(1).join("|").trim();
}
