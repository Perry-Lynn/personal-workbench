/*
 * 工作台核心层 · 带超时的子进程执行
 * ------------------------------------------------------------------
 * 为什么要有它，而不是直接用 std::process::Command::output()：
 *   模块要跑的外部命令里有相当一部分是**会挂住的** ——
 *   jstack / jmap 会 attach 到目标 JVM（目标 GC 停顿时它可能永不返回），
 *   mvn 首次构建要下载插件（几分钟），lsof 在 LISTEN 多的机器上会变慢。
 *   std::process 没有内建超时，一次挂住就能让 IPC 永远不返回、界面永远转圈。
 *
 * 所以统一在这里提供「跑命令 + 超时后 kill」的实现，所有模块共用。
 * （按工作台约定：模块之间不互相依赖，共用能力放 core。）
 *
 * stderr 会并进返回值：java -version、mvn 的错误信息都写在 stderr，
 * 丢掉它的话「命令失败了但拿不到原因」这类问题会非常难查。
 * @Author: fu
 */
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/** 每轮轮询的间隔：够快（不至于让用户等）又不至于空转烧 CPU */
const POLL_MS: u64 = 20;

/** 在指定工作目录下跑命令；cwd 为 None 时继承当前进程的工作目录 */
pub fn run_timeout_in(
    program: &str,
    args: &[&str],
    timeout: Duration,
    cwd: Option<&Path>,
) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = cmd.spawn().map_err(|e| format!("无法启动 {program}: {e}"))?;

    /*
     * stdout / stderr 各起一个读线程，**且在等退出之前**。
     *
     * 这是本文件最容易写错的一处：管道缓冲区只有几十 KB，命令输出一超就塞满，
     * 子进程随即阻塞在 write 上、永不退出。主线程若先 try_wait 再读，
     * 就只能等超时 —— 实测 `ps -ww -A -o …,command=` 单独跑 0.04 秒、
     * 输出 180KB，走这里却每次都「6 秒超时」（Spring 服务台的报错就是这个）。
     * jstack 的线程 dump 同理。
     */
    let (tx, rx) = mpsc::channel::<(bool, String)>();
    let mut sources: Vec<(bool, Box<dyn Read + Send>)> = Vec::new();
    if let Some(s) = child.stdout.take() {
        sources.push((false, Box::new(s)));
    }
    if let Some(s) = child.stderr.take() {
        sources.push((true, Box::new(s)));
    }
    let readers = sources.len();
    for (is_err, mut s) in sources {
        let tx = tx.clone();
        /* 不 join：读线程自己读完发送结果后就结束了，结果统一走下面的消息通道 */
        thread::spawn(move || {
            let mut buf = String::new();
            let _ = s.read_to_string(&mut buf);
            let _ = tx.send((is_err, buf));
        });
    }
    drop(tx);

    /*
     * 轮询 try_wait + 超时 kill。
     * 不用 output()：它没有超时参数，而「目标进程卡住」并不是理论风险。
     */
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{program} 执行超时（{} 秒）", timeout.as_secs()));
                }
                thread::sleep(Duration::from_millis(POLL_MS));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("等待 {program} 失败: {e}"));
            }
        }
    };

    /*
     * 收读线程的结果。进程已退出，管道随之 EOF，正常是立刻收到；
     * 仍按剩余时间收，因为「子进程的孙子进程还攥着管道不放」时读线程会一直等 EOF，
     * 无超时地 recv 就把「永不挂住」这条保证丢了。
     */
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut drained = 0usize;
    while drained < readers {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(format!("{program} 执行超时（{} 秒）", timeout.as_secs()));
        }
        match rx.recv_timeout(left) {
            Ok((true, s)) => {
                stderr = s;
                drained += 1;
            }
            Ok((false, s)) => {
                stdout = s;
                drained += 1;
            }
            Err(_) => return Err(format!("{program} 执行超时（{} 秒）", timeout.as_secs())),
        }
    }

    let mut s = stdout;
    if !stderr.trim().is_empty() {
        if !s.is_empty() {
            s.push('\n');
        }
        s.push_str(&stderr);
    }
    /*
     * 退出码非 0 **不一定**是失败：mvn dependency:tree 在离线模式缺依赖时
     * 也会非 0 退出但仍打印了树。所以只在「非 0 且一个字都没输出」时才报错，
     * 具体怎么解读交给调用方。
     */
    if !status.success() && s.trim().is_empty() {
        return Err(format!("{program} 退出码 {:?}", status.code()));
    }
    Ok(s)
}

/** 在当前进程的工作目录下跑命令 */
pub fn run_timeout(program: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    run_timeout_in(program, args, timeout, None)
}

