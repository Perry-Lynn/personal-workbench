/*
 * Git 管理模块 · Tauri IPC 命令层
 * ------------------------------------------------------------------
 * 命令前缀 git_，返回统一 ApiResponse<T>。
 *
 * 分工：Rust 只跑 git、带出原始输出（GitRaw）与结构化操作结果（OpResult）；
 * porcelain v2 / unified diff / log 格式的**解析全在前端**（纯函数 + 逻辑测试）。
 *
 * 错误契约（重要）：
 *   ApiResponse::err  = 基础设施失败（路径为空、git 没装、超时）
 *   ApiResponse::ok + OpResult{ok:false} = 预期内的业务结果
 *     （merge 冲突、push 被拒、checkout 有未提交修改挡路……）
 *   —— 前者弹红色报错，后者给具体的操作提示，不能混。
 *
 * 一律 async + spawn_blocking：模块约定，任何可能阻塞的逻辑都不能跑在 UI 线程上。
 * @Author: fu
 */
use std::path::{Path, PathBuf};

use tauri::command;
use tauri_plugin_shell::ShellExt;

use crate::core::api::ApiResponse;
use crate::modules::git::models::{AheadBehind, GitOperationState, GitRaw, OpResult, RepoInfo};
use crate::modules::git::runner::{
    branch_format, commit_format, conflict_files, first_line, ok, parse_ahead_behind, run_git,
    run_read, run_read_c, TIMEOUT_READ, TIMEOUT_REMOTE,
};

/** repo 参数统一收敛成 PathBuf；空串直接当基础设施错误 */
fn repo_path(repo: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(repo.trim());
    if repo.trim().is_empty() {
        return Err("没有打开仓库".into());
    }
    Ok(p)
}

/** 写操作的成败判定：退出码 0 成功；否则从 stderr 摘要出失败原因 */
fn op_result(raw: GitRaw, success_msg: &str) -> OpResult {
    if ok(&raw) {
        let mut r = OpResult::ok(success_msg);
        r.stderr = raw.stderr;
        r
    } else {
        OpResult::fail(first_line(&raw.stderr), raw.stderr)
    }
}

/** 合并/拉取失败时：区分「冲突」与其它失败，冲突时带上文件清单 */
fn merge_result(repo: &Path, raw: GitRaw, success_msg: &str) -> OpResult {
    if ok(&raw) {
        return OpResult::ok(success_msg);
    }
    let conflicts = conflict_files(repo);
    let mut r = OpResult::fail(
        if conflicts.is_empty() {
            first_line(&raw.stderr)
        } else {
            format!("合并有 {} 个文件冲突", conflicts.len())
        },
        raw.stderr,
    );
    r.conflicts = conflicts;
    r
}

/* ============================== 仓库 ============================== */

/**
 * 打开一个仓库（用户选的可能是子目录，这里统一收敛到仓库根）。
 * 汇总分支 / 上游 / 领先落后 —— 工具栏一次拿全，不必再发第二条 IPC。
 */
#[command]
pub async fn git_open_repo(path: String) -> ApiResponse<RepoInfo> {
    match tokio::task::spawn_blocking(move || -> Result<RepoInfo, String> {
        let sel = repo_path(&path)?;
        if !sel.exists() {
            return Err(format!("目录不存在：{}", sel.display()));
        }
        /* 仓库根：用户可能选中子目录 */
        let top = run_read(&sel, &["rev-parse", "--show-toplevel"])?;
        if !ok(&top) {
            return Err("这不是一个 git 仓库（没有找到 .git）".into());
        }
        let root = PathBuf::from(top.stdout.trim());
        let info = probe_repo(&root)?;
        Ok(info)
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("打开仓库任务异常退出: {e}")),
    }
}

#[command]
pub async fn git_operation_state(repo: String) -> ApiResponse<GitOperationState> {
    match tokio::task::spawn_blocking(move || operation_state(&repo_path(&repo)?)).await {
        Ok(Ok(v)) => ApiResponse::ok(v), Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("读取 Git 操作状态失败：{e}")),
    }
}

fn operation_state(repo: &Path) -> Result<GitOperationState, String> {
    let git_dir = run_read(repo, &["rev-parse", "--git-dir"])?;
    if !ok(&git_dir) { return Err("无效 Git 仓库".into()); }
    let gd = PathBuf::from(git_dir.stdout.trim());
    let gd = if gd.is_absolute() { gd } else { repo.join(gd) };
    let kind = if gd.join("rebase-merge").exists() || gd.join("rebase-apply").exists() { "rebase" }
        else if gd.join("MERGE_HEAD").exists() { "merge" }
        else if gd.join("CHERRY_PICK_HEAD").exists() { "cherry-pick" }
        else if gd.join("REVERT_HEAD").exists() { "revert" } else { "none" };
    Ok(GitOperationState { kind: kind.into(), conflicts: conflict_files(repo) })
}

#[command]
pub async fn git_mark_resolved(repo: String, path: String, confirm_binary: bool) -> ApiResponse<OpResult> {
    match tokio::task::spawn_blocking(move || mark_resolved(&repo_path(&repo)?, &path, confirm_binary)).await {
        Ok(Ok(v)) => ApiResponse::ok(v), Ok(Err(e)) => ApiResponse::err(e), Err(e) => ApiResponse::err(e.to_string()),
    }
}

#[command]
pub async fn git_open_conflict_file(app: tauri::AppHandle, repo: String, path: String) -> ApiResponse<OpResult> {
    let root = match repo_path(&repo) { Ok(v) => v, Err(e) => return ApiResponse::err(e) };
    let rel = PathBuf::from(&path);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_))) { return ApiResponse::err("冲突路径无效"); }
    let conflicts = conflict_files(&root);
    if !conflicts.iter().any(|p| p == &path) { return ApiResponse::err("该路径已不在冲突列表中"); }
    let file = root.join(rel);
    let canonical = match file.canonicalize() { Ok(v) => v, Err(e) => return ApiResponse::err(format!("冲突文件不存在，可能已删除：{e}")) };
    let canonical_root = match root.canonicalize() { Ok(v) => v, Err(e) => return ApiResponse::err(e.to_string()) };
    if !canonical.starts_with(canonical_root) { return ApiResponse::err("冲突文件符号链接越出仓库"); }
    match app.shell().open(canonical.to_string_lossy().to_string(), None) {
        Ok(()) => ApiResponse::ok(OpResult::ok("已交给系统默认应用打开")), Err(e) => ApiResponse::err(e.to_string()),
    }
}

