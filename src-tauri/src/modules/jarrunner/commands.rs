/*
 * JAR 运行器 · Tauri IPC 命令层
 * ------------------------------------------------------------------
 * 命令前缀 jarrunner_，返回统一 ApiResponse<T>。
 *
 * 三条与其它「本地模块」不同的地方：
 *   1. 进程**不随命令结束**：start 只负责 fork 起来并立刻返回，
 *      输出由 runner 通过事件推给前端（见 runner.rs 顶部）。
 *   2. start 之前必须解出 java 的**绝对路径**（core::jdk）—— GUI 应用的 PATH 里
 *      通常没有 java，直接 spawn("java") 会得到一句看不懂的 No such file。
 *   3. 应用退出时要 stop_all，否则「关了工作台、jar 还在跑」会留下孤儿进程
 *      （收尾挂在 main.rs 的 RunEvent::Exit）。
 *
 * 命令清单：
 *   jarrunner_list_jdks       本机装了哪些 JDK
 *   jarrunner_list_configs    保存过的运行配置
 *   jarrunner_preview        生成命令预览（与 start 同一套拼装逻辑）
 *   jarrunner_save_config     新建或更新一份配置
 *   jarrunner_delete_config   删除一份配置
 *   jarrunner_start          启动一次运行
 *   jarrunner_stop           停止
 *   jarrunner_remove         停止并丢掉这条运行记录
 *   jarrunner_list_runs      全部运行记录（含已结束的）
 *   jarrunner_logs           取某次运行已缓存的日志
 *   jarrunner_clear_logs     清掉后端缓存的日志
 * @Author: fu
 */
use std::path::{Path, PathBuf};

use tauri::{command, AppHandle};

use crate::core::api::ApiResponse;
use crate::core::jdk::{java_bin, list_jdks, read_release, JdkInfo, JdkSource};
use crate::core::storage::{app_data_dir, StorageService};
use crate::core::time::now_ms;
use crate::modules::jarrunner::models::{
    build_argv, command_preview, display_name, jdk_label, JarConfig, LogLine, RunInfo, PH_JAVA,
};
use crate::modules::jarrunner::{runner, storage};

/* =============================================
   ====== 基础设施 ======
   ============================================= */

/*
 * 应用数据目录直接用 core 那份（`core::storage::app_data_dir`），
 * 这里**不再**留私有副本 —— core 的文档注释写明了理由：
 * 「各留一份私有实现会各自演化出不同的退化策略」。
 * 那种漂移的后果是库路径变了、用户的配置「凭空消失」，且不报错。
 */

fn open(dir: &Path) -> Result<std::sync::Arc<StorageService>, String> {
    StorageService::init(dir.to_path_buf()).map_err(|e| format!("打开本地存储失败：{e}"))
}

/* 与 snippets / jvm 同款：把阻塞的那段丢进线程池，结果仍写成显式的两支 */
async fn blocking<T, F>(what: &'static str, f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(r) => r,
        Err(e) => Err(format!("{what}任务异常退出：{e}")),
    }
}

/* =============================================
   ====== JDK ======
   ============================================= */

/** 来源 → 界面上那个短词（与 core/jdk.rs 的 serde 取值保持一致） */
fn source_str(s: &JdkSource) -> &'static str {
    match s {
        JdkSource::Sdkman => "sdkman",
        JdkSource::Brew => "brew",
        JdkSource::Env => "env",
        JdkSource::System => "system",
    }
}

/**
 * 决定「用哪台 JDK 的 java」。
 *
 * 配置里的 jdk_home 为空 = 自动（默认那台）；非空 = 用户指定的那台。
 * 指定的那台不在扫描结果里也不算错（有人把 JDK 解压在任意目录），
 * 这时自己读它的 release 文件补出版本，仍然给它跑。
 */
