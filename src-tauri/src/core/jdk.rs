/*
 * 工作台核心层 · JDK 探测
 * ------------------------------------------------------------------
 * 为什么必须自己扫，而不能直接调 `jps` / `java`：
 *   macOS 上从 Dock / Finder 启动的 GUI 应用，PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，
 *   JAVA_HOME 也常常没设（sdkman 用的是 shim，不是环境变量）。
 *   直接 spawn("jps") 必然 "No such file or directory" ——
 *   表现是「界面上一个进程都没有」，而用户明明开着 IDEA 和 Spring Boot。
 *   所以 jps / jstat / jstack / java 一律用**绝对路径**调用，路径来自这里扫出来的 JDK。
 *
 * 扫描位置（覆盖 macOS 上 JDK 的全部常见落点）：
 *   ~/.sdkman/candidates/java/<id>            sdkman 装的（主力）
 *   ~/Library/Java/JavaVirtualMachines/<名>   当前用户装的
 *   /Library/Java/JavaVirtualMachines/<名>    系统级装的
 *   /opt/homebrew/opt/openjdk<版本号>         Homebrew 装的
 *   $JAVA_HOME                               环境变量
 *
 * （写注释时注意：Rust 的块注释是可嵌套的，所以注释里不能出现
 *   「目录名后紧跟星号」这种写法，否则会把后面的说明整段吞掉，报 E0758。
 *   下面一律用 <id> / <名> 占位代替通配符。）
 *
 * `current` 这类符号链接要跳过：它指向的实体目录已经被单独扫到了，
 * 不跳过就会在列表里出现两条一模一样的 JDK。
 *
 * 【为什么在 core 而不是留在 jvm 模块里】
 *   第二个模块（JAR 运行器）也要「选一台 JDK 来跑 java」，而模块之间不互相依赖
 *   是本仓的硬约定 —— 共用能力的第二个使用者出现时就该上收（见技能「坑 22」）。
 *   原文件是 modules/jvm/probe.rs，整体搬来这里，逻辑一行没改。
 * @Author: fu
 */
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

/* =============================================
   ====== 数据模型 ======
   ============================================= */

/* JDK 是从哪儿扫出来的 */
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JdkSource {
    /** ~/.sdkman/candidates/java/<id> */
    Sdkman,
    /** /Library/Java/JavaVirtualMachines 或 ~/Library 下 */
    System,
    /** /opt/homebrew/opt/openjdk* */
    Brew,
    /** 环境变量 JAVA_HOME */
    Env,
}

/* 一台已安装的 JDK */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JdkInfo {
    /** 展示用的短 id，如 "17.0.10-tem" 或 "oracle_open_jdk-22" */
    pub id: String,
    /** 版本串，如 "17.0.10"；读不出来时为空串（界面显示「未知版本」） */
    pub version: String,
    /** 发行方，如 "Eclipse Adoptium" */
    pub vendor: String,
    /** JAVA_HOME */
    pub home: String,
    pub source: JdkSource,
    /** 是否是「当前默认」：JAVA_HOME 优先，其次 sdkman current */
    pub is_default: bool,
    /**
     * 是否带诊断工具（bin/jps）。
     * JRE 与部分精简发行版没有 —— 没有 jps 就列不出进程，
     * 界面要靠它决定「换一个 JDK」而不是干瞪眼报错。
     */
    pub has_tools: bool,
    /**
     * 这台 JDK 实际存在哪些工具（java / javac / jps / jstack / jmap / jstat / jcmd）。
     *
     * 为什么要把「有没有 jstack」单独列出来，而不是只给 has_tools：
     *   JRE 也能列出进程（jps 在）、但抓不了线程栈（jstack 不在）。
     *   只给 has_tools 的话用户界面上只会看到「可用」，点了「线程栈」才失败 ——
     *   提前把缺失的工具说出来，用户才知道要换 JDK 而不是以为功能坏了。
     */
    pub tools: Vec<String>,
}

/**
 * 关注的诊断工具清单。
 * 顺序即界面上展示的顺序：把最常用的放前面（java 一定在，javac 区分 JDK/JRE）。
 */
pub const JDK_TOOLS: [&str; 7] = ["java", "javac", "jps", "jstack", "jmap", "jstat", "jcmd"];

/* =============================================
   ====== 版本 ======
   ============================================= */

/**
 * 版本串 → 主版本号，用于排序（JDK 8 及以前写作 `1.8.0_482`）。
 * 解析不了返回 0，它会被排到最后，不会让排序崩掉。
 */
pub fn version_major(v: &str) -> u32 {
    let v = v.trim();
    if v.is_empty() {
        return 0;
    }
    let parts: Vec<&str> = v.split('.').collect();
    let first = parts.first().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    if first == 1 {
        /* 1.8.0_482 → 8 */
        return parts.get(1).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    }
    first
}

