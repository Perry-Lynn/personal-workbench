/*
 * Maven 助手模块 · 依赖树解析
 * ------------------------------------------------------------------
 * 跑 `mvn dependency:tree -Dverbose` 并把它解析成结构化数据。
 *
 * 为什么必须用 -Dverbose：不加它的话 Maven **只打印胜出的版本**，
 * 被仲裁掉的那个根本不出现 —— 于是「有冲突」这件事本身都看不见。
 * 加了之后输家会写成 `(g:a:jar:1.0:compile - omitted for conflict with 2.0)`，
 * 「谁赢了」也只在这个短语里写着（1.0 是输家自己的版本，2.0 才是赢家）。
 *
 * 解析是纯函数，输入录好的样本字符串，在文件底部配单测 ——
 * 真机跑一次 mvn 要几十秒，靠手动点界面验证这些边界不现实。
 * @Author: fu
 */
use std::path::Path;
use std::time::Duration;

use crate::modules::maven::models::{Conflict, DepLine, OmitReason, TreeResult};

/** mvn 一次构建可能要几十秒（首次还会下载插件），给足 120 秒 */
pub const TREE_TIMEOUT: Duration = Duration::from_secs(120);

/* =============================================
   ====== 解析一行 ======
   ============================================= */

/**
 * 剥掉树线前缀，返回 (深度, 剩余内容)。
 *
 * Maven 的树线由固定 3 字符的片段拼成：
 *   `+- ` 有兄弟节点、`\- ` 最后一个、`|  ` 与 `   ` 是上一层的延续
 * 每剥掉一个片段就是往下走一层。用数空格或数字符个数来判断深度都不行 ——
 * 层数一多（十几个片段）就会算错。
 */
pub fn strip_tree_prefix(s: &str) -> (usize, &str) {
    let mut rest = s;
    let mut depth = 0usize;
    loop {
        if rest.starts_with("+- ") || rest.starts_with("\\- ") {
            depth += 1;
            rest = &rest[3..];
        } else if rest.starts_with("|  ") || rest.starts_with("   ") {
            depth += 1;
            rest = &rest[3..];
        } else {
            break;
        }
    }
    (depth, rest)
}

/**
 * 从坐标串里拆出 (group, artifact, packaging, version, scope)。
 *
 * 长度可能是 5 段也可能 6 段 —— 有 classifier 时会多一段
 * （`g:a:jar:tests:1.0:test`）。写死取第 4 段做版本的话，
 * 带 classifier 的依赖会把它自己的 classifier 当成版本号显示出来。
 */
pub fn split_coords(s: &str) -> Option<(String, String, String, String, String)> {
    let parts: Vec<&str> = s.split(':').collect();
    match parts.len() {
        5 => Some((
            parts[0].into(),
            parts[1].into(),
            parts[2].into(),
            parts[3].into(),
            parts[4].into(),
        )),
        6 => Some((
            parts[0].into(),
            parts[1].into(),
            parts[2].into(),
            /* 6 段时第 4 段是 classifier，版本和 scope 各往后挪一位 */
            parts[4].into(),
            parts[5].into(),
        )),
        _ => None,
    }
}

/** 从 "omitted for conflict with 2.0" 这类说明里取出原因与赢家版本 */
pub fn parse_omit_note(note: &str) -> (OmitReason, Option<String>) {
    let lower = note.to_lowercase();
    if let Some(idx) = lower.find("omitted for conflict with") {
        let winner = note[idx + "omitted for conflict with".len()..]
            .trim()
            .split_whitespace()
            .next()
            .unwrap_or("")
            /* 说明后面可能还跟着 ")" 或其它文字，只取第一段并去掉括号 */
            .trim_end_matches([')', ',', ';'])
            .to_string();
        return (OmitReason::Conflict, Some(winner));
    }
    if lower.contains("omitted for duplicate") {
        return (OmitReason::Duplicate, None);
    }
    /* "version managed from 2.0" 不是被丢弃，只是版本被 dependencyManagement 改了 */
    if lower.contains("version managed from") {
        return (OmitReason::Managed, None);
    }
    if lower.contains("excluded") {
        return (OmitReason::Excluded, None);
    }
    (OmitReason::Other, None)
}

