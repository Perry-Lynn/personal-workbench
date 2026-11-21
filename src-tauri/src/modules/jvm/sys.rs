/*
 * JVM 进程看板模块 · 系统采集与解析
 * ------------------------------------------------------------------
 * 四路采集，任何一路失败都不牵连其他：
 *   jps   → 有哪些 JVM         （没有 JDK 就整路不可用）
 *   ps    → CPU / RSS / etime  （没有就只有 pid 和名字）
 *   lsof  → 监听端口           （慢，但一次查所有 pid）
 *   jstat → 堆用量             （JRE 起动的进程上会失败）
 *
 * **为什么必须带超时**：jstack / jmap 会 attach 到目标 JVM，
 * 目标处于 GC 停顿或死锁时它可能一直不返回。不加超时的话
 * 一次「卡住的进程」就能把整个扫描拖死（IPC 永不返回，界面永远转圈）。
 * 所以这里统一走 run_timeout，超时直接 kill。
 *
 * ps / lsof 的采集与解析**已下沉到 core::ps** —— spring 模块也要用同样的东西，
 * 而模块之间不互相依赖是硬约定。这里只做 re-export，保持本模块调用点不变。
 *
 * 解析函数是**纯函数**，输入固定字符串、输出固定结构，在文件底部配单测。
 * @Author: fu
 */
use std::path::{Path, PathBuf};
use std::time::Duration;

/* =============================================
   ====== 命令执行 ======
   ============================================= */

/** 默认超时：扫描类命令给 6 秒，转储类给 30 秒（见 commands.rs） */
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(6);
pub const DUMP_TIMEOUT: Duration = Duration::from_secs(30);

/*
 * 带超时的命令执行下沉到了 core::proc（jstack / jmap / mvn 这类会挂住的命令都得走它）。
 * 这里 re-export 只是为了让本模块内部的调用点保持不变。
 */
pub use crate::core::proc::run_timeout;

/*
 * ps / lsof 下沉到了 core::ps（spring 模块共用）。
 * 只 re-export 本模块真正用到的几个，避免出现「没人用」的告警。
 */
pub use crate::core::ps::{collect_ports, collect_ps, kb_to_mb};

/** 某个 JDK 下的诊断工具路径 */
pub fn tool_path(home: &str, tool: &str) -> PathBuf {
    Path::new(home).join("bin").join(tool)
}

/* =============================================
   ====== 解析：jps -l ======
   ============================================= */

/**
 * `jps -l` 的输出 → (pid, main_class)。
 *
 * 要跳过三种行：
 *   - 空行 / 标题行；
 *   - `jdk.jcmd/sun.tools.jps.Jps`：**jps 自己**。它每次扫描都会把自己列进去，
 *     不过滤的话用户每次刷新都能看到一个「刚刚启动、随即消失」的幽灵进程；
 *   - 末尾可能附着的 Warning（JDK 在 hsperfdata 不可写时会打）。
 */
pub fn parse_jps(out: &str) -> Vec<(u32, String)> {
    let mut rows: Vec<(u32, String)> = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut it = line.splitn(2, char::is_whitespace);
        let pid = match it.next().and_then(|s| s.parse::<u32>().ok()) {
            Some(p) => p,
            None => continue,
        };
        let main = it.next().unwrap_or("").trim();
        if main.is_empty() {
            continue;
        }
        /* jps 自身（JDK 9+ 带 jdk.jcmd/ 前缀，JDK 8 直接是 sun.tools.jps.Jps） */
        if main == "sun.tools.jps.Jps" || main.ends_with("/sun.tools.jps.Jps") {
            continue;
        }
        rows.push((pid, main.to_string()));
    }
    rows
}

/** jps 的第二列以 .jar 结尾时，它就是 jar 的绝对路径（-jar 启动） */
pub fn jar_path_of(main_class: &str) -> Option<String> {
    if main_class.ends_with(".jar") {
        Some(main_class.to_string())
    } else {
        None
    }
}

/* =============================================
   ====== 解析：jstat -gc ======
   ============================================= */

/**
 * `jstat -gc <pid>` → (已用 KB, 容量 KB)。
 *
 * 列索引**按表头名定位**，不写死第几列：JDK 8 / 11 / 17 / 21 的 -gc 列集合
 * 并不完全一致（G1 与 ZGC 下尤其），写死列号会在换 JDK 时静默算错。
 *
 * 只累加年轻代 + 老年代（S0/S1/Eden/Old）。Metaspace 不算进「堆」——
 * 它不在 -Xmx 里，混进来会让「堆占用率」看起来永远偏高。
 */
