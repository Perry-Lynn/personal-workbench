/*
 * 片段库 · 数据结构与纯逻辑
 * ------------------------------------------------------------------
 * 存「可以反复复用的一小段文本」：Maven 命令、jstack 命令、SQL、logback 配置、
 * 常用排查步骤……本质是一个本地的、带标签和搜索的剪贴板。
 *
 * 本文件只放数据结构和**纯函数**（不碰 sled、不碰 Tauri、不碰时钟），
 * 这样归一化与保存决策都能在 `cargo test` 里直接断言。
 * 存储读写见 storage.rs，IPC 见 commands.rs。
 *
 * 关于主密钥：**本模块不涉及**。片段是用户自己的代码/命令，不是凭据，
 * 明文落 sled（命名空间 snippets:items）即可 —— 与 jvm / maven 同口径。
 * 若将来真要存 token 类内容，不要在这里「顺手加密」，那会绕开工作台
 * 「主密钥只在用户触发时解析」的约定（见 core/master.rs），而应复用
 * balances 的凭证存储思路单独处理。
 * @Author: fu
 */
use serde::{Deserialize, Serialize};

use crate::core::text::truncate_chars;

/* 标题上限（按字符计，不是字节 —— 见 truncate_chars 的注释） */
pub const MAX_TITLE_CHARS: usize = 120;
/* 单个标签上限 */
pub const MAX_TAG_CHARS: usize = 24;
/* 一条片段最多挂几个标签 */
pub const MAX_TAGS: usize = 12;
/* 语言/类型标记上限 */
pub const MAX_LANG_CHARS: usize = 24;
/*
 * 正文体积上限。
 * 不是为了省空间，而是防止「把一整个文件粘进来当片段」——列表一次要加载全部片段，
 * 一条 10MB 的记录会让整个模块变卡，而用户并不知道自己做了什么。
 * 256KB 对「一小段文本」这个定位已经非常宽松。
 */
pub const MAX_BODY_BYTES: usize = 256 * 1024;

/* =============================================
   ====== 数据结构 ======
   ============================================= */

/* 一条片段。字段名经 serde camelCase 出去，与 src/features/snippets/types.ts 对应 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub title: String,
    pub body: String,
    /* 语言 / 类型标记（java / sql / bash / xml / text…），仅用于展示与图标，不参与语法高亮 */
    pub lang: Option<String>,
    pub tags: Vec<String>,
    pub pinned: bool,
    /* 以下时间戳都是 Unix 毫秒 */
    pub created_at: i64,
    pub updated_at: i64,
    pub used_at: Option<i64>,
    pub use_count: u64,
}

/* =============================================
   ====== 归一化 ======
   ============================================= */

/*
 * 按字符截断的实现已上收到 `core::text`（见那边的注释）。
 * 本文件顶部已 use，**不保留同名转发** —— 转发会让下一个人以为实现还在本地。
 */

/*
 * 标题归一：折叠所有空白（含换行、制表）为单个空格后 trim。
 * 用户在「新建」弹窗里按回车会把换行带进来，不折叠的话列表里会出现
 * 「看起来只有一行、实际标题里藏着换行」的卡片。
 */
pub fn normalize_title(raw: &str) -> String {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&collapsed, MAX_TITLE_CHARS)
}

/*
 * 标签归一。
 *
 * 这里**再次**按分隔符切分，而不是假定前端已经切好了：标签在界面上是一个输入框，
 * 用户会写 `maven, 命令`、也会写 `maven，命令`（中文逗号）、`maven 命令`。
 * 前端 format.ts 里有一份同样的纯逻辑（供输入时即时预览），后端这份是**数据侧的兜底** ——
 * 只要数据是从这条 IPC 进来的，落盘的标签就一定干净。
 *
 * 去重是**大小写不敏感**的，但保留第一次出现的写法（"SQL" 和 "sql" 视为同一个，
 * 显示成先输入的那个）。
 */
pub fn normalize_tags(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in raw {
        for piece in item.split(|c: char| c == ',' || c == '，' || c.is_whitespace()) {
            let tag = truncate_chars(piece.trim(), MAX_TAG_CHARS);
            if tag.is_empty() {
                continue;
            }
            if out.iter().any(|e| e.eq_ignore_ascii_case(&tag)) {
                continue;
            }
            out.push(tag);
            if out.len() >= MAX_TAGS {
                return out;
            }
        }
    }
    out
}