/** 解析 mvn 输出的一行（带 `[INFO] ` 前缀） */
pub fn parse_tree_line(line: &str) -> Option<DepLine> {
    let line = line.trim_end();
    let rest = line.strip_prefix("[INFO] ")?;

    let (depth, rest) = strip_tree_prefix(rest);

    /*
     * 被丢弃的那一条会整体包在括号里：
     *   (g:a:jar:1.0:compile - omitted for conflict with 2.0)
     * 括号是**成对**的，但说明文字里也可能出现括号（比如 "(version managed from 2.0)"），
     * 所以只削掉首尾那一对，中间的原样保留给 note 解析。
     */
    let (is_omitted, body) = if rest.starts_with('(') && rest.ends_with(')') {
        (true, &rest[1..rest.len() - 1])
    } else {
        (false, rest)
    };

    /* 坐标与说明用 " - " 分隔 */
    let (coord_part, note) = match body.find(" - ") {
        Some(i) => (&body[..i], Some(body[i + 3..].trim())),
        None => (body, None),
    };

    let (group, artifact, packaging, version, scope) = split_coords(coord_part.trim())?;
    if group.is_empty() || artifact.is_empty() {
        return None;
    }

    let (omit_reason, conflict_with) = match (is_omitted, note) {
        (true, Some(n)) => {
            let (r, w) = parse_omit_note(n);
            (Some(r), w)
        }
        (true, None) => (Some(OmitReason::Other), None),
        (false, _) => (None, None),
    };

    Some(DepLine {
        depth,
        group,
        artifact,
        version,
        packaging,
        scope,
        omit_reason,
        conflict_with,
    })
}

/* =============================================
   ====== 冲突汇总 ======
   ============================================= */

/**
 * 把「输家行」汇总成一份冲突清单。
 *
 * 赢家来自输家那行的 `omitted for conflict with X` —— 依赖树里
 * **不会有另一行写着「这个版本赢了」**，所以只能从这里取；
 * 取不到（说明文字格式变了）就干脆不报，免得编一个假的赢家出来。
 *
 * 同一个包可能被仲裁掉多个版本（菱形依赖很常见），所以 losers 是数组；
 * 同一个版本在多处被丢弃也只记一次。
 */
pub fn collect_conflicts(lines: &[DepLine]) -> Vec<Conflict> {
    let mut map: Vec<Conflict> = Vec::new();
    for l in lines {
        if l.omit_reason != Some(OmitReason::Conflict) {
            continue;
        }
        let winner = match &l.conflict_with {
            Some(w) if !w.is_empty() => w.clone(),
            _ => continue,
        };
        let key = format!("{}:{}", l.group, l.artifact);
        if let Some(c) = map.iter_mut().find(|c| format!("{}:{}", c.group, c.artifact) == key) {
            /* 赢家以第一个看到的为准；同一个包不该有两个赢家 */
            if !c.losers.contains(&l.version) {
                c.losers.push(l.version.clone());
            }
        } else {
            map.push(Conflict {
                group: l.group.clone(),
                artifact: l.artifact.clone(),
                winner,
                losers: vec![l.version.clone()],
            });
        }
    }
    map.sort_by(|a, b| {
        let ka = format!("{}:{}", a.group, a.artifact);
        let kb = format!("{}:{}", b.group, b.artifact);
        ka.cmp(&kb)
    });
    map
}

/* =============================================
   ====== 执行 ======
   ============================================= */

/**
 * 在项目目录下跑 mvn。
 *
 * **必须传 cwd**：mvn 要在项目目录里才能找到 pom.xml，而且 Maven Wrapper
 * （./mvnw）依赖当前目录下的 .mvn/wrapper 配置。传 -f 只解决了 pom 的位置，
 * 解决不了这些，所以两者都给。
 */
pub fn run_mvn_in(
    mvn: &Path,
    project_dir: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    crate::core::proc::run_timeout_in(
        &mvn.to_string_lossy(),
        args,
        timeout,
        Some(Path::new(project_dir)),
    )
}

