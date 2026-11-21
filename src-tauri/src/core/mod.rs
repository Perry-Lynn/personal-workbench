/*
 * 工作台核心层
 * ------------------------------------------------------------------
 * 放「跨模块共用」的能力，模块之间不直接依赖彼此，只依赖这一层：
 *   - api      统一 IPC 响应包 ApiResponse
 *   - crypto   AES-256-GCM + Argon2id 加解密
 *   - storage  sled 本地 KV（按命名空间隔离各模块数据）
 *   - master   工作台主密钥（系统钥匙串）
 *   - dock     程序坞图标切换（macOS 专用，NSApp.setApplicationIconImage_）
 *   - tray     系统菜单栏上的一行文字（macOS 顶部状态栏 / 托盘）
 *   - lifecycle 窗口生命周期：关窗后转入后台（藏窗口 + 藏 Dock 图标 + 菜单栏常驻）
 *   - proc     带超时的子进程执行（jstack / mvn 这类会挂住的命令必须走它）
 *   - ps       进程资源占用与监听端口的采集/解析（jvm 与 spring 共用）
 *   - jdk      扫本机装了哪些 JDK（jvm 看板与 JAR 运行器共用）
 *   - export   导出文本文件（系统保存对话框 + Rust 写盘）。⚠️ 前端那套
 *              `Blob` + `a[download]` 在本应用的 WKWebView 里会被**静默取消**，
 *              导出必须走这里（原因见 export.rs 文件头）
 *   - text     按字符截断（中文按字节切会 panic，各模块口径必须一致）
 *   - time     当前 Unix 毫秒（原先 snippets / jarrunner 三处各有一份逐字相同的实现）
 *
 * 新增模块时优先复用本层能力，不要重复实现加密与存储。
 * @Author: fu
 */
pub mod api;
pub mod crypto;
pub mod dock;
pub mod directories;
pub mod config_backup;
pub mod export;
pub mod jdk;
pub mod lifecycle;
pub mod master;
pub mod proc;
pub mod ps;
pub mod storage;
pub mod text;
pub mod time;
pub mod tray;

/* 便捷 re-export：模块可直接 use crate::core::{ApiResponse, CryptoService, StorageService}。
   当前模块用的是完整路径，所以这里显式允许「未使用」，保留为对外 API。 */
#[allow(unused_imports)]
pub use api::ApiResponse;
#[allow(unused_imports)]
pub use crypto::CryptoService;
#[allow(unused_imports)]
pub use storage::StorageService;
