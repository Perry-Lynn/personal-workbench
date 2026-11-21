/*
 * Trae 社区 · 本地缓存（列表 + 分类）
 * ------------------------------------------------------------------
 * 冷启动先把上一次的列表和分类画出来，再去请求网络 —— 打开社区不该先空屏。
 *
 * 缓存只存**原始响应**（Rust 返回的形状），不存归一化后的对象：
 * 归一化逻辑以后改了，旧缓存也能按新逻辑重新解释；存归一化对象反而会读到
 * 「旧版本形状」，升级后容易字段对不上。
 *
 * 写入失败（配额满 / 隐私模式）一律静默：缓存只是体验优化，不该影响主流程。
 * @Author: fu
 */
import type { RawCategories, RawLatest } from './types';

const CACHE_KEY = 'workbench:community:cache:v1';
const CACHE_VERSION = 1;

export interface CommunityCache {
  version: number;
  savedAt: number;
  latest: RawLatest;
  categories: RawCategories;
}

function storage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function hasTopics(raw: RawLatest | null | undefined): boolean {
  return Array.isArray(raw?.topic_list?.topics);
}

function hasCategories(raw: RawCategories | null | undefined): boolean {
  return Array.isArray(raw?.category_list?.categories);
}

/** 读取缓存；结构不完整（半截写入 / 被手改坏）就当没有 */
export function readCache(): CommunityCache | null {
  const store = storage();
  if (!store) return null;
  try {
    const text = store.getItem(CACHE_KEY);
    if (!text) return null;
    const parsed = JSON.parse(text) as Partial<CommunityCache>;
    if (!parsed || parsed.version !== CACHE_VERSION) return null;
    if (!Number.isFinite(parsed.savedAt)) return null;
    if (!hasTopics(parsed.latest) || !hasCategories(parsed.categories)) return null;
    return parsed as CommunityCache;
  } catch {
    return null;
  }
}

/** 写入缓存，返回写入时间；失败返回 null（调用方不需要知道原因） */
export function writeCache(latest: RawLatest, categories: RawCategories, now = Date.now()): number | null {
  const store = storage();
  if (!store) return null;
  try {
    const payload: CommunityCache = {
      version: CACHE_VERSION,
      savedAt: now,
      latest,
      categories,
    };
    store.setItem(CACHE_KEY, JSON.stringify(payload));
    return now;
  } catch {
    return null;
  }
}

export function clearCache(): void {
  try {
    storage()?.removeItem(CACHE_KEY);
  } catch {
    /* 清缓存失败不影响任何事 */
  }
}

export const COMMUNITY_CACHE_KEY = CACHE_KEY;
export const COMMUNITY_CACHE_VERSION = CACHE_VERSION;
