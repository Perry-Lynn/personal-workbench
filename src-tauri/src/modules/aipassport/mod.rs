/*
 * AI-Passport 蓝牙模块集合
 * ------------------------------------------------------------------
 * 后端用 btleplug 作为 BLE 中心，连接 AI-Passport 徽章并推送通知。
 *   - ble.rs      核心管理（扫描 / 连接 / 写）
 *   - commands.rs Tauri IPC 命令层
 *   - models.rs   前后端传输结构
 * @Author: fu
 */
pub mod ble;
pub mod commands;
pub mod models;