fn mark_resolved(repo: &Path, raw_path: &str, confirm_binary: bool) -> Result<OpResult, String> {
    let op = operation_state(repo)?;
    if op.kind == "none" { return Ok(OpResult::fail("当前没有进行中的 Git 操作", String::new())); }
    if !op.conflicts.iter().any(|p| p == raw_path) { return Ok(OpResult::fail("该路径已不在冲突列表中", String::new())); }
    let rel = PathBuf::from(raw_path);
    if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_))) { return Ok(OpResult::fail("冲突路径越出仓库", String::new())); }
    let full = repo.join(&rel);
    if full.exists() {
        let real = full.canonicalize().map_err(|e| e.to_string())?;
        let root = repo.canonicalize().map_err(|e| e.to_string())?;
        if !real.starts_with(root) { return Ok(OpResult::fail("文件符号链接越出仓库，拒绝暂存", String::new())); }
        let bytes = std::fs::read(&real).map_err(|e| format!("读取冲突文件失败，拒绝暂存：{e}"))?;
        if bytes.contains(&0) {
            if !confirm_binary { return Ok(OpResult::fail("二进制文件需确认已在外部解决", String::new())); }
        } else if let Ok(text) = std::str::from_utf8(&bytes) {
            if text.lines().any(|l| { let t=l.trim_start(); t.starts_with("<<<<<<<") || t.starts_with("=======") || t.starts_with(">>>>>>>") || t.starts_with("|||||||") }) { return Ok(OpResult::fail("文件仍包含冲突标记，请解决后再试", String::new())); }
        } else if !confirm_binary { return Ok(OpResult::fail("二进制文件需确认已在外部解决", String::new())); }
    }
    let p = format!(":(literal){}", raw_path);
    let raw = run_read(repo, &["add", "-A", "--", &p])?;
    Ok(op_result(raw, "冲突已标记为解决"))
}

#[command]
pub async fn git_continue_operation(repo: String, expected_kind: String) -> ApiResponse<OpResult> {
    match tokio::task::spawn_blocking(move || continue_operation_sync(&repo_path(&repo)?, &expected_kind)).await { Ok(Ok(v)) => ApiResponse::ok(v), Ok(Err(e)) => ApiResponse::err(e), Err(e) => ApiResponse::err(e.to_string()) }
}

fn continue_operation_sync(root: &Path, expected_kind: &str) -> Result<OpResult, String> {
    let state = operation_state(root)?;
    if expected_kind != "merge" || state.kind != "merge" { return Ok(OpResult::fail("当前操作不是 merge，无法继续", String::new())); }
    if !state.conflicts.is_empty() { return Ok(OpResult::fail("仍有未解决的冲突", String::new())); }
    let raw = run_read(root, &["-c", "core.editor=true", "merge", "--continue"])?;
    if ok(&raw) { let after = operation_state(root)?; if after.kind == "none" { Ok(OpResult::ok("合并已完成")) } else { Ok(OpResult::fail("Git 仍报告合并操作进行中", format!("kind={}", after.kind))) } }
    else { Ok(OpResult::fail(first_line(&raw.stderr), raw.stderr)) }
}

#[command]
pub async fn git_abort_operation(repo: String, expected_kind: String) -> ApiResponse<OpResult> {
    match tokio::task::spawn_blocking(move || abort_operation_sync(&repo_path(&repo)?, &expected_kind)).await { Ok(Ok(v)) => ApiResponse::ok(v), Ok(Err(e)) => ApiResponse::err(e), Err(e) => ApiResponse::err(e.to_string()) }
}

fn abort_operation_sync(root: &Path, expected_kind: &str) -> Result<OpResult, String> {
    let state = operation_state(root)?;
    if expected_kind != "merge" || state.kind != "merge" { return Ok(OpResult::fail("当前操作不是 merge，无法中止", String::new())); }
    let raw = run_read(root, &["merge", "--abort"])?;
    if ok(&raw) { let after = operation_state(root)?; if after.kind == "none" { Ok(OpResult::ok("合并已中止")) } else { Ok(OpResult::fail("Git 操作仍处于进行中", format!("kind={}", after.kind))) } }
    else { Ok(OpResult::fail(first_line(&raw.stderr), raw.stderr)) }
}

/** 汇总仓库当前态：分支 / detached / 上游 / 领先落后 / 是否空仓库 */
fn probe_repo(root: &Path) -> Result<RepoInfo, String> {
    /* 当前分支：symbolic-ref 成功 = 在分支上；失败 = detached HEAD */
    let br = run_read(root, &["symbolic-ref", "--short", "-q", "HEAD"])?;
    let branch = if ok(&br) && !br.stdout.trim().is_empty() {
        Some(br.stdout.trim().to_string())
    } else {
        None
    };

    /* 上游：没设过会非 0 退出，不算错 */
    let up = run_read(root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])?;
    let upstream = if ok(&up) && !up.stdout.trim().is_empty() {
        Some(up.stdout.trim().to_string())
    } else {
        None
    };

    /* 领先/落后：left = 只在上游（落后），right = 只在本地（领先） */
    let (ahead, behind) = match &upstream {
        Some(u) => {
            let spec = format!("{u}...HEAD");
            let ab = run_read(root, &["rev-list", "--left-right", "--count", &spec])?;
            if ok(&ab) {
                let v = parse_ahead_behind(&ab.stdout);
                (v.ahead, v.behind)
            } else {
                (0, 0)
            }
        }
        None => (0, 0),
    };

    /* 空仓库（还没有任何提交）：git log 会 128 退出，前端按空态展示 */
    let has_head = run_read(root, &["rev-parse", "--verify", "--quiet", "HEAD"])?;
    let detached = branch.is_none();

    Ok(RepoInfo {
        root: root.display().to_string(),
        valid: true,
        branch,
        detached,
        upstream,
        ahead,
        behind,
        empty: !ok(&has_head),
    })
}

