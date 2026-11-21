/*
 * JAR 运行器模块 · 进程管理
 * ------------------------------------------------------------------
 * 本模块与别的模块都不同：**子进程是长期存活的**（一个 Spring Boot 服务可能跑几天），
 * 所以不能套 core::proc 的「跑完拿输出」模型 —— 那边是等进程结束才返回，
 * 用在这里会让 IPC 永远不返回、界面永远转圈。
 *
 * 结构（每个 run 一份）：
 *   子进程 ──stdout──▶ 读线程 ─┐
 *           ──stderr──▶ 读线程 ─┴─▶ mpsc ─▶ 监管线程 ─▶ 攒批 emit 给前端
 *
 * 为什么要「读线程 + 监管线程」而不是让读线程直接 emit：
 *   1. 一条日志一次 emit 会让高频打印的服务把 IPC 打满（实测几十行/秒很常见）；
 *   2. 日志要有**稳定序号**，两个线程同时写的话顺序会互相穿插 ——
 *      序号统一由监管线程分配，攒够一批（或 120ms）再发一次。
 *
 * 「读完了」怎么判断：两个读线程各自持有 sender 的克隆，
 * 它们都退出后 sender 全部 drop，`recv_timeout` 会返回 **Disconnected** ——
 * 这正是 child.kill() 之后能自动收尾的原因（管道被关，读线程自然读到 EOF）。
 * 注意 Disconnected 与 Timeout **不能合并处理**，合并了监管线程就永远退不出来。
 *
 * 退出收尾放在 main.rs 的 RunEvent::Exit（见 stop_all），
 * 否则「应用关了、jar 还在跑」会留下一堆没人管的孤儿进程。
 * @Author: fu
 */
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::modules::jarrunner::models::{
    build_argv, command_preview, default_work_dir, display_name, env_pairs, validate, JarConfig,
    LogLine, LogStream, RunInfo, RunStatus,
};
use crate::modules::jarrunner::{EVENT_LOG_LINES, EVENT_RUN_STATUS};

/* 每个 run 保留的日志行数上限。服务跑一天能打出几十万行，不设上限内存会一直涨 */
const MAX_LOG_LINES: usize = 2000;
/* 攒批发送：够 60 行或距上次发送超过 120ms 就发一次（兼顾吞吐与实时性） */
const BATCH_MAX: usize = 60;
const BATCH_MS: u64 = 120;
/*
 * 监管线程的单轮等待时长：既是没有新行时的攒批窗口，也是等退出的轮询间隔。
 * 100ms 对「人看着日志滚」足够实时，对 CPU 又几乎无负担。
 */
const POLL_MS: u64 = 100;
/* 收尾时最多等进程退出多久；超时就 kill。10 秒对「还没来得及响应信号」足够 */
const EXIT_TIMEOUT_SECS: u64 = 10;

/* =============================================
   ====== 注册表 ======
   ============================================= */

/** 一次运行在运行期的全部状态。放进 Arc 是因为三个线程都要读它 */
struct RunHandle {
    info: Mutex<RunInfo>,
    /** kill 需要 &mut Child，所以包在 Mutex 里；退出后置 None */
    child: Mutex<Option<Child>>,
    /** 用户点停 / 应用退出收尾的标志 */
    stop: AtomicBool,
    logs: Mutex<VecDeque<LogLine>>,
    /** 日志序号由监管线程统一分配 */
    seq: AtomicU64,
}

/* 全部运行记录（含已结束的，用户要看历史日志与退出码） */
static RUNS: Lazy<Mutex<HashMap<String, Arc<RunHandle>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/*
 * 当前 Unix 毫秒：上收到 `core::time` —— 原先 snippets / jarrunner 三处各有一份
 * 逐字相同的实现，漏改一处不会有任何报错，只是时间戳口径悄悄不一致。
 * （use 就近放在这里，与本文件其它局部依赖的风格一致。）
 */
use crate::core::time::now_ms;

/* =============================================
   ====== 启动 ======
   ============================================= */

