/*
 * 工作台主密钥服务
 * ------------------------------------------------------------------
 * 主密钥是**工作台级**能力：所有需要本地加密的模块共用同一把密钥。
 *
 * 存储策略：**系统钥匙串优先，本地数据目录兜底**。
 *   1. 钥匙串可用      -> 密钥存钥匙串，本地不留副本
 *   2. 钥匙串不可用    -> 密钥暂存本地 KV（app_master_key），并把原因回给前端
 *                        下次启动会自动尝试迁回钥匙串，成功即删除本地副本
 * 这样做的原因：桌面应用可能遇到钥匙串被锁定、无权限、非标准启动环境等情况，
 * 此时让整个工作台的加密能力直接失效，比降级存储的代价更大。
 *
 * 恢复顺序（任何一步成功即返回）：
 *   1. 工作台自己的钥匙串条目        com.fu.workbench / app-master-password
 *   2. 本地数据目录里的兜底/遗留密钥  sled workbench/app_master_key
 *   3. 旧版 LogSight 的钥匙串条目    com.fu.logsight / app-master-password（一次性继承）
 *   4. 以上都没有：本地无历史数据 -> 生成新密钥；本地已有数据 -> 报错等待用户重建
 *
 * 对外命令（前缀 workbench_ 表示工作台级，不属于任何模块）：
 *   workbench_get_or_create_master_password
 *   workbench_reset_master_password
 *   workbench_decrypt_secret
 * @Author: fu
 */
use keyring::{Entry, Error as KeyringError};
use serde::Serialize;
use tauri::{command, AppHandle};

use crate::core::api::ApiResponse;
use crate::core::crypto::CryptoService;
/* app_data_dir 已上收到 core::storage（主密钥 / 余额 / 窗口生命周期三处共用） */
use crate::core::storage::{app_data_dir, StorageService};

/* 钥匙串条目：service 用应用标识，account 固定 */
const KEYRING_SERVICE: &str = "com.fu.workbench";
const KEYRING_ACCOUNT: &str = "app-master-password";

/*
 * 旧版 LogSight 的钥匙串 service。
 * 工作台是 LogSight 的延续，用户机器上往往只存在旧条目；
 * 这里做一次性继承，避免升级后直接落入「钥匙串里找不到密钥」的死角。
 */
const LEGACY_KEYRING_SERVICE: &str = "com.fu.logsight";

/*
 * 本地兜底键名。
 * 与旧版 LogSight 存放明文主密钥的键名保持一致，
 * 这样老数据可以自然迁移进来，不需要额外的迁移分支。
 */
const LOCAL_FALLBACK_KEY: &str = "app_master_key";

/*
 * 校验值明文。
 * 它只用来「验证钥匙串里的密钥能否解开本地数据」，内容本身不参与比较，
 * 所以这里可以随时改名，不会让已有用户失效。
 */
const SENTINEL_PLAINTEXT: &str = "WORKBENCH_OK";

/*
 * 校验值的**来源标记**：记录「写这份校验值时，密钥存在哪里」。
 *
 * 为什么必须有它：校验值一旦解不开，就再也读不出它的任何属性了 ——
 * 而「解不开」正是唯一需要判断的时候。把来源放在密文**之外**，
 * 才能区分下面两件性质完全不同的事：
 *   keychain + 解不开 -> 钥匙串条目被别的程序换过了（真阳性，要告警）
 *   local    + 解不开 -> 只是降级运行留下的痕迹（假阳性，必须沉默）
 */
const SENTINEL_SRC_KEYCHAIN: &str = "keychain";
const SENTINEL_SRC_LOCAL: &str = "local";

/* 修复前那批「无标记」校验值的归档位置（收敛时先存这里，不直接丢弃） */
const SENTINEL_LEGACY_KEY: &str = "master_sentinel_legacy";

/* 密钥实际存放位置 */
#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum KeySource {
    /* 系统钥匙串（首选） */
    Keychain,
    /* 本地数据目录（钥匙串不可用时的兜底） */
    Local,
}

/* 返回给前端的密钥信息 */
#[derive(Serialize)]
pub struct MasterKeyInfo {
    pub key: String,
    pub source: KeySource,
    /* 非致命告警（例如降级到本地存储的原因），前端可展示 */
    pub warning: Option<String>,
}