/* ============================== 只读 ============================== */

/** status --porcelain=v2 --branch -z（含分支头信息与领先/落后） */
#[command]
pub async fn git_status(repo: String) -> ApiResponse<GitRaw> {
    match tokio::task::spawn_blocking(move || -> Result<GitRaw, String> {
        let root = repo_path(&repo)?;
        run_read(&root, &["status", "--porcelain=v2", "--branch", "-z"])
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("查询状态任务异常退出: {e}")),
    }
}

/**
 * 取 diff。
 *   kind = "unstaged"  工作区 vs 暂存区
 *   kind = "staged"    暂存区 vs HEAD
 *   kind = "untracked" 未跟踪文件：git diff 不涉及它们，走 --no-index 比 /dev/null
 *                      （退出码 1 = 有差异，是**正常**结果，不是失败）
 */
#[command]
pub async fn git_diff(repo: String, kind: String, path: Option<String>) -> ApiResponse<GitRaw> {
    match tokio::task::spawn_blocking(move || -> Result<GitRaw, String> {
        let root = repo_path(&repo)?;
        let p = path.filter(|s| !s.trim().is_empty());
        let raw = match kind.as_str() {
            "staged" => {
                let mut args = vec!["diff", "--cached", "-U3"];
                if let Some(p) = &p {
                    args.push("--");
                    args.push(p);
                }
                run_read(&root, &args)?
            }
            "untracked" => {
                let p = p.ok_or("未跟踪文件的 diff 需要指定路径")?;
                /* --no-index 不看索引，直接比两个路径；/dev/null 当「空文件」 */
                let mut r = run_read(&root, &["diff", "--no-index", "-U3", "--", "/dev/null", &p])?;
                if r.code == Some(1) {
                    /* 1 = 存在差异（正常）；git 会把「没差异」留成 0 */
                    r.code = Some(0);
                }
                r
            }
            _ => {
                let mut args = vec!["diff", "-U3"];
                if let Some(p) = &p {
                    args.push("--");
                    args.push(p);
                }
                run_read(&root, &args)?
            }
        };
        Ok(raw)
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("查询差异任务异常退出: {e}")),
    }
}

/**
 * 某个提交的元信息 + 差异（提交详情面板用）。
 * 元信息复用 log 的格式串（前端 parseLog 直接解析）；
 * 差异走 `--first-parent`：合并提交展示「相对第一父的变更」，
 * 否则 git show 对 merge 什么都不给，点开详情永远是空白。
 */
#[command]
pub async fn git_show(repo: String, rev: String) -> ApiResponse<GitRaw> {
    match tokio::task::spawn_blocking(move || -> Result<GitRaw, String> {
        let root = repo_path(&repo)?;
        let meta = run_read(&root, &["show", "-s", &format!("--format={}", commit_format()), &rev])?;
        if !ok(&meta) {
            return Err(if meta.stderr.trim().is_empty() {
                format!("找不到提交 {rev}")
            } else {
                first_line(&meta.stderr)
            });
        }
        let diff = run_read(
            &root,
            &["show", "-U3", "--format=", "-m", "--first-parent", &rev],
        )?;
        /* 拼成一条：前端先按 RS 拆出元信息，剩下的就是 diff */
        Ok(GitRaw {
            stdout: format!("{}{}", meta.stdout, diff.stdout),
            stderr: diff.stderr,
            code: diff.code,
        })
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("查询提交任务异常退出: {e}")),
    }
}

/**
 * 提交历史（topo 序：子先于父 —— 提交图 lane 布局依赖这个顺序）。
 * 空仓库时 git log 128 退出，这里按「空列表」返回而不是报错。
 *
 * rev：不传 = 当前 HEAD；传了 = 看该引用的历史（用于「查看远端分支但不切换分支」）。
 * 前端传的是**完整 refname**（refs/heads/x、refs/remotes/origin/x）——
 * 短名在「分支名与文件名同名」时有歧义，完整 refname 没有。
 * 远端分支读的是本地已有的 remote-tracking ref，**不联网、不动工作区**。
 */
#[command]
pub async fn git_log(repo: String, skip: u32, count: u32, rev: Option<String>) -> ApiResponse<GitRaw> {
    match tokio::task::spawn_blocking(move || -> Result<GitRaw, String> {
        let root = repo_path(&repo)?;
        let skip_s = format!("--skip={skip}");
        let count_s = format!("-n{}", count.max(1));
        let fmt = format!("--format={}", commit_format());
        let rev = rev.filter(|s| !s.trim().is_empty());
        let mut args = vec!["log", "--topo-order", &skip_s, &count_s];
        if let Some(r) = &rev {
            args.push(r);
        }
        args.push(&fmt);
        let raw = run_read(&root, &args)?;
        /* 引用不存在（如还没 fetch 过的远端分支）时给出可操作的提示 */
        if !ok(&raw) && rev.is_some() {
            return Err(format!(
                "无法读取该引用的历史：{}（若这是远端分支，请先 Fetch 把引用取下来）",
                first_line(&raw.stderr)
            ));
        }
        Ok(raw)
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("查询历史任务异常退出: {e}")),
    }
}

/** 分支列表：本地 refs/heads + 远程 refs/remotes（带上游跟踪信息，见 branch_format） */
#[command]
pub async fn git_branches(repo: String) -> ApiResponse<GitRaw> {
    match tokio::task::spawn_blocking(move || -> Result<GitRaw, String> {
        let root = repo_path(&repo)?;
        /* run_read_c：输出要被结构化解析（%(upstream:track) 是可翻译文案），强制英文环境 */
        run_read_c(
            &root,
            &["for-each-ref", "refs/heads", "refs/remotes", &format!("--format={}", branch_format())],
        )
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("查询分支任务异常退出: {e}")),
    }
}