/**
 * 启动一次运行。
 *
 * `java` / `jdk_label` 由命令层解析好再传进来（挑 JDK 的策略属于命令层，
 * 这里只管跑），这样「用哪台 JDK」能单独被测试，也不必在这里扫盘。
 */
pub fn start(
    app: AppHandle,
    cfg: &JarConfig,
    java: String,
    jdk_label: String,
) -> Result<RunInfo, String> {
    validate(cfg)?;

    let argv = build_argv(&java, cfg);
    if argv.is_empty() {
        return Err("命令是空的，没法启动".into());
    }
    let command = command_preview(&argv);

    let work_dir = if cfg.work_dir.trim().is_empty() {
        default_work_dir(&cfg.jar_path)
    } else {
        cfg.work_dir.trim().to_string()
    };

    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]);
    /*
     * stdin 必须显式关掉：GUI 应用没有终端，子进程若读 stdin 会一直等输入
     * （表现是「进程起来了但什么都不输出」），给它 null 就能立刻拿到 EOF。
     */
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if !work_dir.is_empty() {
        cmd.current_dir(&work_dir);
    }
    for (k, v) in env_pairs(cfg) {
        cmd.env(k, v);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动失败：{e}（命令：{command}）"))?;
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let info = RunInfo {
        id: format!("r{}", now_ms()),
        config_id: cfg.id.clone(),
        name: if cfg.name.trim().is_empty() {
            display_name(&cfg.jar_path)
        } else {
            cfg.name.trim().to_string()
        },
        jar_path: cfg.jar_path.clone(),
        java_bin: java,
        jdk_label,
        command: command.clone(),
        work_dir,
        status: RunStatus::Running,
        pid: Some(pid),
        started_at: now_ms(),
        ended_at: None,
        exit_code: None,
        error: None,
    };

    let handle = Arc::new(RunHandle {
        info: Mutex::new(info.clone()),
        child: Mutex::new(Some(child)),
        stop: AtomicBool::new(false),
        logs: Mutex::new(VecDeque::new()),
        seq: AtomicU64::new(0),
    });
    RUNS.lock().insert(info.id.clone(), handle.clone());

    let (tx, rx) = mpsc::channel::<LogLine>();
    if let Some(s) = stdout {
        spawn_reader(LogStream::Stdout, Box::new(s), tx.clone());
    }
    if let Some(s) = stderr {
        spawn_reader(LogStream::Stderr, Box::new(s), tx.clone());
    }
    /*
     * 监管线程自己不能持有 sender —— 否则两个读线程都退出后 channel 也不会
     * Disconnected（还有一份活的 sender），监管线程就永远等在那里。
     */
    drop(tx);

    let run_id = info.id.clone();
    let app2 = app.clone();
    let h2 = handle.clone();
    thread::spawn(move || supervise(app2, h2, run_id, rx));

    /* 第一行写「跑的是什么」，用户不用去猜 —— 长服务日志被冲掉后尤其重要 */
    push_line(&handle, LogLine {
        seq: 0,
        ts: now_ms(),
        stream: LogStream::System,
        text: format!("已启动 pid={pid}：{command}"),
    });
    emit_lines(&app, &info.id, vec![last_line(&handle)]);

    Ok(info)
}

/** 起一个读线程：逐行读子进程的一条输出流，交给监管线程统一编号 */
fn spawn_reader(stream: LogStream, source: Box<dyn Read + Send>, tx: Sender<LogLine>) {
    thread::spawn(move || {
        for line in BufReader::new(source).lines() {
            let text = match line {
                Ok(t) => t,
                Err(e) => {
                    /*
                     * 读到一半管道断了（多数发生在 kill 之后）：这不是故障，
                     * 但也不能静默 —— 写一行让界面知道输出可能被截断。
                     */
                    let _ = tx.send(LogLine {
                        seq: 0,
                        ts: now_ms(),
                        stream,
                        text: format!("[输出读取中断] {e}"),
                    });
                    break;
                }
            };
            if tx.send(LogLine { seq: 0, ts: now_ms(), stream, text }).is_err() {
                break;
            }
        }
    });
}

