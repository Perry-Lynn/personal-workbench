/*
 * 智能体余额模块
 * ------------------------------------------------------------------
 * 读取各 AI 平台（ChatGPT / OpenAI / Claude / Gemini / Trae / WorkBuddy / Qoder CN）的
 * 余额或用量，归一化后在面板展示，并可于蓝牙连接时推送到 AI-Passport。
 *
 * 子模块：
 *   models    归一化数据结构
 *   chatgpt   调用 ChatGPT 网页端内部接口拉用量（已验证可用）
 *   qoder     调用 Qoder CN 客户端内部接口拉用量（路由已验证，鉴权待真机确认）
 *   qoder_cli 调本机 qoderclicn CLI 读 Qoder CN 用量（**已实测跑通，免凭证**）
 *   trae      调 Trae 网页控制台内部接口读订阅额度（需网页登录态两段凭证）
 *   grab      通用「网页登录态一键抓取」引擎（借本机 Chrome 的登录态，CDP 截请求头）
 *   storage   凭证加密存储（复用 core::crypto + core::storage）
 *   commands  Tauri IPC 命令层
 * @Author: fu
 */
pub mod chatgpt;
pub mod commands;
pub mod grab;
pub mod models;
pub mod qoder;
pub mod qoder_cli;
pub mod storage;
pub mod trae;