pub fn parse_jstat_gc(out: &str) -> Option<(f64, f64)> {
    let mut lines = out.lines().filter(|l| !l.trim().is_empty());
    let header: Vec<&str> = lines.next()?.split_whitespace().collect();
    let data: Vec<&str> = match lines.next() {
        Some(l) => l.split_whitespace().collect(),
        None => return None,
    };
    if data.len() != header.len() {
        return None;
    }
    let idx = |name: &str| header.iter().position(|h| *h == name);
    let mut cap = 0.0;
    let mut used = 0.0;
    for (c, u) in [("S0C", "S0U"), ("S1C", "S1U"), ("EC", "EU"), ("OC", "OU")] {
        let ci = idx(c)?;
        let ui = idx(u)?;
        cap += data.get(ci)?.parse::<f64>().unwrap_or(0.0);
        used += data.get(ui)?.parse::<f64>().unwrap_or(0.0);
    }
    if cap <= 0.0 {
        return None;
    }
    Some((used, cap))
}

/* =============================================
   ====== 采集 ======
   ============================================= */

/** 用 jps 列出 JVM 进程（只给 pid + main_class，其余字段留空由调用方补齐） */
pub fn collect_jps(jps: &Path) -> Result<Vec<(u32, String)>, String> {
    let out = run_timeout(&jps.to_string_lossy(), &["-l"], DEFAULT_TIMEOUT)?;
    Ok(parse_jps(&out))
}

/** 单个进程的堆用量（KB）。失败返回 Err，调用方按需降级 */
pub fn collect_heap(jstat: &Path, pid: u32) -> Result<(f64, f64), String> {
    let out = run_timeout(
        &jstat.to_string_lossy(),
        &["-gc", &pid.to_string()],
        DEFAULT_TIMEOUT,
    )?;
    parse_jstat_gc(&out).ok_or_else(|| "jstat 输出无法解析".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ---- jps -l ---- */
    const JPS_OUT: &str = "\
40948 org.jetbrains.idea.maven.server.RemoteMavenServer36
45102 jdk.jcmd/sun.tools.jps.Jps
1234 /Users/fu/app/target/demo-0.0.1.jar
";

    #[test]
    fn jps_解析并跳过自身() {
        let rows = parse_jps(JPS_OUT);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], (40948, "org.jetbrains.idea.maven.server.RemoteMavenServer36".into()));
        assert_eq!(rows[1], (1234, "/Users/fu/app/target/demo-0.0.1.jar".into()));
    }

    #[test]
    fn jps_忽略空行与非数字开头() {
        assert!(parse_jps("").is_empty());
        assert!(parse_jps("\n\n").is_empty());
        assert!(parse_jps("Warning: something\n1234 A.B\n").len() == 1);
    }

    #[test]
    fn jar_路径识别() {
        assert_eq!(
            jar_path_of("/Users/fu/app/target/demo-0.0.1.jar"),
            Some("/Users/fu/app/target/demo-0.0.1.jar".into())
        );
        assert_eq!(jar_path_of("com.example.DemoApplication"), None);
    }

    /* ---- jstat -gc ---- */
    const JSTAT_OUT: &str = "\
 S0C    S1C    S0U    S1U      EC       EU        OC         OU       MC     MU    CCSC   CCSU   YGC     YGCT    FGC    FGCT     GCT
1024.0 1024.0  0.0  512.0   8192.0   4096.0   20480.0    10240.0  4864.0 4200.0 512.0  400.0      9     0.057     0     0.000     0.060
";

    #[test]
    fn jstat_按表头取列() {
        let (used, cap) = parse_jstat_gc(JSTAT_OUT).unwrap();
        assert_eq!(cap, 1024.0 + 1024.0 + 8192.0 + 20480.0);
        assert_eq!(used, 0.0 + 512.0 + 4096.0 + 10240.0);
    }

    #[test]
    fn jstat_列数不匹配就放弃() {
        assert!(parse_jstat_gc("S0C S1C\n1024.0\n").is_none());
        assert!(parse_jstat_gc("").is_none());
        assert!(parse_jstat_gc("只表头没有数据\n").is_none());
    }

    /*
     * 换 JDK 后列顺序可能变（G1 下多 CGC/CGCT，ZGC 下各代容量为 0）。
     * 按名定位必须仍然算对。
     */
    #[test]
    fn jstat_列顺序变化仍算对() {
        let out = "\
 OU       OC      S0U    S0C      EU       EC       S1U    S1C
10240.0 20480.0  0.0  1024.0   4096.0   8192.0   512.0 1024.0
";
        let (used, cap) = parse_jstat_gc(out).unwrap();
        assert_eq!(cap, 1024.0 + 1024.0 + 8192.0 + 20480.0);
        assert_eq!(used, 0.0 + 512.0 + 4096.0 + 10240.0);
    }

    #[test]
    fn jstat_容量为_0_视为不可用() {
        let out = "S0C S1C EC OC S0U S1U EU OU\n0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0\n";
        assert!(parse_jstat_gc(out).is_none());
    }
}
