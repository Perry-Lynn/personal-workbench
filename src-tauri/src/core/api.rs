/*
 * 工作台统一 IPC 响应包
 * ------------------------------------------------------------------
 * 所有 Tauri 命令统一返回 ApiResponse<T>，前端 services 层只需判断 success。
 * 前端对应实现：src/features/<模块>/services/tauriApi.ts
 * @Author: fu
 */
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl<T> ApiResponse<T> {
    /* 成功响应 */
    pub fn ok(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    /* 失败响应 */
    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(msg.into()),
        }
    }
}