fn resolve_java(jdk_home: &str) -> Result<(String, String), String> {
    let want = jdk_home.trim();
    let jdks = list_jdks();

    let picked: Option<JdkInfo> = if want.is_empty() {
        jdks
            .iter()
            .find(|j| j.is_default)
            .or_else(|| jdks.first())
            .cloned()
    } else {
        jdks.iter().find(|j| j.home == want).cloned().or_else(|| {
            /*
             * 手动指定的目录：扫不到不代表不存在。以「目录里有没有 bin/java」为准，
             * 版本从 release 文件现读 —— 读不到就显示「未知版本」，照样能跑。
             */
            let home = PathBuf::from(want);
            if !java_bin(want).exists() {
                return None;
            }
            let (version, vendor) = read_release(&home);
            Some(JdkInfo {
                id: home
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "JAVA_HOME".into()),
                version,
                vendor,
                home: want.to_string(),
                source: JdkSource::Env,
                is_default: false,
                has_tools: false,
                tools: vec![],
            })
        })
    };

    let jdk = match picked {
        Some(j) => j,
        None => {
            return Err(if want.is_empty() {
                "没在本机找到 JDK（sdkman / JavaVirtualMachines / Homebrew / JAVA_HOME 都扫过了）。\
                 装好之后点「重新探测」，或在下面手动填 JAVA_HOME。"
                    .to_string()
            } else {
                format!("这个目录里没有可执行的 java：{want}")
            });
        }
    };

    let bin = java_bin(&jdk.home);
    if !bin.exists() {
        return Err(format!("这个 JDK 里没有可执行的 java：{}", bin.display()));
    }
    let label = jdk_label(&jdk.version, source_str(&jdk.source));
    Ok((bin.to_string_lossy().to_string(), label))
}

/* =============================================
   ====== 命令 ======
   ============================================= */

/** 本机装了哪些 JDK（版本降序，界面下拉框直接列） */
#[command]
pub async fn jarrunner_list_jdks() -> ApiResponse<Vec<JdkInfo>> {
    match blocking("探测 JDK", move || Ok(list_jdks())).await {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(e),
    }
}

/** 保存过的运行配置（最近改过的在前） */
#[command]
pub async fn jarrunner_list_configs(app: AppHandle) -> ApiResponse<Vec<JarConfig>> {
    let dir = app_data_dir(&app);
    match blocking("读取运行配置", move || {
        let svc = open(&dir)?;
        storage::list(&svc).map_err(|e| format!("读取运行配置失败：{e}"))
    })
    .await
    {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(e),
    }
}

/**
 * 新建或更新一份配置。
 * `id` 为空 = 新建（id 与时间戳由后端生成）；给了 id = 改那份已有的。
 */
#[command]
pub async fn jarrunner_save_config(
    app: AppHandle,
    config: JarConfig,
) -> ApiResponse<JarConfig> {
    let dir = app_data_dir(&app);
    match blocking("保存运行配置", move || {
        let svc = open(&dir)?;
        let mut cfg = config;

        let exists = match cfg.id.trim() {
            "" => false,
            id => storage::get(&svc, id)
                .map_err(|e| format!("读取运行配置失败：{e}"))?
                .is_some(),
        };
        /*
         * 带了 id 却查不到 → 报错，不要悄悄新建（同 snippets 的理由：
         * 静默新建会让用户以为「改好了」，实际落到了一条凭空多出来的配置上）。
         */
        if !cfg.id.trim().is_empty() && !exists {
            return Err(format!("运行配置不存在：{}", cfg.id));
        }
        if cfg.id.trim().is_empty() {
            cfg.id = uuid::Uuid::new_v4().to_string();
        }
        if cfg.name.trim().is_empty() {
            cfg.name = display_name(&cfg.jar_path);
        }
        cfg.updated_at = now_ms();
        storage::put(&svc, &cfg).map_err(|e| format!("保存运行配置失败：{e}"))?;
        Ok(cfg)
    })
    .await
    {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(e),
    }
}

/** 删除一份配置 */
#[command]
pub async fn jarrunner_delete_config(app: AppHandle, id: String) -> ApiResponse<bool> {
    let dir = app_data_dir(&app);
    match blocking("删除运行配置", move || {
        let svc = open(&dir)?;
        storage::delete(&svc, id.trim()).map_err(|e| format!("删除运行配置失败：{e}"))
    })
    .await
    {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(e),
    }
}