/** 读 JDK home 下的 release 文件，取 (JAVA_VERSION, IMPLEMENTOR) */
pub fn parse_release(text: &str) -> (String, String) {
    let mut version = String::new();
    let mut vendor = String::new();
    for line in text.lines() {
        let line = line.trim();
        let (k, v) = match line.split_once('=') {
            Some(x) => x,
            None => continue,
        };
        let v = v.trim().trim_matches('"').trim();
        match k.trim() {
            "JAVA_VERSION" => version = v.to_string(),
            "IMPLEMENTOR" => vendor = v.to_string(),
            _ => {}
        }
    }
    /* 有的发行版只写 IMPLEMENTOR，有的写 IMPLEMENTOR_VENDOR，这里兜一下常见的厂商字段 */
    if vendor.is_empty() {
        for line in text.lines() {
            if let Some((k, v)) = line.trim().split_once('=') {
                if k.trim() == "IMPLEMENTOR_VENDOR" {
                    vendor = v.trim().trim_matches('"').trim().to_string();
                }
            }
        }
    }
    (version, vendor)
}

/**
 * 读某个 JDK home 的 release 文件。
 * 对外可见：jvm 模块的 commands.rs 也会用它 —— 从进程的命令行反推出 JAVA_HOME 之后，
 * 要读同一份 release 才能说出「这个进程跑在 JDK 几上」。
 */
pub fn read_release(home: &Path) -> (String, String) {
    let p = home.join("release");
    match fs::read_to_string(p) {
        Ok(s) => parse_release(&s),
        Err(_) => (String::new(), String::new()),
    }
}

/* =============================================
   ====== 扫描 ======
   ============================================= */

/** 一个待确认的候选（还没读版本、没去重） */
struct Candidate {
    home: PathBuf,
    id: String,
    source: JdkSource,
}

/** 扫一个形如 <root>/<name>/Contents/Home 的 JavaVirtualMachines 目录 */
fn scan_jvm_dir(root: &Path, source: JdkSource) -> Vec<Candidate> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let home = path.join("Contents").join("Home");
        if !home.join("bin").join("java").exists() && !home.join("bin").join("jps").exists() {
            continue;
        }
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        /* 目录名常见为 xxx.jdk，去掉后缀更好读 */
        let id = name.strip_suffix(".jdk").unwrap_or(&name).to_string();
        out.push(Candidate { home, id, source });
    }
    out
}

/** 扫 sdkman 的候选目录（跳过 current 等符号链接） */
fn scan_sdkman() -> Vec<Candidate> {
    let mut out = Vec::new();
    let root = match home_dir() {
        Some(h) => h.join(".sdkman").join("candidates").join("java"),
        None => return out,
    };
    let entries = match fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        /*
         * sdkman 的 `current` 是指向某个具体版本的符号链接 —— 它本身不是一台
         * 独立的 JDK。扫它只会多出一条重复项；它真正的用途在下面判 default。
         */
        if name == "current" || name.starts_with("current") {
            continue;
        }
        if !path.join("bin").join("java").exists() {
            continue;
        }
        out.push(Candidate {
            home: path,
            id: name,
            source: JdkSource::Sdkman,
        });
    }
    out
}

/** 扫 /opt/homebrew/opt/openjdk*（Homebrew：真实 home 在 libexec/openjdk.jdk/Contents/Home） */
fn scan_brew() -> Vec<Candidate> {
    let mut out = Vec::new();
    for root in ["/opt/homebrew/opt", "/usr/local/opt"] {
        let entries = match fs::read_dir(root) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if !name.starts_with("openjdk") {
                continue;
            }
            /* Homebrew 的 openjdk  formulae 把真身放在 libexec 下 */
            let home = path.join("libexec").join("openjdk.jdk").join("Contents").join("Home");
            let home = if home.exists() { home } else { path.join("libexec") };
            if !home.join("bin").join("java").exists() {
                continue;
            }
            out.push(Candidate {
                home,
                id: name,
                source: JdkSource::Brew,
            });
        }
    }
    out
}

/** 当前默认 JDK 的真实路径（JAVA_HOME 优先，其次 sdkman current）。用于打 is_default 标记 */
fn default_home() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("JAVA_HOME") {
        if !v.trim().is_empty() {
            if let Ok(c) = fs::canonicalize(&v) {
                return Some(c);
            }
        }
    }
    let cur = home_dir()?.join(".sdkman").join("candidates").join("java").join("current");
    fs::canonicalize(cur).ok()
}

