/*
 * AI-Passport 蓝牙模块 · 核心管理（btleplug 中心 / 客户端）
 * ------------------------------------------------------------------
 * 工作台的定位是 BLE 中心（Central）：去连 AI-Passport（BLE 外设 / GATT Server），
 * 向它的 RX 写特征推送文本。设备只接收、不下发，因此这里只有「扫描 / 连接 / 写」。
 *
 * 与固件约定的协议（见 ai-passport/main/notif_ble.c）：
 *   - 向 RX 写 "<类别>|<来源>|<正文>"，类别 SCHED / REMIND / MSG（或 日程/提醒/消息）
 *   - 整行 CLEAR / CLEARALL / 清空 清空设备通知列表
 *   - 写特征不要求加密，可完全不配对直接写
 *
 * 状态用进程内全局 BLE_MANAGER（Arc<Mutex>），命令不接收 Tauri State 引用，
 * 从而返回类型可与其它模块一致地用 ApiResponse<T>。
 *
 * 线程：btleplug 对象 Clone 即 Arc，统一收进 Arc<Mutex<BleState>>。
 * 命令都是 async，跑在 Tauri 的 tokio 运行时上（btleplug 需要 tokio）。
 */
use std::ops::Deref;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use btleplug::api::{
    Central, CentralEvent, Manager as ManagerTrait, Peripheral as PeripheralApi, ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};

use crate::modules::aipassport::models::{ConnectionState, DiscoveredDevice, PushResult};

/* AI-Passport 的 GATT 标识（字符串形式；NimBLE 端以 128 位小端字节存储） */
const SVC_UUID_STR: &str = "6e400020-b5a3-f393-e0a9-e50e24dcca9e";
const RX_UUID_STR: &str = "6e400021-b5a3-f393-e0a9-e50e24dcca9e";
const DEVICE_NAME: &str = "AI-Passport";

fn svc_uuid() -> Uuid {
    Uuid::parse_str(SVC_UUID_STR).expect("SVC_UUID 常量非法")
}
fn rx_uuid() -> Uuid {
    Uuid::parse_str(RX_UUID_STR).expect("RX_UUID 常量非法")
}

/*
 * macOS 前提：CoreBluetooth 必须在「带 bundle 的 .app」内运行。
 * `tauri dev` 直接跑裸二进制 target/debug/workbench（无 .app / 无 Info.plist），
 * 一旦触碰蓝牙，系统 TCC 因找不到 NSBluetoothAlwaysUsageDescription 会直接
 * __TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION__ 把整个进程 abort（Rust 抓不到）。
 * 故在扫描/连接前先判断是否在 .app 内运行，否则给出明确引导而非崩溃。
 */
#[cfg(target_os = "macos")]
fn running_in_app_bundle() -> bool {
    if let Ok(exe) = std::env::current_exe() {
        return exe.to_string_lossy().contains(".app/Contents/MacOS");
    }
    false
}
#[cfg(not(target_os = "macos"))]
fn running_in_app_bundle() -> bool {
    true
}
fn ensure_bundled_for_ble() -> Result<(), String> {
    if running_in_app_bundle() {
        return Ok(());
    }
    Err(
        "蓝牙功能需要在打包后的 .app 中运行。tauri dev 启动的是裸二进制，系统无法为其申请蓝牙权限（会直接崩溃）。\n\
         请改用打包应用测试：先执行 `npm run tauri:ble`（build 出 .app 并打开），再在弹出的应用中点「扫描设备」。"
            .into(),
    )
}

/* 进程内共享状态 */
pub struct BleState {
    manager: Option<Manager>,
    adapter: Option<Adapter>,
    peripheral: Option<Peripheral>,
    connection: ConnectionState,
}

impl Default for BleState {
    fn default() -> Self {
        Self {
            manager: None,
            adapter: None,
            peripheral: None,
            connection: ConnectionState::default(),
        }
    }
}

