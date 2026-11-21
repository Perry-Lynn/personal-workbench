/*
 * 工作台核心层 · 导出文本文件
 * ------------------------------------------------------------------
 * 为什么需要这一层：**WebView 的下载通道在这套壳里是关着的**。
 *
 * 前端「导出」的常规写法是 `new Blob()` + `a[download]` + `click()`。
 * 在浏览器里它一定落盘，但在本应用的 WKWebView 里**什么都不会发生** ——
 * 而且不报任何错。原因在 wry 的导航代理（wry 0.55.1 的
 * `wkwebview/navigation.rs`，导航策略那一段）：
 *
 *     if should_download {
 *         if has_download_handler { Download } else { Cancel }
 *     }
 *
 * `has_download_handler` 只在应用注册了 `on_download` 时才为真，而它又只能挂在
 * `WebviewWindowBuilder::on_download` 上；本应用的主窗口是 tauri.conf.json 里
 * 声明的（`app.get_webview_window("main")` 拿到的现成窗口），挂不上。
 * 于是下载请求被**静默 Cancel**：用户点「导出」，屏幕上什么都不发生。
 *
 * 所以导出一律走「系统保存对话框 + Rust 写盘」这条路：
 *   1. 前端 `@tauri-apps/plugin-dialog` 的 `save()` 让用户选路径（能改名字与位置）；
 *   2. 前端把路径与正文交给本模块的 `workbench_write_text_file` 落盘。
 * 两步合起来是 `src/core/export.ts::exportTextFile()` ——
 * **前端不要再自己拼 Blob + a[download]，那是死路**（三个模块都踩过）。
 * @Author: fu
 */
use crate::core::api::ApiResponse;

/*
 * 把一段文本写到指定路径（导出用）。
 *
 * 路径来自系统保存对话框，所以这里**不做「允许写哪些目录」的判断** ——
 * 用户自己选的位置就是要写的位置。
 *
 * 父目录不存在时直接报错，不 create_dir_all：保存对话框给出的路径父目录一定存在，
 * 不存在说明调用方把路径拼错了，这时悄悄建目录只会把真正的 bug 藏起来
 * （下次可能建出一个谁都找不到的目录树）。
 */
#[tauri::command]
pub fn workbench_write_text_file(path: String, content: String) -> ApiResponse<()> {
    if path.trim().is_empty() {
        return ApiResponse::err("保存路径为空");
    }
    match std::fs::write(&path, content.as_bytes()) {
        Ok(()) => ApiResponse::ok(()),
        Err(e) => ApiResponse::err(format!("写入失败：{e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* 每个测试用不同的文件名，避免并行跑时互相覆盖 */
    fn tmp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("wb-export-{}-{}.log", std::process::id(), name))
    }

    #[test]
    fn 写盘成功并返回_success() {
        let p = tmp("ok");
        let r = workbench_write_text_file(p.display().to_string(), "第一行\n第二行\n".into());
        assert!(r.success, "应成功：{:?}", r.error);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "第一行\n第二行\n");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn 空内容也照写_不报错() {
        /* 内容为空是调用方的事，这一层不替它判断；但也不能因为空就 panic */
        let p = tmp("empty");
        let r = workbench_write_text_file(p.display().to_string(), String::new());
        assert!(r.success);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn 父目录不存在时报错而不是建目录() {
        let dir = std::env::temp_dir().join(format!("wb-export-{}-missing", std::process::id()));
        let r = workbench_write_text_file(
            dir.join("x.log").display().to_string(),
            "x".into(),
        );
        assert!(!r.success, "父目录不存在应当失败");
        assert!(r.error.unwrap().contains("写入失败"));
        /* 关键：不能顺手把目录建出来 —— 那会把「调用方拼错路径」变成静默成功 */
        assert!(!dir.exists(), "不应自动创建父目录");
    }

    #[test]
    fn 空路径直接拒绝() {
        let r = workbench_write_text_file("   ".into(), "x".into());
        assert!(!r.success);
        assert_eq!(r.error.unwrap(), "保存路径为空");
    }
}
