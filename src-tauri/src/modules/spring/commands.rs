/*
 * Spring Boot 服务台 · Tauri IPC 命令层
 * ------------------------------------------------------------------
 * 命令前缀 spring_，返回统一 ApiResponse<T>。
 *
 *   spring_scan    扫本机 Java 进程 → 认出 Spring Boot → （可选）探活 actuator
 *   spring_probe   对单个端口重试探活（用户点「重试」时用）
 *   spring_open    在浏览器里打开某个端口的 actuator 页面
 *
 * 三段式的取舍：**采集是阻塞的**（ps / lsof），**探活是异步的**（HTTP），
 * 所以采集丢 spawn_blocking、探活在本任务里并发跑，不互相占线程。
 * @Author: fu
 */
use std::collections::HashMap;
use std::time::Instant;

use tauri::command;

use crate::core::api::ApiResponse;
use crate::core::ps;
use crate::modules::spring::actuator;
use crate::modules::spring::detect;
use crate::modules::spring::models::{ActuatorInfo, SpringApp, SpringSnapshot};

/** 扫本机 Java 进程并识别 Spring Boot。`probe` 为 true 时顺带探活 actuator。 */
#[command]
pub async fn spring_scan(probe: bool) -> ApiResponse<SpringSnapshot> {
    let started = Instant::now();

    let collected = tokio::task::spawn_blocking(collect_processes).await;
    let (mut apps, java_processes, mut warnings) = match collected {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return ApiResponse::err(e),
        Err(e) => return ApiResponse::err(format!("采集任务异常退出: {e}")),
    };

    if probe {
        match actuator::client() {
            Ok(client) => probe_all(&client, &mut apps).await,
            Err(e) => warnings.push(e),
        }
    } else {
        warnings.push(
            "已关闭 Actuator 探活：只能靠命令行特征识别，用 -jar 启动且没写 spring 参数的服务可能认不出来"
                .to_string(),
        );
    }

    /*
     * 只留「有强特征」或「actuator 确认过」的。
     * 光有监听端口的裸 Java 进程不算 —— 否则列表里会混进一堆不相干的东西，
     * 用户要在一堆假阳性里找真服务。
     */
    apps.retain(|a| a.confirmed || !a.evidence.is_empty());

    /* 排序：确认过的在前，然后不健康的在前，最后按名字。顺序稳定，刷新不会跳。 */
    apps.sort_by(|a, b| {
        let key = |x: &SpringApp| {
            let bad = x
                .actuator
                .as_ref()
                .and_then(|i| i.status.as_deref())
                .map(|s| s != "UP")
                .unwrap_or(false);
            (!x.confirmed, !bad, x.name.clone())
        };
        key(a).cmp(&key(b))
    });

    ApiResponse::ok(SpringSnapshot {
        apps,
        java_processes,
        elapsed_ms: started.elapsed().as_millis() as u64,
        warnings,
    })
}

/** 对单个端口重试探活（用户点「重试」）。 */
#[command]
pub async fn spring_probe(port: u16) -> ApiResponse<ActuatorInfo> {
    let client = match actuator::client() {
        Ok(c) => c,
        Err(e) => return ApiResponse::err(e),
    };
    match actuator::probe(&client, port).await {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(e),
    }
}

/**
 * 在浏览器里打开 `http://127.0.0.1:<port><path>`。
 *
 * **不收完整 URL 只收 port + path**：收完整 URL 就等于把「打开任意链接」
 * 这个能力交给了前端，而路径校验再严也容易漏（`file://`、`javascript:` 之类）。
 * 在这里自己拼，主机部分就永远是本机回环地址，没有别的可能。
 */
#[command]
pub async fn spring_open(port: u16, path: String) -> ApiResponse<()> {
    let path = path.trim();
    if !path.starts_with('/') {
        return ApiResponse::err("路径必须以 / 开头".to_string());
    }
    if path.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return ApiResponse::err("路径里不能有空白或控制字符".to_string());
    }
    let url = format!("http://127.0.0.1:{port}{path}");

    match tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let r = crate::core::proc::run_timeout("open", &[&url], std::time::Duration::from_secs(10));
        #[cfg(target_os = "windows")]
        let r = crate::core::proc::run_timeout(
            "cmd",
            &["/C", "start", "", &url],
            std::time::Duration::from_secs(10),
        );
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let r = crate::core::proc::run_timeout("xdg-open", &[&url], std::time::Duration::from_secs(10));
        r
    })
    .await
    {
        Ok(Ok(_)) => ApiResponse::ok(()),
        Ok(Err(e)) => ApiResponse::err(format!("打开浏览器失败：{e}")),
        Err(e) => ApiResponse::err(format!("打开任务异常退出: {e}")),
    }
}

/* =============================================
   ====== 内部实现 ======
   ============================================= */

/**
 * 阻塞部分：列全部进程 → 挑出 Java → 查端口 → 组装成候选列表。
 *
 * 返回 (候选应用, Java 进程总数, 告警)。**Java 进程总数要回传**：
 * 用户看到「只认出 1 个」时，需要知道机器上到底跑了几个 Java 进程，
 * 否则分不清是「识别漏了」还是「本来就只有 1 个」。
 */
