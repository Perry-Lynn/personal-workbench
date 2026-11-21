/*
 * Trae 社区模块（community）
 * ------------------------------------------------------------------
 * 接入 forum.trae.cn：列表 / 分类 / 主题 / 用户资料匿名可读；
 * 登录走内嵌 WebviewWindow + SSO cookie 复用（session.rs 存凭证），
 * 之后通知与私信由 authed client 取真实数据。
 * 数据全部经 Tauri 命令取回后由前端自绘，不把论坛网页塞进主界面。
 * @Author: fu
 */
pub mod client;
pub mod commands;
pub mod models;
pub mod session;