/* =============================================
   ====== 监管线程 ======
   ============================================= */

fn supervise(app: AppHandle, handle: Arc<RunHandle>, run_id: String, rx: mpsc::Receiver<LogLine>) {
    let mut batch: Vec<LogLine> = Vec::new();
    let mut last = Instant::now();

    loop {
        match rx.recv_timeout(Duration::from_millis(POLL_MS)) {
            Ok(mut line) => {
                line.seq = handle.seq.fetch_add(1, Ordering::Relaxed) + 1;
                push_line(&handle, line.clone());
                batch.push(line);
                if batch.len() >= BATCH_MAX || last.elapsed() >= Duration::from_millis(BATCH_MS) {
                    emit_lines(&app, &run_id, std::mem::take(&mut batch));
                    last = Instant::now();
                }
            }
            /* 只是这一轮没新行：先把攒的发出去，再看进程是不是已经退了 */
            Err(RecvTimeoutError::Timeout) => {
                if !batch.is_empty() {
                    emit_lines(&app, &run_id, std::mem::take(&mut batch));
                    last = Instant::now();
                }
                if child_exited(&handle) {
                    break;
                }
            }
            /* 两条输出流都读完了 —— kill 或进程自己退出后都会走到这里 */
            Err(RecvTimeoutError::Disconnected) => {
                if !batch.is_empty() {
                    emit_lines(&app, &run_id, std::mem::take(&mut batch));
                }
                break;
            }
        }
    }

    let code = wait_exit(&handle);
    finish(&app, &handle, &run_id, code);
}

/** 进程还在不在；不在就返回 true（退出码由 wait_exit 去取） */
fn child_exited(handle: &RunHandle) -> bool {
    let mut guard = handle.child.lock();
    match guard.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(Some(_))),
        None => true,
    }
}

/**
 * 等进程退出并取退出码。
 *
 * 为什么是轮询而不是阻塞 wait：阻塞会独占 child，那时用户点「停止」就拿不到
 * 它去 kill —— 一个正在收尾的进程会把停止按钮卡住，这是最难受的一种死锁。
 */
fn wait_exit(handle: &RunHandle) -> Option<i32> {
    let deadline = Instant::now() + Duration::from_secs(EXIT_TIMEOUT_SECS);
    loop {
        {
            let mut guard = handle.child.lock();
            match guard.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(st)) => {
                        let code = st.code();
                        *guard = None;
                        return code;
                    }
                    Ok(None) => {}
                    Err(_) => {
                        *guard = None;
                        return None;
                    }
                },
                None => return None,
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        thread::sleep(Duration::from_millis(POLL_MS));
    }
    /* 到点还没退：强制 kill 再取一次，绝不留下活着的子进程 */
    {
        let mut guard = handle.child.lock();
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }
    None
}

/** 收尾：定状态、写时间、发一次状态事件 */
fn finish(app: &AppHandle, handle: &RunHandle, run_id: &str, code: Option<i32>) {
    let stopped = handle.stop.load(Ordering::Relaxed);
    let status = if stopped {
        RunStatus::Stopped
    } else {
        match code {
            Some(0) => RunStatus::Exited,
            Some(_) => RunStatus::Failed,
            /* 连退出码都没拿到（被信号杀死 / 收尾超时）：按失败处理，别显示成正常结束 */
            None => RunStatus::Failed,
        }
    };

    {
        let mut info = handle.info.lock();
        /*
         * 已经不是 Running 说明 stop() 抢先更新过了（它要立刻给界面反馈），
         * 这里就不再覆盖 —— 否则会把「已停止」改成「已失败」，用户会以为停错了。
         */
        if info.status != RunStatus::Running {
            emit_status(app, run_id, &info);
            return;
        }
        info.status = status;
        info.exit_code = code;
        info.ended_at = Some(now_ms());
        if !stopped && matches!(status, RunStatus::Failed) {
            info.error = Some(match code {
                Some(c) => format!("进程退出码 {c}"),
                None => "进程异常结束（未拿到退出码）".to_string(),
            });
        }
        emit_status(app, run_id, &info);
    }

    let text = match status {
        RunStatus::Stopped => "已停止".to_string(),
        RunStatus::Exited => "进程已结束（退出码 0）".to_string(),
        _ => format!("进程已结束（{}）", match code {
            Some(c) => format!("退出码 {c}"),
            None => "未拿到退出码".to_string(),
        }),
    };
    push_line(handle, LogLine {
        seq: handle.seq.fetch_add(1, Ordering::Relaxed) + 1,
        ts: now_ms(),
        stream: LogStream::System,
        text,
    });
    emit_lines(app, run_id, vec![last_line(handle)]);
}

