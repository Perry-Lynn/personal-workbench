use std::path::PathBuf;
use tauri::command;
use tauri_plugin_shell::ShellExt;
use crate::core::api::ApiResponse;

#[command]
pub async fn workbench_open_directory(app: tauri::AppHandle, path: String) -> ApiResponse<()> {
    let p = PathBuf::from(path.trim());
    if !p.is_absolute() { return ApiResponse::err("目录路径必须是绝对路径"); }
    match std::fs::metadata(&p) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return ApiResponse::err("所选路径不是目录"),
        Err(e) => return ApiResponse::err(format!("目录不可访问：{e}")),
    }
    match app.shell().open(p.to_string_lossy().to_string(), None) {
        Ok(()) => ApiResponse::ok(()),
        Err(e) => ApiResponse::err(format!("系统无法打开目录：{e}")),
    }
}

#[command]
pub async fn workbench_open_url(app: tauri::AppHandle, url: String) -> ApiResponse<()> {
    let parsed = match url::Url::parse(url.trim()) {
        Ok(value) => value,
        Err(e) => return ApiResponse::err(format!("网址无效：{e}")),
    };
    if !matches!(parsed.scheme(), "http" | "https") || !parsed.username().is_empty() || parsed.password().is_some() {
        return ApiResponse::err("仅允许不含用户名或密码的 HTTP(S) 网址");
    }
    match app.shell().open(parsed.to_string(), None) {
        Ok(()) => ApiResponse::ok(()),
        Err(e) => ApiResponse::err(format!("系统无法打开网址：{e}")),
    }
}