/**
 * 远端列表：`git remote -v` 原文。
 *
 * 只带回原始行，「这个远端是 GitHub 还是自建 GitLab」的判定放在前端纯函数里
 * （utils/remotes.ts）—— 那里能用真实 URL 样例钉住边界，Rust 侧只做搬运。
 * 没有配置任何远端时退出码仍是 0、stdout 为空，属于正常结果而不是错误。
 */
#[command]
pub async fn git_remotes(repo: String) -> ApiResponse<GitRaw> {
    match tokio::task::spawn_blocking(move || -> Result<GitRaw, String> {
        let root = repo_path(&repo)?;
        run_read(&root, &["remote", "-v"])
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("查询远端列表任务异常退出: {e}")),
    }
}

/** 与上游的相对位置（fetch/pull/push 之后快速刷新 ↑↓ 用） */
#[command]
pub async fn git_ahead_behind(repo: String) -> ApiResponse<AheadBehind> {
    match tokio::task::spawn_blocking(move || -> Result<AheadBehind, String> {
        let root = repo_path(&repo)?;
        let up = run_read(&root, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])?;
        if !ok(&up) || up.stdout.trim().is_empty() {
            /* 没有上游：领先落后无从谈起，给 0/0 而不是报错 */
            return Ok(AheadBehind { ahead: 0, behind: 0 });
        }
        let spec = format!("{}...HEAD", up.stdout.trim());
        let ab = run_read(&root, &["rev-list", "--left-right", "--count", &spec])?;
        if !ok(&ab) {
            return Ok(AheadBehind { ahead: 0, behind: 0 });
        }
        Ok(parse_ahead_behind(&ab.stdout))
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("查询领先落后任务异常退出: {e}")),
    }
}

/* ============================== 暂存 ============================== */

/** 暂存（git add 覆盖修改/删除/新增 —— 指定路径时现代 git 会连删除一起记录） */
#[command]
pub async fn git_stage(repo: String, paths: Vec<String>) -> ApiResponse<OpResult> {
    match tokio::task::spawn_blocking(move || -> Result<OpResult, String> {
        let root = repo_path(&repo)?;
        if paths.is_empty() {
            return Err("没有要暂存的文件".into());
        }
        let mut args = vec!["add", "--"];
        let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        args.extend_from_slice(&refs);
        let raw = run_git(&root, &args, TIMEOUT_READ)?;
        Ok(op_result(raw, "已暂存"))
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("暂存任务异常退出: {e}")),
    }
}

/** 取消暂存（restore --staged：索引回退到 HEAD，工作区改动原样保留） */
#[command]
pub async fn git_unstage(repo: String, paths: Vec<String>) -> ApiResponse<OpResult> {
    match tokio::task::spawn_blocking(move || -> Result<OpResult, String> {
        let root = repo_path(&repo)?;
        if paths.is_empty() {
            return Err("没有要取消暂存的文件".into());
        }
        let mut args = vec!["restore", "--staged", "--"];
        let refs: Vec<&str> = paths.iter().map(|s| s.as_str()).collect();
        args.extend_from_slice(&refs);
        let raw = run_git(&root, &args, TIMEOUT_READ)?;
        Ok(op_result(raw, "已取消暂存"))
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("取消暂存任务异常退出: {e}")),
    }
}

/**
 * 按块（hunk）暂存/取消暂存：前端把单个 hunk 拼成迷你 patch 从 stdin 喂给
 * `git apply --cached -`（reverse = 取消暂存该块）。
 *
 * 失败时 stderr 原样上浮（「patch does not apply」通常意味着相邻块先动了、
 * 上下文对不上）—— 不做 fuzz 重试：悄悄套到别的行上比失败更危险。
 */
#[command]
pub async fn git_stage_hunk(
    repo: String,
    path: String,
    patch: String,
    reverse: bool,
) -> ApiResponse<OpResult> {
    match tokio::task::spawn_blocking(move || -> Result<OpResult, String> {
        let root = repo_path(&repo)?;
        /* path 不参与 git apply（patch 自带 a/b 路径定位文件），但要防前端漏传 */
        if path.trim().is_empty() {
            return Err("没有指定文件".into());
        }
        if patch.trim().is_empty() {
            return Err("补丁内容为空".into());
        }
        let mut args = vec!["apply", "--cached", "--whitespace=nowarn"];
        if reverse {
            args.push("--reverse");
        }
        args.push("-");
        let raw = run_git(&root, &args, TIMEOUT_READ)?;
        let mut r = op_result(raw, if reverse { "已取消暂存该块" } else { "已暂存该块" });
        if !r.ok {
            /* apply 失败最常见于「相邻块先动了、上下文对不上」——提示而非 fuzz 重试 */
            r.message = format!("{}（若刚改过相邻块，请先暂存相邻块再试）", r.message);
        }
        Ok(r)
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("按块暂存任务异常退出: {e}")),
    }
}

/* ============================== 提交 ============================== */

/** 提交暂存区；成功后把新 commit 的 hash 带回来 */
#[command]
pub async fn git_commit(repo: String, message: String, amend: bool) -> ApiResponse<OpResult> {
    match tokio::task::spawn_blocking(move || -> Result<OpResult, String> {
        let root = repo_path(&repo)?;
        if message.trim().is_empty() {
            return Err("提交信息不能为空".into());
        }
        let mut args = vec!["commit"];
        if amend {
            args.push("--amend");
        }
        args.push("-m");
        args.push(&message);
        let raw = run_git(&root, &args, TIMEOUT_READ)?;
        if !ok(&raw) {
            return Ok(op_result(raw, "提交失败"));
        }
        /* 提交成功后取 hash：rev-parse HEAD 失败（理论不可能）就退回摘要 */
        let head = run_read(&root, &["rev-parse", "HEAD"])?;
        let mut r = OpResult::ok("已提交");
        r.hash = if ok(&head) {
            Some(head.stdout.trim().to_string())
        } else {
            None
        };
        Ok(r)
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("提交任务异常退出: {e}")),
    }
}

