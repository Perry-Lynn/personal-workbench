/*
 * 工作台本地 KV 存储服务（sled）
 * ------------------------------------------------------------------
 * 设计要点：**按命名空间隔离**。
 * 每个模块用自己的命名空间前缀，例如：
 *   logsight:servers         LogSight 的服务器配置
 *   logsight:logback_configs LogSight 的 logback 解析结果
 *   workbench               工作台自身的设置（主密钥校验值等）
 *
 * 这样各模块的数据互不干扰，删除某个模块只需删掉它的命名空间，
 * 不会影响其它模块。模块自己的存取封装放在模块目录下
 * （见 src/modules/logsight/storage.rs），本文件只提供通用能力。
 * @Author: fu
 */
use anyhow::{anyhow, Context, Result};
use once_cell::sync::OnceCell;
use parking_lot::RwLock;
use serde::{de::DeserializeOwned, Serialize};
use sled::Db;
use sled::transaction::Transactional;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

/* 工作台级设置的命名空间 */
pub const NS_WORKBENCH: &str = "workbench";

/*
 * 取得应用数据目录，失败返回 Err。
 *
 * 这是全仓**唯一**调用 `app.path().app_data_dir()` 的地方。
 * 需要**写文件**的调用方（如 core/dock.rs 写 Dock 图标）用这个 ——
 * 写盘失败必须让用户看见，静默落到当前目录只会让人找不到文件。
 */
pub fn try_app_data_dir(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_data_dir()
        .context("无法获取应用数据目录")
}

/*
 * 取得应用数据目录（失败时退化为当前目录，保证调用方不会 panic）。
 *
 * 上收到 core 的原因：主密钥、余额模块、窗口生命周期三处都要用它，
 * 各留一份私有实现会各自演化出不同的退化策略（本仓的「第三次要用就上收」规矩）。
 * 注意它的用途是**算路径**，真正打开库仍要走 `StorageService::init`。
 *
 * ⚠️ 「退化到 ./」只适合「拿个路径继续跑」的场景。要写文件请用 `try_app_data_dir`，
 * 别让失败变成「文件悄悄出现在当前工作目录里」。
 */
pub fn app_data_dir(app: &AppHandle) -> PathBuf {
    try_app_data_dir(app).unwrap_or_else(|_| PathBuf::from("./"))
}

/* 存储服务全局单例 */
static STORAGE_INSTANCE: OnceCell<Arc<StorageService>> = OnceCell::new();

/*
 * 存储服务结构体
 * 封装 sled KV 数据库，对外只暴露「命名空间 + key」的通用读写接口
 */
pub struct StorageService {
    /* sled 数据库实例 */
    #[allow(dead_code)]
    db: Db,
    /* 命名空间 -> tree 缓存，避免每次读写都 open_tree */
    trees: RwLock<HashMap<String, sled::Tree>>,
    /* 读写锁，防止并发写冲突 */
    lock: RwLock<()>,
}

/*
 * 判断 sled 的报错是不是「数据库被另一个进程占着」。
 *
 * sled 用文件锁**独占**打开数据库，抢不到时抛的是 `Error::Io`，底层 errno 为 EAGAIN
 * （macOS 上是 35，Linux 上是 11），std 把它映射成 `ErrorKind::WouldBlock`。
 * 用户在同一 bundle id 起了两份进程时看到的就是它：
 *   IO error: could not acquire lock on ".../workbench-db/db":
 *   Os { code: 35, kind: WouldBlock, message: "Resource temporarily unavailable" }
 *
 * 除了 kind，再兜一层消息匹配 —— sled 哪天换了 errno，这条仍然认得出来。
 * ⚠️ 别把它放宽成「凡是 WouldBlock 都算」：只有抢锁这一个场景该换文案。
 */
fn is_lock_contention(err: &sled::Error) -> bool {
    match err {
        sled::Error::Io(io) => {
            matches!(io.kind(), std::io::ErrorKind::WouldBlock)
                || io.to_string().contains("could not acquire lock")
        }
        _ => false,
    }
}

