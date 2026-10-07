import type { App } from "obsidian";
import type { HaloSetting } from "./settings";

/**
 * 插件实例的**最小契约** —— 弹窗与设置面板只依赖这些成员，不依赖 `HaloPlugin` 这个类。
 *
 * ## 为什么需要这个文件
 *
 * 此前 12 个 UI 文件都写 `import type HaloPlugin from "./main"`，而 `main.ts` 又 import 了
 * 这些 UI 文件 —— 于是「入口点」同时是「类型中心」和「被依赖方」。全是 `import type`，
 * 运行时没有环，但结构上是一个**双向依赖**：`main.ts` 依赖全部 UI，全部 UI 依赖 `main.ts`。
 *
 * 后果不是编译不过，而是**改动成本**：想给某个弹窗换一个更小的依赖面，得先动 `main.ts`；
 * 想把 `main.ts` 拆开，得先解开 12 处回指。类型契约把这个环切断 ——
 * UI 依赖 `HaloPluginContext`（一个接口），`HaloPlugin` 去实现它。
 *
 * ## 为什么是 `interface` 而不是把 `HaloPlugin` 搬出来
 *
 * 搬走类定义会让 `main.ts` 不再是「入口点」，反而更难找。接口的价值在于**它只声明被用到的东西**：
 * 下面三个成员是实测扫出来的全部（`grep -oE 'plugin\.[a-zA-Z]+'` 扫 12 个文件），
 * 不是「照抄 HaloPlugin 的公开面」。所以以后给 `HaloPlugin` 加方法**不需要**改这里 ——
 * 只有 UI 真的要用新成员时才加。
 *
 * ## 与 `Plugin` 的关系
 *
 * `app` 由 Obsidian 的 `Plugin` 基类提供，这里重新声明是为了让接口**自足**：
 * 消费方拿到 `HaloPluginContext` 就能用 `plugin.app`，不必同时 import `Plugin`。
 * `HaloPlugin extends Plugin` 因此天然满足这一条，无需额外实现代码。
 */
export interface HaloPluginContext {
  /** Obsidian 的 `App`（vault / metadataCache / workspace / fileManager 都在它上面） */
  readonly app: App;

  /** 插件设置。**可写** —— 设置面板与站点弹窗会就地改它，然后调 `saveSettings()` 落盘。 */
  settings: HaloSetting;

  /**
   * 把 `settings` 落盘。
   *
   * 返回 `Promise` 但**多数调用方刻意不 await**（设置面板的开关回调是同步的）——
   * 那些位置用 `void` 显式声明。声明成 `Promise<void>` 而不是 `void` 是为了让
   * 「要不要等它写完」这个决定留在调用方，而不是被类型逼成「永远不等」。
   */
  saveSettings(): Promise<void>;
}
