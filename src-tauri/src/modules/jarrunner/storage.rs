/*
 * JAR 运行器 · 本地存储封装
 * ------------------------------------------------------------------
 * 只存**运行配置**（jar 路径 / JDK / 参数 / 工作目录 / 环境变量），
 * 运行记录与日志都在内存里（进程一退出日志就没意义了，留在内存足够）。
 *
 * 命名空间 "jarrunner:configs"，与其它模块的数据完全隔离。
 * key = 配置 id：改一份只写一条，且 core::storage 的 list_json 对「单条坏数据」
 * 是跳过而不是整体报错 —— 一份配置读不出来不会把整个列表锁死。
 * @Author: fu
 */
use anyhow::Result;

use crate::core::storage::StorageService;
use crate::modules::jarrunner::models::JarConfig;

pub const NS_CONFIGS: &str = "jarrunner:configs";

/** 列出全部配置（最近改过的在前） */
pub fn list(svc: &StorageService) -> Result<Vec<JarConfig>> {
    let mut list: Vec<JarConfig> = svc.list_json(NS_CONFIGS)?;
    sort_configs(&mut list);
    Ok(list)
}

pub fn get(svc: &StorageService, id: &str) -> Result<Option<JarConfig>> {
    svc.get_json(NS_CONFIGS, id)
}

pub fn put(svc: &StorageService, cfg: &JarConfig) -> Result<()> {
    svc.put_json(NS_CONFIGS, &cfg.id, cfg)
}

/** 删除，返回它是否原本存在 */
pub fn delete(svc: &StorageService, id: &str) -> Result<bool> {
    svc.remove(NS_CONFIGS, id)
}

/**
 * 排序：最近改过的在前，同时间戳按名字稳定排序。
 *
 * 为什么不是按名字排：一个人常跑的 jar 往往就两三个，而「上一次改的那份」
 * 正是他回来要点的那份 —— 时间序比字母序更能命中意图。
 */
fn sort_configs(list: &mut [JarConfig]) {
    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| a.name.cmp(&b.name)));
}