/* ============================== 分支 ============================== */

/** 切换分支（newBranch 非空时 = 基于 ref 新建并切换） */
#[command]
pub async fn git_checkout(
    repo: String,
    ref_name: String,
    new_branch: Option<String>,
) -> ApiResponse<OpResult> {
    match tokio::task::spawn_blocking(move || -> Result<OpResult, String> {
        let root = repo_path(&repo)?;
        if ref_name.trim().is_empty() {
            return Err("分支名为空".into());
        }
        let raw = match new_branch.filter(|s| !s.trim().is_empty()) {
            Some(nb) => run_git(&root, &["checkout", "-b", &nb, &ref_name], TIMEOUT_READ)?,
            None => run_git(&root, &["checkout", &ref_name], TIMEOUT_READ)?,
        };
        /* checkout 被未提交修改挡住是最常见的失败，给出可操作的提示 */
        let mut r = op_result(raw, "已切换分支");
        if !r.ok && r.stderr.contains("would be overwritten") {
            r.message = "本地有未提交的修改会被切换覆盖 —— 请先提交或暂存后再切换".into();
        }
        Ok(r)
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("切换分支任务异常退出: {e}")),
    }
}

/** 删除分支（-d 安全删除：没合并进当前分支的会拒删；force 走 -D） */
#[command]
pub async fn git_delete_branch(repo: String, ref_name: String, force: bool) -> ApiResponse<OpResult> {
    match tokio::task::spawn_blocking(move || -> Result<OpResult, String> {
        let root = repo_path(&repo)?;
        if ref_name.trim().is_empty() {
            return Err("分支名为空".into());
        }
        let flag = if force { "-D" } else { "-d" };
        let raw = run_git(&root, &["branch", flag, &ref_name], TIMEOUT_READ)?;
        let mut r = op_result(raw, "已删除分支");
        if !r.ok && r.stderr.contains("not fully merged") {
            r.message = "该分支尚未合并，已阻止删除（可在分支右键里选「强制删除」）".into();
        }
        Ok(r)
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("删除分支任务异常退出: {e}")),
    }
}

/** 合并分支到当前分支；冲突时带回冲突文件清单 */
#[command]
pub async fn git_merge(repo: String, ref_name: String) -> ApiResponse<OpResult> {
    match tokio::task::spawn_blocking(move || -> Result<OpResult, String> {
        let root = repo_path(&repo)?;
        if ref_name.trim().is_empty() {
            return Err("分支名为空".into());
        }
        let raw = run_git(&root, &["merge", "--no-edit", &ref_name], TIMEOUT_READ)?;
        Ok(merge_result(&root, raw, "合并完成"))
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("合并任务异常退出: {e}")),
    }
}

/* ============================== 远端 ============================== */

/**
 * fetch --all --prune：一次把所有 remote 的所有分支引用都更新到最新。
 * 与「拉取某个分支」（git_fetch_branch）的分工：
 *   · Fetch  = 我关心全部远端，都刷一遍（只动 remote-tracking 引用）
 *   · Pull   = 我只要所选分支那一个引用更新，别的都别动
 * 两者都**不碰工作区、不切换分支、不合并**。
 */
#[command]
pub async fn git_fetch(repo: String) -> ApiResponse<OpResult> {
    match tokio::task::spawn_blocking(move || -> Result<OpResult, String> {
        let root = repo_path(&repo)?;
        let raw = run_git(&root, &["fetch", "--all", "--prune"], TIMEOUT_REMOTE)?;
        Ok(op_result(raw, "已获取远端更新"))
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("fetch 任务异常退出: {e}")),
    }
}

/**
 * merge --ff-only 失败的收敛。
 * git 的原文分两类，分别给指路 —— 用户看到「Not possible to fast-forward」是不知道下一步干嘛的。
 */
fn ff_failure(raw: GitRaw, branch: &str, remote: &str) -> OpResult {
    let first = first_line(&raw.stderr);
    let msg = if raw.stderr.contains("Not possible to fast-forward") {
        format!(
            "本地分支 {branch} 与 {remote}/{branch} 已分叉（本地有远端没有的提交），无法快进 —— 未做任何改动。要把远端提交合进来，请在分支右键选「合并到当前分支」"
        )
    } else if raw.stderr.contains("would be overwritten") {
        format!("工作区里有会被覆盖的改动，git 拒绝了这次快进 —— 请先提交或暂存后重试（{first}）")
    } else {
        first
    };
    OpResult::fail(msg, raw.stderr)
}

/**
 * git_pull_branch 的同步内核（抽出来是为了能直接测：不必起 tokio runtime，
 * 也能在临时仓库里真跑一遍三种情形）。
 */