impl MasterKeyInfo {
    fn keychain(key: String, warning: Option<String>) -> Self {
        Self {
            key,
            source: KeySource::Keychain,
            warning,
        }
    }
}

/*
 * 校验值对「钥匙串里这把密钥」的判定结果。
 * 刻意不用 Option<bool>：`None` 表达不了「有校验值但归属不明」这一档，
 * 而那恰恰是 2026-09-18 出问题的那一档。
 */
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    /* 同一把：校验值解得开，或本地压根没有校验值（没有基准，钥匙串即权威） */
    Same,
    /* 校验值由钥匙串里的密钥写入，而现在钥匙串里这把解不开 -> 钥匙串被换过了 */
    Changed,
    /* 归属不明：降级运行写的 / 修复前留下的无标记历史值 -> 不作判断 */
    Unknown,
}

/* KeySource -> 校验值来源标记 */
fn source_tag(source: KeySource) -> &'static str {
    match source {
        KeySource::Keychain => SENTINEL_SRC_KEYCHAIN,
        KeySource::Local => SENTINEL_SRC_LOCAL,
    }
}

/* 取得钥匙串条目句柄 */
fn master_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| format!("初始化系统钥匙串失败: {e}"))
}

/*
 * 写入钥匙串并立即读回校验。
 * 某些系统在钥匙串锁定时 set_password 会静默失败，必须读回确认。
 */
fn save_and_verify_master_password(entry: &Entry, master: &str) -> Result<(), String> {
    entry
        .set_password(master)
        .map_err(|e| format!("保存系统钥匙串失败: {e}"))?;
    let stored = entry
        .get_password()
        .map_err(|e| format!("系统钥匙串写入后读取校验失败: {e}"))?;
    if stored != master {
        return Err("系统钥匙串写入校验失败：读取到的主密钥不一致".to_string());
    }
    Ok(())
}

/*
 * 落盘主密钥：优先钥匙串，失败则退回本地 KV。
 * 返回 (实际存储位置, 需要提示给用户的告警)。
 */
fn store_master(
    storage: &StorageService,
    entry: &Entry,
    master: &str,
    keychain_write_ok: bool,
) -> Result<(KeySource, Option<String>), String> {
    /*
     * 钥匙串里有东西、但我们读不到（读取失败但不是「无条目」）时**绝不回写**。
     *
     * 因为 save_and_verify_master_password 是「先 set_password 再读回校验」，
     * 也就是「写」这个动作在读回失败之前就已经发生了 —— 万一里面是正确的那把，
     * 这一下就把它覆盖掉了，而且是不可逆的。
     * 原则同 Verdict::Unknown 分支：看不懂就别写。
     */
    if !keychain_write_ok {
        tracing::warn!(
            "[主密钥] 钥匙串不可读（非「无条目」），为免覆盖其中可能正确的密钥，本次不回写钥匙串"
        );
        storage.set_setting(LOCAL_FALLBACK_KEY, master).map_err(|e| {
            format!(
                "系统钥匙串不可读，本地兜底存储也失败（{:#}）；请检查本地数据目录的写入权限",
                e
            )
        })?;
        return Ok((
            KeySource::Local,
            Some(
                "系统钥匙串当前不可读（权限被拒或条目异常）。为免覆盖其中可能正确的密钥，本次没有回写钥匙串；主密钥已暂存到本地数据目录，功能正常但安全性下降。请确认钥匙串访问权限后，到「设置 - 本地密钥」点「重试」。".to_string(),
            ),
        ));
    }

    match save_and_verify_master_password(entry, master) {
        Ok(()) => {
            /* 钥匙串可用了，清掉本地兜底副本，避免两处不一致 */
            let _ = storage.delete_setting(LOCAL_FALLBACK_KEY);
            Ok((KeySource::Keychain, None))
        }
        Err(keychain_err) => {
            tracing::warn!("[主密钥] 系统钥匙串不可用：{keychain_err}，改用本地数据目录兜底");
            storage.set_setting(LOCAL_FALLBACK_KEY, master).map_err(|e| {
                format!(
                    "系统钥匙串不可用（{keychain_err}），本地兜底存储也失败（{:#}）；请检查本地数据目录的写入权限",
                    e
                )
            })?;
            Ok((
                KeySource::Local,
                Some(format!(
                    "系统钥匙串不可用：{keychain_err}。主密钥已暂存到本地数据目录，功能正常但安全性下降。\
                     若应用是被其它工具或沙箱拉起的，请改从系统终端启动，再到「设置 - 本地密钥」点「重试」迁回钥匙串。"
                )),
            ))
        }
    }
}

