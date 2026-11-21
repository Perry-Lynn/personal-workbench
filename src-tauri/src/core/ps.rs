/*
 * 进程与端口的采集与解析（跨模块共用）
 * ------------------------------------------------------------------
 * 从 modules/jvm/sys.rs 下沉过来的：jvm（进程看板）与 spring（Spring Boot 服务台）
 * 都要「列进程 / 拿资源占用 / 查监听端口」这三件事，
 * 而**模块之间不互相依赖**是硬约定，所以放在 core。
 *
 * 解析函数全是**纯函数**：输入固定字符串、输出固定结构。
 * 真实机器上「ps 输出被截断」「lsof 列错位」这类事复现成本太高，
 * 只能在单测里用录好的样本钉住 —— 见文件底部。
 * @Author: fu
 */
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use crate::core::proc::run_timeout;

/** 常规采集（ps / jps / jstat）超时 */
pub const PS_TIMEOUT: Duration = Duration::from_secs(6);
/**
 * lsof 专用超时：全量 LISTEN 扫描在 LISTEN 多的机器上偶尔要 3-5 秒，
 * 6 秒不够 —— 用户场景下看到过 6 秒超时把整次扫描打成降级。
 * 15 秒足够覆盖机器有几十个监听进程的极端情况，且不会让前端等太久。
 */
pub const PORTS_TIMEOUT: Duration = Duration::from_secs(15);

/* =============================================
   ====== 解析：ps ======
   ============================================= */

/** ps 单行 → (pid, cpu%, rss_mb, etime 原文)。command 在最后一个字段之后。 */
pub struct PsRow {
    pub pid: u32,
    pub cpu_percent: f64,
    pub mem_mb: f64,
    pub uptime_sec: Option<u64>,
    pub command: String,
}

/**
 * 取前 n 个非空白字段，以及它们之后的剩余原文。
 *
 * 为什么不能用 `splitn(n, char::is_whitespace)`：
 *   ps 的输出是**按列宽右对齐**的，字段之间常常是多个连续空格。
 *   splitn 对连续分隔符会产生空串字段 —— 于是第 2 列拿到 ""、CPU 解析成 0.0，
 *   命令行也整体错位一个字段。必须按「连续空白视作一个分隔符」来切，
 *   同时又不能用 split_whitespace（那会把命令行本身切碎且丢失原始空格）。
 */
fn split_fields<'a>(line: &'a str, n: usize) -> Option<(Vec<&'a str>, &'a str)> {
    let mut fields: Vec<&'a str> = Vec::with_capacity(n);
    let mut rest = line.trim_start();
    for i in 0..n {
        match rest.find(char::is_whitespace) {
            Some(end) => {
                fields.push(&rest[..end]);
                rest = rest[end..].trim_start();
            }
            None => {
                /* 最后一个字段允许吃掉剩下的全部（例如 ps 没输出 command 列） */
                if i == n - 1 {
                    fields.push(rest);
                    rest = "";
                } else {
                    return None;
                }
            }
        }
    }
    Some((fields, rest))
}

/**
 * 解析 `ps -o pid=,pcpu=,rss=,etime=,command=` 的一行。
 *
 * 命令行本身含大量空格（`-Dspring.profiles.active=dev` 之类），
 * 所以前四个字段按空白切、剩下的**整段原样保留**，
 * 既不切碎命令行，也不会被列对齐的多个连续空格骗到（见 split_fields）。
 */
pub fn parse_ps_line(line: &str) -> Option<PsRow> {
    let (fields, rest) = split_fields(line, 4)?;
    let pid = fields[0].parse::<u32>().ok()?;
    let cpu = fields[1].parse::<f64>().unwrap_or(0.0);
    /* BSD ps 的 rss 单位是 KB */
    let rss_kb = fields[2].parse::<f64>().unwrap_or(0.0);
    let etime = fields[3];
    let command = rest.trim_end().to_string();
    Some(PsRow {
        pid,
        cpu_percent: cpu,
        mem_mb: kb_to_mb(rss_kb),
        uptime_sec: parse_etime(etime),
        command,
    })
}

/**
 * ps 的 etime → 秒。三种形态都要认：
 *   `03:04`        3 分 4 秒
 *   `02:03:04`     2 小时 3 分 4 秒
 *   `01-02:03:04`  1 天 2 小时 3 分 4 秒
 * 认不出来返回 None（界面显示「—」，比显示 0 秒诚实）。
 */
pub fn parse_etime(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().ok()?, r),
        None => (0u64, s),
    };
    let parts: Vec<&str> = rest.split(':').collect();
    let secs = match parts.len() {
        /* MM:SS */
        2 => parts[0].parse::<u64>().ok()? * 60 + parts[1].parse::<u64>().ok()?,
        /* HH:MM:SS */
        3 => {
            parts[0].parse::<u64>().ok()? * 3600
                + parts[1].parse::<u64>().ok()? * 60
                + parts[2].parse::<u64>().ok()?
        }
        _ => return None,
    };
    Some(days * 86400 + secs)
}

