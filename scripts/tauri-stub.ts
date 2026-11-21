/*
 * 纯逻辑自测用的 Tauri IPC 桩。
 * ------------------------------------------------------------------
 * `@/core/ipc` 的 `call()` 走 `@tauri-apps/api/core` 的 `invoke`，而那个函数
 * 就是 `window.__TAURI_INTERNALS__.invoke(cmd, args, options)`
 * （见 `node_modules/@tauri-apps/api/core.js` 的 `async function invoke`）。
 * node 里没有 `window`，所以这里把它造出来。
 *
 * 与 `localstorage-stub.ts` 同款：靠 ES 模块「按 import 顺序求值」生效 ——
 * **在测试文件里写在最前面**（见 `logic-test.ts` 顶部的两条约定）。
 *
 * 为什么值得有它：store 这类「事件流与 IPC 返回竞态」的逻辑，
 * 过去只能靠论证，没法跑断言。有了这个桩就能**把时序构造出来**再断言。
 */
export type StubHandler = (args?: Record<string, unknown>) => unknown;

const handlers = new Map<string, StubHandler>();
const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];

/** 给某个命令挂处理器；返回值会被包成 `ApiResponse.data`。抛错则包成 `success: false` */
export function setCommand(cmd: string, fn: StubHandler): void {
  handlers.set(cmd, fn);
}

/** 某个命令被调用了几次（用于断言「确实去对账了」这类行为） */
export function callCount(cmd: string): number {
  return calls.filter((c) => c.cmd === cmd).length;
}

/** 清空处理器与调用记录，避免用例之间互相污染 */
export function resetCommands(): void {
  handlers.clear();
  calls.length = 0;
}

(globalThis as unknown as { window: unknown }).window = {
  __TAURI_INTERNALS__: {
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      const h = handlers.get(cmd);
      /* 没挂处理器的命令一律返回成功 + null：多数调用在用例里无关紧要 */
      if (!h) return { success: true, data: null, error: null };
      try {
        return { success: true, data: await h(args), error: null };
      } catch (e) {
        return {
          success: false,
          data: null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  },
};

export {};
