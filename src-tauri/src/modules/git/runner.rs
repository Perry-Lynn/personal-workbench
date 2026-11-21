/*
 * Git 管理模块 · git 执行封装
 * ------------------------------------------------------------------
 * 所有 git 调用都从这里走，保证三件事：
 *   1. 永远带 `-c core.quotepath=false / color.ui=false` —— 文件名里的中文
 *      不被转义成 \xxx 八进制、输出不带 ANSI 颜色码，前端解析才对得上；
 *   2. 永远带 `GIT_TERMINAL_PROMPT=0` —— push/pull 要凭据时**直接失败并报原因**，
 *      而不是挂在 /dev/tty 上让界面永远转圈；
 *   3. 永远有超时 —— 只读命令 10 秒，远端命令 120 秒。
 *
 * ⚠️ 不要用 core/proc.rs 的 `run_timeout_in`：它把 stderr 并进 stdout、
 * 吞退出码（那是给 `java -version` 之类设计的），git 的成败判定全靠
 * 退出码 + stderr，必须走 stdout/stderr 分开的 `run_timeout_stdin_env_in`。
 * @Author: fu
 */
use std::path::Path;
use std::time::Duration;

use crate::core::proc::run_timeout_stdin_env_in;
use crate::modules::git::models::{AheadBehind, GitRaw};

/** 只读命令超时（status / diff / log / branch —— 本地操作，10 秒很宽裕） */
pub const TIMEOUT_READ: Duration = Duration::from_secs(10);
/** 远端命令超时（fetch / pull / push —— 受网络与仓库体积影响） */
pub const TIMEOUT_REMOTE: Duration = Duration::from_secs(120);

/*
 * log / for-each-ref 的字段与记录分隔符。
 *
 * 用控制字符而不是 \t / \n：subject、分支名里什么可打印字符都可能出现。
 * ⚠️ 两个 git 子命令对 `%x1f` 转义的支持**不一样**：
 *   · `git log --format` 认它 → 格式串里直接写 `%x1f` 文本，git 负责转换
 *   · `git for-each-ref --format` **不认**（实测原样输出 `%x1f` 字面量）
 *     → 格式串里必须嵌**字面**控制字符（在 Rust 侧用 {FS}/{RS} 拼）
 * 两条路都归到同一个解析约定：输出里是 \x1f / \x1e。
 */
pub const FS: char = '\x1f';
pub const RS: char = '\x1e';

/** log / show 共用的提交元信息格式（前端 parseLog 解析），git 负责 %x 转义 */
pub fn commit_format() -> &'static str {
    "%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e"
}

/** 分支列表格式（前端 parseBranches 解析）。%x 转义不生效，直接写字面分隔符 */
pub fn branch_format() -> String {
    format!(
        "%(refname){FS}%(refname:short){FS}%(objectname:short){FS}%(upstream:short){FS}%(upstream:track){FS}%(HEAD){FS}%(committerdate:unix){FS}%(contents:subject){RS}"
    )
}

/**
 * 在 repo 目录下跑一次 git。
 *
 * 返回 Err 只有一种情况：**基础设施失败**（git 没装、超时、进程起不来）。
 * 「命令跑起来了但退出码非 0」不算错 —— merge 冲突、push 被拒、
 * 空仓库的 log 都是非 0 退出，但都是要拿去给用户看的**业务结果**。
 */
pub fn run_git(repo: &Path, args: &[&str], timeout: Duration) -> Result<GitRaw, String> {
    run_git_env(repo, args, timeout, &[])
}

/** git 的固定环境（文件头那三条保证里的第 2 条，外加两条让输出可解析） */
fn base_envs() -> Vec<(String, String)> {
    vec![
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ("GIT_PAGER".into(), "cat".into()),
        /* merge 时不拉起编辑器（没有 tty，拉起必挂） */
        ("GIT_MERGE_AUTOEDIT".into(), "no".into()),
    ]
}

