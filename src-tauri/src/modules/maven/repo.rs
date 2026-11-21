/*
 * Maven 助手模块 · 本地仓库扫描
 * ------------------------------------------------------------------
 * 仓库的目录结构是 `<repo>/<group/用斜杠分隔>/<artifact>/<version>/<文件>`，
 * 例如 `com/fasterxml/jackson/core/jackson-databind/2.13.0/jackson-databind-2.13.0.jar`
 * 对应 group=com.fasterxml.jackson.core、artifact=jackson-databind、version=2.13.0。
 *
 * **怎么判断某个目录是「版本目录」**：看它的直接子文件里有没有 .jar 或 .pom。
 * 这是唯一可靠的信号 —— group 的层级深度是不固定的（有的两段、有的四段），
 * 靠数层数必然错。而版本目录下才会有实际的产物文件。
 *
 * 扫描只做一次目录遍历，聚合（排行 / 重复检测）是纯函数，在文件底部配单测。
 * @Author: fu
 */
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::modules::maven::models::{
    ArtifactVersion, DuplicateEntry, RepoStats, SizeEntry,
};

/** 排行 / 重复列表的条数上限：界面上一屏放得下的量，再多也没人翻 */
const TOP_GROUPS: usize = 15;
const TOP_ARTIFACTS: usize = 15;
const MAX_DUPLICATES: usize = 30;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/* =============================================
   ====== 遍历 ======
   ============================================= */

/** 递归统计一个目录下所有文件的大小，以及目录自身的最后修改时间 */
fn dir_bytes(dir: &Path) -> (u64, i64) {
    let mut bytes = 0u64;
    let mut mtime = 0i64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        if let Ok(meta) = fs::metadata(&d) {
            if let Ok(t) = meta.modified() {
                if let Ok(sec) = t.duration_since(UNIX_EPOCH) {
                    mtime = mtime.max(sec.as_secs() as i64);
                }
            }
        }
        let entries = match fs::read_dir(&d) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(m) = fs::metadata(&p) {
                bytes += m.len();
            }
        }
    }
    (bytes, mtime)
}

/**
 * 由版本目录反推坐标。
 *   版本目录 = <repo>/g1/g2/artifact/version
 * 于是 artifact 是父目录名，group 是再往上到仓库根的相对路径（斜杠换成点）。
 * 层级不够（直接在仓库根下就见到了 jar）时返回 None。
 */
fn coords_of(root: &Path, version_dir: &Path) -> Option<(String, String, String)> {
    let version = version_dir.file_name()?.to_string_lossy().to_string();
    let artifact_dir = version_dir.parent()?;
    let artifact = artifact_dir.file_name()?.to_string_lossy().to_string();
    let group_dir = artifact_dir.parent()?;
    let rel = group_dir.strip_prefix(root).ok()?;
    let group = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(".");
    if group.is_empty() || artifact.is_empty() || version.is_empty() {
        return None;
    }
    Some((group, artifact, version))
}

/** 递归收集所有版本目录 */
fn collect(root: &Path, dir: &Path, out: &mut Vec<ArtifactVersion>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut subdirs: Vec<std::path::PathBuf> = Vec::new();
    let mut is_version_dir = false;

    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            subdirs.push(p);
            continue;
        }
        if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
            if ext == "jar" || ext == "pom" {
                is_version_dir = true;
            }
        }
    }

    if is_version_dir {
        if let Some((group, artifact, version)) = coords_of(root, dir) {
            let (bytes, modified_at) = dir_bytes(dir);
            out.push(ArtifactVersion {
                is_snapshot: version.to_uppercase().contains("SNAPSHOT"),
                group,
                artifact,
                version,
                bytes,
                modified_at,
            });
        }
        /*
         * 版本目录下面不再往下找：正常仓库里它只放 jar / pom / sha1，
         * 继续递归既没意义又要多读几百个目录。
         */
        return;
    }

    for d in subdirs {
        collect(root, &d, out);
    }
}

/* =============================================
   ====== 聚合（纯函数） ======
   ============================================= */

/** 按 key 聚合体积，按体积降序取前 n */
fn rank(entries: BTreeMap<String, (u64, usize)>, n: usize) -> Vec<SizeEntry> {
    let mut list: Vec<SizeEntry> = entries
        .into_iter()
        .map(|(key, (bytes, count))| SizeEntry { key, bytes, count })
        .collect();
    /* 体积相同时按 key 排序，保证每次扫描结果顺序稳定（界面不会乱跳） */
    list.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.key.cmp(&b.key)));
    list.truncate(n);
    list
}

