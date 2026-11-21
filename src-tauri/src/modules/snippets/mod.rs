/*
 * 片段库模块
 * ------------------------------------------------------------------
 * 本地可复用的文本片段：Maven / jstack 命令、SQL、logback 配置、排查步骤……
 * 带标签、可搜索、可置顶，一键复制到剪贴板。
 *
 * 子模块：
 *   models     数据结构 + 纯逻辑（归一化 / 排序 / 保存决策），带单测
 *   storage    sled 持久化封装（命名空间 snippets:items）
 *   commands   Tauri IPC 命令层
 *
 * 不涉及主密钥、不涉及网络、不涉及子进程 —— 本模块只读写自己的工作台数据。
 * @Author: fu
 */
pub mod commands;
pub mod models;
pub mod storage;