/*
 * 用 newtype 包裹 Arc<Mutex>，既能在本地 impl Default（避免孤儿规则），
 * 又能通过 Deref 直接调用 Mutex 的方法。
 */
#[derive(Clone)]
pub struct BleManager(pub Arc<Mutex<BleState>>);

impl Default for BleManager {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(BleState::default())))
    }
}

impl Deref for BleManager {
    type Target = Mutex<BleState>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

/* 全局单例：命令直接克隆 Arc 使用 */
pub static BLE_MANAGER: Lazy<BleManager> = Lazy::new(BleManager::default);

/*
 * 写入串行化锁。
 *
 * 一次推送在特征层是「若干段 20 字节 + 段间 20ms」的序列，而固件按 '\n' 切行。
 * 如果两次推送并发（例如同一次余额变化同时触发了「摘要推送」和「额度提醒」），
 * 两串分片会交错写进同一个特征，固件就会收到拼接错乱的「行」。
 * 所以在真正开始写之前先拿这把锁，把写入排成队列。
 *
 * 用 tokio 的异步锁而不是已有的 parking_lot 锁：后者是同步锁，
 * 其 guard 不能跨 .await 持有（会让命令的 future 失去 Send）。
 */
static WRITE_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

/* 初始化并缓存 Manager（CoreBluetooth 只需建一次） */
async fn ensure_manager(state: &BleManager) -> Result<Manager, String> {
    if let Some(m) = state.lock().manager.clone() {
        return Ok(m);
    }
    let m = Manager::new()
        .await
        .map_err(|e| format!("初始化蓝牙管理器失败（系统蓝牙可能未授权）: {e}"))?;
    state.lock().manager = Some(m.clone());
    Ok(m)
}

/* 取第一个蓝牙适配器（macOS 通常只有一个） */
async fn ensure_adapter(state: &BleManager) -> Result<Adapter, String> {
    if let Some(a) = state.lock().adapter.clone() {
        return Ok(a);
    }
    let m = ensure_manager(state).await?;
    let mut adapters = m
        .adapters()
        .await
        .map_err(|e| format!("获取蓝牙适配器失败: {e}"))?;
    let a = adapters
        .pop()
        .ok_or_else(|| "未找到蓝牙适配器，请确认系统蓝牙已开启".to_string())?;
    state.lock().adapter = Some(a.clone());
    Ok(a)
}

fn set_connection(state: &BleManager, conn: ConnectionState) {
    state.lock().connection = conn;
}

fn emit_state(app: &AppHandle, state: &BleManager) {
    let conn = state.lock().connection.clone();
    let _ = app.emit("aipassport:state", &conn);
}

/*
 * 扫描：按服务 UUID 过滤，收集符合条件的设备。
 * 扫描期间不改变连接状态（即使已连着也不影响），前端自己显示 scanning 指示。
 */
pub async fn scan(state: BleManager, timeout_ms: u64) -> Result<Vec<DiscoveredDevice>, String> {
    ensure_bundled_for_ble()?;
    let adapter = ensure_adapter(&state).await?;
    // macOS 上 CoreBluetooth 对「自定义 128 位服务 UUID」做扫描预过滤经常返回空，
    // 故这里扫全部设备，再在结果里按名称/服务过滤（见下方 is_target）。
    let filter = ScanFilter::default();
    adapter
        .start_scan(filter)
        .await
        .map_err(|e| format!("开始扫描失败: {e}"))?;
    tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
    adapter
        .stop_scan()
        .await
        .map_err(|e| format!("停止扫描失败: {e}"))?;

    let peripherals = adapter
        .peripherals()
        .await
        .map_err(|e| format!("枚举设备失败: {e}"))?;

    let mut out: Vec<DiscoveredDevice> = Vec::new();
    let svc = svc_uuid();
    for p in peripherals {
        let props = match p.properties().await {
            Ok(Some(props)) => props,
            _ => continue,
        };
        let is_target = props
            .local_name
            .as_deref()
            .map(|n| n == DEVICE_NAME)
            .unwrap_or(false)
            || props.services.iter().any(|s| *s == svc);
        if is_target {
            out.push(DiscoveredDevice {
                id: p.id().to_string(),
                name: props
                    .local_name
                    .clone()
                    .unwrap_or_else(|| DEVICE_NAME.to_string()),
                rssi: props.rssi,
            });
        }
    }
    Ok(out)
}

/*
 * 连接指定设备，发现服务，并启动断开监听。
 * 连接成功后把 peripheral 存入状态，后续推送复用。
 */
pub async fn connect(
    app: AppHandle,
    state: BleManager,
    device_id: String,
) -> Result<DiscoveredDevice, String> {
    set_connection(
        &state,
        ConnectionState {
            state: "connecting".into(),
            device_id: Some(device_id.clone()),
            device_name: None,
            error: None,
        },
    );
    emit_state(&app, &state);

    ensure_bundled_for_ble()?;
    let adapter = ensure_adapter(&state).await?;
    let peripherals = adapter
        .peripherals()
        .await
        .map_err(|e| format!("枚举设备失败: {e}"))?;
    let p = peripherals
        .into_iter()
        .find(|p| p.id().to_string() == device_id)
        .ok_or_else(|| "设备已离开范围或已断电，请重新扫描".to_string())?;

    p.connect()
        .await
        .map_err(|e| format!("连接失败: {e}"))?;
    p.discover_services()
        .await
        .map_err(|e| format!("发现服务失败: {e}"))?;

    let name = p
        .properties()
        .await
        .ok()
        .flatten()
        .and_then(|pr| pr.local_name);

    {
        let mut g = state.lock();
        g.peripheral = Some(p.clone());
        g.connection = ConnectionState {
            state: "connected".into(),
            device_id: Some(device_id.clone()),
            device_name: name.clone(),
            error: None,
        };
    }
    emit_state(&app, &state);

    // 后台监听断开事件，自动把状态切回 idle
    spawn_disconnect_monitor(app, state, adapter.clone());

    Ok(DiscoveredDevice {
        id: device_id,
        name: name.unwrap_or_else(|| DEVICE_NAME.to_string()),
        rssi: None,
    })
}

/*
 * 断开当前连接，清空 peripheral 与连接状态。
 */
pub async fn disconnect(app: AppHandle, state: BleManager) -> Result<(), String> {
    // 取出 peripheral 并立即把状态切回 idle（不等底层断开完成）
    let p = state.lock().peripheral.clone();
    {
        let mut g = state.lock();
        g.peripheral = None;
        g.connection = ConnectionState::default();
    }
    emit_state(&app, &state);
    // macOS 下 btleplug 的 disconnect future 非 Send，不能进 tokio 任务，
    // 故在独立线程用 current-thread runtime block_on 真正释放链路。
    if let Some(p) = p {
        std::thread::spawn(move || {
            if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                let _ = rt.block_on(async move { let _ = p.disconnect().await; });
            }
        });
    }
    Ok(())
}

