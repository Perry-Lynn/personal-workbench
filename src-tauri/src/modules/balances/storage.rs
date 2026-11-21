/*
 * 智能体余额模块 · 凭证存储
 * ------------------------------------------------------------------
 * 平台 access_token / API Key 是敏感凭据，复用工作台主密钥（core::crypto）做
 * AES-256-GCM 加密，密文落 sled（core::storage），绝不存明文、绝不打日志。
 *
 * 设计要点：
 *   - 命令从前端拿到 master_key（与 workbench_decrypt_secret 同一约定：主密钥经 IPC 传入），
 *     用 CryptoService 加密后只存密文；使用时再用同一主密钥解密。
 *   - 命名空间 balances:<provider>，与工作台其它数据隔离。
 *   - ChatGPT 还支持「自动读 ~/.codex/auth.json」（Codex CLI 登录产物），那条不落盘，
 *     仅运行时读取。
 *
 * **凭证是「字段表」而不是单个 token**：ChatGPT / Qoder / OpenAI 只要一条
 * access_token，Trae 网页登录态要 authorization + cookie 两条。所以密文里存的是
 * 一整张 `{key: value}` 的 JSON，平台自己决定要哪几个键 —— 这样新增一个多字段平台
 * 不必再动存储层。
 *
 * ⚠️ **兼容老数据**：升级前存下的密文解开是**裸的 token 字符串**（不是 JSON）。
 * 读的时候按「JSON 对象 → 字段表；否则 → 当作 access_token」两条路走，
 * 老凭证于是继续可用，不会在界面上变成「未配置」。
 * @Author: fu
 */
use std::collections::BTreeMap;

use anyhow::Result;
use tauri::AppHandle;

use crate::core::crypto::CryptoService;
/* app_data_dir 已上收到 core::storage（主密钥 / 余额 / 窗口生命周期三处共用） */
use crate::core::storage::{app_data_dir, StorageService};
use crate::modules::balances::models::{
    DayMark, DetectedCodexCredential, ManualEntry, StoredCredential,
};

/* sled 键前缀 */
const CRED_PREFIX: &str = "balances";
const MANUAL_PREFIX: &str = "balances:manual";
const DAYMARK_PREFIX: &str = "balances:daymark";

fn cred_key(provider: &str) -> String {
    format!("{CRED_PREFIX}:{provider}")
}

fn manual_key(provider: &str) -> String {
    format!("{MANUAL_PREFIX}:{provider}")
}

/* 今日用量基线。「今日」是**每个池各一份**的（口径不同不能共用），故键里带指标名 */
fn daymark_key(provider: &str, metric: &str) -> String {
    format!("{DAYMARK_PREFIX}:{provider}:{metric}")
}

/* 解密出来的凭证：字段表 + 可选的 account_id（后者非敏感，明文存） */
pub struct LoadedCredential {
    pub fields: BTreeMap<String, String>,
    pub account_id: Option<String>,
}

/* 取字段；缺省时回落别名 —— ChatGPT 前端字段名是 access_token，其余平台可能写 apiKey */
impl LoadedCredential {
    pub fn field(&self, key: &str) -> Option<&str> {
        self.fields.get(key).map(|s| s.as_str())
    }
}

/* 加密并保存某平台的凭证字段表 */
pub fn save_fields(
    app: &AppHandle,
    provider: &str,
    fields: &BTreeMap<String, String>,
    account_id: Option<&str>,
    master_key: &str,
) -> Result<()> {
    /* 整张字段表序列化后一起加密：加密的是「有意义的密文」，
     * 逐个字段各存一条密文没有额外好处，反而多一份键名台账要维护。 */
    let payload = serde_json::to_string(fields)?;
    let cipher = CryptoService::new().encrypt_str(&payload, master_key)?;
    let stored = StoredCredential {
        token_cipher: cipher,
        account_id: account_id.map(|s| s.to_string()),
    };
    let value = serde_json::to_string(&stored)?;
    let storage = StorageService::init(app_data_dir(app))?;
    storage.set_setting(&cred_key(provider), &value)?;
    Ok(())
}

/* 读取并解密某平台凭证（无则返回 None） */
pub fn load_fields(
    app: &AppHandle,
    provider: &str,
    master_key: &str,
) -> Result<Option<LoadedCredential>> {
    let storage = StorageService::init(app_data_dir(app))?;
    let Some(raw) = storage.get_setting(&cred_key(provider))? else {
        return Ok(None);
    };
    let stored: StoredCredential =
        serde_json::from_str(&raw).map_err(|e| anyhow::anyhow!("凭证解析失败: {e}"))?;
    let plain = CryptoService::new().decrypt_str(&stored.token_cipher, master_key)?;

    /*
     * 老凭证解出来是**裸 token**，新凭证是 JSON 对象。
     * 只把「JSON 对象」认成字段表 —— JSON 里其它形态（数字、字符串、数组）
     * 都不是我们写进去的样子，一律当作裸 token 处理，免得把一条 token
     * 当成 JSON 拆出一堆空字段。
     */
    let fields: BTreeMap<String, String> = match serde_json::from_str::<serde_json::Value>(&plain) {
        Ok(serde_json::Value::Object(map)) => map
            .into_iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
            .collect(),
        _ => BTreeMap::from([("access_token".to_string(), plain)]),
    };

    Ok(Some(LoadedCredential {
        fields,
        account_id: stored.account_id,
    }))
}