/* 校验值编码：`<来源>:<密文>` */
fn encode_sentinel(source: &str, cipher: &str) -> String {
    format!("{source}:{cipher}")
}

/*
 * 拆出（来源, 密文）。
 * 没有合法前缀的历史值（修复前写下的）返回空来源，调用方按「归属不明」处理。
 */
fn parse_sentinel(raw: &str) -> (&str, &str) {
    match raw.split_once(':') {
        Some((src, cipher)) if src == SENTINEL_SRC_KEYCHAIN || src == SENTINEL_SRC_LOCAL => {
            (src, cipher)
        }
        _ => ("", raw),
    }
}

/*
 * 纯判定：给定「来源标记」和「密文解没解开」这两件事，判断钥匙串里这把密钥的归属。
 *
 * 刻意做成不碰存储、不碰密码学的纯函数 —— 这是整个主密钥逻辑里最容易搞错的一步
 * （2026-09-18 就是在这里把「降级运行遗留」误判成「密钥是错的」），
 * 抽出来才能用单元测试把每条分支钉死。
 */
fn verdict_of(src_tag: &str, decrypted_ok: bool) -> Verdict {
    if decrypted_ok {
        Verdict::Same
    } else if src_tag == SENTINEL_SRC_KEYCHAIN {
        /* 校验值是钥匙串里的密钥写的，而现在这把解不开 -> 钥匙串被换过 */
        Verdict::Changed
    } else {
        /* local / 无标记 -> 没有发言权 */
        Verdict::Unknown
    }
}

/*
 * 能不能把「无标记的历史校验值」收敛掉（重写成当前密钥 + keychain 标记）。
 *
 * 条件是刻意收窄的：
 *   - 必须是无标记的历史值（有标记的说明作者明确，不能动）
 *   - 本地必须**没有**兜底副本 —— 有副本就意味着历史上出现过第二把密钥，
 *     线索必须留着，不能收敛
 * 收敛后「钥匙串被换过」才检测得出来；不收敛则永远停在「归属不明」、永远沉默。
 */
fn should_converge_legacy(sentinel_tag: &str, has_cipher: bool, has_local_copy: bool) -> bool {
    sentinel_tag.is_empty() && has_cipher && !has_local_copy
}

/*
 * 记录主密钥校验值：只是探测手段，写失败不阻塞主流程。
 * `source` = 写这份校验值时密钥实际存在哪里，供日后判断归属。
 */
fn remember_sentinel(storage: &StorageService, master: &str, source: &str) {
    match CryptoService::new().encrypt_str(SENTINEL_PLAINTEXT, master) {
        Ok(cipher) => {
            let tagged = encode_sentinel(source, &cipher);
            if let Err(e) = storage.set_master_sentinel(&tagged) {
                tracing::warn!("[主密钥] 保存校验值失败（不影响本次使用）: {:#}", e);
            }
        }
        Err(e) => tracing::warn!("[主密钥] 生成校验值失败（不影响本次使用）: {:#}", e),
    }
}

/*
 * 命令：获取工作台主密钥。
 * 依次尝试：工作台钥匙串 -> 本地兜底/遗留 -> 旧版钥匙串 -> 生成新密钥。
 */
