/*
 * LogSight 模块本地存储封装
 * ------------------------------------------------------------------
 * 模块不直接操作 sled，只调用 core 的通用 KV 接口，并声明自己的命名空间。
 * 命名空间前缀统一为 "logsight:"，与其它模块的数据完全隔离。
 * @Author: fu
 */
use anyhow::Result;

use crate::core::storage::StorageService;
use crate::modules::logsight::models::{LogbackServerConfig, ServerConfig};

/* 服务器配置表：key = server_id */
pub const NS_SERVERS: &str = "logsight:servers";
/* logback 解析结果表：key = server_id */
pub const NS_LOGBACK: &str = "logsight:logback_configs";

/* ===== 服务器配置 CRUD ===== */

pub fn save_server(svc: &StorageService, server: &ServerConfig) -> Result<()> {
    svc.put_json(NS_SERVERS, &server.id, server)
}

pub fn delete_server(svc: &StorageService, id: &str) -> Result<bool> {
    svc.remove(NS_SERVERS, id)
}

/* 列出全部服务器：按最近连接时间倒序，未连接过的按创建时间倒序 */
pub fn list_servers(svc: &StorageService) -> Result<Vec<ServerConfig>> {
    let mut list: Vec<ServerConfig> = svc.list_json(NS_SERVERS)?;
    list.sort_by(|a, b| {
        let ta = a.last_connected_at.unwrap_or(a.created_at);
        let tb = b.last_connected_at.unwrap_or(b.created_at);
        tb.cmp(&ta)
    });
    Ok(list)
}

/* ===== logback 配置 CRUD ===== */

pub fn save_logback_config(svc: &StorageService, config: &LogbackServerConfig) -> Result<()> {
    svc.put_json(NS_LOGBACK, &config.server_id, config)
}

pub fn get_logback_config(
    svc: &StorageService,
    server_id: &str,
) -> Result<Option<LogbackServerConfig>> {
    svc.get_json(NS_LOGBACK, server_id)
}

pub fn delete_logback_config(svc: &StorageService, server_id: &str) -> Result<bool> {
    svc.remove(NS_LOGBACK, server_id)
}
