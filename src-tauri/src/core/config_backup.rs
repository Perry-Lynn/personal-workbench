use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, path::PathBuf};
use tauri::{command, AppHandle};

use crate::{
    core::{api::ApiResponse, storage::{app_data_dir, StorageService}},
    modules::{jarrunner::models::JarConfig, logsight::models::{AuthType, ServerConfig}},
};

const MAX_BYTES: u64 = 5 * 1024 * 1024;

#[command]
pub async fn workbench_read_text_file(path: String) -> ApiResponse<String> {
    let file = PathBuf::from(path.trim());
    if !file.is_absolute() { return ApiResponse::err("文件路径必须是绝对路径"); }
    let result = (|| -> anyhow::Result<String> {
        let meta = std::fs::metadata(&file).context("读取文件信息失败")?;
        if !meta.is_file() || meta.len() > MAX_BYTES { anyhow::bail!("文件必须是普通文件且不超过 5 MiB"); }
        use std::io::Read;
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        std::fs::File::open(&file).context("打开文件失败")?.take(MAX_BYTES + 1).read_to_end(&mut bytes).context("读取文件失败")?;
        if bytes.len() as u64 > MAX_BYTES { anyhow::bail!("文件超过 5 MiB"); }
        String::from_utf8(bytes).context("文件不是有效 UTF-8")
    })();
    match result { Ok(s) => ApiResponse::ok(s), Err(e) => ApiResponse::err(format!("{e:#}")) }
}