#[command]
pub async fn workbench_get_or_create_master_password(app: AppHandle) -> ApiResponse<MasterKeyInfo> {
    let dir = app_data_dir(&app);
    tracing::info!("[主密钥] 开始获取，数据目录: {:?}", dir);

    let storage = match StorageService::init(dir) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("[主密钥] 初始化存储失败: {:#}", e);
            return ApiResponse::err(format!("初始化存储失败: {:#}", e));
        }
    };
    let entry = match master_entry() {
        Ok(entry) => entry,
        Err(e) => {
            tracing::error!("[主密钥] {e}");
            return ApiResponse::err(e);
        }
    };

    /*
     * 钥匙串「读失败」分两种，处置完全不同：
     *   NoEntry  -> 里面确实没有条目，回写是安全的
     *   其它错误 -> 里面可能有条目、只是我们读不到，回写会覆盖它 -> 禁止
     */
    let mut keychain_write_ok = true;

    /* 1. 工作台自己的钥匙串条目 */
    match entry.get_password() {
        Ok(master) => {
            tracing::info!("[主密钥] 命中系统钥匙串");

            /*
             * 校验值（master_sentinel）是「某把密钥加密过的固定明文」，存在本地 KV 里，
             * 用来判断「钥匙串里的这把密钥」是否还是当初那把。
             *
             * 它带一个**来源标记**（编码为 `<来源>:<密文>`，见 parse_sentinel）。
             * 标记记录「写这份校验值时密钥存在哪里」，且必须在密文**之外** ——
             * 因为最需要它的时候恰恰是「密文解不开」的时候：
             *
             *   tag=keychain 且解不开 -> 校验值当初由**钥匙串里的**密钥写入，
             *                            而钥匙串里现在这把解不开它
             *                            => 钥匙串条目被别的程序换过了（真阳性）
             *   tag=local    且解不开 -> 校验值是一次降级运行用临时密钥写的，
             *                            对当前钥匙串密钥没有发言权（沉默）
             *   无标记 / 历史值        -> 归属不明（沉默）
             *
             * 2026-09-18 真机实测：修复前的实现不带标记，降级运行写下的校验值
             * 在钥匙串恢复后成了「谁也解不开的孤儿」，据此告警是**假阳性** ——
             * 而当时钥匙串里那把其实是对的（能解开真实的服务器密码密文）。
             */
            let (verdict, sentinel_tag, sentinel_cipher) = match storage.get_master_sentinel() {
                Ok(Some(raw)) => {
                    let (src_tag, cipher) = parse_sentinel(&raw);
                    let decrypted_ok = matches!(
                        CryptoService::new().decrypt_str(cipher, &master),
                        Ok(plain) if plain == SENTINEL_PLAINTEXT
                    );
                    (
                        verdict_of(src_tag, decrypted_ok),
                        src_tag.to_string(),
                        Some(cipher.to_string()),
                    )
                }
                /* 本地还没有校验值：没有可比对的基准，钥匙串即权威 */
                Ok(None) => (Verdict::Same, String::new(), None),
                Err(e) => {
                    tracing::warn!("[主密钥] 读取校验值失败，为安全起见保留本地兜底副本：{e}");
                    (Verdict::Unknown, String::new(), None)
                }
            };

            let mut warning: Option<String> = None;
            match verdict {
                Verdict::Same => {
                    /*
                     * 顺手把来源标记补成 keychain（**密文不动，只补标记**）。
                     * 能走到这里就说明当前密钥解得开这份密文，补标记不损失任何信息；
                     * 而只有标记是 keychain，「钥匙串被别的程序换过」才检测得出来。
                     */
                    if let Some(cipher) = &sentinel_cipher {
                        if !sentinel_tag.is_empty() && sentinel_tag != SENTINEL_SRC_KEYCHAIN {
                            let tagged = encode_sentinel(SENTINEL_SRC_KEYCHAIN, cipher);
                            if storage.set_master_sentinel(&tagged).is_ok() {
                                tracing::info!("[主密钥] 校验值来源标记已补为 keychain");
                            }
                        }
                    }

                    /*
                     * 「能解开校验值」并不等于「本地兜底副本是多余的」：
                     * 副本可能来自更早的一次降级运行，而那个时代的密文可能还在用。
                     * 只有在两者**完全一致**时，才能确认副本冗余、可安全清理。
                     */
                    match storage.get_setting(LOCAL_FALLBACK_KEY) {
                        Ok(Some(local)) if local == master => {
                            match storage.delete_setting(LOCAL_FALLBACK_KEY) {
                                Ok(true) => tracing::info!(
                                    "[主密钥] 已清理本地兜底副本（与钥匙串密钥一致，本地不留副本）"
                                ),
                                Ok(false) => {}
                                Err(e) => {
                                    tracing::warn!("[主密钥] 清理本地兜底副本失败（不影响使用）：{e}")
                                }
                            }
                        }
                        Ok(Some(_)) => tracing::warn!(
                            "[主密钥] 本地兜底副本与钥匙串密钥不同，已保留（可能仍被更早的密文使用）"
                        ),
                        Ok(None) => {}
                        Err(e) => {
                            tracing::warn!("[主密钥] 读取本地兜底副本失败，保守起见不清理：{e}")
                        }
                    }
                }
                Verdict::Changed => {
                    /*
                     * 真阳性：校验值当初由钥匙串里的密钥写入，而现在钥匙串里这把解不开它
                     * => 钥匙串条目被别的程序换过了。
                     *
                     * 仍然**不写任何存储**：换成新密钥会让已有密文永久失效，
                     * 而手上这把也不一定就是错的。只陈述事实，并明确劝阻「重建」——
                     * 用户看到「数据可能坏了」的第一反应恰恰是去点重建。
                     */
                    tracing::warn!(
                        "[主密钥] 钥匙串条目似乎已被其它程序更改（原密钥解得开校验值，当前这把解不开）"
                    );
                    warning = Some("系统钥匙串里的主密钥似乎已被其它程序更改：当前这把解不开本地数据的校验值，已有的加密数据（如 LogSight 的服务器密码 / 私钥）可能无法解密。本地数据目录里的兜底副本仍保留着，没有删除。请先不要点「重建」——重建会换一把新密钥，旧密文就再也解不开了。".to_string());
                }
                Verdict::Unknown => {
                    /*
                     * 归属不明：校验值要么是降级运行用临时密钥写的（tag=local），
                     * 要么是修复前留下的无标记历史值。这两种情况下它都**没有发言权** ——
                     * 不能据此说钥匙串里的密钥是错的（2026-09-18 实测过反例）。
                     * 只记日志：不动作、不告警、不写存储，线索原样保留。
                     */
                    tracing::warn!(
                        "[主密钥] 校验值归属不明（降级运行遗留 / 历史无标记值），不作判断，沿用钥匙串密钥"
                    );

                    /*
                     * 有一种「不明」是可以安全收敛的，这里显式处理：
                     * 修复前留下的无标记历史值 + 本地不存在第二把候选密钥。
                     *
                     * 收敛的意义：不收敛的话，这个校验值会永远停在「归属不明」、
                     * 永远沉默 —— 那么「钥匙串被别的程序换过」这件事就再也检测不出来。
                     * 收敛之后，检测能力对当前密钥立刻生效。
                     *
                     * 代价是零：旧值先归档到 SENTINEL_LEGACY_KEY（只写一次，不覆盖），
                     * 而它本身是「没有任何密钥解得开」的孤儿，留着也用不上。
                     * 条件由 should_converge_legacy 单独把关并做了单元测试。
                     */
                    let has_local_copy =
                        !matches!(storage.get_setting(LOCAL_FALLBACK_KEY), Ok(None));
                    if should_converge_legacy(
                        &sentinel_tag,
                        sentinel_cipher.is_some(),
                        has_local_copy,
                    ) {
                        if let Some(cipher) = &sentinel_cipher {
                            if matches!(storage.get_setting(SENTINEL_LEGACY_KEY), Ok(None)) {
                                let _ = storage.set_setting(SENTINEL_LEGACY_KEY, cipher);
                            }
                            remember_sentinel(&storage, &master, SENTINEL_SRC_KEYCHAIN);
                            tracing::info!(
                                "[主密钥] 无标记的历史校验值已收敛为当前密钥（旧值归档到 {SENTINEL_LEGACY_KEY}）"
                            );
                        }
                    }
                }
            }

            return ApiResponse::ok(MasterKeyInfo::keychain(master, warning));
        }
        Err(KeyringError::NoEntry) => {
            tracing::warn!("[主密钥] 系统钥匙串中没有工作台条目，继续尝试其它来源");
        }
        Err(e) => {
            /*
             * 读失败不等于没密钥：可能只是钥匙串被锁定或本进程无权限。
             * 不在这里直接失败，继续走后面的来源，实在没有才由 store_master 降级处理。
             */
            keychain_write_ok = false;
            tracing::warn!("[主密钥] 读取系统钥匙串失败，继续尝试其它来源：{e}");
        }
    }

    /*
     * 2. 本地兜底副本 / 旧版遗留明文密钥。
     * 拿到后顺手尝试迁回钥匙串，迁移成功会删掉本地副本。
     */
    match storage.get_setting(LOCAL_FALLBACK_KEY) {
        Ok(Some(local_master)) => {
            let (source, warning) = match store_master(&storage, &entry, &local_master, keychain_write_ok) {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!("[主密钥] {e}");
                    return ApiResponse::err(e);
                }
            };
            remember_sentinel(&storage, &local_master, source_tag(source));
            tracing::info!("[主密钥] 使用本地存储的密钥，当前位置: {:?}", source);
            return ApiResponse::ok(MasterKeyInfo {
                key: local_master,
                source,
                warning,
            });
        }
        Ok(None) => {}
        Err(e) => {
            tracing::error!("[主密钥] 读取本地密钥失败: {:#}", e);
            return ApiResponse::err(format!("读取设置失败: {:#}", e));
        }
    }

    /*
     * 3. 旧版 LogSight 的钥匙串条目。
     * 读取旧条目可能触发系统授权弹窗，也可能因权限被拒；
     * 这一步失败只当作「没有旧密钥」，绝不能因此阻塞新密钥的创建。
     */
    match Entry::new(LEGACY_KEYRING_SERVICE, KEYRING_ACCOUNT) {
        Ok(legacy_entry) => match legacy_entry.get_password() {
            Ok(legacy_master) => {
                let (source, warning) = match store_master(&storage, &entry, &legacy_master, keychain_write_ok) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::error!("[主密钥] 继承旧版密钥失败: {e}");
                        return ApiResponse::err(e);
                    }
                };
                remember_sentinel(&storage, &legacy_master, source_tag(source));
                tracing::info!("[主密钥] 已继承旧版 LogSight 钥匙串中的主密钥");
                return ApiResponse::ok(MasterKeyInfo {
                    key: legacy_master,
                    source,
                    warning,
                });
            }
            Err(KeyringError::NoEntry) => tracing::info!("[主密钥] 无旧版 LogSight 钥匙串条目"),
            Err(e) => tracing::warn!("[主密钥] 读取旧版 LogSight 钥匙串失败（忽略）: {e}"),
        },
        Err(e) => tracing::warn!("[主密钥] 打开旧版 LogSight 钥匙串失败（忽略）: {e}"),
    }

    /* 4. 决定「生成新密钥」还是「等待用户恢复」 */
    match storage.get_master_sentinel() {
        Ok(Some(_)) => {
            tracing::error!("[主密钥] 本地存在加密数据，但钥匙串与旧版条目都找不到主密钥");
            ApiResponse::err(
                "系统钥匙串中找不到应用主密钥，无法解密已有本地数据；请恢复钥匙串后重试"
                    .to_string(),
            )
        }
        Ok(None) => {
            let master = CryptoService::generate_app_master_password();
            let (source, warning) = match store_master(&storage, &entry, &master, keychain_write_ok) {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!("[主密钥] {e}");
                    return ApiResponse::err(e);
                }
            };
            remember_sentinel(&storage, &master, source_tag(source));
            tracing::info!("[主密钥] 本地无历史数据，已生成新的工作台主密钥（位置: {:?}）", source);
            ApiResponse::ok(MasterKeyInfo {
                key: master,
                source,
                warning,
            })
        }
        Err(e) => {
            tracing::error!("[主密钥] 读取校验值失败: {:#}", e);
            ApiResponse::err(format!("读取设置失败: {:#}", e))
        }
    }
}

