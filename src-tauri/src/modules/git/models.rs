/*
 * Git 管理模块 · 数据模型
 * ------------------------------------------------------------------
 * 分工与 Maven 模块同款：Rust 只负责「把 git 跑起来、把原始输出带回来」，
 * porcelain / unified diff / log 格式的解析全部在前端纯函数里做
 * （scripts/logic-test.ts 能直接用真实 git 输出钉住解析边界）。
 * @Author: fu
 */
use serde::{Deserialize, Serialize};

/** git 命令的原始输出：stdout / stderr 分开、带退出码（解析在前端） */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRaw {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
}

/** 仓库打开结果（rev-parse / symbolic-ref 汇总） */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /** 仓库根目录（用户可能选中的是子目录，这里统一收敛到根） */
    pub root: String,
    pub valid: bool,
    /** 当前分支名；detached HEAD 时为 None */
    pub branch: Option<String>,
    pub detached: bool,
    /** 上游分支（origin/main 之类）；没设过为 None */
    pub upstream: Option<String>,
    /** 领先上游的提交数 */
    pub ahead: u32,
    /** 落后上游的提交数 */
    pub behind: u32,
    /** 仓库还没有任何提交（git log 之类会报错，前端要按空态展示） */
    pub empty: bool,
}

/**
 * 写操作的统一结果。
 *
 * 与 ApiResponse 的分工：ApiResponse::err 只表达「基础设施失败」
 * （git 找不到、超时、参数为空）；而「merge 冲突了」「push 被拒」
 * 是**预期内的业务结果**，走 ok + ok:false，前端才能给出
 * 「有冲突，去解决」这类具体提示，而不是一句红色报错。
 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub ok: bool,
    /** 给人看的结果摘要（成功摘要 / 失败首行原因） */
    pub message: String,
    /** 提交/合并产生的 commit hash（仅 commit 成功时有） */
    pub hash: Option<String>,
    /** 合并/拉取冲突时的冲突文件列表（diff --name-only --diff-filter=U） */
    pub conflicts: Vec<String>,
    /** git 的 stderr 原文，冲突提示里可展开查看 */
    pub stderr: String,
}

impl OpResult {
    pub fn ok(message: impl Into<String>) -> Self {
        Self { ok: true, message: message.into(), hash: None, conflicts: Vec::new(), stderr: String::new() }
    }

    pub fn fail(message: impl Into<String>, stderr: String) -> Self {
        Self { ok: false, message: message.into(), hash: None, conflicts: Vec::new(), stderr }
    }
}

/** 与上游的相对位置（rev-list --left-right --count） */
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AheadBehind {
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperationState { pub kind: String, pub conflicts: Vec<String> }
