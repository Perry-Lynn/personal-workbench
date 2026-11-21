/*
 * Maven 助手模块 · 定位 mvn 与本地仓库
 * ------------------------------------------------------------------
 * 和 JDK 完全同一个坑：从 Dock 启动的 GUI 应用 PATH 里没有 sdkman，
 * 直接 spawn("mvn") 必然失败 —— 表现是「点了分析什么都没发生」。
 * 所以 mvn 一律按候选路径逐个试，找到第一个存在的就用。
 *
 * 优先级：**项目自带的 ./mvnw 最高**。
 *   Maven Wrapper 存在的意义就是「这个项目要用这个版本的 Maven」，
 *   用全局的 mvn 去分析它，遇到版本差异会解析出不同的结果。
 *
 * 本地仓库路径默认 ~/.m2/repository，但可以被 ~/.m2/settings.xml 的
 * <localRepository> 改掉 —— 有人会把仓库放到别的大盘上，读不到就白扫。
 * @Author: fu
 */
use std::fs;
use std::path::{Path, PathBuf};

use crate::modules::maven::models::{MavenInfo, MavenSource};

fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

/* =============================================
   ====== 找 mvn ======
   ============================================= */

/** 候选的 mvn 路径（按优先级） */
fn candidates(project_dir: Option<&str>) -> Vec<(PathBuf, MavenSource)> {
    let mut out = Vec::new();

    /* 1. 项目自带的 Maven Wrapper —— 版本与项目一致，最可信 */
    if let Some(dir) = project_dir {
        let mvnw = Path::new(dir).join("mvnw");
        if mvnw.exists() {
            out.push((mvnw, MavenSource::Wrapper));
        }
    }

    /* 2. sdkman 的 current（本机的主力） */
    if let Some(h) = home_dir() {
        let p = h.join(".sdkman").join("candidates").join("maven").join("current").join("bin").join("mvn");
        out.push((p, MavenSource::Sdkman));
    }

    /* 3. Homebrew / 手动安装 */
    out.push((PathBuf::from("/opt/homebrew/bin/mvn"), MavenSource::Brew));
    out.push((PathBuf::from("/usr/local/bin/mvn"), MavenSource::System));
    out.push((PathBuf::from("/opt/local/bin/mvn"), MavenSource::System));

    out
}

/**
 * 从 `mvn -v` 的第一行取版本号。
 * 输出形如：`Apache Maven 3.9.6 (bc0240f3c744dd6b6ec2920b3cd08dcc295161ae)`
 * 只取 "Apache Maven " 之后到第一个空格为止。
 */
pub fn parse_mvn_version(out: &str) -> String {
    for line in out.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Apache Maven ") {
            let v = rest.split_whitespace().next().unwrap_or("");
            if !v.is_empty() {
                return v.to_string();
            }
        }
    }
    /* 有的发行版不写 "Apache Maven" 前缀，退回「第一个像版本号的 token」 */
    for line in out.lines() {
        for tok in line.split_whitespace() {
            if tok.chars().next().is_some_and(|c| c.is_ascii_digit()) && tok.contains('.') {
                return tok.to_string();
            }
        }
    }
    String::new()
}

/* =============================================
   ====== 找本地仓库 ======
   ============================================= */

/**
 * 从 settings.xml 里读 <localRepository>。
 *
 * 注释块要先去掉：默认的 settings.xml 里 `<localRepository>` 那一行
 * **是被注释掉的示例**，不去注释会把它当成真实配置，扫到一个不存在的路径。
 */
pub fn parse_local_repository(xml: &str) -> Option<String> {
    let re = regex::Regex::new(r"(?s)<!--.*?-->").ok()?;
    let cleaned = re.replace_all(xml, "");
    let start = cleaned.find("<localRepository>")?;
    let rest = &cleaned[start + "<localRepository>".len()..];
    let end = rest.find("</localRepository>")?;
    let v = rest[..end].trim();
    if v.is_empty() {
        return None;
    }
    /* Maven 支持 ${user.home} 这类占位符，至少要能展开这一个 */
    let expanded = if let Some(h) = home_dir() {
        v.replace("${user.home}", &h.to_string_lossy())
    } else {
        v.to_string()
    };
    Some(expanded)
}