/*
 * 命令：重建主密钥。
 * 仅在用户明确确认钥匙串无法恢复时调用；本地数据记录会保留，但旧密文无法用新密钥解密。
 */
#[command]
pub async fn workbench_reset_master_password(app: AppHandle) -> ApiResponse<MasterKeyInfo> {
    let storage = match StorageService::init(app_data_dir(&app)) {
        Ok(s) => s,
        Err(e) => return ApiResponse::err(format!("初始化存储失败: {:#}", e)),
    };
    let entry = match master_entry() {
        Ok(entry) => entry,
        Err(e) => return ApiResponse::err(e),
    };
    let master = CryptoService::generate_app_master_password();
    /*
     * 重建：用户已明确确认要换一把新密钥，所以这里**允许**回写钥匙串
     * （与自动恢复路径不同 —— 那条路径上覆盖可能是正确的那把，代价不可逆）。
     */
    let (source, warning) = match store_master(&storage, &entry, &master, true) {
        Ok(v) => v,
        Err(e) => {
            tracing::error!("[主密钥] 重建失败: {e}");
            return ApiResponse::err(e);
        }
    };
    remember_sentinel(&storage, &master, source_tag(source));
    tracing::info!("[主密钥] 已按用户要求重建工作台主密钥（位置: {:?}）", source);
    ApiResponse::ok(MasterKeyInfo {
        key: master,
        source,
        warning,
    })
}

