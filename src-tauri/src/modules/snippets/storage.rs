/*
 * 片段库 · 本地存储封装
 * ------------------------------------------------------------------
 * 模块不直接操作 sled，只调用 core 的通用 KV 接口，并声明自己的命名空间。
 * 命名空间 "snippets:items"，与其它模块的数据完全隔离（删本模块只需删这个命名空间）。
 *
 * key = 片段 id（uuid），value = 整条 Snippet 的 JSON。
 * 之所以一条一个 key 而不是整库存成一个数组：改一条只写一条，
 * 而且 core::storage 的 list_json 对「单条坏数据」是跳过而不是整体报错，
 * 一条记录反序列化失败不会把整个片段库锁死。
 * @Author: fu
 */
use anyhow::Result;

use crate::core::storage::StorageService;
use crate::modules::snippets::models::{sort_snippets, Snippet};

/* 片段表：key = 片段 id */
pub const NS_SNIPPETS: &str = "snippets:items";

/* 列出全部片段，已按「置顶 → 最近更新」排好序 */
pub fn list(svc: &StorageService) -> Result<Vec<Snippet>> {
    let mut list: Vec<Snippet> = svc.list_json(NS_SNIPPETS)?;
    sort_snippets(&mut list);
    Ok(list)
}

pub fn get(svc: &StorageService, id: &str) -> Result<Option<Snippet>> {
    svc.get_json(NS_SNIPPETS, id)
}

pub fn put(svc: &StorageService, snippet: &Snippet) -> Result<()> {
    svc.put_json(NS_SNIPPETS, &snippet.id, snippet)
}

/* 删除，返回它是否原本存在 */
pub fn delete(svc: &StorageService, id: &str) -> Result<bool> {
    svc.remove(NS_SNIPPETS, id)
}