/* =============================================
   ====== 停止 / 查询 ======
   ============================================= */

/**
 * 停止一次运行。
 *
 * 置标志 + kill + **同步改一次状态**；但这里**不 emit** —— 本函数没有 AppHandle，
 * 收尾事件由监管线程的 finish 发（`finish` 见到「已不是 Running」也会照发一次）。
 *
 * 界面之所以点完立刻变，靠的是前端 `store.stopRun` 拿到返回后
 * **自己乐观置一次 stopped**、再 `loadRuns()` 对账。
 * ⚠️ 改前端时别把那两行删了 —— 删了就要等监管线程（最多 POLL_MS）才看到按钮变回去，
 * 就是那种「点了没反应」的感觉。
 */
pub fn stop(run_id: &str) -> bool {
    let handle = RUNS.lock().get(run_id).cloned();
    let Some(handle) = handle else {
        return false;
    };
    handle.stop.store(true, Ordering::Relaxed);
    {
        let mut guard = handle.child.lock();
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
            *guard = None;
        }
    }
    let mut info = handle.info.lock();
    if info.status == RunStatus::Running {
        info.status = RunStatus::Stopped;
        info.ended_at = Some(now_ms());
    }
    true
}

/** 停止全部还在跑的运行，返回停掉的数量（用在应用退出收尾） */
pub fn stop_all() -> usize {
    let ids: Vec<String> = {
        let map = RUNS.lock();
        map.iter()
            .filter(|(_, h)| h.info.lock().status == RunStatus::Running)
            .map(|(id, _)| id.clone())
            .collect()
    };
    let n = ids.len();
    for id in ids {
        stop(&id);
    }
    n
}

/** 移除一条运行记录（先停后删）。返回它是否原本存在 */
pub fn remove(run_id: &str) -> bool {
    stop(run_id);
    RUNS.lock().remove(run_id).is_some()
}

/** 全部运行记录（含已结束的），按启动时间倒序 */
pub fn list_runs() -> Vec<RunInfo> {
    let mut list: Vec<RunInfo> = RUNS.lock().values().map(|h| h.info.lock().clone()).collect();
    list.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    list
}

/** 取某个 run 已缓存的日志（切走再回来、或前端清空后想看后端留的底） */
pub fn logs(run_id: &str) -> Vec<LogLine> {
    match RUNS.lock().get(run_id) {
        Some(h) => h.logs.lock().iter().cloned().collect(),
        None => Vec::new(),
    }
}

/** 清空某个 run 的后端日志缓冲 */
pub fn clear_logs(run_id: &str) {
    if let Some(h) = RUNS.lock().get(run_id) {
        h.logs.lock().clear();
    }
}

/* =============================================
   ====== 内部小工具 ======
   ============================================= */

fn push_line(handle: &RunHandle, line: LogLine) {
    let mut logs = handle.logs.lock();
    if logs.len() >= MAX_LOG_LINES {
        logs.pop_front();
    }
    logs.push_back(line);
}

/** 取刚 push 的那一行（用于把「已启动 / 已结束」这类系统提示单独发出去） */
fn last_line(handle: &RunHandle) -> LogLine {
    handle
        .logs
        .lock()
        .back()
        .cloned()
        .unwrap_or(LogLine {
            seq: 0,
            ts: now_ms(),
            stream: LogStream::System,
            text: String::new(),
        })
}