#[command]
pub async fn workbench_check_config_paths(paths: Vec<String>) -> ApiResponse<Vec<String>> {
    if paths.len() > 3000 { return ApiResponse::err("路径检查数量超过 3000"); }
    ApiResponse::ok(paths.into_iter().filter(|p| PathBuf::from(p).is_absolute() && !PathBuf::from(p).exists()).collect())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JarSafeConfig {
    pub id: String, pub name: String, pub jar_path: String, pub jdk_home: String,
    pub config_file: String, pub work_dir: String, pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerSafeConfig {
    pub id: String, pub bookmark_category: String, pub title: String, pub host: String,
    pub port: u16, pub username: String, pub auth_type: AuthType,
    #[serde(default)] pub private_key_path: Option<String>, #[serde(default)] pub ssh_config_path: Option<String>,
    pub use_ssh_agent: bool, #[serde(default)] pub ssh_agent_path: Option<String>, pub use_mfa: bool,
    pub created_at: chrono::DateTime<chrono::Utc>, pub updated_at: chrono::DateTime<chrono::Utc>,
    #[serde(default)] pub last_connected_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyRequest { pub jars: Vec<JarSafeConfig>, pub servers: Vec<ServerSafeConfig> }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult { pub jars_applied: usize, pub servers_applied: usize }

fn validate_request(request: &ApplyRequest) -> anyhow::Result<()> {
    if request.jars.len() > 500 || request.servers.len() > 500 { anyhow::bail!("每类配置最多 500 条"); }
    let mut ids = HashSet::new();
    for item in &request.jars { validate_id(&item.id)?; if !ids.insert(format!("j:{}", item.id)) { anyhow::bail!("JAR 配置存在重复 ID"); } }
    for item in &request.servers { validate_id(&item.id)?; if !ids.insert(format!("s:{}", item.id)) { anyhow::bail!("LogSight 配置存在重复 ID"); } }
    Ok(())
}

#[command]
pub async fn workbench_validate_config_backup(request: ApplyRequest) -> ApiResponse<()> {
    match validate_request(&request) { Ok(()) => ApiResponse::ok(()), Err(e) => ApiResponse::err(format!("备份配置无效：{e:#}")) }
}

#[command]
pub async fn workbench_apply_config_backup(app: AppHandle, request: ApplyRequest) -> ApiResponse<ApplyResult> {
    let result = (|| -> anyhow::Result<ApplyResult> {
        validate_request(&request)?;
        let svc = StorageService::init(app_data_dir(&app))?;
        let jar_safe: HashMap<String, JarSafeConfig> = request.jars.iter().cloned().map(|v| (v.id.clone(), v)).collect();
        let server_safe: HashMap<String, ServerSafeConfig> = request.servers.iter().cloned().map(|v| (v.id.clone(), v)).collect();
        let jar_ids: Vec<String> = jar_safe.keys().cloned().collect();
        let server_ids: Vec<String> = server_safe.keys().cloned().collect();
        svc.apply_config_backup_batch(&jar_ids, &server_ids, |namespace, id, raw| {
            if namespace == "jarrunner:configs" {
                let safe = jar_safe.get(id).ok_or_else(|| anyhow::anyhow!("缺少已验证的 JAR 配置"))?;
                merge_jar_record(id, raw, safe)
            } else {
                let safe = server_safe.get(id).ok_or_else(|| anyhow::anyhow!("缺少已验证的服务器配置"))?;
                merge_server_record(id, raw, safe)
            }
        })?;
        Ok(ApplyResult { jars_applied: jar_ids.len(), servers_applied: server_ids.len() })
    })();
    match result { Ok(v) => ApiResponse::ok(v), Err(e) => ApiResponse::err(format!("安全配置应用失败：{e:#}")) }
}

fn validate_id(id: &str) -> anyhow::Result<()> {
    if id.is_empty() || id.len() > 128 || id.chars().any(|c| c.is_control()) { anyhow::bail!("配置 ID 非法"); }
    Ok(())
}

fn merge_jar_record(id: &str, raw: Option<&[u8]>, safe: &JarSafeConfig) -> anyhow::Result<Vec<u8>> {
    let mut cfg = match raw { Some(bytes) => serde_json::from_slice::<JarConfig>(bytes).context("现有 JAR 配置无法读取")?, None => JarConfig {
        id: id.to_owned(), name: String::new(), jar_path: String::new(), jdk_home: String::new(), jvm_args: String::new(), program_args: String::new(), config_file: String::new(), work_dir: String::new(), env: vec![], custom_command: String::new(), updated_at: 0,
    }};
    cfg.name = safe.name.clone(); cfg.jar_path = safe.jar_path.clone(); cfg.jdk_home = safe.jdk_home.clone(); cfg.config_file = safe.config_file.clone(); cfg.work_dir = safe.work_dir.clone(); cfg.updated_at = safe.updated_at;
    serde_json::to_vec(&cfg).context("序列化 JAR 配置失败")
}

fn merge_server_record(id: &str, raw: Option<&[u8]>, safe: &ServerSafeConfig) -> anyhow::Result<Vec<u8>> {
    let mut cfg = match raw { Some(bytes) => serde_json::from_slice::<ServerConfig>(bytes).context("现有服务器配置无法读取")?, None => { let mut v=ServerConfig::default(); v.id=id.to_owned(); v.run_scripts_enabled=false; v.run_scripts.clear(); v } };
    cfg.bookmark_category = safe.bookmark_category.clone(); cfg.title = safe.title.clone(); cfg.host = safe.host.clone(); cfg.port = safe.port; cfg.username = safe.username.clone(); cfg.auth_type = safe.auth_type.clone();
    cfg.private_key_path = safe.private_key_path.clone(); cfg.ssh_config_path = safe.ssh_config_path.clone(); cfg.use_ssh_agent = safe.use_ssh_agent; cfg.ssh_agent_path = safe.ssh_agent_path.clone(); cfg.use_mfa = safe.use_mfa;
    cfg.created_at = safe.created_at; cfg.updated_at = safe.updated_at; cfg.last_connected_at = safe.last_connected_at;
    serde_json::to_vec(&cfg).context("序列化服务器配置失败")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn 安全DTO拒绝参数密钥脚本与未知字段() {
        let jar = r#"{"id":"j1","name":"app","jarPath":"/app.jar","jdkHome":"","configFile":"","workDir":"","updatedAt":1,"env":[]}"#;
        assert!(serde_json::from_str::<JarSafeConfig>(jar).is_err());
        let server = r#"{"id":"s1","bookmark_category":"default","title":"prod","host":"host","port":22,"username":"root","auth_type":"Password","use_ssh_agent":false,"use_mfa":false,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","password_cipher":"secret"}"#;
        assert!(serde_json::from_str::<ServerSafeConfig>(server).is_err());
    }

    #[test]
    fn 重复ID与超限安全配置整包拒绝() {
        let a = JarSafeConfig { id:"same".into(), name:"a".into(), jar_path:"".into(), jdk_home:"".into(), config_file:"".into(), work_dir:"".into(), updated_at:0 };
        let req = ApplyRequest { jars: vec![a.clone(), a], servers: vec![] };
        assert!(validate_request(&req).is_err());
        let too_many = ApplyRequest { jars: vec![], servers: vec![ServerSafeConfig {
            id:"s".into(), bookmark_category:"default".into(), title:"t".into(), host:"h".into(), port:22, username:"u".into(), auth_type:AuthType::Password,
            private_key_path:None, ssh_config_path:None, use_ssh_agent:false, ssh_agent_path:None, use_mfa:false,
            created_at:chrono::Utc::now(), updated_at:chrono::Utc::now(), last_connected_at:None,
        }; 501] };
        assert!(validate_request(&too_many).is_err());
    }

    #[test]
    fn 同ID恢復僅覆蓋白名單並保留敏感字段() {
        let safe = JarSafeConfig { id:"j1".into(), name:"after".into(), jar_path:"new.jar".into(), jdk_home:"jdk".into(), config_file:"".into(), work_dir:"work".into(), updated_at:2 };
        let old = br#"{"id":"j1","name":"before","jarPath":"old.jar","jdkHome":"","jvmArgs":"-Xmx1g","programArgs":"--private","configFile":"","workDir":"","env":[{"key":"TOKEN","value":"secret"}],"customCommand":"private-command","updatedAt":1}"#;
        let merged: serde_json::Value = serde_json::from_slice(&merge_jar_record("j1", Some(old), &safe).unwrap()).unwrap();
        assert_eq!(merged["name"], "after"); assert_eq!(merged["jvmArgs"], "-Xmx1g"); assert_eq!(merged["env"][0]["value"], "secret"); assert_eq!(merged["customCommand"], "private-command");
        assert_eq!(merged["jarPath"], "new.jar");
    }

    #[test]
    fn 服务器恢复保留密文脚本并确保新增配置不自动运行() {
        let now = chrono::Utc::now();
        let safe = ServerSafeConfig { id:"s1".into(), bookmark_category:"default".into(), title:"after".into(), host:"host2".into(), port:2200, username:"root".into(), auth_type:AuthType::Password,
            private_key_path:None, ssh_config_path:None, use_ssh_agent:false, ssh_agent_path:None, use_mfa:false,
            created_at:now, updated_at:now, last_connected_at:None };
        let old = br#"{"id":"s1","bookmark_category":"default","title":"before","host":"host","port":22,"username":"root","auth_type":"Password","password_cipher":"cipher","private_key_cipher":"key","private_key_path":null,"ssh_config_path":null,"use_ssh_agent":false,"ssh_agent_path":null,"use_mfa":false,"run_scripts_enabled":true,"run_scripts":[{"content":"secret command","delay_ms":5}],"description":"private","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","last_connected_at":null}"#;
        let merged: serde_json::Value = serde_json::from_slice(&merge_server_record("s1", Some(old), &safe).unwrap()).unwrap();
        assert_eq!(merged["host"], "host2"); assert_eq!(merged["password_cipher"], "cipher");
        assert_eq!(merged["private_key_cipher"], "key"); assert_eq!(merged["run_scripts_enabled"], true);
        assert_eq!(merged["run_scripts"][0]["content"], "secret command");
        let added: serde_json::Value = serde_json::from_slice(&merge_server_record("s1", None, &safe).unwrap()).unwrap();
        assert_eq!(added["password_cipher"], serde_json::Value::Null);
        assert_eq!(added["run_scripts_enabled"], false); assert_eq!(added["run_scripts"], serde_json::json!([]));
    }
}
