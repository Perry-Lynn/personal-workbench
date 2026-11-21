/*
 * 工作台核心 · 文本工具
 * ------------------------------------------------------------------
 * 上收自 modules/snippets/models.rs，按本仓「第二个模块要用就上收」的约定搬过来，
 * 免得各模块各留一份、慢慢演化出不同口径。
 *
 * 这里只有纯函数，不碰 sled / Tauri / 网络 / 时钟。
 * @Author: fu
 */

/*
 * 按**字符**截断。
 *
 * 必须按字符：Rust 的 &str 按字节切片，`&s[..max]` 落在多字节字符中间会直接 panic，
 * 而中文在 UTF-8 里占 3 字节 —— 一个 120 字节的标题只够 40 个汉字。
 *
 * ⚠️ 与前端 `core/text.ts` 的 `truncateStrict` 是**同一口径**（截到 n 个字符、不加省略号）。
 * 两边必须一致：界面按 120 个字符显示、后端却按 121 存，落盘时就会把最后一个字符吃掉，
 * 而且只在超长时才出现（snippets 踩过这个坑，见技能「坑 20」）。
 */
pub fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 短文本不截断() {
        assert_eq!(truncate_chars("abc", 5), "abc");
        assert_eq!(truncate_chars("abc", 3), "abc");
    }

    #[test]
    fn 按字符截断不会切出半个汉字() {
        /* 6 个汉字限 3 个 —— 按字节切会 panic，按字符切得到 3 个汉字 */
        let s = "你好世界测试";
        assert_eq!(truncate_chars(s, 3), "你好世");
        assert_eq!(truncate_chars(s, 3).chars().count(), 3);
    }

    #[test]
    fn 超长英文按字符截断() {
        assert_eq!(truncate_chars("abcdefgh", 4), "abcd");
    }

    #[test]
    fn 截断结果长度恰好等于上限() {
        let s = "汉".repeat(300);
        assert_eq!(truncate_chars(&s, 120).chars().count(), 120);
    }

    #[test]
    fn 空串与零长度() {
        assert_eq!(truncate_chars("", 5), "");
        assert_eq!(truncate_chars("abc", 0), "");
    }
}
