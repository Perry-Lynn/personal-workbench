/*
 * Maven 助手模块 · Tauri IPC 命令层
 * ------------------------------------------------------------------
 * 命令前缀 maven_，返回统一 ApiResponse<T>。
 *
 * 三条命令，慢的分两种处理：
 *   maven_locate           探测 mvn 与本地仓库（跑一次 mvn -v，20 秒内）
 *   maven_scan_repo        扫 ~/.m2（纯文件遍历，但要读几千个目录 → spawn_blocking）
 *   maven_dependency_tree  跑 mvn（几十秒 → spawn_blocking + 120 秒超时）
 *
 * 一律 async + spawn_blocking：模块约定，任何可能阻塞的逻辑都不能跑在 UI 线程上。
 *
 * 命令清单：
 *   maven_locate           找 mvn 在哪、本地仓库在哪
 *   maven_scan_repo        仓库体积 / 排行 / 多版本重复
 *   maven_dependency_tree  解析单个项目的依赖树与版本冲突
 * @Author: fu
 */
use std::path::{Path, PathBuf};

use tauri::command;

use crate::core::api::ApiResponse;
use crate::modules::maven::locate;
use crate::modules::maven::models::{MavenInfo, RepoStats, TreeResult};
use crate::modules::maven::{repo, tree};

/** 探测 mvn 与本地仓库。project_dir 用于优先采用项目自带的 mvnw */
#[command]
pub async fn maven_locate(project_dir: Option<String>) -> ApiResponse<MavenInfo> {
    match tokio::task::spawn_blocking(move || locate::locate(project_dir.as_deref())).await {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(format!("探测 Maven 失败: {e}")),
    }
}

/** 扫本地仓库。path 为空时用自动探测到的仓库路径 */
#[command]
pub async fn maven_scan_repo(path: Option<String>) -> ApiResponse<RepoStats> {
    match tokio::task::spawn_blocking(move || {
        let p: PathBuf = match path.filter(|s| !s.trim().is_empty()) {
            Some(s) => PathBuf::from(s),
            None => locate::repo_path(),
        };
        if !p.exists() {
            return Err(format!("本地仓库不存在：{}", p.display()));
        }
        Ok(repo::scan_repo(&p))
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("扫描仓库任务异常退出: {e}")),
    }
}

/**
 * 解析某个项目的依赖树。
 *
 * 为什么要求传**目录**而不是 pom.xml 文件路径：
 *   mvn 要在项目目录里跑（Maven Wrapper 还要读 .mvn/wrapper），
 *   而且多模块项目里 pom 之间的相对引用也依赖工作目录。
 *   传文件进来反而会丢掉这些信息。
 */
#[command]
pub async fn maven_dependency_tree(project_dir: String, offline: bool) -> ApiResponse<TreeResult> {
    if project_dir.trim().is_empty() {
        return ApiResponse::err("请先选择项目目录");
    }
    match tokio::task::spawn_blocking(move || -> Result<TreeResult, String> {
        if !Path::new(&project_dir).exists() {
            return Err(format!("目录不存在：{project_dir}"));
        }
        let info = locate::locate(Some(&project_dir));
        if !info.found {
            return Err(
                "没有找到 mvn：既没有项目自带的 ./mvnw，也没在 sdkman / Homebrew / \
                 /usr/local 下找到。装好 Maven 后点「重新探测」。"
                    .into(),
            );
        }
        tree::run_tree(Path::new(&info.path), &project_dir, offline)
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("依赖树任务异常退出: {e}")),
    }
}
