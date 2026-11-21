/*
 * AI-Passport 蓝牙模块 · 数据模型
 * ------------------------------------------------------------------
 * 仅描述「前后端传输的结构」，不含逻辑。
 * 对应固件（ai-passport/main/notif_ble.c）暴露的 GATT 外设：
 *   - 服务 UUID   6e400020-b5a3-f393-e0a9-e50e24dcca9e
 *   - RX 写特征   6e400021-b5a3-f393-e0a9-e50e24dcca9e（WRITE / WRITE_NO_RSP）
 * 设备只接收、不下发，所以这里只有「设备列表 / 连接状态 / 推送结果」。
 */
use serde::{Deserialize, Serialize};

/* 扫描到的设备 */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredDevice {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rssi: Option<i16>,
}

/* 一次推送 / 清空的结果 */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushResult {
    pub bytes: usize,
    pub text: String,
}

/* 连接状态。state 取值：
 *   idle / scanning / connecting / connected / error */
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConnectionState {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
