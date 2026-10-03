import { rs } from "@rstest/core";
import type { App, RequestUrlParam } from "obsidian";
import { TFile, requestUrl } from "obsidian";
import { CURRENT_SETTINGS_VERSION, type HaloSetting, type HaloSite } from "../../src/settings";

/** 测试用站点。url 无尾斜杠（即 `normalizeSite()` 的产物） */
export const TEST_SITE: HaloSite = {
  name: "Halo",
  url: "https://halo.example.com",
  token: "token",
  mcpToken: "",
  default: true,
};

interface RequestUrlMock {
  mock: {
    calls: [RequestUrlParam][];
  };
  mockImplementation: (implementation: (request: RequestUrlParam) => unknown) => void;
  mockReset: () => void;
}

/** `tests/setup.ts` 把 obsidian 的 requestUrl 整体 mock 成了 `rs.fn()`，这里取回它的 mock 接口 */
export function requestUrlMock(): RequestUrlMock {
  return requestUrl as unknown as RequestUrlMock;
}

export interface MockAppParts {
  app: App;
  contents: Map<string, string>;
  fileManager: {
    processFrontMatter: ReturnType<typeof rs.fn>;
  };
  metadataCache: {
    getFileCache: ReturnType<typeof rs.fn>;
    getFirstLinkpathDest: ReturnType<typeof rs.fn>;
  };
  vault: {
    create: ReturnType<typeof rs.fn>;
    getAbstractFileByPath: ReturnType<typeof rs.fn>;
    modify: ReturnType<typeof rs.fn>;
    read: ReturnType<typeof rs.fn>;
    readBinary: ReturnType<typeof rs.fn>;
  };
}

export function createSettings(overrides: Partial<HaloSetting> = {}): HaloSetting {
  return {
    settingsVersion: CURRENT_SETTINGS_VERSION,
    sites: [TEST_SITE],
    publishByDefault: false,
    replaceImageLinks: true,
    imageUploadCache: {},
    ...overrides,
  };
}

export function createFile(path: string, size = 100, mtime = 1000): TFile {
  const file = new TFile();
  const name = path.split("/").pop() || path;
  const extension = name.includes(".") ? name.split(".").pop() || "" : "";
  const basename = extension ? name.slice(0, -(extension.length + 1)) : name;
  const parentPath = path.split("/").slice(0, -1).join("/");

  Object.assign(file, {
    basename,
    extension,
    name,
    parent: parentPath
      ? {
          name: parentPath.split("/").pop() || parentPath,
          path: parentPath,
        }
      : null,
    path,
    stat: {
      ctime: mtime,
      mtime,
      size,
    },
  });

  return file;
}

export interface MockAppOptions {
  /**
   * 覆盖 `vault.readBinary` 的实现。
   *
   * 图片上传的边界用例靠它指定图片的**真实字节数**——分流判据用的是读回来的字节数，
   * 而不是 `file.stat.size`（后者由 `createFile()` 的 `size` 参数控制，两者相互独立）。
   */
  readBinary?: (file: TFile) => Promise<ArrayBufferLike>;
}

export function createMockApp(
  markdown: string,
  activeFile: TFile,
  files: TFile[],
  options: MockAppOptions = {},
): MockAppParts {
  const contents = new Map<string, string>([[activeFile.path, markdown]]);
  const filesByPath = new Map<string, TFile>([[activeFile.path, activeFile]]);

  for (const file of files) {
    filesByPath.set(file.path, file);
  }

  const vault = {
    // 拉取远端文章要新建本地笔记；登记进 contents / filesByPath，
    // 之后 `read`、`getAbstractFileByPath` 就能像真 vault 一样看到它
    create: rs.fn(async (path: string, data: string) => {
      const file = createFile(path);

      contents.set(path, data);
      filesByPath.set(path, file);

      return file;
    }),
    getAbstractFileByPath: rs.fn((path: string) => filesByPath.get(path)),
    modify: rs.fn(async (file: TFile, updatedMarkdown: string) => {
      contents.set(file.path, updatedMarkdown);
    }),
    read: rs.fn(async (file: TFile) => contents.get(file.path) || ""),
    readBinary: rs.fn(options.readBinary ?? (async () => new TextEncoder().encode("image").buffer)),
  };

  const metadataCache = {
    getFileCache: rs.fn(() => ({ frontmatter: {} })),
    getFirstLinkpathDest: rs.fn((linkPath: string) => filesByPath.get(linkPath)),
  };

  const fileManager = {
    processFrontMatter: rs.fn((file: TFile, callback: (frontmatter: Record<string, unknown>) => void) => {
      callback({});
    }),
  };

  return {
    app: {
      fileManager,
      metadataCache,
      vault,
      workspace: {
        activeEditor: {
          file: activeFile,
        },
        // 拉取远端文章后要把它打开（`pullPost`）；测试只关心「有没有走到这一步」
        getLeaf: rs.fn(() => ({ openFile: rs.fn(async () => undefined) })),
      },
    } as unknown as App,
    contents,
    fileManager,
    metadataCache,
    vault,
  };
}
