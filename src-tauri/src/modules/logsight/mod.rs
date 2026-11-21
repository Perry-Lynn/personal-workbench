/*
 * LogSight 模块（SSH 远程日志查看）
 * ------------------------------------------------------------------
 * 命令前缀统一为 logsight_，事件名统一为 logsight:*，
 * 存储命名空间统一为 logsight:*，避免与后续模块冲突。
 * @Author: fu
 */
pub mod commands;
pub mod models;
pub mod services;
pub mod storage;

#[allow(unused_imports)]
pub use services::{LogStreamService, SSHService};

/* ===== 前端监听的事件名 =====
 * 统一加 logsight: 前缀，避免多模块共存时事件名冲突。
 * 前端对应监听位置：src/features/logsight/LogSightModule.tsx
 */
/* 会话状态变化（连接中 / 已连接 / 流式中 / 错误 ...） */
pub const EVENT_SESSION_STATUS: &str = "logsight:log-session-status";
/* 批量推送的日志行 */
pub const EVENT_LOG_LINES: &str = "logsight:log-lines";
