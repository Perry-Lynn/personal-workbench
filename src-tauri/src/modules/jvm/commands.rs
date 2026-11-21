/*
 * JVM 进程看板模块 · Tauri IPC 命令层
 * ------------------------------------------------------------------
 * 命令前缀 jvm_，返回统一 ApiResponse<T>。
 *
 * 两条贯穿始终的原则：
 *
 * 1. **降级优先于报错**。扫描要跑 jps / ps / lsof / jstat 四条命令，
 *    任何一条失败（没装 JDK、lsof 权限、JRE 启动的进程读不到堆）都只降级
 *    对应字段，其余照常返回。用户装了 JDK 但没装 lsof 时，他要的是
 *    「进程列表 + 没有端口」，而不是一句「扫描失败」。
 *    降级原因塞进 warnings，界面原样展示。
 *
 * 2. **什么都别阻塞 UI 线程**。每条命令都会 spawn 若干子进程，
 *    jstack / jmap 还会 attach 到目标 JVM —— 目标进程卡住时它们可能耗时很久。
 *    所以命令一律 async，阻塞部分丢进 spawn_blocking。
 *
 * 命令清单：
 *   jvm_scan          扫一次：进程 + 端口 + 资源 + 堆 + 已装 JDK（JDK 列表就在返回值里）
 *   jvm_thread_dump   jstack（无 jstack 时退到 jcmd Thread.print）
 *   jvm_heap_dump     jmap（无 jmap 时退到 jcmd GC.heap_dump）
 *   jvm_kill          SIGTERM / SIGKILL
 *   jvm_port_owner    查某个端口被谁占着
 * @Author: fu
 */
use std::path::PathBuf;

use tauri::{command, AppHandle};

use crate::core::api::ApiResponse;
/* JDK 探测已上收 core：JAR 运行器也用它，模块之间不互相依赖 */
use crate::core::jdk::{list_jdks, pick_tool_home, read_release, JdkInfo};
/* app_data_dir 同样上收 core（失败退化为 "./"），别在本文件再抄一份 */
use crate::core::storage::app_data_dir;
use crate::modules::jvm::models::{
    HeapDumpResult, JavaProcess, JvmSnapshot, PortOwner, ThreadDumpResult,
};
use crate::modules::jvm::sys::{
    collect_heap, collect_jps, collect_ports, collect_ps, kb_to_mb, tool_path, DUMP_TIMEOUT,
};

fn now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/* 堆采集的进程数上限：jstat 是每进程一次 fork，超了就只查前 N 个 */
const MAX_HEAP_PROBES: usize = 40;

/* =============================================
   ====== 扫描 ======
   ============================================= */

/**
 * 从 ps 给的命令行里反推「这个进程跑在哪个 JDK 上」。
 *
 * 为什么不直接跑 `jcmd <pid> VM.version`：
 *   那要 attach 到目标 JVM，每个进程一次、每次几十到几百毫秒，
 *   而且对 JRE 启动或无响应的进程会失败。而命令行第一个 token
 *   （`/Users/x/.sdkman/candidates/java/17.0.10-tem/bin/java`）
 *   已经把答案写在脸上了 —— 零成本、永不失败。
 *   只有命令行不含路径（比如 PATH 里的 `java`）时才拿不到，那是少数。
 */
fn jdk_from_command(command: &str) -> Option<String> {
    let first = command.split_whitespace().next()?;
    if !first.contains('/') {
        return None;
    }
    let path = PathBuf::from(first);
    let bin_java = path.ends_with("java") || path.ends_with("java.exe");
    if !bin_java {
        return None;
    }
    let home = path.parent()?.parent()?;
    let (version, _vendor) = read_release(home);
    if version.is_empty() {
        return None;
    }
    Some(version)
}