/**
 * 跑一次 dependency:tree。
 *
 * `offline`（-o）默认开：不带它时 Maven 会去仓库检查 SNAPSHOT 与插件更新，
 * 一次几十秒到几分钟，而分析依赖树要的只是「已经解析好的结果」。
 * 离线失败的典型原因是本地缺依赖，这时由调用方提示用户关掉离线重试。
 */
pub fn run_tree(mvn: &Path, project_dir: &str, offline: bool) -> Result<TreeResult, String> {
    let started = std::time::Instant::now();
    let mut args: Vec<String> = Vec::new();
    if offline {
        args.push("-o".into());
    }
    args.push("-f".into());
    args.push("pom.xml".into());
    args.push("dependency:tree".into());
    args.push("-Dverbose".into());

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    let out = run_mvn_in(mvn, project_dir, &arg_refs, TREE_TIMEOUT)?;

    let mut lines: Vec<DepLine> = Vec::new();
    let mut root = String::new();
    for line in out.lines() {
        if let Some(dep) = parse_tree_line(line) {
            if dep.depth == 0 && root.is_empty() {
                root = format!("{}:{}:{}", dep.group, dep.artifact, dep.version);
            }
            lines.push(dep);
        }
    }

    let conflicts = collect_conflicts(&lines);

    /*
     * 一条都解析不出来时基本可以断定失败了（mvn 报错 / 没跑起来）。
     * 这时返回原始输出让界面显示，比默默给一个空树好 —— 用户至少能看到 mvn 说了什么。
     */
    let mut warnings: Vec<String> = Vec::new();
    if lines.is_empty() {
        warnings.push("没能从 mvn 输出里解析出依赖树，请看「原始输出」确认 mvn 是否报错。".into());
    }
    if out.contains("The following artifacts could not be resolved") {
        warnings.push("本地缺少部分依赖（离线模式下常见），可关掉「离线」重试。".into());
    }

    Ok(TreeResult {
        root,
        lines,
        conflicts,
        raw: out,
        elapsed_ms: started.elapsed().as_millis() as u64,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 剥树线前缀算对深度() {
        assert_eq!(strip_tree_prefix("com.a:b:jar:1:compile"), (0, "com.a:b:jar:1:compile"));
        assert_eq!(strip_tree_prefix("+- a:b:jar:1:compile"), (1, "a:b:jar:1:compile"));
        assert_eq!(strip_tree_prefix("|  +- a:b:jar:1:compile"), (2, "a:b:jar:1:compile"));
        assert_eq!(strip_tree_prefix("|  |  \\- a:b:jar:1:compile"), (3, "a:b:jar:1:compile"));
    }

    #[test]
    fn 坐标五段与六段都要拆对() {
        let (g, a, p, v, s) = split_coords("org.slf4j:slf4j-api:jar:1.7.36:compile").unwrap();
        assert_eq!((g.as_str(), a.as_str(), p.as_str(), v.as_str(), s.as_str()),
                   ("org.slf4j", "slf4j-api", "jar", "1.7.36", "compile"));
        /* 六段：多出来的是 classifier，版本必须取第 5 段 */
        let (_g, _a, _p, v2, s2) = split_coords("org.junit:junit5:jar:tests:1.0:test").unwrap();
        assert_eq!(v2, "1.0");
        assert_eq!(s2, "test");
    }

    #[test]
    fn 段数不对返回_None() {
        assert!(split_coords("a:b:jar").is_none());
        assert!(split_coords("a:b:jar:1:compile:extra:more").is_none());
    }

    #[test]
    fn 冲突说明能取出赢家() {
        let (r, w) = parse_omit_note("omitted for conflict with 2.0");
        assert_eq!(r, OmitReason::Conflict);
        assert_eq!(w, Some("2.0".into()));
    }

    /*
     * 括号里带右括号的情况：整行是
     *   (a:b:jar:1.0:compile - omitted for conflict with 2.0)
     * 如果按「最后一个右括号」切，会把赢家版本里的括号也吃进去。
     * parse_tree_line 只削首尾一对，所以这里拿到的是干净的 "2.0"。
     */
    #[test]
    fn 赢家版本不带多余的右括号() {
        let line = "[INFO] |  +- (org.a:b:jar:1.0:compile - omitted for conflict with 2.0)";
        let d = parse_tree_line(line).unwrap();
        assert_eq!(d.conflict_with, Some("2.0".into()));
        assert_eq!(d.version, "1.0");
    }

    #[test]
    fn 重复与管理版本的判定() {
        let (r1, _) = parse_omit_note("omitted for duplicate");
        assert_eq!(r1, OmitReason::Duplicate);
        let (r2, _) = parse_omit_note("version managed from 2.0; omitted for duplicate");
        /* 同时出现时优先按 duplicate 记（它才是「这条没被引入」的原因） */
        assert_eq!(r2, OmitReason::Duplicate);
        let (r3, _) = parse_omit_note("excluded for conflict");
        assert_eq!(r3, OmitReason::Excluded);
    }

    #[test]
    fn 正常行没有_omit() {
        let d = parse_tree_line("[INFO] +- org.slf4j:slf4j-api:jar:1.7.36:compile").unwrap();
        assert_eq!(d.depth, 1);
        assert_eq!(d.group, "org.slf4j");
        assert_eq!(d.version, "1.7.36");
        assert_eq!(d.scope, "compile");
        assert_eq!(d.omit_reason, None);
    }

    #[test]
    fn 非依赖行被忽略() {
        assert!(parse_tree_line("[INFO] Scanning for projects...").is_none());
        assert!(parse_tree_line("[INFO] BUILD SUCCESS").is_none());
        assert!(parse_tree_line("[INFO]").is_none());
        assert!(parse_tree_line("").is_none());
    }

    #[test]
    fn 冲突汇总去重且赢家只记一次() {
        let lines = vec![
            DepLine {
                depth: 2,
                group: "org.a".into(),
                artifact: "b".into(),
                version: "1.0".into(),
                packaging: "jar".into(),
                scope: "compile".into(),
                omit_reason: Some(OmitReason::Conflict),
                conflict_with: Some("2.0".into()),
            },
            /* 同一个版本在别处又被丢弃一次 —— 不能重复记 */
            DepLine {
                depth: 3,
                group: "org.a".into(),
                artifact: "b".into(),
                version: "1.0".into(),
                packaging: "jar".into(),
                scope: "compile".into(),
                omit_reason: Some(OmitReason::Conflict),
                conflict_with: Some("2.0".into()),
            },
            /* 同一个包还有个 1.5 也输了 */
            DepLine {
                depth: 2,
                group: "org.a".into(),
                artifact: "b".into(),
                version: "1.5".into(),
                packaging: "jar".into(),
                scope: "compile".into(),
                omit_reason: Some(OmitReason::Conflict),
                conflict_with: Some("2.0".into()),
            },
        ];
        let cs = collect_conflicts(&lines);
        assert_eq!(cs.len(), 1);
        assert_eq!(cs[0].winner, "2.0");
        assert_eq!(cs[0].losers, vec!["1.0".to_string(), "1.5".to_string()]);
    }

    #[test]
    fn 取不到赢家时不编造冲突() {
        let lines = vec![DepLine {
            depth: 1,
            group: "org.a".into(),
            artifact: "b".into(),
            version: "1.0".into(),
            packaging: "jar".into(),
            scope: "compile".into(),
            omit_reason: Some(OmitReason::Conflict),
            conflict_with: None,
        }];
        assert!(collect_conflicts(&lines).is_empty());
    }

    #[test]
    fn 重复丢弃不算冲突() {
        let lines = vec![DepLine {
            depth: 1,
            group: "org.a".into(),
            artifact: "b".into(),
            version: "1.0".into(),
            packaging: "jar".into(),
            scope: "compile".into(),
            omit_reason: Some(OmitReason::Duplicate),
            conflict_with: None,
        }];
        assert!(collect_conflicts(&lines).is_empty());
    }
}
