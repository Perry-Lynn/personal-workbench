/*
 * LogSight 模块 Tauri IPC 命令层
 * ------------------------------------------------------------------
 * 命令名统一加 logsight_ 前缀，与工作台级命令（workbench_*）和其它模块隔离。
 * 前端对应实现：src/features/logsight/services/tauriApi.ts
 * 所有命令参数用 serde 强类型校验，返回 ApiResponse 统一封装。
 * @Author: fu
 */
use tauri::{command, AppHandle};

use crate::core::api::ApiResponse;
use crate::core::crypto::CryptoService;
/*
 * `app_data_dir` 是 core 的统一实现（失败退化为 "./"），别在本文件再抄一份 ——
 * 这里原来有 7 处内联的 `app.path().app_data_dir().unwrap_or_else(...)`，
 * 各自演化就会和 core 的退化策略分叉（见 core/storage.rs 的注释）。
 */
use crate::core::storage::{app_data_dir, StorageService};
use crate::modules::logsight::models::{
    ConnectTestResult, DirListResult, HostKeyInfo, LogLine, LogSourceProbeResult,
    LogbackServerConfig, PathValidateResult, ServerConfig,
};
use crate::modules::logsight::services::logback_parser::parse_logback_xml;
use crate::modules::logsight::services::{LogStreamService, SSHService};
use crate::modules::logsight::storage as ls_store;

/* ===== 服务器配置 CRUD 命令 ===== */

/*
 * 命令：保存或更新一个服务器配置
 * 接收明文密码/私钥，内部用 master 加密后存入 sled
 */
#[command]
pub async fn logsight_save_server(
    app: AppHandle,
    mut server: ServerConfig,
    password_plain: Option<String>,
    private_key_pem_plain: Option<String>,
    master_password: String,
) -> ApiResponse<ServerConfig> {
    let data_dir = app_data_dir(&app);
    let crypto = CryptoService::new();

    // 1. 加密敏感字段
    if let Some(pwd) = password_plain.as_ref().filter(|s| !s.is_empty()) {
        match crypto.encrypt_str(pwd, &master_password) {
            Ok(c) => server.password_cipher = Some(c),
            Err(e) => return ApiResponse::err(format!("密码加密失败: {:#}", e)),
        }
    }
    if let Some(pem) = private_key_pem_plain.as_ref().filter(|s| !s.is_empty()) {
        match crypto.encrypt_str(pem, &master_password) {
            Ok(c) => server.private_key_cipher = Some(c),
            Err(e) => return ApiResponse::err(format!("私钥加密失败: {:#}", e)),
        }
    }

    // 2. id 为空则新建一个，更新更新时间
    if server.id.is_empty() {
        server.id = format!("svr_{}", hex::encode(rand::random::<[u8; 8]>()));
    }
    server.updated_at = chrono::Utc::now();

    let storage = match StorageService::init(data_dir) {
        Ok(s) => s,
        Err(e) => return ApiResponse::err(format!("{:#}", e)),
    };
    if let Err(e) = ls_store::save_server(&storage, &server) {
        return ApiResponse::err(format!("保存服务器失败: {:#}", e));
    }
    ApiResponse::ok(server)
}

/* 命令：列出所有服务器配置（敏感字段保持密文，由前端按需解密） */
#[command]
pub async fn logsight_list_servers(app: AppHandle) -> ApiResponse<Vec<ServerConfig>> {
    let data_dir = app_data_dir(&app);
    let storage = match StorageService::init(data_dir) {
        Ok(s) => s,
        Err(e) => return ApiResponse::err(format!("{:#}", e)),
    };
    match ls_store::list_servers(&storage) {
        Ok(list) => ApiResponse::ok(list),
        Err(e) => ApiResponse::err(format!("{:#}", e)),
    }
}