/*
 * 一次子进程执行的完整结果。
 *
 * 与上面那对函数的区别：上面把 stderr 直接拼进返回值（对 `java -version` 那种
 * 「原因写在 stderr」的命令最省事），但**「逐行读 JSON」的场景不行** ——
 * stderr 里混进一行普通日志，调用方按行解析就会多出一条噪音。
 * 所以这里 stdout / stderr 分开给，由调用方自己决定怎么用。
 */
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
}

/*
 * 与 run_timeout_in 同源，但把一段文本喂给子进程的 stdin。
 *
 * 为什么不能直接复用 run_timeout_in：那个函数把 stdin 设成 `Stdio::null()`。
 * 而「控制协议」类 CLI（`--input-format stream-json`）恰恰要求**从 stdin 读报文**，
 * 给 null 的话它一个请求都收不到，会当成空会话直接结束 —— 表现是「命令成功退出，
 * 但什么都没有」，最难查。
 *
 * 两个方向必须同时读，否则会死锁：子进程的 stdout 可能有几十 KB
 * （实测 qoderclicn 的 initialize 响应就有 70KB），而管道缓冲区只有 64KB ——
 * 填满后子进程阻塞在 write 上，此时若主线程还在等它退出，就永远等不到。
 * 所以 stdout / stderr 各起一个读线程，主线程只等「读完 + 退出」的截止时间。
 *
 * stdin 写完立刻关闭：子进程靠「stdin EOF」判断输入结束，不关就一直等下一行。
 */
pub fn run_timeout_stdin_in(
    program: &str,
    args: &[&str],
    input: &str,
    timeout: Duration,
    cwd: Option<&Path>,
) -> Result<CommandOutput, String> {
    run_timeout_stdin_env_in(program, args, input, timeout, cwd, &[])
}

/*
 * 与 run_timeout_stdin_in 同源，但允许**注入环境变量**。
 *
 * 为什么要有它：git 这类工具的「交互性」由环境变量控制 ——
 * 不设 `GIT_TERMINAL_PROMPT=0` 时，push/pull 遇到要输凭据会去开 /dev/tty，
 * 子进程没有 tty 就可能挂在那儿直到超时，界面上表现为「推送永远转圈」。
 * 配置项里没有等价开关（`credential.interactive` 只管凭据助手这一种交互），
 * 所以必须能在 spawn 时带环境。
 */
pub fn run_timeout_stdin_env_in(
    program: &str,
    args: &[&str],
    input: &str,
    timeout: Duration,
    cwd: Option<&Path>,
    envs: &[(String, String)],
) -> Result<CommandOutput, String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = cmd.spawn().map_err(|e| format!("无法启动 {program}: {e}"))?;

    if let Some(mut si) = child.stdin.take() {
        /* 写入失败通常意味着子进程已经退出（如参数不合法），交给下面的读线程报结果 */
        let _ = si.write_all(input.as_bytes());
        let _ = si.flush();
        drop(si);
    }

    let (tx, rx) = mpsc::channel::<(bool, String)>();
    /*
     * stdout / stderr 是两种不同的类型（ChildStdout / ChildStderr），
     * 只有共同的 trait 能用 —— 装箱成 `dyn Read + Send` 才能放进同一个列表里循环起线程。
     */
    let mut sources: Vec<(bool, Box<dyn Read + Send>)> = Vec::new();
    if let Some(s) = child.stdout.take() {
        sources.push((false, Box::new(s)));
    }
    if let Some(s) = child.stderr.take() {
        sources.push((true, Box::new(s)));
    }

    let mut readers = Vec::new();
    for (is_err, mut s) in sources {
        let tx = tx.clone();
        readers.push(thread::spawn(move || {
            let mut buf = String::new();
            /* 读到 EOF 为止；子进程被 kill 时这里会正常返回已读到的部分 */
            let _ = s.read_to_string(&mut buf);
            let _ = tx.send((is_err, buf));
        }));
    }
    drop(tx);

    let deadline = Instant::now() + timeout;
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut drained = 0usize;
    while drained < readers.len() {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("{program} 执行超时（{} 秒）", timeout.as_secs()));
        }
        match rx.recv_timeout(left) {
            Ok((true, s)) => {
                stderr = s;
                drained += 1;
            }
            Ok((false, s)) => {
                stdout = s;
                drained += 1;
            }
            /* 超时，或所有发送端都已消失（理论上不会，因为上面 drop 了 tx 的副本） */
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{program} 执行超时（{} 秒）", timeout.as_secs()));
            }
        }
    }

    /* 管道已 EOF，进程通常随即退出；仍按剩余时间轮询，避免最后一步又无限等 */
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(POLL_MS));
            }
            Err(_) => break None,
        }
    };

    Ok(CommandOutput {
        stdout,
        stderr,
        code,
    })
}
