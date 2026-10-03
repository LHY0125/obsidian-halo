import { beforeEach, describe, expect, it } from "@rstest/core";
import type { App, TFile } from "obsidian";
import { MCP_UPLOAD_MAX_BYTES, toBase64, uploadImage } from "../../src/service/image-upload";
import type { HaloSetting, HaloSite } from "../../src/settings";
import { McpError } from "../../src/transport/errors";
import { createFakeClient } from "../helpers/mcp-mock";
import { createFile, createMockApp, createSettings, requestUrlMock } from "../helpers/obsidian-mocks";

describe("toBase64", () => {
  it("编码已知字节", () => {
    const bytes = new TextEncoder().encode("hello");
    expect(toBase64(bytes.buffer as ArrayBuffer)).toBe("aGVsbG8=");
  });

  it("能处理超过单个 spread 上限的数组，不爆栈", () => {
    // String.fromCharCode(...bytes) 在 7 MiB 的数组上会抛 RangeError，
    // 所以实现必须分块。这里用超过分块大小的数据守住这个性质。
    const big = new Uint8Array(MCP_UPLOAD_MAX_BYTES / 2);
    expect(() => toBase64(big.buffer)).not.toThrow();
    expect(toBase64(big.buffer).length).toBeGreaterThan(0);
  });

  it("空数组编码为空串", () => {
    expect(toBase64(new ArrayBuffer(0))).toBe("");
  });
});

describe("MCP_UPLOAD_MAX_BYTES", () => {
  it("恰好是 7 MiB", () => {
    expect(MCP_UPLOAD_MAX_BYTES).toBe(7 * 1024 * 1024);
    expect(MCP_UPLOAD_MAX_BYTES).toBe(7340032);
  });
});

interface UploadFixture {
  app: App;
  file: TFile;
  settings: HaloSetting;
  site: HaloSite;
}

/**
 * 造一张指定字节数的假图片及配套的 app / settings / site。
 *
 * `sizeInBytes` 决定的是 `vault.readBinary` 读回来的**真实字节数**，也就是分流判据看的值；
 * `siteToken` 是 PAT，只有 > 7 MiB 的 REST 回退路径才会用到。
 */
function setup(sizeInBytes: number, siteToken = ""): UploadFixture {
  const file = createFile("assets/a.png");
  const data = new ArrayBuffer(sizeInBytes);
  const { app } = createMockApp("", file, [file], { readBinary: async () => data });
  const site: HaloSite = {
    name: "s",
    url: "https://blog.example.com",
    token: siteToken,
    mcpToken: "hmcp_x",
    default: true,
  };

  return { app, file, settings: createSettings(), site };
}

describe("uploadImage（≤7 MiB 走 MCP，>7 MiB 回退 REST）", () => {
  beforeEach(() => {
    requestUrlMock().mockReset();
  });

  it("恰好等于 7 MiB 走 MCP（上限是闭区间）", async () => {
    const { client, calls } = createFakeClient(() => ({ permalink: "/upload/a.png" }));
    const { file, app, settings, site } = setup(MCP_UPLOAD_MAX_BYTES);

    await uploadImage(file, { app, settings, site, client });

    expect(calls.map((call) => call.name)).toEqual(["halo_upload_attachment"]);
  });

  it("超过 7 MiB 时回退 REST，不打 MCP 工具", async () => {
    const { client, calls } = createFakeClient(() => ({ permalink: "/upload/a.png" }));
    const { file, app, settings, site } = setup(MCP_UPLOAD_MAX_BYTES + 1, "pat_x");
    const uploads = requestUrlMock();
    uploads.mockImplementation(() => ({ json: { status: { permalink: "/upload/a.png" } } }));

    await uploadImage(file, { app, settings, site, client });

    expect(calls).toHaveLength(0);
    expect(uploads.mock.calls).toHaveLength(1);
  });

  it("超过 7 MiB 但没配 PAT 时给出可操作的错误，不发注定 401 的请求", async () => {
    const { client, calls } = createFakeClient(() => ({ permalink: "/upload/a.png" }));
    const { file, app, settings, site } = setup(MCP_UPLOAD_MAX_BYTES + 1, "");
    const uploads = requestUrlMock();

    const error = await uploadImage(file, { app, settings, site, client }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ params: { size: MCP_UPLOAD_MAX_BYTES + 1 } });

    expect(uploads.mock.calls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("MCP 返回相对 permalink 时补上站点前缀", async () => {
    const { client } = createFakeClient(() => ({ permalink: "/upload/a.png" }));
    const { file, app, settings, site } = setup(1024);

    expect(await uploadImage(file, { app, settings, site, client })).toBe("https://blog.example.com/upload/a.png");
  });

  it("MCP 返回绝对 URL 时原样返回，不重复拼接", async () => {
    const { client } = createFakeClient(() => ({ permalink: "https://cdn.example.com/a.png" }));
    const { file, app, settings, site } = setup(1024);

    expect(await uploadImage(file, { app, settings, site, client })).toBe("https://cdn.example.com/a.png");
  });

  it("base64 编码的是真实字节，不是文件名占位", async () => {
    const { client, calls } = createFakeClient(() => ({ permalink: "/upload/a.png" }));
    const file = createFile("assets/a.png");
    const { app } = createMockApp("", file, [file], {
      readBinary: async () => new TextEncoder().encode("hello").buffer,
    });
    const site: HaloSite = {
      name: "s",
      url: "https://blog.example.com",
      token: "",
      mcpToken: "hmcp_x",
      default: true,
    };

    await uploadImage(file, { app, settings: createSettings(), site, client });

    expect(calls[0].args.contentBase64).toBe("aGVsbG8=");
  });

  it("MCP 结果里没有 permalink 时报错，而不是把 undefined 当成链接", async () => {
    const { client } = createFakeClient(() => ({}));
    const { file, app, settings, site } = setup(1024);

    await expect(uploadImage(file, { app, settings, site, client })).rejects.toThrow(
      "Halo MCP attachment response has no permalink",
    );
  });
});