/* 命令：用主密钥把密文解成明文（前端按需解密敏感字段时使用） */
#[command]
pub async fn workbench_decrypt_secret(
    cipher_b64: String,
    master_password: String,
) -> ApiResponse<String> {
    match CryptoService::new().decrypt_str(&cipher_b64, &master_password) {
        Ok(plain) => ApiResponse::ok(plain),
        Err(e) => ApiResponse::err(format!("解密失败: {:#}", e)),
    }
}

#[cfg(test)]
mod sentinel_tests {
    use super::*;

    /*
     * 编码 / 解码：来源必须在密文**之外** —— 密文解不开时也要读得到它，
     * 否则就退化成修复前那套「解不开就无从判断」的实现。
     */
    #[test]
    fn sentinel_roundtrip_keeps_source_outside_cipher() {
        let cipher = "AbCd+/=1234";
        let encoded = encode_sentinel(SENTINEL_SRC_KEYCHAIN, cipher);
        assert_eq!(encoded, format!("{SENTINEL_SRC_KEYCHAIN}:{cipher}"));
        let (src_tag, got) = parse_sentinel(&encoded);
        assert_eq!(src_tag, SENTINEL_SRC_KEYCHAIN);
        assert_eq!(got, cipher);

        let encoded_local = encode_sentinel(SENTINEL_SRC_LOCAL, cipher);
        assert_eq!(parse_sentinel(&encoded_local), (SENTINEL_SRC_LOCAL, cipher));
    }