fn collect_processes() -> Result<(Vec<SpringApp>, usize, Vec<String>), String> {
    let mut warnings: Vec<String> = Vec::new();

    let rows = ps::collect_all_ps().map_err(|e| format!("列进程失败：{e}"))?;
    let java: Vec<&ps::PsRow> = rows
        .iter()
        .filter(|r| detect::looks_like_java(&r.command))
        .collect();
    let java_processes = java.len();
    if java_processes == 0 {
        return Ok((Vec::new(), 0, warnings));
    }

    let pids: Vec<u32> = java.iter().map(|r| r.pid).collect();
    let ports: HashMap<u32, Vec<u16>> = match ps::collect_ports(&pids) {
        Ok(m) => m,
        Err(e) => {
            warnings.push(format!("查监听端口失败（端口一列会是空的）：{e}"));
            HashMap::new()
        }
    };

    let mut apps: Vec<SpringApp> = Vec::new();
    for row in java {
        /* lsof 实测到的端口 */
        let ports_of = ports.get(&row.pid).cloned().unwrap_or_default();
        let evidence = detect::strong_evidence(&row.command);
        /*
         * 既没特征又没端口 → 无关的 Java 进程，不占列表。
         * 这里判的是**实测**端口而不是下面的最终端口：命令行声明的 `server.port`
         * 本身就会进 evidence（见 strong_evidence），所以真走到「没特征」那一步时
         * 声明值也必然是 None，用哪个判都一样 —— 但写实测的更贴合「只认实测证据」。
         */
        if evidence.is_empty() && ports_of.is_empty() {
            continue;
        }
        /* 实测优先，lsof 被拦掉时退回命令行声明的 --server.port */
        let final_ports = detect::resolve_ports(&ports_of, detect::parse_server_port(&row.command));
        let main_class = detect::main_class_of(&row.command);
        let jar = main_class
            .as_deref()
            .filter(|m| m.ends_with(".jar"))
            .map(|m| m.to_string());
        let name = detect::app_name(jar.as_deref(), main_class.as_deref());
        apps.push(SpringApp {
            pid: row.pid,
            hint: detect::weak_hint(&name),
            name,
            main_class,
            jar,
            ports: final_ports,
            profiles: detect::parse_profiles(&row.command),
            command: row.command.clone(),
            cpu_percent: row.cpu_percent,
            mem_mb: row.mem_mb,
            uptime_sec: row.uptime_sec,
            evidence,
            confirmed: false,
            actuator: None,
            actuator_error: None,
        });
    }
    Ok((apps, java_processes, warnings))
}

/**
 * 并发探活所有候选的端口。
 *
 * 一个应用可能有多个监听端口（8080 业务 + 35729 devtools 的 livereload），
 * 所以逐个端口都试，**第一个成功的为准**；全部失败才记错误，
 * 且只记第一个错误 —— 后面那些「35729 端口没有响应」没有信息量。
 */
async fn probe_all(client: &reqwest::Client, apps: &mut [SpringApp]) {
    let targets: Vec<(usize, u16)> = apps
        .iter()
        .enumerate()
        .flat_map(|(i, a)| a.ports.iter().map(move |p| (i, *p)))
        .collect();
    if targets.is_empty() {
        return;
    }

    let results =
        futures_util::future::join_all(targets.iter().map(|(_, p)| actuator::probe(client, *p))).await;

    for ((idx, _), r) in targets.iter().zip(results) {
        match r {
            Ok(info) => {
                if apps[*idx].actuator.is_none() {
                    apps[*idx].actuator = Some(info);
                    apps[*idx].confirmed = true;
                }
            }
            Err(e) => {
                if apps[*idx].actuator_error.is_none() {
                    apps[*idx].actuator_error = Some(e);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /** `ps` 是否被沙箱直接拒绝 exec（`Operation not permitted`）；判定理由见下方 smoke_real_scan */
    fn ps_blocked_by_env(err: &str) -> bool {
        err.contains("Operation not permitted")
    }

    /*
     * 真机冒烟：必须真正跑一次 collect_processes()，不能只测 detect / actuator 里的纯函数。
     * 教训来自已删除的代码检索模块 —— 那里 13 条纯函数单测全绿，而顶层入口一次都没被执行过，
     * 结果主路径带着一个「第一次调用就永久卡死」的死锁上线了。
     *
     * 本机此刻未必有 Spring Boot 在跑，所以**不断言内容**，只断言
     * 「跑得完、不报错」，并把结果打出来供人工核对（`-- --nocapture` 可见）。
     */
    /*
     * 沙箱托管的环境里 `ps` 会被直接拒绝 exec（`Operation not permitted`），
     * 这不是代码问题 —— 本模块在生产里是双击 .app 启动，不受沙箱约束。
     *
     * ⚠️ 这里原本还放行第二种表现「ps 执行超时」，并把它也归给沙箱 —— **那是错的**。
     * 那个 6 秒超时是 core::proc 的真实缺陷：子进程输出塞满管道缓冲区后卡在 write 上，
     * 永不退出，而主线程在等它退出、没人读管道（见 proc.rs 的注释）。
     * 放行它等于把「Spring 服务台每次都报扫描失败」这个 bug 一直藏在这条用例背后。
     * 现在只放行 EPERM；**再见到超时就先查 proc.rs，别怪环境**。
     */
    #[test]
    fn smoke_real_scan() {
        let (apps, java_processes, warnings) = match collect_processes() {
            Ok(v) => v,
            Err(e) if ps_blocked_by_env(&e) => {
                println!("跳过真机冒烟（当前环境不允许启动 ps，本条未真正验证）：{e}");
                return;
            }
            Err(e) => panic!("采集失败：{e}"),
        };

        println!("Java 进程 {java_processes} 个，候选 {} 个", apps.len());
        for a in &apps {
            println!(
                "  pid={} name={} ports={:?} profiles={:?} evidence={:?} hint={:?}",
                a.pid, a.name, a.ports, a.profiles, a.evidence, a.hint
            );
        }
        for w in &warnings {
            println!("  warn: {w}");
        }
        /* 候选数不该超过 Java 进程总数 */
        assert!(apps.len() <= java_processes);
    }
}