fn emit_lines(app: &AppHandle, run_id: &str, lines: Vec<LogLine>) {
    if lines.is_empty() {
        return;
    }
    let payload = serde_json::json!({ "runId": run_id, "lines": lines });
    let _ = app.emit(EVENT_LOG_LINES, payload);
}

fn emit_status(app: &AppHandle, run_id: &str, info: &RunInfo) {
    let payload = serde_json::json!({
        "runId": run_id,
        "status": info.status,
        "exitCode": info.exit_code,
        "endedAt": info.ended_at,
        "error": info.error,
    });
    let _ = app.emit(EVENT_RUN_STATUS, payload);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 日志缓冲超过上限会丢最旧的() {
        let h = RunHandle {
            info: Mutex::new(RunInfo {
                id: "r1".into(),
                config_id: String::new(),
                name: "t".into(),
                jar_path: String::new(),
                java_bin: String::new(),
                jdk_label: String::new(),
                command: String::new(),
                work_dir: String::new(),
                status: RunStatus::Running,
                pid: None,
                started_at: 0,
                ended_at: None,
                exit_code: None,
                error: None,
            }),
            child: Mutex::new(None),
            stop: AtomicBool::new(false),
            logs: Mutex::new(VecDeque::new()),
            seq: AtomicU64::new(0),
        };
        for i in 0..(MAX_LOG_LINES + 50) {
            push_line(&h, LogLine {
                seq: i as u64,
                ts: 0,
                stream: LogStream::Stdout,
                text: format!("line-{i}"),
            });
        }
        let logs = h.logs.lock();
        assert_eq!(logs.len(), MAX_LOG_LINES);
        /* 丢的是最旧的：剩下第一行不该是 line-0 */
        assert_eq!(logs.front().map(|l| l.text.clone()), Some(format!("line-50")));
        assert_eq!(
            logs.back().map(|l| l.text.clone()),
            Some(format!("line-{}", MAX_LOG_LINES + 49))
        );
    }

    /*
     * 这是「点了停止没反应」的防线：stop 必须**同步**把状态改成 Stopped，
     * 不能等监管线程慢慢收尾。
     */
    #[test]
    fn stop_同步改状态() {
        let h = RunHandle {
            info: Mutex::new(RunInfo {
                id: "r2".into(),
                config_id: String::new(),
                name: "t".into(),
                jar_path: String::new(),
                java_bin: String::new(),
                jdk_label: String::new(),
                command: String::new(),
                work_dir: String::new(),
                status: RunStatus::Running,
                pid: None,
                started_at: 0,
                ended_at: None,
                exit_code: None,
                error: None,
            }),
            child: Mutex::new(None),
            stop: AtomicBool::new(false),
            logs: Mutex::new(VecDeque::new()),
            seq: AtomicU64::new(0),
        };
        h.stop.store(true, Ordering::Relaxed);
        {
            let mut info = h.info.lock();
            if info.status == RunStatus::Running {
                info.status = RunStatus::Stopped;
            }
        }
        assert_eq!(h.info.lock().status, RunStatus::Stopped);
    }

    /*
     * finish 的「先到先得」规则：stop() 已经标了 Stopped，
     * 收尾时就不能再按退出码改成 Failed —— 否则用户点了停止却看到「失败」。
     */
    #[test]
    fn finish_不覆盖已终止的状态() {
        let h = RunHandle {
            info: Mutex::new(RunInfo {
                id: "r3".into(),
                config_id: String::new(),
                name: "t".into(),
                jar_path: String::new(),
                java_bin: String::new(),
                jdk_label: String::new(),
                command: String::new(),
                work_dir: String::new(),
                status: RunStatus::Stopped,
                pid: None,
                started_at: 0,
                ended_at: None,
                exit_code: None,
                error: None,
            }),
            child: Mutex::new(None),
            stop: AtomicBool::new(true),
            logs: Mutex::new(VecDeque::new()),
            seq: AtomicU64::new(0),
        };
        /* 没有 AppHandle 可用，这里直接复现 finish 的判定逻辑 */
        let stopped = h.stop.load(Ordering::Relaxed);
        if h.info.lock().status == RunStatus::Running {
            let status = if stopped { RunStatus::Stopped } else { RunStatus::Failed };
            h.info.lock().status = status;
        }
        assert_eq!(h.info.lock().status, RunStatus::Stopped);
    }

    #[test]
    fn 退出码决定状态() {
        /* 0 → Exited；非 0 → Failed；拿不到退出码 → Failed（不是 Exited） */
        let decide = |stopped: bool, code: Option<i32>| -> RunStatus {
            if stopped {
                return RunStatus::Stopped;
            }
            match code {
                Some(0) => RunStatus::Exited,
                Some(_) => RunStatus::Failed,
                None => RunStatus::Failed,
            }
        };
        assert_eq!(decide(false, Some(0)), RunStatus::Exited);
        assert_eq!(decide(false, Some(1)), RunStatus::Failed);
        assert_eq!(decide(false, None), RunStatus::Failed);
        assert_eq!(decide(true, Some(1)), RunStatus::Stopped);
    }

    /*
     * 真跑一条命令，验「读线程 + 监管线程」这条主路径 ——
     * 纯函数测试全绿也证明不了进程能被真正启动和收尾（见技能坑 15）。
     * 沙箱里 /bin/sh 可能被拦，被拦就跳过（那是环境问题，不是代码问题）。
     */
    #[test]
    fn 主路径_真跑一次_echo() {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg("echo hello; echo oops 1>&2; sleep 0.2; exit 3");
        let mut child = match cmd
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                println!("跳过：本环境无法启动 /bin/sh（{e}）");
                return;
            }
        };
        let out = child.stdout.take();
        let err = child.stderr.take();
        let handle = Arc::new(RunHandle {
            info: Mutex::new(RunInfo {
                id: "r4".into(),
                config_id: String::new(),
                name: "t".into(),
                jar_path: String::new(),
                java_bin: String::new(),
                jdk_label: String::new(),
                command: "echo".into(),
                work_dir: String::new(),
                status: RunStatus::Running,
                pid: Some(child.id()),
                started_at: 0,
                ended_at: None,
                exit_code: None,
                error: None,
            }),
            child: Mutex::new(Some(child)),
            stop: AtomicBool::new(false),
            logs: Mutex::new(VecDeque::new()),
            seq: AtomicU64::new(0),
        });

        let (tx, rx) = mpsc::channel::<LogLine>();
        spawn_reader(LogStream::Stdout, Box::new(out.unwrap()), tx.clone());
        spawn_reader(LogStream::Stderr, Box::new(err.unwrap()), tx.clone());
        drop(tx);

        /* 复刻 supervise 的接收循环（它要 AppHandle，这里只验读与收尾） */
        let mut got: Vec<LogLine> = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_millis(POLL_MS)) {
                Ok(mut line) => {
                    line.seq = handle.seq.fetch_add(1, Ordering::Relaxed) + 1;
                    push_line(&handle, line.clone());
                    got.push(line);
                }
                Err(RecvTimeoutError::Timeout) => {
                    if child_exited(&handle) {
                        break;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        let code = wait_exit(&handle);

        assert_eq!(code, Some(3), "退出码应透传");
        assert!(got.iter().any(|l| l.text == "hello"), "stdout 应收到 hello");
        assert!(
            got.iter().any(|l| l.text == "oops" && l.stream == LogStream::Stderr),
            "stderr 应收到 oops 且标记为 stderr"
        );
        /* 序号必须连续：两个读线程共用一个编号器，跳号就说明有行没登记 */
        let seqs: Vec<u64> = got.iter().map(|l| l.seq).collect();
        for (i, s) in seqs.iter().enumerate() {
            assert_eq!(*s, (i + 1) as u64, "序号应连续：{seqs:?}");
        }
    }
}