/* 命令：删除服务器配置 */
#[command]
pub async fn logsight_delete_server(app: AppHandle, id: String) -> ApiResponse<bool> {
    let data_dir = app_data_dir(&app);
    let storage = match StorageService::init(data_dir) {
        Ok(s) => s,
        Err(e) => return ApiResponse::err(format!("{:#}", e)),
    };
    match ls_store::delete_server(&storage, &id) {
        Ok(deleted) => ApiResponse::ok(deleted),
        Err(e) => ApiResponse::err(format!("{:#}", e)),
    }
}

/* ===== SSH 连接与日志流命令 ===== */

/* 命令：测试 SSH 连通性（不建立缓存，仅做一次性连接测试，返回延迟 ms 与错误） */
#[command]
pub async fn logsight_test_connection(
    server: ServerConfig,
    password_plain: Option<String>,
    private_key_pem_plain: Option<String>,
) -> ApiResponse<ConnectTestResult> {
    let res = SSHService::test_connection(
        &server,
        password_plain.as_deref(),
        private_key_pem_plain.as_deref(),
    )
    .await;
    ApiResponse::ok(res)
}

/* 获取当前 SSH 主机指纹及本机信任状态，不执行登录认证。 */
#[command]
pub async fn logsight_inspect_host_key(server: ServerConfig) -> ApiResponse<HostKeyInfo> {
    match SSHService::inspect_host_key(&server).await {
        Ok(info) => ApiResponse::ok(info),
        Err(e) => ApiResponse::err(format!("读取 SSH 主机指纹失败: {:#}", e)),
    }
}

/* 用户核对指纹并明确确认后，更新本机 known_hosts 记录。 */
#[command]
pub async fn logsight_trust_host_key(
    server: ServerConfig,
    expected_fingerprint: String,
) -> ApiResponse<HostKeyInfo> {
    match SSHService::trust_host_key(&server, &expected_fingerprint).await {
        Ok(info) => ApiResponse::ok(info),
        Err(e) => ApiResponse::err(format!("更新 SSH 主机信任失败: {:#}", e)),
    }
}

/*
 * 命令：启动 tail -F 实时日志流
 * 返回 session_id，后续通过事件 log-lines / log-session-status 接收推送
 */
#[command]
pub async fn logsight_start_tail(
    app: AppHandle,
    server: ServerConfig,
    remote_path: String,
    lines_backtrack: Option<u32>,
    password_plain: Option<String>,
    private_key_pem_plain: Option<String>,
) -> ApiResponse<String> {
    let lines = lines_backtrack.unwrap_or(200).max(1);
    let session_id = format!("ses_{}", hex::encode(rand::random::<[u8; 8]>()));
    match LogStreamService::start_tail(
        app,
        session_id.clone(),
        server,
        remote_path,
        lines,
        password_plain,
        private_key_pem_plain,
    ) {
        Ok(sid) => ApiResponse::ok(sid),
        Err(e) => ApiResponse::err(format!("启动日志流失败: {:#}", e)),
    }
}

/* 命令：停止指定日志流会话 */
#[command]
pub fn logsight_stop_tail(session_id: String) -> ApiResponse<bool> {
    ApiResponse::ok(LogStreamService::stop_tail(&session_id))
}

/* 命令：分页获取历史日志 */
#[command]
pub async fn logsight_fetch_history(
    server: ServerConfig,
    remote_path: String,
    page: Option<u32>,
    page_size: Option<u32>,
    password_plain: Option<String>,
    private_key_pem_plain: Option<String>,
) -> ApiResponse<Vec<LogLine>> {
    match LogStreamService::fetch_history(
        &server,
        &remote_path,
        page.unwrap_or(1).max(1),
        page_size.unwrap_or(500).clamp(10, 5000),
        password_plain.as_deref(),
        private_key_pem_plain.as_deref(),
    )
    .await
    {
        Ok(lines) => ApiResponse::ok(lines),
        Err(e) => ApiResponse::err(format!("获取历史日志失败: {:#}", e)),
    }
}