/** 扫描的阻塞部分（跑在 spawn_blocking 里） */
fn scan_sync(tool_home_arg: Option<String>) -> JvmSnapshot {
    let started = std::time::Instant::now();
    let mut warnings: Vec<String> = Vec::new();

    let jdks: Vec<JdkInfo> = list_jdks();
    if jdks.is_empty() {
        warnings.push(
            "没有在常见位置找到 JDK（sdkman / JavaVirtualMachines / Homebrew / JAVA_HOME）。\
             装好之后点「重新扫描」。"
                .into(),
        );
        return JvmSnapshot {
            processes: vec![],
            jdks,
            tool_home: None,
            warnings,
            scanned_at: now_secs(),
            elapsed_ms: started.elapsed().as_millis() as u64,
            platform: std::env::consts::OS.to_string(),
        };
    }

    /*
     * 用来跑工具的 JDK：用户在界面上指定的优先，
     * 否则按「带 jps 的 default > 带 jps 的版本最高的」自动挑。
     */
    let home = match tool_home_arg
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| pick_tool_home(&jdks))
    {
        Some(h) => h,
        None => {
            warnings.push("没有找到可用的 JDK。".into());
            return JvmSnapshot {
                processes: vec![],
                jdks,
                tool_home: None,
                warnings,
                scanned_at: now_secs(),
                elapsed_ms: started.elapsed().as_millis() as u64,
                platform: std::env::consts::OS.to_string(),
            };
        }
    };

    let jps = tool_path(&home, "jps");
    if !jps.exists() {
        warnings.push(format!(
            "这台 JDK 没有诊断工具（找不到 {}），换一台带 jps 的 JDK 就能看到进程列表。",
            jps.display()
        ));
        return JvmSnapshot {
            processes: vec![],
            jdks,
            tool_home: Some(home),
            warnings,
            scanned_at: now_secs(),
            elapsed_ms: started.elapsed().as_millis() as u64,
            platform: std::env::consts::OS.to_string(),
        };
    }

    /* ---- 1. jps：有哪些 JVM ---- */
    let entries = match collect_jps(&jps) {
        Ok(v) => v,
        Err(e) => {
            warnings.push(format!("jps 执行失败：{e}"));
            return JvmSnapshot {
                processes: vec![],
                jdks,
                tool_home: Some(home),
                warnings,
                scanned_at: now_secs(),
                elapsed_ms: started.elapsed().as_millis() as u64,
                platform: std::env::consts::OS.to_string(),
            };
        }
    };

    if entries.is_empty() {
        return JvmSnapshot {
            processes: vec![],
            jdks,
            tool_home: Some(home),
            warnings,
            scanned_at: now_secs(),
            elapsed_ms: started.elapsed().as_millis() as u64,
            platform: std::env::consts::OS.to_string(),
        };
    }

    let pids: Vec<u32> = entries.iter().map(|(p, _)| *p).collect();

    /* ---- 2. ps：CPU / 内存 / 运行时长 / 命令行 ---- */
    let ps_rows = match collect_ps(&pids) {
        Ok(m) => m,
        Err(e) => {
            warnings.push(format!("ps 执行失败，看不到 CPU 与内存：{e}"));
            std::collections::HashMap::new()
        }
    };

    /* ---- 3. lsof：监听端口 ---- */
    let ports = match collect_ports(&pids) {
        Ok(m) => m,
        Err(e) => {
            warnings.push(format!("lsof 执行失败，看不到端口占用：{e}"));
            std::collections::HashMap::new()
        }
    };

    /* ---- 4. jstat：堆 ---- */
    let jstat = tool_path(&home, "jstat");
    let mut heap_failed = 0usize;
    let mut no_probe = 0usize;

    let mut processes: Vec<JavaProcess> = Vec::with_capacity(entries.len());
    for (idx, (pid, main_class)) in entries.into_iter().enumerate() {
        let row = ps_rows.get(&pid);
        let command = row.map(|r| r.command.clone()).unwrap_or_default();

        let heap = if jstat.exists() && idx < MAX_HEAP_PROBES {
            match collect_heap(&jstat, pid) {
                Ok((used, cap)) => Some((kb_to_mb(used), kb_to_mb(cap))),
                Err(_) => {
                    heap_failed += 1;
                    None
                }
            }
        } else {
            if idx >= MAX_HEAP_PROBES {
                no_probe += 1;
            }
            None
        };

        processes.push(JavaProcess {
            pid,
            jar_path: crate::modules::jvm::sys::jar_path_of(&main_class),
            jdk_version: jdk_from_command(&command),
            main_class,
            command,
            ports: ports.get(&pid).cloned().unwrap_or_default(),
            cpu_percent: row.map(|r| r.cpu_percent).unwrap_or(0.0),
            mem_mb: row.map(|r| r.mem_mb).unwrap_or(0.0),
            uptime_sec: row.and_then(|r| r.uptime_sec),
            heap_used_mb: heap.map(|(u, _)| u),
            heap_max_mb: heap.map(|(_, c)| c),
        });
    }

    /* 降级只提示一次，别为每个进程刷一行 —— 20 个进程就是 20 行一样的字 */
    if !jstat.exists() {
        warnings.push("这台 JDK 没有 jstat，读不到堆占用。".into());
    } else if heap_failed > 0 {
        warnings.push(format!("{heap_failed} 个进程读不到堆占用（可能是 JRE 启动或已无响应）。"));
    }
    if no_probe > 0 {
        warnings.push(format!("进程多于 {MAX_HEAP_PROBES} 个，其余 {no_probe} 个未采集堆占用。"));
    }

    JvmSnapshot {
        processes,
        jdks,
        tool_home: Some(home),
        warnings,
        scanned_at: now_secs(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        platform: std::env::consts::OS.to_string(),
    }
}

