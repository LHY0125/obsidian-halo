import { describe, expect, it } from "@rstest/core";
import { createFakeClient } from "./mcp-mock";

/**
 * 这个假客户端本身也是被测对象。
 *
 * 它是全部服务层测试的地基：它若把一个失败吞掉，上层「写入失败会重试 / 会报错」的用例
 * 会全部变成静默的假绿 —— 而那正是最难发现的一类问题。
 */
describe("createFakeClient", () => {
  it("async responder 抛错时，两个入口都要把失败传播出去", async () => {
    // 关键在于 responder 是 async：不 await 的话 rejection 不会被传播，
    // 调用看起来成功，而同一个 responder 交给 callToolJson 却会正确地抛。
    const { client } = createFakeClient(async () => {
      throw new Error("boom");
    });

    await expect(client.callToolJson("halo_create_post")).rejects.toThrow("boom");
    await expect(client.callToolVoid("halo_create_post")).rejects.toThrow("boom");
  });

  it("responder 抛错的那一次调用仍留在 calls 里", async () => {
    // 先记录再求值：否则「失败的那次没有打 MCP」这类断言会假阳性
    const { client, calls } = createFakeClient(() => {
      throw new Error("boom");
    });

    await expect(client.callToolJson("halo_get_post")).rejects.toThrow("boom");

    expect(calls).toEqual([{ args: {}, method: "callToolJson", name: "halo_get_post" }]);
  });
});