/* 命令：按时间范围获取历史日志（服务端 awk 按文本时间比较） */
#[command]
pub async fn logsight_fetch_history_by_time(
    server: ServerConfig,
    remote_path: String,
    start_ms: i64,
    end_ms: i64,
    max_lines: Option<u32>,
    offset_lines: Option<u32>,
    password_plain: Option<String>,
    private_key_pem_plain: Option<String>,
) -> ApiResponse<Vec<LogLine>> {
    match LogStreamService::fetch_history_by_time(
        &server,
        &remote_path,
        start_ms,
        end_ms,
        max_lines.unwrap_or(5000).clamp(10, 20000),
        offset_lines.unwrap_or(0),
        password_plain.as_deref(),
        private_key_pem_plain.as_deref(),
    )
    .await
    {
        Ok(lines) => ApiResponse::ok(lines),
        Err(e) => ApiResponse::err(format!("按时间加载日志失败: {:#}", e)),
    }
}

/* 命令：在日志文件中搜索关键字，支持正则/忽略大小写，支持 -v 排除 */
#[command]
pub async fn logsight_search_logs(
    server: ServerConfig,
    remote_path: String,
    keyword: String,
    exclude_keyword: Option<String>,
    regex: Option<bool>,
    case_insensitive: Option<bool>,
    max_lines: Option<u32>,
    password_plain: Option<String>,
    private_key_pem_plain: Option<String>,
) -> ApiResponse<Vec<LogLine>> {
    match LogStreamService::search_logs(
        &server,
        &remote_path,
        &keyword,
        exclude_keyword.as_deref(),
        regex.unwrap_or(false),
        case_insensitive.unwrap_or(true),
        max_lines.unwrap_or(1000).clamp(10, 20000),
        password_plain.as_deref(),
        private_key_pem_plain.as_deref(),
    )
    .await
    {
        Ok(lines) => ApiResponse::ok(lines),
        Err(e) => ApiResponse::err(format!("搜索失败: {:#}", e)),
    }
}

/*
 * 命令：按 traceId 跨文件追踪一次请求的完整链路
 * 服务端 grep 粗筛 + Rust 端精确比对 trace_id 字段，返回按时间升序的链路
 */
#[command]
pub async fn logsight_search_by_trace_id(
    server: ServerConfig,
    remote_path: String,
    trace_id: String,
    max_lines: Option<u32>,
    password_plain: Option<String>,
    private_key_pem_plain: Option<String>,
) -> ApiResponse<Vec<LogLine>> {
    match LogStreamService::search_by_trace_id(
        &server,
        &remote_path,
        &trace_id,
        max_lines.unwrap_or(2000).clamp(10, 20000),
        password_plain.as_deref(),
        private_key_pem_plain.as_deref(),
    )
    .await
    {
        Ok(lines) => ApiResponse::ok(lines),
        Err(e) => ApiResponse::err(format!("链路追踪失败: {:#}", e)),
    }
}

/*
 * 命令：探测服务器上各日志源预设的文件情况
 * 传入日志根目录（如 /var/log/app/logs），
 * 若该服务器已导入 logback 配置则使用自定义预设，否则回退到硬编码预设
 */
#[command]
pub async fn logsight_probe_log_sources(
    app: AppHandle,
    server: ServerConfig,
    base_dir: String,
    password_plain: Option<String>,
    private_key_pem_plain: Option<String>,
) -> ApiResponse<Vec<LogSourceProbeResult>> {
    let data_dir = app_data_dir(&app);
    let logback_config = StorageService::init(data_dir)
        .ok()
        .and_then(|s| ls_store::get_logback_config(&s, &server.id).ok().flatten());

    match LogStreamService::probe_log_sources(
        &server,
        &base_dir,
        password_plain.as_deref(),
        private_key_pem_plain.as_deref(),
        logback_config.as_ref(),
    )
    .await
    {
        Ok(res) => ApiResponse::ok(res),
        Err(e) => ApiResponse::err(format!("探测日志源失败: {:#}", e)),
    }
}

/* ===== logback.xml 配置导入命令 ===== */

/*
 * 命令：解析并保存 logback.xml 配置到指定服务器
 */