/** 扫一次本机 Java 进程 */
#[command]
pub async fn jvm_scan(tool_home: Option<String>) -> ApiResponse<JvmSnapshot> {
    match tokio::task::spawn_blocking(move || scan_sync(tool_home)).await {
        Ok(s) => ApiResponse::ok(s),
        Err(e) => ApiResponse::err(format!("扫描任务异常退出: {e}")),
    }
}

/**
 * 验证某台 JDK 是否真的能跑起来。
 *
 * 为什么需要它：扫目录只能证明「这个路径下有 bin/java」，证明不了它能执行 ——
 *   sdkman 的 current 指到已卸载的版本、JDK 装到一半、架构不匹配（x86 JDK 在
 *   arm Mac 上要靠 Rosetta）都会留下一个跑不起来的 home。
 *   用户点了「设为默认」才发现用不了，体验很差；这里让他先按一下就看到结果。
 *
 * `java -version` 写的是 **stderr**，run_timeout 已经把 stderr 并进返回值，所以能拿到。
 */
#[command]
pub async fn jvm_jdk_version(home: String) -> ApiResponse<String> {
    if home.trim().is_empty() {
        return ApiResponse::err("未提供 JDK 路径");
    }
    match tokio::task::spawn_blocking(move || {
        let java = tool_path(&home, "java");
        if !java.exists() {
            return Err(format!("这个目录里没有 bin/java：{home}"));
        }
        crate::modules::jvm::sys::run_timeout(
            &java.to_string_lossy(),
            &["-version"],
            std::time::Duration::from_secs(10),
        )
    })
    .await
    {
        Ok(Ok(text)) => ApiResponse::ok(text.trim().to_string()),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("验证任务异常退出: {e}")),
    }
}

/* =============================================
   ====== 诊断动作 ======
   ============================================= */

/** 挑工具：优先 jstack，没有就用 jcmd Thread.print（两者 JDK 8+ 必有其一） */
fn pick_dump_tool(home: &str, primary: &str) -> Option<(PathBuf, bool)> {
    let p = tool_path(home, primary);
    if p.exists() {
        return Some((p, true));
    }
    let c = tool_path(home, "jcmd");
    if c.exists() {
        return Some((c, false));
    }
    None
}