fn pull_branch_sync(
    root: &Path,
    remote: &str,
    branch: &str,
    update_local: bool,
) -> Result<OpResult, String> {
    let (remote, branch) = (remote.trim().to_string(), branch.trim().to_string());
    if remote.is_empty() || branch.is_empty() {
        return Err("远端名或分支名为空".into());
    }

    /* ① 只要远端引用 */
    if !update_local {
        let raw = run_git(root, &["fetch", &remote, &branch], TIMEOUT_REMOTE)?;
        return Ok(op_result(
            raw,
            &format!("已更新 {remote}/{branch} 的远端状态（未改任何本地分支）"),
        ));
    }

    let upstream = format!("{remote}/{branch}");
    /* 当前检出的是哪条分支：分离头指针 / 空仓库时拿不到（非 0 退出即视为「没有」） */
    let head = run_read(root, &["symbolic-ref", "--short", "-q", "HEAD"])?;
    let head_branch = if ok(&head) { head.stdout.trim().to_string() } else { String::new() };

    let r = if head_branch == branch {
        /* ③ 当前检出分支：先取远端引用，再快进合并 */
        let fetched = run_git(root, &["fetch", &remote, &branch], TIMEOUT_REMOTE)?;
        if !ok(&fetched) {
            op_result(fetched, "")
        } else {
            let merged = run_git(root, &["merge", "--ff-only", &upstream], TIMEOUT_READ)?;
            if ok(&merged) {
                let mut ok_r = OpResult::ok(format!(
                    "已快进更新当前分支 {branch} 到 {upstream}（无合并提交）"
                ));
                ok_r.stderr = merged.stderr;
                ok_r
            } else {
                ff_failure(merged, &branch, &remote)
            }
        }
    } else {
        /* ② 非当前检出的本地分支：让 git 自己把住「只能快进」这道门 */
        let raw = run_git(
            root,
            &["fetch", &remote, &format!("{branch}:{branch}")],
            TIMEOUT_REMOTE,
        )?;
        if ok(&raw) {
            let mut ok_r = OpResult::ok(format!(
                "已快进更新本地分支 {branch} 到 {upstream} 的最新提交（工作区与当前分支未动）"
            ));
            ok_r.stderr = raw.stderr;
            ok_r
        } else if raw.stderr.contains("non-fast-forward") {
            OpResult::fail(
                format!(
                    "本地分支 {branch} 上有 {upstream} 没有的提交，无法快进 —— 未做任何改动。要保留本地提交，请先切到它再合并"
                ),
                raw.stderr,
            )
        } else {
            op_result(raw, "")
        }
    };
    Ok(r)
}

/**
 * 拉取**一个分支**：把远端最新带回来，并按所选分支的性质决定要不要更新本地引用。
 *
 * 三种情形（`update_local` 来自前端「选中的是不是本地分支」，但**具体走哪条路由 Rust
 * 按 HEAD 的实际状态定** —— 前端那份状态可能已经过期，比如刚在命令行切了分支）：
 *
 *   ① 选中的是**远端分支**（update_local = false）
 *        `git fetch <remote> <branch>` —— 只更新 refs/remotes/<remote>/<branch>，
 *        任何本地分支都不动。
 *
 *   ② 选中的是**本地分支，且不是当前检出的那条**
 *        `git fetch <remote> <branch>:<branch>` —— 把本地该分支**快进**到远端位置；
 *        工作区与当前检出的分支完全不动。
 *        ⚠️ 这个带本地端的 `<分支>:<分支>` refspec **正是这里要用的**：它确实会改写本地
 *        分支，但只改写用户**自己选中的那一条**，而且 git 只在**可快进**时才允许
 *        —— 历史已分叉会直接 `[rejected] non-fast-forward`，本地引用保持原样、不丢提交。
 *        （早先这里写过「绝不能用带本地端的 refspec」，那是把「不要合并」过度解读成了
 *        「不要更新本地分支」：用户要的是「拉 B 分支时别动我正在做的 A 分支」，B 自己得更新。
 *        症状是「提示落后远端 4 个提交，点完 Pull 还是落后 4 个」。）
 *
 *   ③ 选中的本地分支**就是当前检出分支**
 *        先 fetch 再 `merge --ff-only` —— 只在能快进时前进，**不产生合并提交**；
 *        工作区有会被覆盖的改动时 git 自己会拒绝，不会硬来。
 *
 * 三条路都**不产生 merge 提交**、都不碰别的分支。「把远端提交真正合进当前分支历史
 * （可能产生合并提交）」是另一个动作：git_merge（分支右键 → 合并到当前分支）。
 */
#[command]
pub async fn git_pull_branch(
    repo: String,
    remote: String,
    branch: String,
    update_local: bool,
) -> ApiResponse<OpResult> {
    match tokio::task::spawn_blocking(move || -> Result<OpResult, String> {
        let root = repo_path(&repo)?;
        pull_branch_sync(&root, &remote, &branch, update_local)
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("拉取分支任务异常退出: {e}")),
    }
}

/**
 * `rev-list --count <from>..<to>`：只在 to 里、不在 from 里的提交数。
 * 用于远端分支「多出来几个提交」的计数 —— 旧引用已被回收（force push / GC）时会失败，
 * 前端退化成「只显示有新提交、不显示个数」。
 */
#[command]
pub async fn git_count_between(repo: String, from: String, to: String) -> ApiResponse<u32> {
    match tokio::task::spawn_blocking(move || -> Result<u32, String> {
        let root = repo_path(&repo)?;
        let spec = format!("{}..{}", from.trim(), to.trim());
        let raw = run_read(&root, &["rev-list", "--count", &spec])?;
        if !ok(&raw) {
            return Err(first_line(&raw.stderr));
        }
        Ok(raw.stdout.trim().parse::<u32>().unwrap_or(0))
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("统计提交数任务异常退出: {e}")),
    }
}