/** 本地仓库路径：settings.xml 指定优先，否则 ~/.m2/repository */
pub fn repo_path() -> PathBuf {
    if let Some(h) = home_dir() {
        let settings = h.join(".m2").join("settings.xml");
        if let Ok(s) = fs::read_to_string(&settings) {
            if let Some(p) = parse_local_repository(&s) {
                return PathBuf::from(p);
            }
        }
        return h.join(".m2").join("repository");
    }
    PathBuf::from(".m2/repository")
}

/* =============================================
   ====== 汇总 ======
   ============================================= */

/** 探测 mvn 与本地仓库。project_dir 用于优先采用项目自带的 mvnw */
pub fn locate(project_dir: Option<&str>) -> MavenInfo {
    let repo = repo_path();
    let repo_exists = repo.exists();

    for (path, source) in candidates(project_dir) {
        if !path.exists() {
            continue;
        }
        /*
         * 跑一次 `mvn -v` 有两个作用：确认它真的能执行，以及拿到版本号。
         * 扫目录只证明文件存在 —— sdkman 的 current 指向已卸载版本时会留下死链。
         */
        let version = match crate::modules::jvm::sys::run_timeout(
            &path.to_string_lossy(),
            &["-v"],
            std::time::Duration::from_secs(20),
        ) {
            Ok(out) => parse_mvn_version(&out),
            Err(_) => continue,
        };
        return MavenInfo {
            found: true,
            path: path.to_string_lossy().to_string(),
            version,
            source: Some(source),
            repo_path: repo.to_string_lossy().to_string(),
            repo_exists,
        };
    }

    MavenInfo {
        found: false,
        path: String::new(),
        version: String::new(),
        source: None,
        repo_path: repo.to_string_lossy().to_string(),
        repo_exists,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解析_mvn_版本() {
        let out = "Apache Maven 3.9.6 (bc0240f3c744dd6b6ec2920b3cd08dcc295161ae)\nMaven home: /x\n";
        assert_eq!(parse_mvn_version(out), "3.9.6");
    }

    #[test]
    fn 没有_Apache_前缀时退回第一个像版本号的_token() {
        assert_eq!(parse_mvn_version("Maven 3.8.7 something"), "3.8.7");
    }

    #[test]
    fn 认不出版本返回空串() {
        assert_eq!(parse_mvn_version(""), "");
        assert_eq!(parse_mvn_version("garbage output"), "");
    }

    /*
     * 这一格是最容易错的：Maven 自带的 settings.xml 里
     * <localRepository> 是**被注释掉的示例**。不去注释就会扫到 /path/to/local/repo。
     */
    #[test]
    fn 忽略被注释掉的_localRepository() {
        let xml = "\
<settings>
  <!-- <localRepository>/path/to/local/repo</localRepository> -->
</settings>";
        assert_eq!(parse_local_repository(xml), None);
    }

    #[test]
    fn 读取真实配置() {
        let xml = "<settings><localRepository>/data/m2/repo</localRepository></settings>";
        assert_eq!(parse_local_repository(xml), Some("/data/m2/repo".into()));
    }

    #[test]
    fn 展开_user_home_占位符() {
        let xml = "<settings><localRepository>${user.home}/m2/repo</localRepository></settings>";
        let got = parse_local_repository(xml).unwrap_or_default();
        assert!(got.ends_with("/m2/repo"), "实际：{got}");
        assert!(!got.contains("${"), "占位符没展开：{got}");
    }

    #[test]
    fn 空配置返回_None() {
        assert_eq!(parse_local_repository(""), None);
        assert_eq!(parse_local_repository("<settings></settings>"), None);
    }
}