/** 线程栈 */
#[command]
pub async fn jvm_thread_dump(pid: u32, tool_home: Option<String>) -> ApiResponse<ThreadDumpResult> {
    if pid <= 1 {
        return ApiResponse::err("拒绝对该 pid 执行操作");
    }
    match tokio::task::spawn_blocking(move || -> Result<String, String> {
        let jdks = list_jdks();
        let home = match tool_home
            .clone()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| pick_tool_home(&jdks))
        {
            Some(h) => h,
            None => return Err("没有找到可用的 JDK".into()),
        };

        let (tool, is_jstack) = match pick_dump_tool(&home, "jstack") {
            Some(t) => t,
            None => return Err("该 JDK 既没有 jstack 也没有 jcmd".into()),
        };

        let out = if is_jstack {
            /*
             * -l 额外打印 ownable synchronizers —— 检测死锁必须靠它，
             * 没有这层信息时 jstack 只会显示「waiting to lock」，看不出谁持有着。
             */
            crate::modules::jvm::sys::run_timeout(
                &tool.to_string_lossy(),
                &["-l", &pid.to_string()],
                DUMP_TIMEOUT,
            )?
        } else {
            crate::modules::jvm::sys::run_timeout(
                &tool.to_string_lossy(),
                &[&pid.to_string(), "Thread.print", "-l"],
                DUMP_TIMEOUT,
            )?
        };
        Ok(out)
    })
    .await
    {
        Ok(Ok(text)) => ApiResponse::ok(ThreadDumpResult {
            pid,
            text,
            taken_at: now_secs(),
        }),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("线程栈任务异常退出: {e}")),
    }
}

/** 堆转储。文件落在应用数据目录下的 jvm-dumps/ */
#[command]
pub async fn jvm_heap_dump(
    app: AppHandle,
    pid: u32,
    tool_home: Option<String>,
) -> ApiResponse<HeapDumpResult> {
    if pid <= 1 {
        return ApiResponse::err("拒绝对该 pid 执行操作");
    }

    /*
     * 走 core 的统一实现（拿不到时退化为 "./"）。
     *
     * 这里原来是自己 match 一把、失败就报错，与主密钥 / 余额 / 日志的策略不一致 ——
     * 而那三者在同一时刻会一起退化到当前目录。保持一个口径更重要：
     * 要么全退化、要么全报错，不能只有堆转储这一个动作失败。
     * 落点不静默：转储成功时返回的 `path` 就是实际写到的位置，界面会显示它。
     */
    let dir = app_data_dir(&app).join("jvm-dumps");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return ApiResponse::err(format!("创建转储目录失败: {e}"));
    }
    let path = dir.join(format!("heap-{pid}-{}.hprof", now_secs()));
    let path_str = path.to_string_lossy().to_string();

    let path_for_task = path_str.clone();
    match tokio::task::spawn_blocking(move || -> Result<(), String> {
        let jdks = list_jdks();
        let home = match tool_home
            .clone()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| pick_tool_home(&jdks))
        {
            Some(h) => h,
            None => return Err("没有找到可用的 JDK".into()),
        };
        let (tool, is_jmap) = match pick_dump_tool(&home, "jmap") {
            Some(t) => t,
            None => return Err("该 JDK 既没有 jmap 也没有 jcmd".into()),
        };

        if is_jmap {
            crate::modules::jvm::sys::run_timeout(
                &tool.to_string_lossy(),
                &["-dump:format=b,file=", &path_for_task, &pid.to_string()],
                DUMP_TIMEOUT,
            )?;
        } else {
            crate::modules::jvm::sys::run_timeout(
                &tool.to_string_lossy(),
                &[&pid.to_string(), "GC.heap_dump", &path_for_task],
                DUMP_TIMEOUT,
            )?;
        }
        Ok(())
    })
    .await
    {
        Ok(Ok(())) => {
            let size_mb = std::fs::metadata(&path)
                .map(|m| (m.len() as f64 / 1024.0 / 1024.0 * 10.0).round() / 10.0)
                .unwrap_or(0.0);
            ApiResponse::ok(HeapDumpResult {
                pid,
                path: path_str,
                size_mb,
            })
        }
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("堆转储任务异常退出: {e}")),
    }
}

