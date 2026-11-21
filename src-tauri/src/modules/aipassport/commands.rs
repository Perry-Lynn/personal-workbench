/*
 * AI-Passport 蓝牙模块 · Tauri IPC 命令层
 * ------------------------------------------------------------------
 * 命令名统一加 aipassport_ 前缀，与工作台级命令（workbench_*）和 LogSight 隔离。
 * 所有命令返回 ApiResponse<T>，事件通过 aipassport:devices / aipassport:state 推送。
 * 蓝牙状态来自全局 BLE_MANAGER（见 ble.rs），命令不接收 Tauri State 引用，
 * 因此返回类型与 LogSight 一致地用 ApiResponse<T>。
 * @Author: fu
 */
use tauri::{command, AppHandle, Emitter};

use crate::core::api::ApiResponse;
use crate::modules::aipassport::ble;
use crate::modules::aipassport::models::{ConnectionState, DiscoveredDevice, PushResult};

/*
 * 扫描周围 AI-Passport 设备。默认扫 8 秒，结果同时经 aipassport:devices 事件推送。
 */
#[command]
pub async fn aipassport_scan(
    app: AppHandle,
    timeout_ms: Option<u64>,
) -> ApiResponse<Vec<DiscoveredDevice>> {
    match ble::scan(ble::BLE_MANAGER.clone(), timeout_ms.unwrap_or(8000)).await {
        Ok(devices) => {
            let _ = app.emit("aipassport:devices", &devices);
            ApiResponse::ok(devices)
        }
        Err(e) => ApiResponse::err(e),
    }
}

/*
 * 连接指定设备（device_id 来自扫描结果）。
 */
#[command]
pub async fn aipassport_connect(
    app: AppHandle,
    device_id: String,
) -> ApiResponse<DiscoveredDevice> {
    match ble::connect(app, ble::BLE_MANAGER.clone(), device_id).await {
        Ok(dev) => ApiResponse::ok(dev),
        Err(e) => ApiResponse::err(e),
    }
}

/*
 * 断开当前连接。
 */
#[command]
pub async fn aipassport_disconnect(app: AppHandle) -> ApiResponse<()> {
    match ble::disconnect(app, ble::BLE_MANAGER.clone()).await {
        Ok(_) => ApiResponse::ok(()),
        Err(e) => ApiResponse::err(e),
    }
}

/*
 * 推送一条通知 / 提醒 / 日程到设备。
 * category 取值：SCHED（日程）/ REMIND（提醒）/ MSG（消息）。
 */
#[command]
pub async fn aipassport_push(
    app: AppHandle,
    category: String,
    source: String,
    body: String,
) -> ApiResponse<PushResult> {
    match ble::push(ble::BLE_MANAGER.clone(), category, source, body).await {
        Ok(r) => {
            let _ = app.emit("aipassport:state", &ble::get_state(&ble::BLE_MANAGER));
            ApiResponse::ok(r)
        }
        Err(e) => ApiResponse::err(e),
    }
}

/*
 * 推送若干条**原始行**到设备，由固件按行首标签自行分流
 * （BAL / BALT 进余额图表页，SCHED / REMIND / MSG 进通知列表）。
 *
 * 为什么单独开一个命令而不复用 aipassport_push：
 *   aipassport_push 按固件**通知存储**的上限校验正文（96 字节），而余额图表行
 *   天生比它长（平台名 + 主指标 + 两个环形指标，中文一个字 3 字节）。
 *   行的语义由调用方负责（见 src/features/balances/device.ts），本命令只管传输。
 */
#[command]
pub async fn aipassport_push_lines(lines: Vec<String>) -> ApiResponse<PushResult> {
    match ble::push_lines(ble::BLE_MANAGER.clone(), lines).await {
        Ok(r) => ApiResponse::ok(r),
        Err(e) => ApiResponse::err(e),
    }
}

/*
 * 清空设备上的通知列表。
 */
#[command]
pub async fn aipassport_clear(app: AppHandle) -> ApiResponse<PushResult> {
    match ble::clear(ble::BLE_MANAGER.clone()).await {
        Ok(r) => {
            let _ = app.emit("aipassport:state", &ble::get_state(&ble::BLE_MANAGER));
            ApiResponse::ok(r)
        }
        Err(e) => ApiResponse::err(e),
    }
}

/*
 * 读取当前连接状态（前端进入模块时拉取一次）。
 */
#[command]
pub fn aipassport_state() -> ApiResponse<ConnectionState> {
    ApiResponse::ok(ble::get_state(&ble::BLE_MANAGER))
}
