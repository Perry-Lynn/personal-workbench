/*
 * 工作台核心 · 时间
 * ------------------------------------------------------------------
 * `now_ms` 原先在 snippets/commands.rs、jarrunner/commands.rs、jarrunner/runner.rs
 * 各有一份，实现逐字相同。三份重复意味着「哪天要改时钟口径得记得改三处」，
 * 而漏改一处不会有任何报错 —— 只是那个模块的时间戳口径悄悄和别人不一样。
 * 上收到这里，只留一份。
 *
 * 这里除读系统时钟外没有副作用，不碰 sled / Tauri / 网络。
 * @Author: fu
 */
use std::time::{SystemTime, UNIX_EPOCH};

/*
 * 当前 Unix 毫秒。
 *
 * 系统时钟早于 1970（或被回拨到那个区间）时退化为 0，**不 panic** ——
 * 时间戳为 0 只是排序难看，让整个保存流程失败要糟得多。
 */
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 返回的是合理的毫秒时间戳() {
        /* 只钉住量级（2020-01-01 ~ 2100-01-01），不钉具体值 —— 钉死了会变成时间炸弹 */
        let t = now_ms();
        assert!(t > 1_577_836_800_000, "时间戳应晚于 2020-01-01，实际 {t}");
        assert!(t < 4_102_444_800_000, "时间戳应早于 2100-01-01，实际 {t}");
    }

    #[test]
    fn 连续两次调用单调不减() {
        let a = now_ms();
        let b = now_ms();
        assert!(b >= a, "时钟不应倒退：{a} -> {b}");
    }
}