/*
 * 只要「一条 token」的平台（ChatGPT / Qoder PAT）用的便捷封装：
 * 从字段表里取 access_token（老格式与新格式都落在同一个键上）。
 */
pub fn load_credential(
    app: &AppHandle,
    provider: &str,
    master_key: &str,
) -> Result<Option<DetectedCodexCredential>> {
    let Some(loaded) = load_fields(app, provider, master_key)? else {
        return Ok(None);
    };
    let access_token = loaded
        .field("access_token")
        .or_else(|| loaded.field("apiKey"))
        .unwrap_or_default()
        .to_string();
    Ok(Some(DetectedCodexCredential {
        access_token,
        account_id: loaded.account_id,
    }))
}

/* 删除某平台凭证 */
pub fn delete_credential(app: &AppHandle, provider: &str) -> Result<()> {
    let storage = StorageService::init(app_data_dir(app))?;
    storage.delete_setting(&cred_key(provider))?;
    Ok(())
}

/* 是否已存有凭证（供前端判断「已配置」标记，不解密） */
pub fn has_credential(app: &AppHandle, provider: &str) -> bool {
    let storage = match StorageService::init(app_data_dir(app)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    matches!(storage.get_setting(&cred_key(provider)), Ok(Some(_)))
}

/*
 * 自动检测 Codex CLI 登录产物 ~/.codex/auth.json。
 * 存在则返回 access_token + account_id；不存在返回 None（不影响其它平台）。
 * 仅 ChatGPT 用：用户若装了 Codex CLI 并 codex login，无需手动粘贴 token。
 */
pub fn detect_codex_auth() -> Option<DetectedCodexCredential> {
    let home = dirs::home_dir()?;
    let path = home.join(".codex").join("auth.json");
    let contents = std::fs::read_to_string(&path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&contents).ok()?;
    let tokens = v.get("tokens")?;
    let access_token = tokens
        .get("access_token")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())?;
    let account_id = tokens
        .get("account_id")
        .and_then(|a| a.as_str())
        .map(|s| s.to_string());
    Some(DetectedCodexCredential {
        access_token,
        account_id,
    })
}

/* ---- 手动录入（无公开接口的平台，如 Trae / WorkBuddy） ---- */

/* 保存/覆盖某平台的手动余额条目 */
pub fn save_manual(app: &AppHandle, provider: &str, label: &str, value: &str) -> Result<()> {
    let entry = ManualEntry {
        label: label.to_string(),
        value: value.to_string(),
    };
    let json = serde_json::to_string(&entry)?;
    let storage = StorageService::init(app_data_dir(app))?;
    storage.set_setting(&manual_key(provider), &json)?;
    Ok(())
}

/* 读取某平台的手动余额条目（无则 None） */
pub fn load_manual(app: &AppHandle, provider: &str) -> Option<ManualEntry> {
    let storage = StorageService::init(app_data_dir(app)).ok()?;
    let raw = storage.get_setting(&manual_key(provider)).ok()??;
    serde_json::from_str(&raw).ok()
}

/* 删除某平台的手动余额条目 */
pub fn delete_manual(app: &AppHandle, provider: &str) -> Result<()> {
    let storage = StorageService::init(app_data_dir(app))?;
    storage.delete_setting(&manual_key(provider))?;
    Ok(())
}

/* ---- 今日用量基线（差分累计用，非敏感，明文存） ---- */

/*
 * 读某平台某指标的今日基线。没有 / 反序列化失败都返回 None ——
 * 这两者对调用方是同一件事「还没有锚点」，此时不该出今日用量。
 *
 * 基线坏了最多是今天不算增量；比让「今日 −1234」这种负数显示在界面上安全得多。
 */
pub fn load_day_mark(app: &AppHandle, provider: &str, metric: &str) -> Option<DayMark> {
    let storage = StorageService::init(app_data_dir(app)).ok()?;
    let raw = storage.get_setting(&daymark_key(provider, metric)).ok()??;
    serde_json::from_str(&raw).ok()
}

/* 写回今日基线。失败只吞掉：它不影响本次刷新出数，下次再记即可 */
pub fn save_day_mark(app: &AppHandle, provider: &str, metric: &str, mark: &DayMark) {
    if let Ok(json) = serde_json::to_string(mark) {
        if let Ok(storage) = StorageService::init(app_data_dir(app)) {
            let _ = storage.set_setting(&daymark_key(provider, metric), &json);
        }
    }
}