pub fn top_groups(versions: &[ArtifactVersion], n: usize) -> Vec<SizeEntry> {
    let mut map: BTreeMap<String, (u64, std::collections::HashSet<String>)> = BTreeMap::new();
    for v in versions {
        let e = map.entry(v.group.clone()).or_default();
        e.0 += v.bytes;
        e.1.insert(format!("{}:{}", v.group, v.artifact));
    }
    rank(
        map.into_iter()
            .map(|(k, (bytes, set))| (k, (bytes, set.len())))
            .collect(),
        n,
    )
}

pub fn top_artifacts(versions: &[ArtifactVersion], n: usize) -> Vec<SizeEntry> {
    let mut map: BTreeMap<String, (u64, usize)> = BTreeMap::new();
    for v in versions {
        let key = format!("{}:{}", v.group, v.artifact);
        let e = map.entry(key).or_default();
        e.0 += v.bytes;
        e.1 += 1;
    }
    rank(map, n)
}

/**
 * 找出存了多个版本的 artifact —— 清理仓库的主要目标。
 *
 * 只统计**真的有多版本**的：一个 artifact 存 3 个版本，其中 2 个是别的依赖要求的
 * 旧版本、1 个是 SNAPSHOT 反复覆盖留下的，这些正是「几十 G 是谁」的答案。
 * 按占用降序，因为用户要的是「先删哪个最划算」。
 */
pub fn duplicates(versions: &[ArtifactVersion], n: usize) -> Vec<DuplicateEntry> {
    /* (group, artifact, versions, 总字节, 最大单版本字节, SNAPSHOT 数) */
    type Acc = (String, String, Vec<String>, u64, u64, usize);
    let mut map: BTreeMap<String, Acc> = BTreeMap::new();
    for v in versions {
        let key = format!("{}:{}", v.group, v.artifact);
        let e: &mut Acc = map.entry(key).or_insert_with(|| {
            (v.group.clone(), v.artifact.clone(), Vec::new(), 0u64, 0u64, 0usize)
        });
        e.2.push(v.version.clone());
        e.3 += v.bytes;
        /* 保留最大的单版本：它就是「清理时该留下的那个」的体积 */
        e.4 = e.4.max(v.bytes);
        if v.is_snapshot {
            e.5 += 1;
        }
    }

    let mut list: Vec<DuplicateEntry> = map
        .into_values()
        .filter(|(_, _, vs, _, _, _)| vs.len() > 1)
        .map(|(group, artifact, versions, bytes, largest_bytes, snapshot_count)| {
            DuplicateEntry {
                group,
                artifact,
                versions,
                bytes,
                largest_bytes,
                snapshot_count,
            }
        })
        .collect();

    list.sort_by(|a, b| {
        b.bytes
            .cmp(&a.bytes)
            .then_with(|| a.artifact.cmp(&b.artifact))
            .then_with(|| a.group.cmp(&b.group))
    });
    /* 版本列表内部也排一下，界面上看起来才稳定 */
    for d in list.iter_mut() {
        d.versions.sort();
    }
    list.truncate(n);
    list
}

/* =============================================
   ====== 入口 ======
   ============================================= */