/*
 * 抢锁失败时给用户看的提示。
 *
 * 抽成纯函数是为了让**文案本身**能被断言 —— 这句话是用户唯一能看到的东西，
 * 埋在 `init` 的闭包里就只能靠人眼盯，改坏了没人知道。
 *
 * 各模块的调用点都已经是 `format!("打开本地存储失败：{e}")`，所以这里不再重复
 * 「本地存储」四个字，拼起来是「打开本地存储失败：被另一个…」，读着通顺。
 * 末尾保留原始错误：用户看不懂，但排查时是唯一能定位到 errno 的线索。
 */
fn lock_contention_message(last_err: &str) -> String {
    format!(
        "被另一个「个人工作台」实例占用：同一时刻只能有一个实例打开数据库。\
         请先退出正在运行的那一个再重试（在活动监视器里结束名为 workbench 的进程，\
         或点菜单栏图标选「退出工作台」）。原始错误：{last_err}"
    )
}

impl StorageService {
    /*
     * 初始化存储服务（单例）
     * 在 AppData 目录下创建 workbench-db 文件夹作为 sled 数据库目录
     */
    pub fn init(app_data_dir: PathBuf) -> Result<Arc<Self>> {
        STORAGE_INSTANCE
            .get_or_try_init(|| -> Result<Arc<Self>> {
                let db_dir = app_data_dir.join("workbench-db");
                std::fs::create_dir_all(&db_dir)
                    .with_context(|| format!("创建数据库目录失败: {:?}", db_dir))?;

                /*
                 * sled 打开偶尔会因瞬时原因失败：上一次进程刚退出、文件系统还在收尾，
                 * 或启动环境对目录的访问被短暂拒绝。
                 * 这种失败一旦冒到上层，会把「主密钥初始化」这类关键流程直接打死，
                 * 而实际上重试一次就好了，所以这里做有限次重试。
                 */
                let mut last_err = String::new();
                /* 最后一次失败是不是「抢锁失败」。重试对它没用，要换成人话告诉用户 */
                let mut lock_contended = false;
                for attempt in 1..=3 {
                    match sled::open(&db_dir) {
                        Ok(db) => {
                            if attempt > 1 {
                                tracing::info!("sled 数据库第 {attempt} 次尝试打开成功: {:?}", db_dir);
                            }
                            return Ok(Arc::new(Self {
                                db,
                                trees: RwLock::new(HashMap::new()),
                                lock: RwLock::new(()),
                            }));
                        }
                        Err(e) => {
                            tracing::warn!("打开 sled 数据库失败（第 {attempt}/3 次）: {e}");
                            lock_contended = is_lock_contention(&e);
                            last_err = format!("{e}");
                            if attempt < 3 {
                                std::thread::sleep(std::time::Duration::from_millis(
                                    120 * attempt as u64,
                                ));
                            }
                        }
                    }
                }
                /*
                 * 抢锁失败 = 另一个「个人工作台」进程正开着这个库，重试再多次也没用。
                 *
                 * 正常路径下**走不到这里**：main.rs 第一个注册的 tauri-plugin-single-instance
                 * 会在第二份进程开库之前就把它打发掉。这里是兜底 ——
                 * 单实例守卫靠 /tmp 下的 unix socket 互相发现，而 macOS 会定期清理 /tmp 里的
                 * 陈旧文件，socket 一旦被清掉，第二份进程就会「连不上 → 自认是唯一实例」继续启动。
                 *
                 * 换文案的理由：原始 sled 报错（一句 would block 的 IO error）对用户毫无意义，
                 * 只会让人以为「数据坏了 / 装坏了」。技术细节留在末尾，方便排查。
                 */
                if lock_contended {
                    tracing::error!("sled 数据库被其它实例占用: {:?}", db_dir);
                    return Err(anyhow!("{}", lock_contention_message(&last_err)));
                }
                Err(anyhow!("打开 sled 数据库失败: {:?}: {last_err}", db_dir))
            })
            .cloned()
    }

    /* 获取已初始化的全局单例（若未初始化则返回错误） */
    #[allow(dead_code)]
    pub fn get() -> Result<Arc<Self>> {
        STORAGE_INSTANCE
            .get()
            .cloned()
            .ok_or_else(|| anyhow!("StorageService 尚未初始化，请先调用 init()"))
    }