/** push。被拒（non-fast-forward）等业务失败走 ok:false + stderr 原文 */
#[command]
pub async fn git_push(repo: String) -> ApiResponse<OpResult> {
    match tokio::task::spawn_blocking(move || -> Result<OpResult, String> {
        let root = repo_path(&repo)?;
        let raw = run_git(&root, &["push"], TIMEOUT_REMOTE)?;
        let mut r = op_result(raw, "已推送");
        if !r.ok && r.stderr.contains("non-fast-forward") {
            r.message =
                "推送被拒：远端有你本地没有的提交 —— 先 Pull（会快进更新本地分支）或合并后再推送"
                    .into();
        }
        Ok(r)
    })
    .await
    {
        Ok(Ok(v)) => ApiResponse::ok(v),
        Ok(Err(e)) => ApiResponse::err(e),
        Err(e) => ApiResponse::err(format!("push 任务异常退出: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /** 临时目录（同名先清掉，免得上一轮残留影响判断） */
    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("git-pull-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("建临时目录失败");
        d
    }

    /** 跑一条 git；失败立刻 panic —— 夹具写错要当场暴露，不能静默往下走 */
    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t.io")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t.io")
            .output()
            .expect("git 起不来");
        assert!(
            out.status.success(),
            "git {:?} 失败: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    fn git_may_fail(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").args(args).current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t.io")
            .env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t.io")
            .output().expect("git 起不来");
        String::from_utf8_lossy(&out.stderr).to_string()
    }

    fn make_conflict(tag: &str) -> PathBuf {
        let repo = tmpdir(tag);
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("冲突 文件.txt"), "base\n").unwrap();
        git(&repo, &["add", "-A"]); git(&repo, &["commit", "-qm", "base"]);
        git(&repo, &["checkout", "-qb", "topic"]);
        std::fs::write(repo.join("冲突 文件.txt"), "topic\n").unwrap();
        git(&repo, &["commit", "-qam", "topic"]);
        git(&repo, &["checkout", "-q", "main"]);
        std::fs::write(repo.join("冲突 文件.txt"), "main\n").unwrap();
        git(&repo, &["commit", "-qam", "main"]);
        let _ = git_may_fail(&repo, &["merge", "topic"]);
        repo
    }

    #[test]
    fn merge冲突重开可识别_残留拒绝_继续生成真实合并提交() {
        let repo = make_conflict("conflict-continue");
        let state = operation_state(&repo).unwrap();
        assert_eq!(state.kind, "merge");
        assert_eq!(state.conflicts, vec!["冲突 文件.txt"]);
        let refused = mark_resolved(&repo, "冲突 文件.txt", false).unwrap();
        assert!(!refused.ok);
        assert!(refused.message.contains("冲突标记"));
        assert_eq!(operation_state(&repo).unwrap().conflicts.len(), 1);
        std::fs::write(repo.join("冲突 文件.txt"), "resolved\n").unwrap();
        let staged = mark_resolved(&repo, "冲突 文件.txt", false).unwrap();
        assert!(staged.ok, "{}", staged.message);
        assert_eq!(operation_state(&repo).unwrap().kind, "merge");
        assert!(operation_state(&repo).unwrap().conflicts.is_empty());
        let done = continue_operation_sync(&repo, "merge").unwrap();
        assert!(done.ok, "{} {}", done.message, done.stderr);
        assert_eq!(operation_state(&repo).unwrap().kind, "none");
        assert_eq!(git(&repo, &["rev-list", "--count", "--merges", "HEAD"]).trim(), "1");
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn merge中止恢復工作區且拒絕錯誤類型和未解衝突() {
        let repo = make_conflict("conflict-abort");
        let wrong = continue_operation_sync(&repo, "rebase").unwrap();
        assert!(!wrong.ok);
        let unresolved = continue_operation_sync(&repo, "merge").unwrap();
        assert!(!unresolved.ok);
        let aborted = abort_operation_sync(&repo, "merge").unwrap();
        assert!(aborted.ok, "{} {}", aborted.message, aborted.stderr);
        assert_eq!(operation_state(&repo).unwrap().kind, "none");
        assert_eq!(std::fs::read_to_string(repo.join("冲突 文件.txt")).unwrap(), "main\n");
        let none = abort_operation_sync(&repo, "merge").unwrap();
        assert!(!none.ok);
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn 二进制冲突需显式确认且操作类型路径优先识别rebase() {
        let repo = tmpdir("conflict-binary");
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("data.bin"), b"base\0bytes").unwrap(); git(&repo, &["add", "-A"]); git(&repo, &["commit", "-qm", "base"]);
        git(&repo, &["checkout", "-qb", "topic"]);
        std::fs::write(repo.join("data.bin"), b"topic\0bytes").unwrap(); git(&repo, &["commit", "-qam", "topic"]);
        git(&repo, &["checkout", "-q", "main"]);
        std::fs::write(repo.join("data.bin"), b"main\0bytes").unwrap(); git(&repo, &["commit", "-qam", "main"]);
        let _ = git_may_fail(&repo, &["merge", "topic"]);
        assert_eq!(operation_state(&repo).unwrap().conflicts, vec!["data.bin"]);
        assert!(!mark_resolved(&repo, "data.bin", false).unwrap().ok);
        assert!(mark_resolved(&repo, "data.bin", true).unwrap().ok);
        let gd = PathBuf::from(git(&repo, &["rev-parse", "--git-dir"]).trim());
        let gd = if gd.is_absolute() { gd } else { repo.join(gd) };
        std::fs::create_dir_all(gd.join("rebase-merge")).unwrap();
        assert_eq!(operation_state(&repo).unwrap().kind, "rebase");
        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn worktree下git状态探测正确且删除冲突可暂存解决() {
        let repo = tmpdir("conflict-worktree");
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("gone.txt"), "base\n").unwrap(); git(&repo, &["add", "-A"]); git(&repo, &["commit", "-qm", "base"]);
        git(&repo, &["branch", "topic"]);
        let wt = repo.with_file_name(format!("git-pull-wt-{}", std::process::id())); let _ = std::fs::remove_dir_all(&wt);
        git(&repo, &["worktree", "add", "-q", wt.to_str().unwrap(), "topic"]);
        assert_eq!(operation_state(&wt).unwrap().kind, "none");
        std::fs::remove_file(wt.join("gone.txt")).unwrap(); git(&wt, &["commit", "-qam", "delete"]);
        git(&repo, &["checkout", "-q", "main"]); std::fs::write(repo.join("gone.txt"), "modified\n").unwrap(); git(&repo, &["commit", "-qam", "modify"]);
        let _ = git_may_fail(&repo, &["merge", "topic"]);
        let state = operation_state(&repo).unwrap(); assert_eq!(state.kind, "merge"); assert!(state.conflicts.contains(&"gone.txt".to_string()));
        std::fs::remove_file(repo.join("gone.txt")).unwrap();
        let r = mark_resolved(&repo, "gone.txt", false).unwrap(); assert!(r.ok, "{}", r.message);
        assert!(operation_state(&repo).unwrap().conflicts.is_empty());
        let _ = std::fs::remove_dir_all(repo); let _ = std::fs::remove_dir_all(wt);
    }

    fn rev(dir: &Path, r: &str) -> String {
        git(dir, &["rev-parse", r]).trim().to_string()
    }

    /**
     * Pull 的核心契约：**把所选分支更新到远端最新，但只快进 —— 不产生合并提交、不碰别的分支**。
     *
     * 四种情形都真跑一遍，尤其是①：选中的本地分支不是当前检出分支时，过去这里只 fetch
     * 不更新本地分支，症状就是「提示落后远端 4 个提交，点完 Pull 还是落后 4 个」。
     * 这条断言（本地 develop 必须前进、HEAD 与工作区必须不动）就是钉住那个 bug 的。
     */
    #[test]
    fn 拉取分支_只快进不产生合并提交也不碰别的分支() {
        let base = tmpdir("branch");
        let remote = base.join("remote.git");
        let work = base.join("work");
        std::fs::create_dir_all(&remote).unwrap();
        git(&remote, &["init", "-q", "--bare"]);
        std::fs::create_dir_all(&work).unwrap();
        git(&work, &["init", "-q"]);
        std::fs::write(work.join("f.txt"), "c1\n").unwrap();
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-qm", "c1"]);
        /* 默认分支名随环境不同，统一改名成 main，夹具才与 init.defaultBranch 无关 */
        git(&work, &["branch", "-m", "main"]);
        let url = remote.to_str().unwrap().to_string();
        git(&work, &["remote", "add", "origin", &url]);
        git(&work, &["push", "-q", "-u", "origin", "main"]);
        /* 远端上造一条 develop，本地 develop 也指向它（两边都停在 c1） */
        git(&work, &["push", "-q", "origin", "main:develop"]);
        git(&work, &["fetch", "-q", "origin"]);
        git(&work, &["branch", "-q", "develop", "origin/develop"]);

        /* 借临时分支把两条提交推到远端 develop —— 本地 develop 与 main 都不动 */
        git(&work, &["checkout", "-q", "-b", "tmp"]);
        git(&work, &["commit", "-q", "--allow-empty", "-m", "r1"]);
        git(&work, &["commit", "-q", "--allow-empty", "-m", "r2"]);
        git(&work, &["push", "-q", "origin", "tmp:develop"]);
        git(&work, &["checkout", "-q", "main"]);
        git(&work, &["branch", "-qD", "tmp"]);

        let head0 = rev(&work, "HEAD");
        let tree0 = std::fs::read_to_string(work.join("f.txt")).unwrap();

        /* ① 选中的 develop 不是当前检出分支：本地 develop 快进，HEAD / 工作区不动 */
        let r1 = pull_branch_sync(&work, "origin", "develop", true).expect("不该是基础设施错误");
        assert!(r1.ok, "应成功：{}", r1.message);
        let dev = rev(&work, "develop");
        assert_eq!(
            dev,
            rev(&work, "refs/remotes/origin/develop"),
            "本地 develop 应快进到 origin/develop"
        );
        assert_ne!(dev, head0, "develop 必须真的前进（这就是用户反馈的那个问题）");
        assert_eq!(rev(&work, "HEAD"), head0, "HEAD 不能被动");
        assert_eq!(
            std::fs::read_to_string(work.join("f.txt")).unwrap(),
            tree0,
            "工作区不能被动"
        );

        /* ② 选中的就是当前检出分支：快进并同步工作区，仍不产生合并提交 */
        /* tmp2 必须从 origin/develop 开 —— 从 main 开会得到一笔非快进的推送（远端 develop 已前进） */
        git(&work, &["checkout", "-q", "-b", "tmp2", "origin/develop"]);
        std::fs::write(work.join("g.txt"), "r3\n").unwrap();
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-qm", "r3"]);
        git(&work, &["push", "-q", "origin", "tmp2:develop"]);
        git(&work, &["checkout", "-q", "develop"]);
        git(&work, &["branch", "-qD", "tmp2"]);
        let head1 = rev(&work, "HEAD");
        let r2 = pull_branch_sync(&work, "origin", "develop", true).expect("不该失败");
        assert!(r2.ok, "应成功：{}", r2.message);
        assert_ne!(rev(&work, "HEAD"), head1, "当前分支应快进前进");
        assert_eq!(rev(&work, "HEAD"), rev(&work, "refs/remotes/origin/develop"));
        assert!(work.join("g.txt").exists(), "检出分支被快进时工作区要一起更新");
        /* ⚠️ 用 --count：不带它时「没有合并提交」的输出是**空串**而不是 0，判断会假失败 */
        assert_eq!(
            git(&work, &["rev-list", "--count", "--merges", "HEAD"]).trim(),
            "0",
            "不能产生合并提交"
        );

        /* ③ 已分叉：明确拒绝，且什么都不改 */
        std::fs::write(work.join("mine.txt"), "mine\n").unwrap();
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-qm", "local-work"]);
        /* ⚠️ 必须从 origin/develop 开 tmp3：从本地 develop 开的话，本地提交会被一起推上远端，
           历史反而变成「本地是远端的祖先」，那就不是分叉了 */
        git(&work, &["checkout", "-q", "-b", "tmp3", "origin/develop"]);
        git(&work, &["commit", "-q", "--allow-empty", "-m", "remote-work"]);
        git(&work, &["push", "-q", "origin", "tmp3:develop"]);
        git(&work, &["checkout", "-q", "main"]);
        git(&work, &["branch", "-qD", "tmp3"]);
        let dev3 = rev(&work, "develop");
        let r3 = pull_branch_sync(&work, "origin", "develop", true).expect("不该失败");
        assert!(!r3.ok, "分叉时必须明确失败，而不是静默改写");
        assert!(r3.message.contains("无法快进"), "要讲清为什么：{}", r3.message);
        assert_eq!(rev(&work, "develop"), dev3, "被拒绝时本地分支一个字都不能动");

        /* ④ 只刷远端引用（选中的是远端分支时的路径）：本地分支不动 */
        let dev4 = rev(&work, "develop");
        let r4 = pull_branch_sync(&work, "origin", "develop", false).expect("不该失败");
        assert!(r4.ok, "应成功：{}", r4.message);
        assert_eq!(rev(&work, "develop"), dev4, "只刷远端引用时不许动本地分支");

        let _ = std::fs::remove_dir_all(&base);
    }
}