/**
 * 生成命令预览（界面上那条可以复制的命令行）。
 *
 * 为什么不放在前端拼：拼装规则一旦有两份实现，就会在「预览」与「实际执行」
 * 之间出现偏差 —— 而用户复制出去却跑不通，是比预览难看严重得多的问题。
 * 所以这里与 start 走**同一个** build_argv，只差最后不真的 fork。
 *
 * JDK 还没装（或指定的目录里没有 java）时不报错：预览退化成 `{java} -jar ...`，
 * 让用户照样能看到参数是怎么排的。启动时才报错（那时必须给一个真路径）。
 */
#[command]
pub async fn jarrunner_preview(config: JarConfig) -> ApiResponse<String> {
    match blocking("生成命令预览", move || {
        let java = resolve_java(&config.jdk_home)
            .map(|(bin, _)| bin)
            .unwrap_or_else(|_| PH_JAVA.to_string());
        Ok(command_preview(&build_argv(&java, &config)))
    })
    .await
    {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(e),
    }
}

/**
 * 启动一次运行。
 * 传进来的是**当前表单里的配置**，不要求先保存 —— 想留着复用再点保存。
 */
#[command]
pub async fn jarrunner_start(app: AppHandle, config: JarConfig) -> ApiResponse<RunInfo> {
    let app2 = app.clone();
    match blocking("启动", move || {
        let (java, label) = resolve_java(&config.jdk_home)?;
        runner::start(app2, &config, java, label)
    })
    .await
    {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(e),
    }
}

/** 停止一次运行 */
#[command]
pub async fn jarrunner_stop(run_id: String) -> ApiResponse<bool> {
    match blocking("停止", move || Ok(runner::stop(run_id.trim()))).await {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(e),
    }
}

/** 停止并丢掉这条运行记录（界面上的「移除」） */
#[command]
pub async fn jarrunner_remove(run_id: String) -> ApiResponse<bool> {
    match blocking("移除运行记录", move || Ok(runner::remove(run_id.trim()))).await {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(e),
    }
}

/** 全部运行记录（含已结束的），启动时间倒序 */
#[command]
pub async fn jarrunner_list_runs() -> ApiResponse<Vec<RunInfo>> {
    match blocking("读取运行记录", move || Ok(runner::list_runs())).await {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(e),
    }
}

/** 某次运行已缓存的日志（后端最多留 2000 行） */
#[command]
pub async fn jarrunner_logs(run_id: String) -> ApiResponse<Vec<LogLine>> {
    match blocking("读取日志", move || Ok(runner::logs(run_id.trim()))).await {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(e),
    }
}

/** 清掉后端缓存的日志（前端自己的缓冲区要自己清） */
#[command]
pub async fn jarrunner_clear_logs(run_id: String) -> ApiResponse<bool> {
    match blocking("清空日志", move || {
        runner::clear_logs(run_id.trim());
        Ok(true)
    })
    .await
    {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(e),
    }
}

/* =============================================
   ====== 应用退出收尾 ======
   ============================================= */

/**
 * 停止全部还在跑的 jar。
 * 挂在 main.rs 的 RunEvent::Exit —— 关窗退出与菜单栏退出两条路径都会走到。
 */
pub fn stop_all() -> usize {
    runner::stop_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 来源标签与前端短名一致() {
        assert_eq!(source_str(&JdkSource::Sdkman), "sdkman");
        assert_eq!(source_str(&JdkSource::Brew), "brew");
        assert_eq!(source_str(&JdkSource::Env), "env");
        assert_eq!(source_str(&JdkSource::System), "system");
    }

    /*
     * 「没装 JDK」是真实会发生的情况（新机器、只装了 JRE），
     * 这时必须给出可操作的提示，而不是 spawn 失败那一句 No such file。
     */
    #[test]
    fn 自动模式找不到_JDK_时给出可操作提示() {
        /* resolve_java 会真的扫盘，这里只验「空 home 时不 panic 且必有结论」 */
        let r = resolve_java("");
        match r {
            Ok((bin, label)) => {
                assert!(bin.ends_with("java"), "实际: {bin}");
                assert!(label.starts_with("Java "), "实际: {label}");
            }
            Err(e) => assert!(e.contains("JDK"), "错误信息应指向 JDK：{e}"),
        }
    }

    #[test]
    fn 手动指定一个不存在的目录要报错而不是悄悄用默认的() {
        let e = resolve_java("/绝对/不存在/的/jdk").unwrap_err();
        assert!(e.contains("没有可执行的 java"), "实际: {e}");
    }
}
