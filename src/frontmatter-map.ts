/** `halo.visible` 的三个合法取值，与 Halo Post 的 schema 一致 */
export type PostVisible = "PUBLIC" | "INTERNAL" | "PRIVATE";

const VISIBLE_VALUES: readonly string[] = ["PUBLIC", "INTERNAL", "PRIVATE"];

/**
 * frontmatter `halo:` 下 6 个元数据字段的**已校验**形态。
 *
 * 这 6 个键名与 `Post.spec` 上的同名键逐一对应 —— `applyPostFrontmatter` 直接把它展开进 `spec`。
 * 代价是 **tsc 看不见名字写错**（`@halo-dev/api-client` 解析不了，`Post` 退化成 `any`，见 CLAUDE.md），
 * 所以 `tests/service/local-content.test.ts` 里每个字段都必须有一条「真的落进 spec 了」的断言。
 *
 * **稀疏是契约**：只有 frontmatter 真正写了的键才会出现在这个对象上。展开时「没这个键」
 * 就等于「不改动」，这正是 spec 要求的「没写就跟随远端」。
 */
export interface HaloPostFields {
  visible?: PostVisible;
  pinned?: boolean;
  priority?: number;
  publishTime?: string;
  allowComment?: boolean;
  template?: string;
}

/**
 * 校验结果。失败时**只给 i18n 键与参数，不渲染文案** —— 本模块是纯函数，
 * 按 `transport/errors.ts` 已确立的分层，依赖 i18next 的渲染放在 UI 侧。
 */
export type HaloFieldsResult =
  | { ok: true; fields: HaloPostFields }
  | { ok: false; key: string; params: Record<string, string> };

/**
 * 把 frontmatter 里的原值转成给用户看的文本。
 *
 * 对象/数组走 JSON：`String({})` 得到的是 `[object Object]`，而报错必须能让用户对上他写的那一行。
 */
function formatValue(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return String(value);
  }

  return JSON.stringify(value) ?? String(value);
}

/**
 * 「写了吗」的判据。**`null` 与缺键同义** —— YAML 里 `visible:` 这种空值自然解析成 null，
 * 而把它判成「写错了」会逼用户去改一行他并没有写错的配置。
 */
function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * 把 frontmatter 的 `halo` 对象校验成一组可落地的字段。
 *
 * 入参取 `unknown` 而不是 `HaloPostFrontmatter`：本模块不该依赖 `service/`，
 * 而 `halo` 在运行时本来就可能是任何东西（笔记是人手写的）。
 *
 * 校验的收益集中在**一处**：`visible` 写成 `public`（小写）时服务端若原样接受，
 * 前台会静默变成默认可见性；若拒绝，用户只拿到一句「发布失败」+ 服务端原文。
 * 两种都不如本地直接说清「哪一行、写了什么、该写什么」。
 */
export function parseHaloPostFields(halo: unknown): HaloFieldsResult {
  const fields: HaloPostFields = {};

  if (typeof halo !== "object" || halo === null || Array.isArray(halo)) {
    return { ok: true, fields };
  }

  const source = halo as Record<string, unknown>;

  const visible = source.visible;

  if (isPresent(visible)) {
    const trimmed = typeof visible === "string" ? visible.trim() : undefined;

    if (trimmed === undefined || !VISIBLE_VALUES.includes(trimmed)) {
      return { ok: false, key: "frontmatter.error_visible", params: { value: formatValue(visible) } };
    }

    fields.visible = trimmed as PostVisible;
  }

  for (const field of ["pinned", "allowComment"] as const) {
    const value = source[field];

    if (!isPresent(value)) {
      continue;
    }

    if (typeof value !== "boolean") {
      return { ok: false, key: "frontmatter.error_boolean", params: { field, value: formatValue(value) } };
    }

    fields[field] = value;
  }

  const priority = source.priority;

  if (isPresent(priority)) {
    if (typeof priority !== "number" || !Number.isInteger(priority)) {
      return {
        ok: false,
        key: "frontmatter.error_integer",
        params: { field: "priority", value: formatValue(priority) },
      };
    }

    fields.priority = priority;
  }

  const publishTime = source.publishTime;

  if (isPresent(publishTime)) {
    if (typeof publishTime !== "string") {
      return {
        ok: false,
        key: "frontmatter.error_string",
        params: { field: "publishTime", value: formatValue(publishTime) },
      };
    }

    const trimmed = publishTime.trim();

    // 空串是**合法值**，语义是「立即发布」（spec §5.1）。必须在这里短路：
    // `Date.parse("")` 是 NaN，不短路会把这个契约规定的合法值判成非法。
    if (trimmed !== "" && Number.isNaN(Date.parse(trimmed))) {
      return { ok: false, key: "frontmatter.error_publish_time", params: { value: formatValue(publishTime) } };
    }

    fields.publishTime = trimmed;
  }

  const template = source.template;

  if (isPresent(template)) {
    if (typeof template !== "string") {
      return {
        ok: false,
        key: "frontmatter.error_string",
        params: { field: "template", value: formatValue(template) },
      };
    }

    fields.template = template.trim();
  }

  return { ok: true, fields };
}