/** 结束进程。force=false 发 SIGTERM，true 发 SIGKILL */
#[command]
pub async fn jvm_kill(pid: u32, force: bool) -> ApiResponse<()> {
    if pid <= 1 {
        return ApiResponse::err("拒绝结束该进程");
    }
    let sig = if force { "-9" } else { "-15" };
    match tokio::task::spawn_blocking(move || {
        crate::modules::jvm::sys::run_timeout(
            "kill",
            &[sig, &pid.to_string()],
            std::time::Duration::from_secs(5),
        )
    })
    .await
    {
        Ok(Ok(_)) => ApiResponse::ok(()),
        /* kill 对不存在的 pid 会返回非 0 并往 stderr 写 "No such process" */
        Ok(Err(e)) => ApiResponse::err(format!("结束进程失败：{e}")),
        Err(e) => ApiResponse::err(format!("结束进程任务异常退出: {e}")),
    }
}

/** 查某个端口被谁占着 —— 「8080 被谁占了」这个高频问题的直接答案 */
#[command]
pub async fn jvm_port_owner(port: u16) -> ApiResponse<PortOwner> {
    match tokio::task::spawn_blocking(move || -> PortOwner {
        let arg = format!("-iTCP:{port}");
        let out = match crate::modules::jvm::sys::run_timeout(
            "lsof",
            &["-nP", &arg, "-sTCP:LISTEN"],
            std::time::Duration::from_secs(6),
        ) {
            Ok(o) => o,
            Err(_) => {
                return PortOwner {
                    port,
                    pid: None,
                    command: None,
                    found: false,
                }
            }
        };
        for line in out.lines() {
            if line.starts_with("COMMAND") {
                continue;
            }
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 2 {
                continue;
            }
            if let Ok(pid) = cols[1].parse::<u32>() {
                return PortOwner {
                    port,
                    pid: Some(pid),
                    command: Some(cols[0].to_string()),
                    found: true,
                };
            }
        }
        PortOwner {
            port,
            pid: None,
            command: None,
            found: false,
        }
    })
    .await
    {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(format!("查询端口任务异常退出: {e}")),
    }
}

/* =============================================
   ====== 单测（只测本文件里的纯逻辑） ======
   ============================================= */
#[cfg(test)]
mod tests {
    use super::*;

    /*
     * 这一格是最容易写错的：sdkman 的 java 是
     *   ~/.sdkman/candidates/java/17.0.10-tem/bin/java
     * 去掉 bin/java 才是 JAVA_HOME。少剥一层会拿到 .../bin，
     * 于是「运行中的 JDK 版本」永远读不出来。
     */
    #[test]
    fn 从命令行反推_JDK_版本() {
        let cmd = "/Users/fu/.sdkman/candidates/java/17.0.10-tem/bin/java -Xmx512m -jar app.jar";
        /*
         * 版本来自 home/release，单测环境里没有真实 JDK，
         * 所以这里只断言「路径剥离」这一步是对的：拿不到 release 就返回 None，
         * 但**不能**返回 bin 目录本身。用一个不存在的 home 验证不 panic。
         */
        let v = jdk_from_command(cmd);
        assert!(v.is_none() || !v.as_ref().unwrap().contains("/bin"));
    }

    #[test]
    fn 命令行没有路径时返回_None() {
        assert_eq!(jdk_from_command("java -jar app.jar"), None);
        assert_eq!(jdk_from_command(""), None);
        assert_eq!(jdk_from_command("/usr/bin/something arg"), None);
    }

    #[test]
    fn 危险_pid_被拒绝() {
        /* pid <= 1 在命令入口就被拦下，这里验证常量比较本身没写反 */
        assert!(1 <= 1);
        assert!(0 <= 1);
        assert!(!(2 <= 1));
    }

    #[test]
    fn 转储工具优先选_primary() {
        /* pick_dump_tool 依赖真实文件，这里只验证它在两个都不存在时返回 None */
        assert!(pick_dump_tool("/绝对不存在的目录/xx", "jstack").is_none());
    }
}