/** KB → MB，保留一位 */
pub fn kb_to_mb(kb: f64) -> f64 {
    (kb / 1024.0 * 10.0).round() / 10.0
}

/* =============================================
   ====== 解析：lsof -nP -iTCP -sTCP:LISTEN ======
   ============================================= */

/**
 * lsof 输出 → pid 到监听端口的映射。
 *
 * 端口要去重：同一进程在 IPv4 / IPv6 上各监听一次，lsof 会给出两行，
 * 不去重的话「8080 8080」这种重复会直接显示在界面上。
 *
 * NAME 列形如 `*:8080`、`127.0.0.1:8080`、`[::1]:8080`，
 * 端口一律取**最后一个冒号之后**的部分（IPv6 地址本身带冒号）。
 */
pub fn parse_lsof_listen(out: &str) -> HashMap<u32, Vec<u16>> {
    let mut map: HashMap<u32, Vec<u16>> = HashMap::new();
    for line in out.lines() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with("COMMAND") {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        /*
         * COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME —— NAME 固定是第 9 列。
         *
         * **不能取最后一列**：监听中的行末尾还跟着一个 `(LISTEN)`，
         * 取最后一列会拿到它，端口解析必然失败（表现是「一个端口都看不到」）。
         */
        if cols.len() < 9 {
            continue;
        }
        let pid = match cols[1].parse::<u32>() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let name = cols[8];
        let port_str = match name.rsplit(':').next() {
            Some(s) => s,
            None => continue,
        };
        let port = match port_str.parse::<u16>() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let v = map.entry(pid).or_default();
        if !v.contains(&port) {
            v.push(port);
        }
    }
    for v in map.values_mut() {
        v.sort_unstable();
    }
    map
}

/* =============================================
   ====== 采集 ======
   ============================================= */

/*
 * ps 的 `-ww`：显式要求「不限列宽」。
 *
 * man ps 的原文：默认宽度是「你的窗口大小」，`-w` 给 132 列，
 * `-w` 写两次（即 `-ww`）则「按需给任意多列，不看窗口大小」；
 * 并特别说明 **「输出不是终端时，永远用不限列宽」**。
 *
 * 也就是说：我们走管道拿输出，本来就不截断，`-ww` 实际是个空操作。
 * 那为什么还留着？因为这件事**依赖「输出不是 tty」这个前提**，
 * 而一旦哪天有人改成 pty 或直接在终端里跑，长命令行就会被从中间砍掉 ——
 * 而 `--spring.profiles.active=dev` 这种关键参数恰恰在 80 列之后，
 * 表现是「有端口但认不出 profile」这种极难自查的静默失败。
 * 写上是把前提钉死，代价为零。
 */
const PS_FIELDS: &str = "pid=,pcpu=,rss=,etime=,command=";

/** 一次 ps 拿指定 pid 的资源占用 → pid → PsRow */
pub fn collect_ps(pids: &[u32]) -> Result<HashMap<u32, PsRow>, String> {
    if pids.is_empty() {
        return Ok(HashMap::new());
    }
    let list = pids
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let out = run_timeout("ps", &["-ww", "-o", PS_FIELDS, "-p", &list], PS_TIMEOUT)?;
    Ok(parse_ps_map(&out))
}

/**
 * 本机**全部**进程的资源占用。
 *
 * 与 collect_ps 的区别是不需要先知道 pid —— Spring Boot 服务台要靠扫描命令行
 * 才能认出哪些是 Java 进程，所以必须先无条件列一遍。
 * 几百行输出在毫秒级，代价可以接受。
 */
pub fn collect_all_ps() -> Result<Vec<PsRow>, String> {
    let out = run_timeout("ps", &["-ww", "-A", "-o", PS_FIELDS], PS_TIMEOUT)?;
    Ok(out.lines().filter_map(parse_ps_line).collect())
}

/** ps 文本 → pid → PsRow（供 collect_ps / collect_all_ps 共用，也便于单测） */
pub fn parse_ps_map(out: &str) -> HashMap<u32, PsRow> {
    let mut map = HashMap::new();
    for line in out.lines() {
        if let Some(row) = parse_ps_line(line) {
            map.insert(row.pid, row);
        }
    }
    map
}

/**
 * 查本机 LISTEN 中的 TCP 端口。
 *
 * **为什么用全量扫描 + Rust 端按 pid 过滤，而不是 `lsof -p <pids>`**：
 *   `lsof -p <pids>` 会对每个 pid 各做一次 stat/proc 查询，3 个进程在某些机器上
 *   累加起来能超过 6 秒（用户在 Spring Boot 场景下遇到过）。改成一次全量
 *   `-iTCP -sTCP:LISTEN` 反而更稳 —— LISTEN 端口通常只有几条，扫描几乎不耗时，
 *   然后用 hashset 在解析端 O(1) 过滤目标 pid。超时也加到 15 秒兜底。
 */
