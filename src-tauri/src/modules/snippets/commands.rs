/*
 * 片段库 · Tauri IPC 命令层
 * ------------------------------------------------------------------
 * 命令前缀 snippets_，返回统一 ApiResponse<T>。
 *
 * 一律 async + spawn_blocking：模块约定，任何可能阻塞的逻辑都不能跑在 UI 线程上。
 * 这里尤其要注意 —— sled 是同步 I/O，而且 StorageService::init 首次调用会建目录、
 * 失败时还带 sleep 重试（最长几百毫秒），放 UI 线程上会直接卡住界面。
 *
 * 命令清单：
 *   snippets_list        列出全部片段（已排序）
 *   snippets_save        新建或更新一条
 *   snippets_delete      删除一条
 *   snippets_toggle_pin  置顶 / 取消置顶
 *   snippets_touch       记一次「被复制使用」
 *
 * 不涉及主密钥：片段是用户自己的代码/命令，不是凭据，明文落 sled 即可
 * （理由见 models.rs 顶部注释）。
 * @Author: fu
 */
use std::path::Path;
use std::sync::Arc;

use tauri::{command, AppHandle};

use crate::core::api::ApiResponse;
use crate::core::storage::{app_data_dir, StorageService};
use crate::core::time::now_ms;
use crate::modules::snippets::models::{build_saved, Snippet};
use crate::modules::snippets::storage;

/* =============================================
   ====== 基础设施 ======
   ============================================= */

/* 打开（或取得）存储服务 */
fn open(dir: &Path) -> Result<Arc<StorageService>, String> {
    StorageService::init(dir.to_path_buf()).map_err(|e| format!("打开本地存储失败：{e}"))
}

/*
 * 把「打开存储 → 做事 → 返回」整段丢进阻塞线程池。
 *
 * 五个命令的骨架完全一样，抽出来只为让每个命令只剩它自己那段业务逻辑；
 * 结果处理仍保持 Ok/Err 两支的显式写法（与 jvm / maven 的 commands.rs 一致）。
 */
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

/*
 * 取一条片段，取不到就给出可读的错误。
 * 「不存在」和「读失败」必须分开报 —— 前者是前端拿错了 id，后者是磁盘问题，
 * 混成一句话会让人排查错方向。
 */
fn must_get(svc: &StorageService, id: &str) -> Result<Snippet, String> {
    match storage::get(svc, id) {
        Ok(Some(s)) => Ok(s),
        Ok(None) => Err(format!("片段不存在：{id}")),
        Err(e) => Err(format!("读取片段失败：{e}")),
    }
}

/* =============================================
   ====== 命令 ======
   ============================================= */

/** 列出全部片段（置顶优先 → 最近更新在前） */
#[command]
pub async fn snippets_list(app: AppHandle) -> ApiResponse<Vec<Snippet>> {
    let dir = app_data_dir(&app);
    match blocking("读取片段", move || {
        let svc = open(&dir)?;
        storage::list(&svc).map_err(|e| format!("读取片段失败：{e}"))
    })
    .await
    {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(e),
    }
}

/**
 * 新建或更新一条片段。
 *
 * `id` 为空 / None = 新建（id 由后端生成）；给了 id = 改那条已有的。
 */
#[command]
pub async fn snippets_save(
    app: AppHandle,
    id: Option<String>,
    title: String,
    body: String,
    lang: Option<String>,
    tags: Vec<String>,
) -> ApiResponse<Snippet> {
    let dir = app_data_dir(&app);
    match blocking("保存片段", move || {
        let svc = open(&dir)?;

        /*
         * 带了 id 却查不到 → 直接报错，**不要**悄悄新建一条。
         * 前端要是拿错了 id（比如列表被刷新过），静默新建会让用户以为「改好了」，
         * 实际改动落到了一条凭空多出来的片段上，原来那条纹丝不动 —— 这种问题极难自查。
         */
        let existing = match id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(rid) => Some(must_get(&svc, rid)?),
            None => None,
        };

        /* 归一化、校验、时间戳都在这个纯函数里，见 models.rs::build_saved */
        let snippet = build_saved(existing, &title, &body, lang.as_deref(), &tags, now_ms())?;
        storage::put(&svc, &snippet).map_err(|e| format!("保存片段失败：{e}"))?;
        Ok(snippet)
    })
    .await
    {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(e),
    }
}

/** 删除一条片段，返回它是否原本存在 */
#[command]
pub async fn snippets_delete(app: AppHandle, id: String) -> ApiResponse<bool> {
    let dir = app_data_dir(&app);
    match blocking("删除片段", move || {
        let svc = open(&dir)?;
        storage::delete(&svc, id.trim()).map_err(|e| format!("删除片段失败：{e}"))
    })
    .await
    {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(e),
    }
}

/** 置顶 / 取消置顶 */
#[command]
pub async fn snippets_toggle_pin(app: AppHandle, id: String) -> ApiResponse<Snippet> {
    let dir = app_data_dir(&app);
    match blocking("置顶片段", move || {
        let svc = open(&dir)?;
        let mut snippet = must_get(&svc, id.trim())?;
        snippet.pinned = !snippet.pinned;

        /*
         * 刻意**不动** updated_at。
         * 置顶改的是「摆在哪」，不是「内容变了」；动了它，一次置顶就会把
         * 「最近更新」的排序整个打乱，用户会以为别的片段被改过。
         */
        storage::put(&svc, &snippet).map_err(|e| format!("置顶片段失败：{e}"))?;
        Ok(snippet)
    })
    .await
    {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(e),
    }
}

/** 记一次使用（前端在「复制」成功后调用） */
#[command]
pub async fn snippets_touch(app: AppHandle, id: String) -> ApiResponse<Snippet> {
    let dir = app_data_dir(&app);
    match blocking("记录使用", move || {
        let svc = open(&dir)?;
        let mut snippet = must_get(&svc, id.trim())?;
        snippet.use_count = snippet.use_count.saturating_add(1);
        snippet.used_at = Some(now_ms());

        /* 同 toggle_pin：复制不算编辑，不动 updated_at */
        storage::put(&svc, &snippet).map_err(|e| format!("记录使用失败：{e}"))?;
        Ok(snippet)
    })
    .await
    {
        Ok(v) => ApiResponse::ok(v),
        Err(e) => ApiResponse::err(e),
    }
}