#[command]
pub async fn logsight_import_logback_config(
    app: AppHandle,
    server_id: String,
    xml_content: String,
) -> ApiResponse<LogbackServerConfig> {
    let data_dir = app_data_dir(&app);
    let storage = match StorageService::init(data_dir) {
        Ok(s) => s,
        Err(e) => return ApiResponse::err(format!("初始化存储失败: {:#}", e)),
    };
    match parse_logback_xml(&xml_content, &server_id) {
        Ok(config) => {
            if let Err(e) = ls_store::save_logback_config(&storage, &config) {
                return ApiResponse::err(format!("保存配置失败: {:#}", e));
            }
            ApiResponse::ok(config)
        }
        Err(e) => ApiResponse::err(format!("解析 logback.xml 失败: {:#}", e)),
    }
}

/*
 * 命令：获取服务器已保存的 logback 配置
 */
#[command]
pub async fn logsight_get_logback_config(
    app: AppHandle,
    server_id: String,
) -> ApiResponse<Option<LogbackServerConfig>> {
    let data_dir = app_data_dir(&app);
    let storage = match StorageService::init(data_dir) {
        Ok(s) => s,
        Err(e) => return ApiResponse::err(format!("初始化存储失败: {:#}", e)),
    };
    match ls_store::get_logback_config(&storage, &server_id) {
        Ok(config) => ApiResponse::ok(config),
        Err(e) => ApiResponse::err(format!("读取配置失败: {:#}", e)),
    }
}

/*
 * 命令：删除服务器的 logback 配置
 */
#[command]
pub async fn logsight_delete_logback_config(app: AppHandle, server_id: String) -> ApiResponse<()> {
    let data_dir = app_data_dir(&app);
    let storage = match StorageService::init(data_dir) {
        Ok(s) => s,
        Err(e) => return ApiResponse::err(format!("初始化存储失败: {:#}", e)),
    };
    match ls_store::delete_logback_config(&storage, &server_id) {
        Ok(_) => ApiResponse::ok(()),
        Err(e) => ApiResponse::err(format!("删除配置失败: {:#}", e)),
    }
}

/* ===== 服务器目录选择 & 路径校验命令 ===== */

/*
 * 命令：枚举远程服务器指定目录下的条目
 * 前端 Tree 组件懒加载：展开时调用一次，传入节点完整绝对路径
 * 默认路径：/var/log/app/
 */
#[command]
pub async fn logsight_list_server_dir(
    server: ServerConfig,
    remote_path: String,
    password_plain: Option<String>,
    private_key_pem_plain: Option<String>,
) -> ApiResponse<DirListResult> {
    match SSHService::list_directory(
        &server,
        &remote_path,
        password_plain.as_deref(),
        private_key_pem_plain.as_deref(),
    )
    .await
    {
        Ok(res) => ApiResponse::ok(res),
        Err(e) => ApiResponse::err(format!("读取目录失败: {:#}", e)),
    }
}

/*
 * 命令：校验远程路径的合法性、存在性、可读性
 * 前端在用户手输路径后失焦时调用，或选择文件后二次确认
 */
#[command]
pub async fn logsight_validate_server_path(
    server: ServerConfig,
    remote_path: String,
    password_plain: Option<String>,
    private_key_pem_plain: Option<String>,
) -> ApiResponse<PathValidateResult> {
    let res = SSHService::validate_path(
        &server,
        &remote_path,
        password_plain.as_deref(),
        private_key_pem_plain.as_deref(),
    )
    .await;
    ApiResponse::ok(res)
}

/*
 * 命令：解析服务器登录用户主目录（$HOME）
 * 用于前端「家目录」快捷按钮
 */
#[command]
pub async fn logsight_resolve_server_home(
    server: ServerConfig,
    password_plain: Option<String>,
    private_key_pem_plain: Option<String>,
) -> ApiResponse<String> {
    match SSHService::resolve_home(
        &server,
        password_plain.as_deref(),
        private_key_pem_plain.as_deref(),
    )
    .await
    {
        Ok(p) => ApiResponse::ok(p),
        Err(e) => ApiResponse::err(format!("解析主目录失败: {:#}", e)),
    }
}