pub fn collect_ports(pids: &[u32]) -> Result<HashMap<u32, Vec<u16>>, String> {
    if pids.is_empty() {
        return Ok(HashMap::new());
    }
    let out = run_timeout("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN"], PORTS_TIMEOUT)?;
    let all = parse_lsof_listen(&out);
    let set: HashSet<u32> = pids.iter().copied().collect();
    Ok(all.into_iter().filter(|(p, _)| set.contains(p)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ---- lsof ---- */
    const LSOF_OUT: &str = "\
COMMAND     PID     USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
java      40948 fupengyu   90u  IPv4 0x9c9dfe1679fb6164      0t0  TCP *:8080 (LISTEN)
java      40948 fupengyu   91u  IPv6 0x7c44c286f9de3579      0t0  TCP *:8080 (LISTEN)
java      40948 fupengyu   92u  IPv4 0xe076cc8e40f8ca05      0t0  TCP 127.0.0.1:5005 (LISTEN)
java       7777 fupengyu   93u  IPv4 0xaaaaaaaaaaaaaaaa      0t0  TCP [::1]:9000 (LISTEN)
";

    #[test]
    fn lsof_按_pid_聚合且去重() {
        let map = parse_lsof_listen(LSOF_OUT);
        /* IPv4/IPv6 同一端口只留一个，升序 */
        assert_eq!(map.get(&40948), Some(&vec![5005, 8080]));
        /* IPv6 地址里的冒号不能干扰取端口 */
        assert_eq!(map.get(&7777), Some(&vec![9000]));
    }

    #[test]
    fn lsof_跳过表头与短行() {
        assert!(parse_lsof_listen("COMMAND PID USER\n").is_empty());
        assert!(parse_lsof_listen("java 40948 fupengyu\n").is_empty());
        assert!(parse_lsof_listen("").is_empty());
    }

    /* ---- ps ---- */
    #[test]
    fn ps_行解析保留含空格的命令行() {
        let row =
            parse_ps_line("40948   0.1  123456  01-02:03:04 java -jar demo.jar --server.port=8080")
                .unwrap();
        assert_eq!(row.pid, 40948);
        assert_eq!(row.cpu_percent, 0.1);
        assert_eq!(row.mem_mb, 120.6); /* 123456 KB / 1024 ≈ 120.6 MB */
        assert_eq!(row.uptime_sec, Some(86400 + 2 * 3600 + 3 * 60 + 4));
        assert_eq!(row.command, "java -jar demo.jar --server.port=8080");
    }

    #[test]
    fn ps_多个连续空格也能切对() {
        let row =
            parse_ps_line("  999   12.5   2048   03:04 /usr/bin/java -Xmx512m   -jar  a.jar ").unwrap();
        assert_eq!(row.pid, 999);
        assert_eq!(row.cpu_percent, 12.5);
        assert_eq!(row.mem_mb, 2.0);
        assert_eq!(row.uptime_sec, Some(184));
        assert_eq!(row.command, "/usr/bin/java -Xmx512m   -jar  a.jar");
    }

    #[test]
    fn ps_残缺行返回_None() {
        assert!(parse_ps_line("").is_none());
        assert!(parse_ps_line("abc 1 2 3 4").is_none());
        assert!(parse_ps_line("40948").is_none());
    }

    #[test]
    fn ps_文本聚合成_map() {
        let m = parse_ps_map(
            "  1   0.0  1024  01:00 /usr/bin/java -jar a.jar\n  2   1.0  2048  02:00 /bin/sh\n",
        );
        assert_eq!(m.len(), 2);
        assert_eq!(m.get(&1).map(|r| r.command.as_str()), Some("/usr/bin/java -jar a.jar"));
        assert_eq!(m.get(&2).map(|r| r.mem_mb), Some(2.0));
    }

    /* ---- etime ---- */
    #[test]
    fn etime_三种形态() {
        assert_eq!(parse_etime("03:04"), Some(184));
        assert_eq!(parse_etime("02:03:04"), Some(7384));
        assert_eq!(parse_etime("01-02:03:04"), Some(93784));
    }

    #[test]
    fn etime_异常输入返回_None() {
        assert_eq!(parse_etime(""), None);
        assert_eq!(parse_etime("  "), None);
        assert_eq!(parse_etime("abc"), None);
        /* 四段不属于任何已知形态，宁可空着也不猜 */
        assert_eq!(parse_etime("1:2:3:4"), None);
    }

    /*
     * 这一格是「运行时长永远是 0」的直接防线：
     * "1-" 这种只有天、没有时分秒的形态解析不出来，必须返回 None 而不是 0。
     */
    #[test]
    fn etime_只有天数时不猜成_0() {
        assert_eq!(parse_etime("1-"), None);
    }
}