    /* 修复前写下的校验值没有前缀，必须按「归属不明」处理，不能当 keychain */
    #[test]
    fn legacy_sentinel_without_prefix_is_unknown_source() {
        let legacy = "AbCd+/=1234";
        assert_eq!(parse_sentinel(legacy), ("", legacy));
    }

    /* 前缀不认识时不能瞎猜：整串当密文，来源留空 */
    #[test]
    fn unknown_prefix_is_treated_as_bare_cipher() {
        let weird = "something:AbCd";
        assert_eq!(parse_sentinel(weird), ("", weird));
    }

    /*
     * 判定表。这是整个修复的核心 —— 尤其前两行：
     * 同样是「密文解不开」，来源不同，结论完全相反。
     */
    #[test]
    fn verdict_matrix() {
        assert_eq!(verdict_of(SENTINEL_SRC_KEYCHAIN, true), Verdict::Same);
        assert_eq!(verdict_of(SENTINEL_SRC_LOCAL, true), Verdict::Same);
        assert_eq!(verdict_of("", true), Verdict::Same);

        /* 真阳性：校验值是钥匙串里的密钥写的，现在解不开 -> 钥匙串被换过 */
        assert_eq!(verdict_of(SENTINEL_SRC_KEYCHAIN, false), Verdict::Changed);

        /* 假阳性必须被挡住：降级运行写的校验值，对当前钥匙串密钥没有发言权 */
        assert_eq!(verdict_of(SENTINEL_SRC_LOCAL, false), Verdict::Unknown);
        /* 修复前的历史值同样没有发言权 */
        assert_eq!(verdict_of("", false), Verdict::Unknown);
    }

    /* 收敛条件：三个条件缺一不可，任何一条不满足都必须保持沉默 */
    #[test]
    fn converge_requires_legacy_and_no_rival_key() {
        /* 无标记 + 有密文 + 本地无副本 -> 收敛 */
        assert!(should_converge_legacy("", true, false));
        /* 有标记（作者明确）-> 不收敛 */
        assert!(!should_converge_legacy(SENTINEL_SRC_KEYCHAIN, true, false));
        assert!(!should_converge_legacy(SENTINEL_SRC_LOCAL, true, false));
        /* 本地还留着兜底副本（历史上出现过第二把密钥）-> 不收敛，线索留着 */
        assert!(!should_converge_legacy("", true, true));
        /* 压根没有密文（读失败等）-> 不收敛 */
        assert!(!should_converge_legacy("", false, false));
    }

    /* 真阳性与假阳性在「来源」上必须是可区分的，否则这次修复没有意义 */
    #[test]
    fn changed_and_unknown_are_distinguishable() {
        assert_ne!(
            verdict_of(SENTINEL_SRC_KEYCHAIN, false),
            verdict_of(SENTINEL_SRC_LOCAL, false)
        );
    }
}