    /*
     * 取得（或按需创建）某个命名空间的 tree
     */
    pub fn tree(&self, namespace: &str) -> Result<sled::Tree> {
        if let Some(t) = self.trees.read().get(namespace) {
            return Ok(t.clone());
        }
        let mut guard = self.trees.write();
        /* 双重检查：并发下可能已被其它线程插入 */
        if let Some(t) = guard.get(namespace) {
            return Ok(t.clone());
        }
        let tree = self
            .db
            .open_tree(namespace)
            .with_context(|| format!("打开数据表失败: {}", namespace))?;
        guard.insert(namespace.to_string(), tree.clone());
        Ok(tree)
    }

    /* ===== 通用读写 ===== */

    /* 序列化为 JSON 后写入指定命名空间 */
    pub fn put_json<V: Serialize>(&self, namespace: &str, key: &str, value: &V) -> Result<()> {
        let tree = self.tree(namespace)?;
        let _g = self.lock.write();
        let bytes = serde_json::to_vec(value).context("JSON 序列化失败")?;
        tree.insert(key.as_bytes(), bytes)?;
        tree.flush()?;
        Ok(())
    }

    /// Merge safe config fields under the write lock, then atomically write both fixed trees.
    pub fn apply_config_backup_batch<F>(&self, jars: &[String], servers: &[String], merge: F) -> Result<()>
    where F: Fn(&str, &str, Option<&[u8]>) -> Result<Vec<u8>> {
        let jar_tree = self.tree("jarrunner:configs")?;
        let server_tree = self.tree("logsight:servers")?;
        let _guard = self.lock.write();
        let mut old_jars = Vec::new(); let mut old_servers = Vec::new();
        let mut next_jars = Vec::new(); let mut next_servers = Vec::new();
        for id in jars { let old = jar_tree.get(id.as_bytes())?; let bytes = merge("jarrunner:configs", id, old.as_deref())?; old_jars.push((id.as_bytes().to_vec(), old)); next_jars.push((id.clone(), bytes)); }
        for id in servers { let old = server_tree.get(id.as_bytes())?; let bytes = merge("logsight:servers", id, old.as_deref())?; old_servers.push((id.as_bytes().to_vec(), old)); next_servers.push((id.clone(), bytes)); }
        let apply: std::result::Result<(), sled::transaction::TransactionError<()>> = (&jar_tree, &server_tree).transaction(|(jt, st)| {
            for (id, bytes) in &next_jars { jt.insert(id.as_bytes().to_vec(), bytes.clone())?; }
            for (id, bytes) in &next_servers { st.insert(id.as_bytes().to_vec(), bytes.clone())?; }
            Ok(())
        });
        if let Err(e) = apply { return Err(anyhow!("配置事务失败：{e:?}")); }
        if let Err(e) = jar_tree.flush().and_then(|_| server_tree.flush().map(|_| 0)) {
            let rollback: std::result::Result<(), sled::transaction::TransactionError<()>> = (&jar_tree, &server_tree).transaction(|(jt, st)| {
                for (id, value) in &old_jars { match value { Some(v) => { jt.insert(id.clone(), v.to_vec())?; }, None => { jt.remove(id.clone())?; } } }
                for (id, value) in &old_servers { match value { Some(v) => { st.insert(id.clone(), v.to_vec())?; }, None => { st.remove(id.clone())?; } } }
                Ok(())
            });
            return match rollback {
                Ok(()) => match jar_tree.flush().and_then(|_| server_tree.flush().map(|_| 0)) {
                    Ok(_) => Err(anyhow!("配置写入持久化失败，已回滚：{e}")),
                    Err(r) => Err(anyhow!("配置写入持久化失败；回滚后再次持久化也失败：{e}；{r}")),
                },
                Err(r) => Err(anyhow!("配置写入持久化失败且回滚失败：{e}；{r:?}")),
            };
        }
        Ok(())
    }