/** 带额外环境变量的 git 调用（extra 会覆盖 base_envs 里的同名项） */
pub fn run_git_env(
    repo: &Path,
    args: &[&str],
    timeout: Duration,
    extra: &[(&str, &str)],
) -> Result<GitRaw, String> {
    let mut full: Vec<&str> = vec![
        "-c",
        "core.quotepath=false",
        "-c",
        "color.ui=false",
        "-c",
        "color.diff=false",
    ];
    full.extend_from_slice(args);
    let mut envs = base_envs();
    envs.extend(extra.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())));
    let out = run_timeout_stdin_env_in("git", &full, "", timeout, Some(repo), &envs)?;
    Ok(GitRaw {
        stdout: out.stdout,
        stderr: out.stderr,
        code: out.code,
    })
}

/** 只读命令的快捷方式 */
pub fn run_read(repo: &Path, args: &[&str]) -> Result<GitRaw, String> {
    run_git(repo, args, TIMEOUT_READ)
}

/**
 * 只读命令 + 强制 `LC_ALL=C`。
 *
 * 专给**输出要被结构化解析**的命令用（目前是分支列表）：`%(upstream:track)` 是
 * git 的可翻译文案，装了中文 catalog 的机器上会输出「[领先 1]」之类，解析当场断掉。
 * 本机 LANG=zh_CN.UTF-8 时实测输出仍是英文（catalog 没装），但**碰巧对不能当依赖** ——
 * 同一份代码换台机器就坏，而且坏法是「徽标不出」这种不报错的坏法。
 *
 * 只对需要解析输出的命令加，不给全模块加：其它命令的 stderr 是要展示给用户看的，
 * 保持系统语言更友好。
 */
pub fn run_read_c(repo: &Path, args: &[&str]) -> Result<GitRaw, String> {
    run_git_env(repo, args, TIMEOUT_READ, &[("LC_ALL", "C")])
}

/** 退出码为 0 */
pub fn ok(raw: &GitRaw) -> bool {
    raw.code == Some(0)
}

/**
 * 把 git 的报错收敛成「给人看的一句话」。
 *
 * git 的 stderr 经常是多段（提示 + 建议 + 命令行 echo），
 * 第一行才是失败原因，后面几行是给人看的建议 —— 摘要取首行，
 * 全文保留在 OpResult.stderr 里供展开。
 */
pub fn first_line(s: &str) -> String {
    s.lines()
        .find(|l| !l.trim().is_empty())
        .map(|l| l.trim().to_string())
        .unwrap_or_default()
}

/** 合并/拉取失败后，把冲突文件名列出来（diff --name-only --diff-filter=U） */
pub fn conflict_files(repo: &Path) -> Vec<String> {
    match run_read(repo, &["diff", "--name-only", "--diff-filter=U", "-z"]) {
        Ok(raw) if ok(&raw) => raw
            .stdout.as_bytes().split(|b| *b == 0).filter(|p| !p.is_empty())
            .filter_map(|p| std::str::from_utf8(p).ok().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

/**
 * 解析 `rev-list --left-right --count <upstream>...HEAD` 的输出。
 *
 * 输出是 `<left>\t<right>`：left = 只在上游（**落后**），right = 只在本地（**领先**）。
 * 方向别记反 —— 界面上 ↑↓ 箭头的意义全靠它。
 */
pub fn parse_ahead_behind(stdout: &str) -> AheadBehind {
    let mut it = stdout.trim().split_whitespace();
    let behind = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let ahead = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    AheadBehind { ahead, behind }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 领先落后的方向解析() {
        let ab = parse_ahead_behind("3\t7\n");
        assert_eq!(ab.behind, 3);
        assert_eq!(ab.ahead, 7);
    }

    #[test]
    fn 空输出按零处理() {
        let ab = parse_ahead_behind("");
        assert_eq!(ab.ahead, 0);
        assert_eq!(ab.behind, 0);
    }

    #[test]
    fn 报错摘要取首个非空行() {
        assert_eq!(
            first_line("fatal: refusing to merge unrelated histories\nhint: foo\n"),
            "fatal: refusing to merge unrelated histories"
        );
        assert_eq!(first_line("\n\nerror: x"), "error: x");
    }
}