/** 列出全部 JDK（已去重、按主版本号降序） */
pub fn list_jdks() -> Vec<JdkInfo> {
    let mut cands: Vec<Candidate> = Vec::new();

    if let Ok(v) = std::env::var("JAVA_HOME") {
        let home = PathBuf::from(v.trim());
        if !home.as_os_str().is_empty() && home.join("bin").join("java").exists() {
            cands.push(Candidate {
                id: home
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "JAVA_HOME".into()),
                home,
                source: JdkSource::Env,
            });
        }
    }

    cands.extend(scan_sdkman());
    if let Some(h) = home_dir() {
        cands.extend(scan_jvm_dir(
            &h.join("Library").join("Java").join("JavaVirtualMachines"),
            JdkSource::System,
        ));
    }
    cands.extend(scan_jvm_dir(
        Path::new("/Library/Java/JavaVirtualMachines"),
        JdkSource::System,
    ));
    cands.extend(scan_brew());

    let default = default_home();

    let mut seen: Vec<PathBuf> = Vec::new();
    let mut list: Vec<JdkInfo> = Vec::new();
    for c in cands {
        /* 按 canonical 去重：JAVA_HOME / current / 实体目录可能指向同一台 JDK */
        let canon = fs::canonicalize(&c.home).unwrap_or_else(|_| c.home.clone());
        if seen.iter().any(|p| *p == canon) {
            continue;
        }
        seen.push(canon.clone());

        let (version, vendor) = read_release(&c.home);
        /* 逐个探测 bin 下有哪些工具 —— 只读文件系统，不 fork 任何进程 */
        let tools: Vec<String> = JDK_TOOLS
            .iter()
            .filter(|t| c.home.join("bin").join(t).exists())
            .map(|t| t.to_string())
            .collect();
        let has_tools = tools.iter().any(|t| t == "jps");
        let is_default = default.as_ref().map(|d| *d == canon).unwrap_or(false);

        list.push(JdkInfo {
            id: c.id,
            version,
            vendor,
            home: c.home.to_string_lossy().to_string(),
            source: c.source,
            is_default,
            has_tools,
            tools,
        });
    }

    /* 版本高的在前；版本相同的按 id 稳定排序，免得每次刷新顺序乱跳 */
    list.sort_by(|a, b| {
        version_major(&b.version)
            .cmp(&version_major(&a.version))
            .then_with(|| a.id.cmp(&b.id))
    });

    /*
     * 一台都没标成 default 时（没设 JAVA_HOME、也没有 sdkman current），
     * 把排在最前面的（版本最高的）标成 default —— 拿它来跑 jps 最合理。
     */
    if !list.iter().any(|j| j.is_default) {
        if let Some(first) = list.first_mut() {
            first.is_default = true;
        }
    }

    list
}

/**
 * 挑一台用来跑诊断工具的 JDK。
 *
 * 优先级：**带 jps 的 default > 带 jps 的最高版本 > 其它 default**。
 * 第三档是兜底：只有 JRE（没有 jps）时也要返回一个 home，
 * 这样界面能明确提示「这台 JDK 没有诊断工具」，而不是含糊地报「没找到 JDK」。
 */
pub fn pick_tool_home(jdks: &[JdkInfo]) -> Option<String> {
    let with_tools: Vec<&JdkInfo> = jdks.iter().filter(|j| j.has_tools).collect();
    let pool: Vec<&JdkInfo> = if with_tools.is_empty() {
        jdks.iter().collect()
    } else {
        with_tools
    };

    if let Some(j) = pool.iter().find(|j| j.is_default) {
        return Some(j.home.clone());
    }
    /*
     * list_jdks 已按版本降序排好，pool 保持了这个顺序。
     * 但防御性地再排一次：这个函数也可能被直接喂一份没排过的列表。
     */
    let mut sorted = pool;
    sorted.sort_by(|a, b| {
        version_major(&b.version)
            .cmp(&version_major(&a.version))
            .then_with(|| a.id.cmp(&b.id))
    });
    sorted.first().map(|j| j.home.clone())
}

/* =============================================
   ====== 给「跑 java」用的便利函数 ======
   ============================================= */

/**
 * 某台 JDK 的 java 可执行文件绝对路径。
 *
 * 直接用 "java" 是不行的：GUI 应用的 PATH 里通常没有它（见文件头），
 * 而 JAR 运行器必须让用户能选版本 —— 选了就得按选的那台去调。
 */
pub fn java_bin(home: &str) -> PathBuf {
    let exe = if cfg!(windows) { "java.exe" } else { "java" };
    Path::new(home).join("bin").join(exe)
}

/*
 * 「默认用哪台」**不在这里**实现：调用方拿到的是整份 JdkInfo 列表，
 * 自己 find(is_default) 就行；单独再提供一个只返回 home 的函数，
 * 会让人在两条路径之间犹豫，而它们很容易演化出不同的选择规则。
 * （JAR 运行器需要的是 home + 版本 + 来源，所以直接吃列表。）
 */

