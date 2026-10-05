import { describe, expect, test } from "@rstest/core";
import { CONTENT_TOOLSETS, type ContentKind } from "../src/content-kind";

describe("content-kind", () => {
  test("两种内容类型的工具名逐项不同，且都带正确的前缀", () => {
    const post = CONTENT_TOOLSETS.post;
    const page = CONTENT_TOOLSETS.page;

    for (const key of Object.keys(post) as (keyof typeof post)[]) {
      expect(post[key]).toMatch(/^halo_[a-z_]*post/);
      expect(page[key]).toMatch(/^halo_[a-z_]*single_page/);
      expect(post[key]).not.toBe(page[key]);
    }
  });

  test("页面没有文章独有的工具（发布状态是两套）", () => {
    expect(CONTENT_TOOLSETS.post.setPublish).toBe("halo_set_post_publish_state");
    expect(CONTENT_TOOLSETS.page.setPublish).toBe("halo_set_single_page_publish_state");
  });

  test("每一种内容类型都有完整的 7 个工具", () => {
    const keys = ["list", "get", "create", "update", "setPublish", "recycle", "restore"] as const;

    for (const kind of ["post", "page"] as ContentKind[]) {
      for (const key of keys) {
        expect(CONTENT_TOOLSETS[kind][key]).toBeTruthy();
      }
    }
  });
});
