import { describe, expect, test } from "@rstest/core";
import {
  type McpAttachmentItem,
  deleteAttachment,
  fetchAttachments,
  formatBytes,
  toAttachmentItems,
} from "../src/attachment-model";
import { LIST_PAGE_SIZE } from "../src/pagination";
import { createFakeClient } from "./helpers/mcp-mock";

function attachment(overrides: Partial<McpAttachmentItem> = {}): McpAttachmentItem {
  return {
    name: "2e475d53-43f6-489a-9958-f1b14610d655",
    displayName: "QQ20261004-204734.webp",
    groupName: "attachment-group-ypunokwu",
    policyName: "default-policy",
    ownerName: "liuhangyv",
    mediaType: "image/webp",
    size: 43224,
    permalink: "/upload/QQ20261004-204734.webp",
    version: 1,
    ...overrides,
  };
}

describe("toAttachmentItems", () => {
  test("剔除缺 name 的项（删除时 name 是必填入参）", () => {
    expect(toAttachmentItems([attachment({ name: undefined })])).toHaveLength(0);
  });

  test("缺 displayName 时回落成 name，避免一行空白", () => {
    expect(toAttachmentItems([attachment({ displayName: undefined })])[0].displayName).toBe(
      "2e475d53-43f6-489a-9958-f1b14610d655",
    );
  });

  test("缺 version 时回落成 0 —— 删除接口的 expectedVersion 是必填的", () => {
    // ⚠️ 回落成 0 是**有代价**的：服务端会用一个错的版本号去删，多半被拒。
    // 但比 `undefined` 好 —— 后者会被 JSON.stringify 丢掉，服务端报「缺 expectedVersion」，
    // 用户看到的是「参数错误」而不是「这个附件的版本号读不出来」。
    expect(toAttachmentItems([attachment({ version: undefined })])[0].version).toBe(0);
  });

  test("isImage 按 mediaType 判断，而不是按扩展名（⚠️ 该字段目前无生产消费者）", () => {
    // 按扩展名判会漏掉 `.webp` 之外的图片类型，也会把 `.svg` 之外的当图片。
    // mediaType 是服务端探测出来的，比文件名可信。
    //
    // `AttachmentItem.isImage` 在 `attachment-modal.ts` 里**没有任何消费者**（列表不筛类型、
    // 也不显示类型图标），所以这三条断言是它唯一的覆盖 —— 详 `attachment-model.ts` 的字段注释。
    // 用例名里点明这一点，是为了不让「改它就能改弹窗」这个错觉留在这份文件里。
    expect(toAttachmentItems([attachment({ mediaType: "image/png" })])[0].isImage).toBe(true);
    expect(toAttachmentItems([attachment({ mediaType: "application/pdf" })])[0].isImage).toBe(false);
    expect(toAttachmentItems([attachment({ mediaType: undefined })])[0].isImage).toBe(false);
  });

  test("permalink 缺省时回落空串（它不是标识，只是「复制链接」的内容）", () => {
    expect(toAttachmentItems([attachment({ permalink: undefined })])[0].permalink).toBe("");
  });
});

describe("formatBytes", () => {
  test("按 1024 进制换算，保留一位小数", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(43224)).toBe("42.2 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });
});

/**
 * 按页切片的假站点。返回外壳逐字对齐实测：
 * `halo_list_attachments` 回的是 `{ items, page, size, total, totalPages, hasNext }`。
 *
 * 未列出的工具一律抛错 —— 静默返回 `{}` 会把「调了不该调的工具」变成看不见的假绿。
 */
function pagedResponder(all: McpAttachmentItem[]) {
  return (name: string, args: Record<string, unknown>) => {
    if (name !== "halo_list_attachments") {
      throw new Error(`Unexpected tool: ${name}`);
    }

    const page = args.page as number;
    const size = args.size as number;
    const start = (page - 1) * size;
    const totalPages = Math.ceil(all.length / size);

    return {
      items: all.slice(start, start + size),
      page,
      size,
      total: all.length,
      totalPages,
      hasNext: page < totalPages,
    };
  };
}

describe("fetchAttachments", () => {
  test("翻页取全 —— 站点实测 264 个附件，只取一页会让用户以为站点上只有 100 个", async () => {
    const all = Array.from({ length: 264 }, (_, index) => attachment({ name: `attachment-${index}` }));
    const { client, calls } = createFakeClient(pagedResponder(all));

    const result = await fetchAttachments(client);

    expect(result.items).toHaveLength(264);
    expect(result.truncated).toBe(false);
    // 264 条按 100 一页 → 3 页。只取一页的话这里会是 1，而结果会少 164 条。
    expect(calls).toHaveLength(3);
    // 页号从 1 开始递增（schema 的 minimum 就是 1）
    expect(calls.map((call) => call.args.page)).toEqual([1, 2, 3]);
    // 页大小必须是 schema 的 maximum（100），传大了会被服务端拒绝
    expect(calls.every((call) => call.args.size === LIST_PAGE_SIZE)).toBe(true);
  });

  test("触顶时把 truncated 交给调用方 —— 本层既不吞掉也不自己弹提示", async () => {
    // 永远说 hasNext:true 的服务端。`fetchAllPages` 会在 maxPages（默认 20）处停下并标记触顶；
    // 没有这条上限的话这个循环会一直发请求直到 Obsidian 卡死。
    let calls = 0;
    const { client } = createFakeClient(() => {
      calls++;
      return {
        items: [attachment()],
        page: calls,
        size: LIST_PAGE_SIZE,
        total: 9999,
        totalPages: 9999,
        hasNext: true,
      };
    });

    const result = await fetchAttachments(client);

    expect(result.truncated).toBe(true);
    expect(calls).toBe(20);
  });

  test("返回的是映射后的条目 —— 缺 name 的项在取数结果里已经没了", async () => {
    const { client } = createFakeClient(
      pagedResponder([attachment({ name: undefined }), attachment({ name: "kept" })]),
    );

    const result = await fetchAttachments(client);

    expect(result.items.map((item) => item.name)).toEqual(["kept"]);
  });
});

describe("deleteAttachment", () => {
  test("version 一路从列表带到删除（乐观锁的 expectedVersion）", async () => {
    const [item] = toAttachmentItems([attachment({ version: 7 })]);
    const { client, calls } = createFakeClient(() => undefined);

    await deleteAttachment(client, item);

    // 一次断言同时钉住三件事：调了哪个工具、`version` 有没有当 expectedVersion 传下去、
    // 走的是不是写路径（`callToolVoid`）。走 `callToolJson` 的话会在**删成功之后**抛错。
    expect(calls).toEqual([
      {
        name: "halo_delete_attachment",
        args: { name: "2e475d53-43f6-489a-9958-f1b14610d655", expectedVersion: 7 },
        method: "callToolVoid",
      },
    ]);
  });

  test("version 缺失时回落成的 0 也会被传下去 —— undefined 会被 JSON.stringify 丢掉", async () => {
    const [item] = toAttachmentItems([attachment({ version: undefined })]);
    const { client, calls } = createFakeClient(() => undefined);

    await deleteAttachment(client, item);

    // `expectedVersion` 是**必填**的（实测 `required: ["name", "expectedVersion"]`）。
    // 传 undefined 的话这个键会在序列化时消失，服务端报「缺参数」——
    // 而用户此刻需要知道的是「这个附件的版本号读不出来」，不是「参数错误」。
    expect(calls[0].args).toEqual({
      name: "2e475d53-43f6-489a-9958-f1b14610d655",
      expectedVersion: 0,
    });
  });
});