/*
 * 向 RX 特征写一行文本（核心推送）。
 * 固件 notif_ble.h 的整行上限 NOTIF_BLE_LINE_MAX=160（含结尾 '\0'），超长整行会被设备静默丢弃；
 * 另 notif_store.h 的存储上限更紧：正文 96、来源 24（均含 '\0'），超限会被按 UTF-8 截断并追加 ".."。
 * 两处都提前拦截，返回明确错误而不是让推送「看起来成功、设备却没反应/被截断」。
 */
const NOTIF_BLE_LINE_MAX: usize = 160; // ai-passport/main/notif_ble.h（整行上限）
const NOTIF_TEXT_MAX: usize = 96; // ai-passport/main/notif_store.h（正文缓冲，含 '\0'）
const NOTIF_SOURCE_MAX: usize = 24; // ai-passport/main/notif_store.h（来源缓冲，含 '\0'）
async fn write_raw(state: &BleManager, text: &str) -> Result<PushResult, String> {
    let byte_len = text.as_bytes().len();
    if byte_len > NOTIF_BLE_LINE_MAX - 1 {
        return Err(format!(
            "推送内容过长（{} 字节，固件整行上限 {} 字节）：设备会整行丢弃超长内容且无任何报错。请缩短后重试。",
            byte_len,
            NOTIF_BLE_LINE_MAX - 1
        ));
    }

    /* 拿到这把锁才开始写：并发的两次推送必须排成队列，不能交错（见 WRITE_LOCK 注释） */
    let _write_guard = WRITE_LOCK.lock().await;

    let p = state
        .lock()
        .peripheral
        .clone()
        .ok_or_else(|| "尚未连接设备，请先连接 AI-Passport".to_string())?;

    // 确保特征已发现（重连后可能需再发现一次）
    let _ = p.discover_services().await;
    let rx = rx_uuid();
    let chars = p.characteristics();
    let chr = chars
        .iter()
        .find(|c| c.uuid == rx)
        .ok_or_else(|| "未找到 RX 写特征（设备固件可能未包含通知服务）".to_string())?;

    // 关键：每条推送都以 '\n' 结尾。
    // 固件 line_feed 收到 '\n'/'\\r' 会立即 line_flush()（把已收内容当一整条推出），
    // 因此每条推送自定界——既不依赖 150ms 空闲定时器收尾，也不会把两次紧挨着的推送拼成一行。
    // 固件注释也明确：补换行的客户端最稳；不补换行就只能靠空闲定时器，且快速连续的两次推送会被并成一行。
    // 另外 CoreBluetooth 的 WithoutResponse 写不会自动分包——超 MTU 会被静默截断，
    // 故按固定 20 字节(最小 MTU 23 - 3)手动分包；段间留 20ms 间隔，对任意协商 MTU 都安全
    // (btleplug 0.11 不暴露 mtu())。换行符本身计入最后一小段即可。
    let wire = format!("{text}\n");
    const CHUNK: usize = 20;
    let data = wire.as_bytes();
    let chunks: Vec<&[u8]> = data.chunks(CHUNK).collect();
    for (i, c) in chunks.iter().enumerate() {
        p.write(chr, c, WriteType::WithoutResponse)
            .await
            .map_err(|e| format!("写入失败(第 {}/{} 段): {e}", i + 1, chunks.len()))?;
        if i + 1 < chunks.len() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    // 上报字节数按「用户内容」（不含结尾换行），与前端的字节计数口径一致
    Ok(PushResult {
        bytes: text.len(),
        text: text.to_string(),
    })
}

/*
 * 推送一条通知 / 提醒 / 日程。
 * 组装格式：<类别>|<来源>|<正文>（类别 SCHED / REMIND / MSG）。
 */
pub async fn push(
    state: BleManager,
    category: String,
    source: String,
    body: String,
) -> Result<PushResult, String> {
    // 固件存储上限（含 '\0'）：正文 96、来源 24。
    //
    // ⚠️ 超长不是「显示不全」，而是**整条推送被拒绝** —— 所以这里提前拦，
    //    不能指望设备端截断。措辞要说准：说「会被静默截断」会让用户以为
    //    「推出去了一半」，实际是一条都没推出去（2026-10-22 修正）。
    if body.as_bytes().len() > NOTIF_TEXT_MAX - 1 {
        return Err(format!(
            "正文过长（{} 字节，徽章最多 {} 字节）：本次推送已被拒绝，内容没有送出。\
             请减少推送的内容（比如在「智能体余额 → 偏好设置 → 推送」里少勾几个平台）。",
            body.as_bytes().len(),
            NOTIF_TEXT_MAX - 1
        ));
    }
    if source.as_bytes().len() > NOTIF_SOURCE_MAX - 1 {
        return Err(format!(
            "来源过长（{} 字节，徽章最多 {} 字节）：本次推送已被拒绝，内容没有送出。请缩短来源。",
            source.as_bytes().len(),
            NOTIF_SOURCE_MAX - 1
        ));
    }
    let payload = if source.is_empty() {
        format!("{category}|{body}")
    } else {
        format!("{category}|{source}|{body}")
    };
    write_raw(&state, &payload).await
}

/*
 * 推送若干条**原始行**，由固件按行首标签自行分流（如 BAL / BALT 进余额页，
 * SCHED / REMIND / MSG 进通知列表）。行的语义由调用方负责，本函数只管传输。
 *
 * 为什么不复用 push()：push() 会按固件**通知存储**的上限拦截正文（96 字节），
 * 而余额图表行天生比它长 —— 一条 BAL 行含平台名 + 主指标 + 两个环形指标，
 * 中文一个字 3 字节，轻松超过 96。用 push() 会被这里直接拒掉。
 *
 * 这里唯一必须挡住的是**固件整行缓冲**的上限（159 字节）：超长时固件整行丢弃
 * 且没有任何报错，用户只会看到「设备上什么都没变」。
 *
 * 逐行顺序写入，每条各自以 '\n' 结尾（见 write_raw），因此不会互相粘连。
 */
pub async fn push_lines(state: BleManager, lines: Vec<String>) -> Result<PushResult, String> {
    if lines.is_empty() {
        return Err("没有可推送的内容".to_string());
    }

    let mut total = 0usize;
    for (i, line) in lines.iter().enumerate() {
        /* 行内换行会把一条拆成两条 —— 固件按 '\n' 切行，这是行边界 */
        if line.contains('\n') || line.contains('\r') {
            return Err(format!("第 {} 行含换行符，会被设备拆成两条", i + 1));
        }
        if line.as_bytes().len() > NOTIF_BLE_LINE_MAX - 1 {
            return Err(format!(
                "第 {} 行过长（{} 字节，固件整行上限 {} 字节）：设备会整行丢弃且无任何报错。",
                i + 1,
                line.as_bytes().len(),
                NOTIF_BLE_LINE_MAX - 1
            ));
        }
        write_raw(&state, line).await?;
        total += line.as_bytes().len();
    }

    Ok(PushResult {
        bytes: total,
        text: lines.join("\n"),
    })
}

/*
 * 清空设备上的通知列表（写整行 CLEAR）。
 */
pub async fn clear(state: BleManager) -> Result<PushResult, String> {
    write_raw(&state, "CLEAR").await
}

/*
 * 读取当前连接状态（前端首次进入时拉取）。
 */
pub fn get_state(state: &BleManager) -> ConnectionState {
    state.lock().connection.clone()
}

/*
 * 断开监听：连接成功后启动，设备掉线时把状态切回 idle 并广播。
 */
fn spawn_disconnect_monitor(app: AppHandle, state: BleManager, adapter: Adapter) {
    tauri::async_runtime::spawn(async move {
        let events = match adapter.events().await {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(target: "aipassport", "监听设备事件失败: {e}");
                return;
            }
        };
        let mut events = events;
        while let Some(ev) = events.next().await {
            if let CentralEvent::DeviceDisconnected(id) = ev {
                let mut g = state.lock();
                let same = g
                    .peripheral
                    .as_ref()
                    .map(|p| p.id().to_string())
                    == Some(id.to_string());
                if same {
                    g.peripheral = None;
                    g.connection = ConnectionState {
                        state: "idle".into(),
                        device_id: None,
                        device_name: None,
                        error: Some("设备已断开连接".into()),
                    };
                }
                drop(g);
                let _ = app.emit("aipassport:state", &state.lock().connection.clone());
                break;
            }
        }
    });
}