/* 语言标记归一：trim + 转小写 + 截断，空串归一为 None（避免出现 lang:"" 这种半空值） */
pub fn normalize_lang(raw: Option<&str>) -> Option<String> {
    let s = truncate_chars(raw?.trim(), MAX_LANG_CHARS).to_lowercase();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/* =============================================
   ====== 排序 ======
   ============================================= */

/*
 * 列表顺序：置顶优先 → 最近更新在前 → id 兜底。
 *
 * id 兜底不能省：updated_at 是毫秒时间戳，同一秒内连建两条会撞在同一毫秒上，
 * 没有兜底键时 sort_by 的稳定性虽然能保住插入顺序，但那个顺序来自 sled 的
 * 字节序遍历，不是用户预期 —— 加了 id 之后至少是**确定且可复现**的。
 */
pub fn sort_snippets(list: &mut [Snippet]) {
    list.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then(b.updated_at.cmp(&a.updated_at))
            .then(a.id.cmp(&b.id))
    });
}

/* =============================================
   ====== 保存决策 ======
   ============================================= */

/*
 * 算出「这次保存应该落盘什么」。
 *
 * 抽成纯函数是为了能测：commands.rs 里的那层只是取存储、调这里、写回。
 * 这里要守住的不变量：
 *   · 新建：id 由后端生成（前端给的空 id 不算数），计数从 0 开始
 *   · 编辑：**created_at / pinned / use_count 一律沿用旧值** —— 改个错别字不该
 *     把「创建时间」重置、也不该把「置顶」和「用过几次」抹掉
 *   · 两种情况 updated_at 都取 now（编辑时间就是现在）
 *   · 标题折叠后为空 → 报错（没有标题的片段在列表里无法辨认）
 */
pub fn build_saved(
    existing: Option<Snippet>,
    title: &str,
    body: &str,
    lang: Option<&str>,
    tags: &[String],
    now: i64,
) -> Result<Snippet, String> {
    let title = normalize_title(title);
    if title.is_empty() {
        return Err("标题不能为空".to_string());
    }
    if body.len() > MAX_BODY_BYTES {
        return Err(format!(
            "正文太大了（{} KB），上限 {} KB —— 片段库放的是「一小段」，整份文件请直接在编辑器里打开",
            body.len() / 1024,
            MAX_BODY_BYTES / 1024
        ));
    }

    let lang = normalize_lang(lang);
    let tags = normalize_tags(tags);

    Ok(match existing {
        Some(mut s) => {
            s.title = title;
            s.body = body.to_string();
            s.lang = lang;
            s.tags = tags;
            s.updated_at = now;
            s
        }
        None => Snippet {
            id: uuid::Uuid::new_v4().to_string(),
            title,
            body: body.to_string(),
            lang,
            tags,
            pinned: false,
            created_at: now,
            updated_at: now,
            used_at: None,
            use_count: 0,
        },
    })
}

/* =============================================
   ====== 单测 ======
   ============================================= */
