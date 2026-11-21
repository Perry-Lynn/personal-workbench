/*
 * Trae 社区 · 登录态存储
 * ------------------------------------------------------------------
 * 登录 cookie 只在本机保存，且**永不打印**：
 *   1. 优先写应用数据目录的 community-session.json，权限 0600；
 *   2. 文件写不进去时才退回 macOS 钥匙串。
 *
 * 之所以把顺序反过来（原先是钥匙串优先）：本应用是 ad-hoc 签名（`signingIdentity: "-"`），
 * 每次重新打包签名都会变，钥匙串把它当成「另一个程序」，于是**每次启动读会话**
 * 都会弹“个人工作台想要使用您储存在钥匙串中的机密信息”，要用户输入登录密码。
 * 实测点「通知」时就弹了一次。0600 文件只有当前用户可读，代价远小于每次启动弹窗。
 * 钥匙串只作为文件写失败时的兜底保留。
 *
 * 进程内再缓一份，避免每次取通知都读钥匙串。
 * 界面上只需要 SessionState（不含 cookie）。
 * @Author: fu
 */
use std::io::Write;
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::core::storage;

const KEYRING_SERVICE: &str = "com.fu.workbench.community";
const KEYRING_ACCOUNT: &str = "session";
const FILE_NAME: &str = "community-session.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Session {
    /* `Cookie: _t=…; _forum_session=…`，属于敏感信息，禁止出现在日志/错误里 */
    pub cookie: String,
    pub username: String,
    pub name: Option<String>,
    pub avatar_template: Option<String>,
    pub user_id: i64,
    pub unread_notifications: i64,
    pub unread_private_messages: i64,
    /* keychain / file */
    #[serde(default)]
    pub stored: String,
}

impl Session {
    pub fn state(&self) -> SessionState {
        SessionState {
            logged_in: !self.cookie.is_empty() && !self.username.is_empty(),
            username: Some(self.username.clone()).filter(|s| !s.is_empty()),
            name: self.name.clone(),
            avatar_template: self.avatar_template.clone(),
            unread_notifications: self.unread_notifications,
            unread_private_messages: self.unread_private_messages,
            stored: self.stored.clone(),
            window_open: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SessionState {
    pub logged_in: bool,
    pub username: Option<String>,
    pub name: Option<String>,
    pub avatar_template: Option<String>,
    pub unread_notifications: i64,
    pub unread_private_messages: i64,
    pub stored: String,
    /* 登录窗口是否还开着：前端轮询据此判断「用户提前关了窗口」 */
    #[serde(default)]
    pub window_open: bool,
}

static CACHE: Lazy<Mutex<Option<Session>>> = Lazy::new(|| Mutex::new(None));
static LOADED: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(false));

fn app_dir(app: &AppHandle) -> PathBuf {
    storage::app_data_dir(app)
}

fn file_path(app: &AppHandle) -> PathBuf {
    app_dir(app).join(FILE_NAME)
}

fn read_keychain() -> Option<Session> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).ok()?;
    let raw = entry.get_password().ok()?;
    let mut session: Session = serde_json::from_str(&raw).ok()?;
    session.stored = "keychain".to_string();
    Some(session)
}

fn write_keychain(session: &Session) -> bool {
    let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) else {
        return false;
    };
    let Ok(raw) = serde_json::to_string(session) else {
        return false;
    };
    entry.set_password(&raw).is_ok()
}

fn read_file(app: &AppHandle) -> Option<Session> {
    let raw = std::fs::read_to_string(file_path(app)).ok()?;
    let mut session: Session = serde_json::from_str(&raw).ok()?;
    session.stored = "file".to_string();
    Some(session)
}

fn write_file(app: &AppHandle, session: &Session) -> bool {
    let dir = app_dir(app);
    if std::fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let raw = match serde_json::to_vec(session) {
        Ok(raw) => raw,
        Err(_) => return false,
    };
    let path = file_path(app);
    let written = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&path)?;
        file.write_all(&raw)?;
        file.flush()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    })();
    written.is_ok()
}

fn remove_file(app: &AppHandle) -> bool {
    std::fs::remove_file(file_path(app)).is_ok()
}

/* 首次访问时从磁盘/钥匙串装载，之后走内存 */
pub fn load(app: &AppHandle) -> Option<Session> {
    {
        let loaded = LOADED.lock();
        if *loaded {
            return CACHE.lock().clone();
        }
    }
    let session = read_file(app).or_else(read_keychain);
    if let Some(mut value) = session.clone() {
        if value.stored.is_empty() {
            value.stored = "file".to_string();
        }
        *CACHE.lock() = Some(value);
    }
    *LOADED.lock() = true;
    session
}

/* 保存登录态；优先 0600 文件，写失败才退钥匙串。返回最终落盘方式。 */
pub fn save(app: &AppHandle, mut session: Session) -> Session {
    session.cookie = session.cookie.trim().to_string();
    session.username = session.username.trim().to_string();

    if write_file(app, &session) {
        /* 文件写盘成功就是常态路径：这里**不动**钥匙串。
           对它做删除同样会触发系统授权弹窗（签名逐次变化），留给 clear() 统一处理。 */
        session.stored = "file".to_string();
    } else if write_keychain(&session) {
        session.stored = "keychain".to_string();
    } else {
        session.stored = "file".to_string();
    }
    *CACHE.lock() = Some(session.clone());
    *LOADED.lock() = true;
    session
}

/* 更新未读数这类非敏感字段：重写 0600 文件即可，不碰钥匙串 */
pub fn update_unread(app: &AppHandle, notifications: i64, private_messages: i64) {
    let Some(mut session) = load(app) else { return };
    session.unread_notifications = notifications;
    session.unread_private_messages = private_messages;
    save(app, session);
}

pub fn clear(app: &AppHandle) {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
        let _ = entry.delete_credential();
    }
    remove_file(app);
    *CACHE.lock() = None;
    *LOADED.lock() = true;
}

/* 单测用：不碰真实钥匙串，只验证 0600 文件读写的结构 */
#[cfg(test)]
pub fn test_write(dir: &Path, session: &Session) -> bool {
    let path = dir.join(FILE_NAME);
    let raw = serde_json::to_vec(session).unwrap_or_default();
    if std::fs::write(&path, raw).is_err() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    true
}