pub fn scan_repo(repo: &Path) -> RepoStats {
    let started = std::time::Instant::now();
    let mut versions: Vec<ArtifactVersion> = Vec::new();
    collect(repo, repo, &mut versions);

    let total_bytes = versions.iter().map(|v| v.bytes).sum();
    let key = |v: &ArtifactVersion| format!("{}:{}", v.group, v.artifact);
    let artifact_count = versions.iter().map(key).collect::<std::collections::HashSet<_>>().len();
    let snapshot_count = versions.iter().filter(|v| v.is_snapshot).count();

    RepoStats {
        repo_path: repo.to_string_lossy().to_string(),
        total_bytes,
        artifact_count,
        version_count: versions.len(),
        snapshot_count,
        top_groups: top_groups(&versions, TOP_GROUPS),
        top_artifacts: top_artifacts(&versions, TOP_ARTIFACTS),
        duplicates: duplicates(&versions, MAX_DUPLICATES),
        scanned_at: now_secs(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(group: &str, artifact: &str, version: &str, bytes: u64) -> ArtifactVersion {
        ArtifactVersion {
            group: group.into(),
            artifact: artifact.into(),
            version: version.into(),
            bytes,
            modified_at: 0,
            is_snapshot: version.to_uppercase().contains("SNAPSHOT"),
        }
    }

    #[test]
    fn 按_group_聚合并排序() {
        let list = vec![
            v("com.a", "x", "1", 100),
            v("com.a", "y", "1", 200),
            v("org.b", "z", "1", 500),
        ];
        let top = top_groups(&list, 10);
        assert_eq!(top[0].key, "org.b");
        assert_eq!(top[0].bytes, 500);
        /* count 是 artifact 数，不是版本数 */
        assert_eq!(top[1].key, "com.a");
        assert_eq!(top[1].count, 2);
    }

    #[test]
    fn 同一_artifact_的多个版本按_group_只算一个() {
        let list = vec![v("com.a", "x", "1", 100), v("com.a", "x", "2", 100)];
        let top = top_groups(&list, 10);
        assert_eq!(top.len(), 1);
        assert_eq!(top[0].count, 1);
    }

    #[test]
    fn 按_artifact_聚合_count_是版本数() {
        let list = vec![
            v("com.a", "x", "1", 100),
            v("com.a", "x", "2", 150),
            v("com.a", "y", "1", 400),
        ];
        let top = top_artifacts(&list, 10);
        assert_eq!(top[0].key, "com.a:y");
        assert_eq!(top[0].bytes, 400);
        assert_eq!(top[1].key, "com.a:x");
        assert_eq!(top[1].bytes, 250);
        assert_eq!(top[1].count, 2);
    }

    #[test]
    fn 只统计真的有多个版本的_artifact() {
        let list = vec![
            v("com.a", "x", "1", 100),
            v("com.a", "y", "1", 900),
            v("com.a", "y", "2", 100),
        ];
        let dups = duplicates(&list, 10);
        assert_eq!(dups.len(), 1);
        assert_eq!(dups[0].artifact, "y");
        assert_eq!(dups[0].versions, vec!["1".to_string(), "2".to_string()]);
        assert_eq!(dups[0].bytes, 1000);
    }

    /*
     * 「能释放多少」= bytes - largest_bytes。
     * 若按版本数平分去估，一个体积悬殊的 SNAPSHOT 会把结果带偏一大截
     * （这里是 10，平分会算出 455）。
     */
    #[test]
    fn 记录最大单版本以便算可释放空间() {
        let list = vec![v("com.a", "x", "1", 10), v("com.a", "x", "2-SNAPSHOT", 900)];
        let dups = duplicates(&list, 10);
        assert_eq!(dups[0].bytes, 910);
        assert_eq!(dups[0].largest_bytes, 900);
        assert_eq!(dups[0].bytes - dups[0].largest_bytes, 10);
    }

    #[test]
    fn 重复项按占用降序() {
        let list = vec![
            v("com.a", "small", "1", 10),
            v("com.a", "small", "2", 10),
            v("com.a", "big", "1", 900),
            v("com.a", "big", "2", 900),
        ];
        let dups = duplicates(&list, 10);
        assert_eq!(dups[0].artifact, "big");
        assert_eq!(dups[1].artifact, "small");
    }

    #[test]
    fn SNAPSHOT_计数() {
        let list = vec![
            v("com.a", "x", "1.0-SNAPSHOT", 10),
            v("com.a", "x", "1.0", 10),
        ];
        let dups = duplicates(&list, 10);
        assert_eq!(dups[0].snapshot_count, 1);
    }

    #[test]
    fn 输出条数受上限约束() {
        let list: Vec<ArtifactVersion> = (0..40)
            .map(|i| v(&format!("com.g{i}"), "x", "1", 100 - i as u64))
            .collect();
        assert_eq!(top_groups(&list, 15).len(), 15);
        assert_eq!(top_artifacts(&list, 15).len(), 15);
    }

    #[test]
    fn 空输入不炸() {
        assert!(top_groups(&[], 10).is_empty());
        assert!(top_artifacts(&[], 10).is_empty());
        assert!(duplicates(&[], 10).is_empty());
    }

    /*
     * 坐标反推是最容易写错的一格：group 的层数不固定，
     * 必须「版本目录往上两级」而不是「数到第三层」。
     */
    #[test]
    fn 坐标反推支持任意层数的_group() {
        let root = Path::new("/repo");
        let four = Path::new("/repo/com/fasterxml/jackson/core/jackson-databind/2.13.0");
        let (g, a, ver) = coords_of(root, four).unwrap();
        assert_eq!(g, "com.fasterxml.jackson.core");
        assert_eq!(a, "jackson-databind");
        assert_eq!(ver, "2.13.0");

        let two = Path::new("/repo/junit/junit/4.13.2");
        let (g2, a2, _v2) = coords_of(root, two).unwrap();
        assert_eq!(g2, "junit");
        assert_eq!(a2, "junit");
    }

    #[test]
    fn 层级不足时不产生坐标() {
        let root = Path::new("/repo");
        /* 直接在仓库根下就见到了产物文件 —— 不该当成某个 artifact */
        assert!(coords_of(root, Path::new("/repo/weird")).is_none());
    }
}
