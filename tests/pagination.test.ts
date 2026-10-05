import { describe, expect, rs, test } from "@rstest/core";
import { fetchAllPages } from "../src/pagination";

function paged<T>(items: T[], page: number, total: number, size: number) {
  const totalPages = Math.ceil(total / size);
  return { items, page, size, total, totalPages, hasNext: page < totalPages };
}

describe("fetchAllPages", () => {
  test("一页就够时只调一次", async () => {
    const fetchPage = rs.fn(async (page: number, size: number) => paged(["a", "b"], page, 2, size));
    const result = await fetchAllPages(fetchPage, { pageSize: 100 });

    expect(result.items).toEqual(["a", "b"]);
    expect(result.truncated).toBe(false);
    expect(fetchPage.mock.calls).toHaveLength(1);
  });

  test("按 hasNext 翻完所有页，结果按页序拼接", async () => {
    // 250 条、每页 100 → 3 页
    const all = Array.from({ length: 250 }, (_, i) => i);
    const fetchPage = rs.fn(async (page: number, size: number) => {
      const start = (page - 1) * size;
      return paged(all.slice(start, start + size), page, all.length, size);
    });

    const result = await fetchAllPages(fetchPage, { pageSize: 100 });

    expect(result.items).toEqual(all);
    expect(result.truncated).toBe(false);
    expect(fetchPage.mock.calls).toHaveLength(3);
  });

  test("hasNext 为真但 items 为空时**必须停下**，否则会无限循环", async () => {
    // 服务端自相矛盾的响应：说还有下一页，却一页都不给。
    // 不挡这一条的话循环永远出不来 —— 而这是一个**会挂住 Obsidian 主线程**的失败模式。
    let calls = 0;
    const fetchPage = rs.fn(async (page: number, size: number) => {
      calls++;
      return { items: [], page, size, total: 999, totalPages: 999, hasNext: true };
    });

    const result = await fetchAllPages(fetchPage, { pageSize: 100 });

    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(true);
    // 第一次拿到空 items 就该停，不该有第二次
    expect(calls).toBe(1);
  });

  test("超过 maxPages 时停下并标记 truncated", async () => {
    const fetchPage = rs.fn(async (page: number, size: number) => paged([page], page, 100000, size));

    const result = await fetchAllPages(fetchPage, { pageSize: 100, maxPages: 3 });

    expect(result.items).toEqual([1, 2, 3]);
    expect(result.truncated).toBe(true);
    expect(fetchPage.mock.calls).toHaveLength(3);
  });

  test("页号从 1 开始（schema 的 minimum 就是 1）", async () => {
    const seen: number[] = [];
    const fetchPage = rs.fn(async (page: number, size: number) => {
      seen.push(page);
      return paged([page], page, 150, size);
    });

    await fetchAllPages(fetchPage, { pageSize: 100 });

    expect(seen).toEqual([1, 2]);
  });
});