#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, pinned: bool, updated_at: i64) -> Snippet {
        Snippet {
            id: id.to_string(),
            title: format!("t-{id}"),
            body: "b".to_string(),
            lang: None,
            tags: vec![],
            pinned,
            created_at: 1,
            updated_at,
            used_at: None,
            use_count: 0,
        }
    }

    /* ---- 截断 ---- */
    /* 断言已随实现上收到 core/text.rs，这里不再重复（避免两份同名断言各自腐烂） */

    /* ---- 标题 ---- */

    #[test]
    fn 标题折叠空白并去首尾空格() {
        assert_eq!(normalize_title("  a \n b\tc  "), "a b c");
    }

    #[test]
    fn 标题超长按字符截断() {
        let t = normalize_title(&"汉".repeat(200));
        assert_eq!(t.chars().count(), MAX_TITLE_CHARS);
    }

    #[test]
    fn 纯空白标题归一为空() {
        assert_eq!(normalize_title(" \n\t "), "");
    }

    /* ---- 标签 ---- */

    #[test]
    fn 标签按三种分隔符切开() {
        let out = normalize_tags(&["maven, 命令".to_string(), "sql，查询 索引".to_string()]);
        assert_eq!(out, vec!["maven", "命令", "sql", "查询", "索引"]);
    }

    #[test]
    fn 标签去空并去重() {
        let out = normalize_tags(&["a,,b".to_string(), "  ".to_string(), "a".to_string()]);
        assert_eq!(out, vec!["a", "b"]);
    }

    #[test]
    fn 标签去重忽略大小写但保留首次写法() {
        let out = normalize_tags(&["SQL".to_string(), "sql".to_string(), "Sql".to_string()]);
        assert_eq!(out, vec!["SQL"]);
    }

    #[test]
    fn 标签数量有上限() {
        let raw: Vec<String> = (0..40).map(|i| format!("t{i}")).collect();
        assert_eq!(normalize_tags(&raw).len(), MAX_TAGS);
    }

    #[test]
    fn 单个标签超长按字符截断() {
        let raw = vec!["汉".repeat(100)];
        let out = normalize_tags(&raw);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].chars().count(), MAX_TAG_CHARS);
    }

    #[test]
    fn 空标签输入得到空列表() {
        assert!(normalize_tags(&[]).is_empty());
        assert!(normalize_tags(&["".to_string()]).is_empty());
    }

    /* ---- 语言标记 ---- */

    #[test]
    fn 语言标记转小写并去空() {
        assert_eq!(normalize_lang(Some("  JAVA ")), Some("java".to_string()));
        assert_eq!(normalize_lang(Some("   ")), None);
        assert_eq!(normalize_lang(None), None);
    }

    #[test]
    fn 语言标记超长按字符截断() {
        let l = normalize_lang(Some(&"x".repeat(100))).unwrap();
        assert_eq!(l.chars().count(), MAX_LANG_CHARS);
    }

    /* ---- 排序 ---- */

    #[test]
    fn 置顶永远排最前() {
        let mut list = vec![
            sample("a", false, 100),
            sample("b", true, 1),
            sample("c", false, 999),
        ];
        sort_snippets(&mut list);
        assert_eq!(list[0].id, "b");
        /* 剩下按 updated_at 倒序 */
        assert_eq!(list[1].id, "c");
        assert_eq!(list[2].id, "a");
    }

    #[test]
    fn 同一毫秒按_id_定序_结果可复现() {
        let mut list = vec![sample("b", false, 5), sample("a", false, 5)];
        sort_snippets(&mut list);
        assert_eq!(list[0].id, "a");
        assert_eq!(list[1].id, "b");
    }

    /* ---- 保存决策 ---- */

    #[test]
    fn 新建时由后端生成_id_且计数归零() {
        let s = build_saved(None, "  我的命令 ", "mvn -v", Some("BASH"), &[], 1000).unwrap();
        assert!(!s.id.is_empty());
        assert_eq!(s.title, "我的命令");
        assert_eq!(s.lang, Some("bash".to_string()));
        assert!(!s.pinned);
        assert_eq!(s.use_count, 0);
        assert_eq!(s.used_at, None);
        assert_eq!(s.created_at, 1000);
        assert_eq!(s.updated_at, 1000);
    }

    #[test]
    fn 编辑沿用创建时间与使用统计() {
        let mut old = sample("keep", true, 111);
        old.created_at = 500;
        old.use_count = 7;
        old.used_at = Some(900);

        let s = build_saved(Some(old), "改过的标题", "新正文", None, &[], 2000).unwrap();
        assert_eq!(s.id, "keep");
        assert_eq!(s.title, "改过的标题");
        assert_eq!(s.body, "新正文");
        /* 这三项是「不该被编辑抹掉」的 */
        assert_eq!(s.created_at, 500);
        assert!(s.pinned);
        assert_eq!(s.use_count, 7);
        assert_eq!(s.used_at, Some(900));
        assert_eq!(s.updated_at, 2000);
    }

    #[test]
    fn 空标题被拒绝() {
        let err = build_saved(None, "   \n ", "body", None, &[], 1).unwrap_err();
        assert!(err.contains("标题"), "错误信息应说明是标题问题: {err}");
    }

    #[test]
    fn 正文超上限被拒绝() {
        let big = "x".repeat(MAX_BODY_BYTES + 1);
        let err = build_saved(None, "t", &big, None, &[], 1).unwrap_err();
        assert!(err.contains("正文"), "错误信息应说明是正文问题: {err}");
    }

    #[test]
    fn 正文刚好等于上限可以通过() {
        let body = "x".repeat(MAX_BODY_BYTES);
        assert!(build_saved(None, "t", &body, None, &[], 1).is_ok());
    }

    #[test]
    fn 保存时标签一并归一() {
        let s = build_saved(None, "t", "b", None, &["a, b".to_string(), "A".to_string()], 1).unwrap();
        assert_eq!(s.tags, vec!["a", "b"]);
    }
}