#[cfg(test)]
mod tests {
    use super::*;

    const RELEASE: &str = r#"
IMPLEMENTOR="Eclipse Adoptium"
IMPLEMENTOR_VENDOR="Adoptium"
JAVA_VERSION="17.0.10"
JAVA_VERSION_DATE="2024-01-16"
MODULES="java.base java.compiler"
"#;

    #[test]
    fn release_解析() {
        let (v, vendor) = parse_release(RELEASE);
        assert_eq!(v, "17.0.10");
        assert_eq!(vendor, "Eclipse Adoptium");
    }

    #[test]
    fn release_空内容不炸() {
        let (v, vendor) = parse_release("");
        assert_eq!(v, "");
        assert_eq!(vendor, "");
    }

    #[test]
    fn release_没有_implementor_时退回_VENDOR() {
        let (v, vendor) = parse_release("JAVA_VERSION=\"21.0.2\"\nIMPLEMENTOR_VENDOR=\"Homebrew\"\n");
        assert_eq!(v, "21.0.2");
        assert_eq!(vendor, "Homebrew");
    }

    /*
     * 界面会把 tools 直接列给用户看（「这台 JDK 缺 jstack」），
     * 所以清单里少一个工具名 = 界面上永远不显示它 = 用户以为 JDK 坏了。
     */
    #[test]
    fn 工具清单覆盖全部诊断工具() {
        for t in ["java", "javac", "jps", "jstack", "jmap", "jstat", "jcmd"] {
            assert!(JDK_TOOLS.contains(&t), "JDK_TOOLS 缺少 {t}");
        }
        assert_eq!(JDK_TOOLS.len(), 7);
    }

    #[test]
    fn 主版本号_新旧两种写法() {
        assert_eq!(version_major("17.0.10"), 17);
        assert_eq!(version_major("22.0.2"), 22);
        assert_eq!(version_major("1.8.0_482"), 8);
        assert_eq!(version_major("21.0.2+13"), 21);
        assert_eq!(version_major(""), 0);
        assert_eq!(version_major("garbage"), 0);
    }

    fn jdk(id: &str, version: &str, home: &str, has_tools: bool, is_default: bool) -> JdkInfo {
        JdkInfo {
            id: id.into(),
            version: version.into(),
            vendor: String::new(),
            home: home.into(),
            source: JdkSource::Sdkman,
            is_default,
            has_tools,
            tools: if has_tools {
                vec!["java".into(), "jps".into()]
            } else {
                vec!["java".into()]
            },
        }
    }

    #[test]
    fn 优先挑_default_且带工具的() {
        let list = vec![
            jdk("22", "22.0.2", "/jdk22", true, false),
            jdk("17", "17.0.10", "/jdk17", true, true),
        ];
        assert_eq!(pick_tool_home(&list), Some("/jdk17".into()));
    }

    #[test]
    fn 没有_default_时挑版本最高的() {
        let list = vec![
            jdk("8", "1.8.0_482", "/jdk8", true, false),
            jdk("22", "22.0.2", "/jdk22", true, false),
            jdk("17", "17.0.10", "/jdk17", true, false),
        ];
        assert_eq!(pick_tool_home(&list), Some("/jdk22".into()));
    }

    /*
     * 这一格是「一台 JDK 都没有」的防线：JRE 没有 jps，
     * 但如果连它都不返回，界面就只能说「未找到 JDK」，而其实装了 —— 误导更严重。
     */
    #[test]
    fn 全都只有_JRE_时也要返回一个_home() {
        let list = vec![jdk("jre8", "1.8.0_482", "/jre8", false, true)];
        assert_eq!(pick_tool_home(&list), Some("/jre8".into()));
    }

    #[test]
    fn 空列表返回_None() {
        assert_eq!(pick_tool_home(&[]), None);
    }

    /* 只有 JRE 且带 default 时，也要优先选带工具的那个（能跑 jps 才有用） */
    #[test]
    fn 带工具的优先于_default_的_JRE() {
        let list = vec![
            jdk("jre", "1.8.0_482", "/jre", false, true),
            jdk("jdk17", "17.0.10", "/jdk17", true, false),
        ];
        assert_eq!(pick_tool_home(&list), Some("/jdk17".into()));
    }

    #[test]
    fn java_可执行文件路径按_home_拼() {
        let p = java_bin("/Library/Java/JavaVirtualMachines/jdk-17.jdk/Contents/Home");
        assert!(p.ends_with("bin/java"), "实际路径: {p:?}");
        assert!(p.starts_with("/Library/Java"));
    }
}
