//! 独立探针：在真机上验证 btleplug / CoreBluetooth 链路是否可用。
//! 不依赖物理 AI-Passport 设备即可证明：适配器存在、扫描能跑、事件流工作。
//! 运行：cargo run --example ble_probe
use btleplug::api::{Central, CentralEvent, Manager as ManagerTrait, Peripheral as PeripheralTrait, ScanFilter};
use btleplug::platform::Manager;
use futures_util::StreamExt;
use std::time::{Duration, Instant};

const AI_PASSPORT_SVC: &str = "6e400020-b5a3-f393-e0a9-e50e24dcca9e";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    print!("[probe] 创建 BLE Manager（最多等 10s，超时说明此二进制未获蓝牙授权）...");
    let manager = match tokio::time::timeout(Duration::from_secs(10), Manager::new()).await {
        Ok(Ok(m)) => m,
        Ok(Err(e)) => {
            println!("[probe] Manager::new 失败: {e}");
            return Ok(());
        }
        Err(_) => {
            println!("[probe] Manager::new 超时：本 Mac 未向该裸二进制授予 CoreBluetooth 权限（TCC 限制）。");
            println!("[probe] 这是预期行为——蓝牙客户端必须运行在带 bundle id 的原生 .app 内（即 Tauri 应用）。");
            println!("[probe] 请在 Tauri 应用窗口内（设置→AI-Passport→扫描）实测，那里会弹系统蓝牙授权框。");
            return Ok(());
        }
    };
    let adapters = manager.adapters().await?;
    println!("[probe] 发现 {} 个蓝牙适配器", adapters.len());
    let adapter = match adapters.into_iter().next() {
        Some(a) => a,
        None => {
            println!("[probe] 无可用蓝牙适配器（此 Mac 可能无蓝牙，或 CoreBluetooth 权限被拒）");
            return Ok(());
        }
    };

    println!("[probe] 开始扫描 6 秒（不限服务，列出附近所有 BLE 设备）...");
    adapter.start_scan(ScanFilter::default()).await?;
    let mut events = adapter.events().await?;
    let deadline = Instant::now() + Duration::from_secs(6);
    let mut count = 0usize;
    while Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(600), events.next()).await {
            Ok(Some(CentralEvent::DeviceDiscovered(id))) => {
                if let Ok(p) = adapter.peripheral(&id).await {
                    if let Ok(Some(props)) = p.properties().await {
                        count += 1;
                        let name = props.local_name.clone().unwrap_or_else(|| "<未知>".into());
                        let rssi = props.rssi.map(|r| r as i32).unwrap_or(0);
                        let is_badge = props
                            .services
                            .iter()
                            .any(|u| u.to_string().eq_ignore_ascii_case(AI_PASSPORT_SVC));
                        let tag = if is_badge { "  <== AI-Passport 服务匹配!" } else { "" };
                        println!(
                            "[probe] + #{:<2} name={:?} addr={} rssi={}{}",
                            count, name, props.address, rssi, tag
                        );
                    }
                }
            }
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => continue,
        }
    }
    let _ = adapter.stop_scan().await;
    println!("[probe] 扫描结束，共发现 {} 个设备", count);
    if count == 0 {
        println!("[probe] 未发现任何设备：附近可能无 BLE 外设，或本 Mac 尚未授予蓝牙权限（系统弹框后允许再跑）");
    } else {
        println!("[probe] BLE 链路正常：适配器可用、扫描与事件流工作，AI-Passport 模块已具备连接基础");
    }
    Ok(())
}
