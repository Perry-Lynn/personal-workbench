/*
 * 纯逻辑自测用的 localStorage 桩。
 * ------------------------------------------------------------------
 * `alerts.ts` 在**模块顶层**就会读 localStorage 恢复「已提醒」状态，
 * 所以这个桩必须在它之前执行 —— 靠 ES 模块「按 import 顺序求值」保证：
 * 在测试文件里把 `import './localstorage-stub'` 写在最前面即可。
 *
 * 用内存 Map 代替，不落盘，跑完即弃。
 */
const store = new Map<string, string>();

(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    store.set(k, String(v));
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
} as Storage;

export {};