    /* 读取并反序列化 */
    pub fn get_json<V: DeserializeOwned>(&self, namespace: &str, key: &str) -> Result<Option<V>> {
        let tree = self.tree(namespace)?;
        let _g = self.lock.read();
        match tree.get(key.as_bytes())? {
            Some(ivec) => {
                let v: V = serde_json::from_slice(&ivec).context("JSON 反序列化失败")?;
                Ok(Some(v))
            }
            None => Ok(None),
        }
    }

    /* 删除一个 key，返回它是否存在过 */
    pub fn remove(&self, namespace: &str, key: &str) -> Result<bool> {
        let tree = self.tree(namespace)?;
        let _g = self.lock.write();
        let existed = tree.remove(key.as_bytes())?.is_some();
        tree.flush()?;
        Ok(existed)
    }

    /*
     * 列出命名空间下全部值
     * 单条记录反序列化失败时跳过，不整体报错，避免一条坏数据锁死整个列表
     */
    pub fn list_json<V: DeserializeOwned>(&self, namespace: &str) -> Result<Vec<V>> {
        let tree = self.tree(namespace)?;
        let _g = self.lock.read();
        let mut list: Vec<V> = Vec::new();
        for item in tree.iter() {
            let (_k, v) = item?;
            if let Ok(parsed) = serde_json::from_slice::<V>(&v) {
                list.push(parsed);
            }
        }
        Ok(list)
    }

    /* ===== 工作台级设置（字符串键值） ===== */

    /* 通用设置写入。当前只有读取方（主密钥校验值），保留为模块可用的写入接口 */
    #[allow(dead_code)]
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.put_json(NS_WORKBENCH, key, &value.to_string())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        self.get_json(NS_WORKBENCH, key)
    }

    pub fn delete_setting(&self, key: &str) -> Result<bool> {
        self.remove(NS_WORKBENCH, key)
    }

    /* 保存主密钥校验值（加密过的哨兵，用于判断钥匙串是否与本地数据匹配） */
    pub fn set_master_sentinel(&self, cipher: &str) -> Result<()> {
        self.put_json(NS_WORKBENCH, "master_sentinel", &cipher.to_string())
    }

    pub fn get_master_sentinel(&self) -> Result<Option<String>> {
        self.get_json(NS_WORKBENCH, "master_sentinel")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /*
     * 两个分支都用手工构造的 io::Error 覆盖，不用真的起第二个进程去抢锁 ——
     * 那样既慢又要靠文件系统行为，还会污染真实数据库目录。
     * 用 `ErrorKind::WouldBlock` + sled 原话，形状与真实报错一致且跨平台稳定。
     */
    #[test]
    fn 抢锁失败被识别为实例占用() {
        let e = sled::Error::Io(std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "could not acquire lock on \"/x/workbench-db/db\"",
        ));
        assert!(is_lock_contention(&e));
    }

    #[test]
    fn 只有消息匹配也能识别() {
        /* 万一 sled 改了 errno，kind 不再是 WouldBlock，靠消息仍要认出来 */
        let e = sled::Error::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            "could not acquire lock on \"/x/workbench-db/db\"",
        ));
        assert!(is_lock_contention(&e));
    }

    #[test]
    fn 普通_io_错误不算占用() {
        let e = sled::Error::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "No such file or directory",
        ));
        assert!(!is_lock_contention(&e));
    }

    #[test]
    fn 非_io_错误不算占用() {
        assert!(!is_lock_contention(&sled::Error::Unsupported(
            "unsupported".into()
        )));
    }

    #[test]
    fn 抢锁提示是给用户看的人话() {
        let m = lock_contention_message("IO error: could not acquire lock on \"/x/db\"");
        /* 结论：用户一眼能看懂到底发生了什么 */
        assert!(m.contains("被另一个「个人工作台」实例占用"));
        /* 动作：光说「被占用」用户不知道下一步该干嘛，必须给可执行的出路 */
        assert!(m.contains("退出正在运行的那一个"));
        /* 线索：原始错误留在末尾，排查时是唯一能定位到 errno 的东西 */
        assert!(m.ends_with("could not acquire lock on \"/x/db\""));
    }
}
