/*
 * JAR 运行器模块 · 数据模型与纯逻辑
 * ------------------------------------------------------------------
 * 把「一份配置」变成「一条可执行的 argv」是本模块唯一有判断力的地方，
 * 所以**全部写成纯函数**并配单测：命令行拼错的表现是「进程秒退、日志里一行
 * 看不懂的 Usage」，而那类问题在界面上极难自查。
 *
 * 两种运行模式：
 *   1. 常规模式：`<java> [JVM 参数] -jar <jar 路径> [程序参数]`
 *   2. 自定义命令：整条命令自己写，支持两个占位符
 *        {java}  选中 JDK 的 java 绝对路径
 *        {jar}   jar 文件的绝对路径
 *      例：`{java} -cp target/classes com.example.Main --server.port=8081`
 *      （写注释时不能用「目录名后紧跟星号」的写法：Rust 块注释可嵌套，
 *        那个星号会开启一层注释把后面的说明整段吞掉，报 E0758。）
 *
 * 自定义命令是「支持配置运行命令」的关键：java 之外的用法（指定 classpath、
 * 跑 main 类、加 agent）用表单填不出来，而用户往往就是想照着平时敲的那条命令跑。
 * @Author: fu
 */
use serde::{Deserialize, Serialize};

/* 占位符：自定义命令里会被替换成实际路径 */
pub const PH_JAVA: &str = "{java}";
pub const PH_JAR: &str = "{jar}";

/*
 * Spring Boot 指定配置文件位置的参数键（**不带** `--` 前缀，方便做 contains 判断）。
 * 之所以由我们拼而不是让用户手打：配置文件路径常含空格与中文，
 * 手打一遍就多一个出错的地方，而选文件不会。
 */
pub const SPRING_CONFIG_KEY: &str = "spring.config.location";

/* =============================================
   ====== 数据结构 ======
   ============================================= */

/** 一条环境变量。用「键值对数组」而不是 map：前端要按行编辑，有序更好改 */
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvPair {
    pub key: String,
    pub value: String,
}

/** 一次运行的配置（可保存复用）。不涉及密钥：这里只有本地路径与参数 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JarConfig {
    pub id: String,
    /** 展示名，默认取 jar 文件名 */
    pub name: String,
    /** jar 绝对路径 */
    pub jar_path: String,
    /** JAVA_HOME；空串 = 自动（用默认那台 JDK） */
    pub jdk_home: String,
    /** JVM 参数，如 `-Xmx512m -Dfile.encoding=UTF-8` */
    pub jvm_args: String,
    /** 程序参数，如 `--spring.profiles.active=dev` */
    pub program_args: String,
    /**
     * Spring Boot 的配置文件（application.yml / application.properties）绝对路径；
     * 空串 = 不传。非空时会拼成 `--spring.config.location=file:<路径>`。
     *
     * 自定义命令模式下**不生效** —— 那时整条命令由用户自己写，
     * 我们再往里塞东西就违背了「整条按它跑」。
     */
    /*
     * ⚠️ `serde(default)` 不能省。配置是用 JSON 存进 sled 的，而
     * `StorageService::list_json` 对**反序列化失败的记录是静默跳过**
     * （core/storage.rs，本意是「一条坏数据不锁死整个列表」）——
     * 少了这个属性，加字段之前存下的配置会因为缺 `configFile` 键而**整条消失**：
     * 用户看到的是「我保存的配置没了」，而且不报任何错。
     * **给这个结构加字段时，新字段一律带上 `serde(default)`。**
     */
    #[serde(default)]
    pub config_file: String,
    /** 工作目录；空串 = jar 所在目录 */
    pub work_dir: String,
    /** 额外的环境变量（不会清空继承来的环境，只覆盖同名项） */
    pub env: Vec<EnvPair>,
    /**
     * 自定义命令。非空时**整条**按它跑（占位符见文件头），
     * 此时 jvm_args / program_args 不参与拼装 —— 两处同时生效只会让人糊涂。
     */
    pub custom_command: String,
    pub updated_at: i64,
}

/** 运行状态的粗粒度取值，界面据此上色 */
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    /** 正在跑 */
    Running,
    /** 自己跑完了，退出码 0 */
    Exited,
    /** 自己跑完了，退出码非 0 */
    Failed,
    /** 被用户点停 / 应用退出时收尾 */
    Stopped,
}

/** 一行日志来自哪。stdout / stderr 分开是为了界面能只盯着错误看 */
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
    /** 工作台自己写进去的提示（「进程已启动」这类），不是子进程的输出 */
    System,
}

/** 一次运行的完整状态 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub id: String,
    /** 它来自哪份配置；直接改表单后启动的为空串 */
    pub config_id: String,
    pub name: String,
    pub jar_path: String,
    /** 实际调用的 java 绝对路径 */
    pub java_bin: String,
    /** JDK 的展示标签，如 "17.0.10 · sdkman" */
    pub jdk_label: String,
    /** 拼好的完整命令行（界面上原文展示 / 一键复制） */
    pub command: String,
    pub work_dir: String,
    pub status: RunStatus,
    pub pid: Option<u32>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub exit_code: Option<i32>,
    /** 启动失败 / 运行期异常的原因 */
    pub error: Option<String>,
}

/** 一行日志 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /** 本 run 内的自增序号，前端用它做 key、也用于判断是否跳过重复批次 */
    pub seq: u64,
    pub ts: i64,
    pub stream: LogStream,
    pub text: String,
}

/* =============================================
   ====== 纯逻辑：命令行拼装 ======
   ============================================= */

/**
 * 把一条命令行拆成 argv。
 *
 * 支持双引号与单引号包裹（`-Dmsg="hello world"` 这种必须保留成一个参数），
 * 引号本身不带进结果。不处理反斜杠转义 —— 那是 shell 的活，
 * 我们直接 exec、不经 shell，所以反斜杠就是普通字符。
 */
pub fn split_args(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut started = false;

    for ch in s.chars() {
        match quote {
            Some(q) => {
                if ch == q {
                    quote = None;
                } else {
                    cur.push(ch);
                }
            }
            None => match ch {
                '"' | '\'' => {
                    quote = Some(ch);
                    started = true;
                }
                c if c.is_whitespace() => {
                    if started {
                        out.push(std::mem::take(&mut cur));
                        started = false;
                    }
                }
                _ => {
                    cur.push(ch);
                    started = true;
                }
            },
        }
    }
    /* 末尾没闭合的引号：按「用户就是这个意思」收尾，不丢最后一个参数 */
    if started {
        out.push(std::mem::take(&mut cur));
    }
    out
}

/**
 * 由配置文件路径生成 Spring 的参数：`--spring.config.location=file:<路径>`。
 *
 * 用 `file:` 前缀是 Spring 的规范写法。这里**不加引号** —— 我们直接 exec、
 * 不经 shell，整个「键=值」就是 argv 里的一项，路径带空格也不会被拆开
 * （`command_preview` 会替它加引号，那只是给人看的）。
 */
pub fn spring_config_arg(path: &str) -> String {
    format!("--{SPRING_CONFIG_KEY}=file:{}", path.trim())
}

/**
 * 用户是不是自己在程序参数里写了 `spring.config.location`。
 *
 * 写了就**不再追加**我们那条：同一个键出现两次时谁生效是有讲究的，
 * 与其去猜 Spring 的取值顺序，不如让用户的**显式输入**说了算 ——
 * 他真想用选中的那个，把程序参数里那截删掉即可。
 *
 * 注意 `spring.config.additional-location` **不会**误命中：
 * 它的键是 `additional-location`，不含 `spring.config.location` 这个子串。
 */
fn has_own_config_location(program_args: &str) -> bool {
    program_args.contains(SPRING_CONFIG_KEY)
}

/** 由「配置 + java 绝对路径」得到 argv（拼不出东西的情况由 `validate` 先拦住） */
pub fn build_argv(java: &str, cfg: &JarConfig) -> Vec<String> {
    let custom = cfg.custom_command.trim();
    if !custom.is_empty() {
        let replaced = custom.replace(PH_JAVA, java).replace(PH_JAR, &cfg.jar_path);
        return split_args(&replaced);
    }

    let mut argv: Vec<String> = vec![java.to_string()];
    argv.extend(split_args(&cfg.jvm_args));
    argv.push("-jar".to_string());
    argv.push(cfg.jar_path.clone());
    argv.extend(split_args(&cfg.program_args));
    /* 配置文件排在程序参数**之后**：先让用户自己的参数占位，语义上它也是「附加」 */
    let cf = cfg.config_file.trim();
    if !cf.is_empty() && !has_own_config_location(&cfg.program_args) {
        argv.push(spring_config_arg(cf));
    }
    argv
}

/**
 * 把 argv 拼回一条可阅读、可复制的命令。
 *
 * 为什么要单独一个函数而不是直接 join(" ")：含空格的参数必须加引号，
 * 否则用户复制出去粘到终端里就变成两个参数了 —— 预览和真实执行**不一致**
 * 比预览难看严重得多。
 */
pub fn command_preview(argv: &[String]) -> String {
    argv
        .iter()
        .map(|a| {
            if a.is_empty() {
                "\"\"".to_string()
            } else if a.chars().any(|c| c.is_whitespace() || c == '"') {
                format!("\"{}\"", a.replace('"', "\\\""))
            } else {
                a.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/** jar 路径 → 展示名（去掉目录与 .jar 后缀） */
pub fn display_name(jar_path: &str) -> String {
    let path = std::path::Path::new(jar_path);
    let file = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| jar_path.to_string());
    match file.strip_suffix(".jar") {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => file,
    }
}

/** jar 所在目录（作为默认工作目录） */
pub fn default_work_dir(jar_path: &str) -> String {
    std::path::Path::new(jar_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/**
 * 启动前的校验。
 *
 * 这里只查「本地能立刻判断」的事：jar 路径存在、工作目录存在、配置文件存在。
 * 不查 java 能不能跑（那要 fork，交给真正启动时的错误去说），
 * 也不查 jar 是不是合法的 zip —— 不合法的表现是 java 自己打印一行错误，
 * 提前猜反而容易误报。
 */
pub fn validate(cfg: &JarConfig) -> Result<(), String> {
    let jar = cfg.jar_path.trim();
    if jar.is_empty() {
        return Err("还没选 jar 文件".into());
    }
    let p = std::path::Path::new(jar);
    if !p.exists() {
        return Err(format!("jar 文件不存在：{jar}"));
    }
    if !p.is_file() {
        return Err(format!("这不是一个文件：{jar}"));
    }
    let wd = cfg.work_dir.trim();
    if !wd.is_empty() && !std::path::Path::new(wd).is_dir() {
        return Err(format!("工作目录不存在：{wd}"));
    }
    /*
     * 配置文件选了就得真的在：路径写错时 Spring 会**退回默认配置照常启动**，
     * 表现是「配置没生效但服务起来了」—— 比直接启动失败难查得多。
     * 自定义命令模式下这个字段不参与拼装，所以那时不校验。
     */
    let cf = cfg.config_file.trim();
    if !cf.is_empty() && cfg.custom_command.trim().is_empty() {
        let cp = std::path::Path::new(cf);
        if !cp.exists() {
            return Err(format!("配置文件不存在：{cf}"));
        }
        if !cp.is_file() {
            return Err(format!("配置文件不是一个文件：{cf}"));
        }
    }
    /* 自定义命令模式下 -jar 由用户自己写，不能要求 jar 一定被拼进去 */
    Ok(())
}

/** 环境变量里空 key 会写到进程环境里变成一条脏数据，进 argv 前先滤掉 */
pub fn env_pairs(cfg: &JarConfig) -> Vec<(String, String)> {
    cfg.env
        .iter()
        .filter(|e| !e.key.trim().is_empty())
        .map(|e| (e.key.trim().to_string(), e.value.clone()))
        .collect()
}

/**
 * JDK 的展示标签（下拉框里的一行）。
 *
 * 为什么要带来源：同一个版本号可能装了两份（sdkman 一份、系统一份），
 * 只写「Java 17」时用户选错了也不知道；加上来源，「我装在哪儿」立刻对得上。
 * 版本读不出来（release 文件缺失）时写「未知版本」而不是留空 ——
 * 空串在下拉框里是一条看不见的选项。
 */
pub fn jdk_label(version: &str, source: &str) -> String {
    let v = if version.trim().is_empty() {
        "未知版本"
    } else {
        version.trim()
    };
    let from = match source {
        "sdkman" => "sdkman",
        "brew" => "Homebrew",
        "env" => "JAVA_HOME",
        _ => "系统",
    };
    format!("Java {v} · {from}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(jar: &str, jvm: &str, prog: &str) -> JarConfig {
        JarConfig {
            id: "c1".into(),
            name: "demo".into(),
            jar_path: jar.into(),
            jdk_home: String::new(),
            jvm_args: jvm.into(),
            program_args: prog.into(),
            config_file: String::new(),
            work_dir: String::new(),
            env: vec![],
            custom_command: String::new(),
            updated_at: 0,
        }
    }

    #[test]
    fn 常规模式_参数顺序是_jvm参数_在前_程序参数_在后() {
        let c = cfg("/app/demo.jar", "-Xmx512m", "--server.port=8081");
        assert_eq!(
            build_argv("/jdk/bin/java", &c),
            vec![
                "/jdk/bin/java",
                "-Xmx512m",
                "-jar",
                "/app/demo.jar",
                "--server.port=8081"
            ]
        );
    }

    /*
     * java 的参数顺序是**有语义的**：`-jar` 之后的一切都归程序，
     * 把程序参数放到 -jar 前面会被当成 JVM 参数（或报 "Unrecognized option"）。
     */
    #[test]
    fn 参数为空时不产生空串参数() {
        let c = cfg("/app/demo.jar", "", "");
        assert_eq!(
            build_argv("/jdk/bin/java", &c),
            vec!["/jdk/bin/java", "-jar", "/app/demo.jar"]
        );
    }

    #[test]
    fn 拆分命令_引号内的空格保留() {
        assert_eq!(
            split_args("-Dmsg=\"hello world\" -Xmx1g"),
            vec!["-Dmsg=hello world", "-Xmx1g"]
        );
        assert_eq!(split_args("-Dp='a b'"), vec!["-Dp=a b"]);
    }

    #[test]
    fn 拆分命令_连续空白不产生空参数() {
        assert_eq!(split_args("  -a    -b  "), vec!["-a", "-b"]);
        assert!(split_args("   ").is_empty());
        assert!(split_args("").is_empty());
    }

    #[test]
    fn 拆分命令_引号没闭合也收尾() {
        assert_eq!(split_args("-Dmsg=\"hello"), vec!["-Dmsg=hello"]);
    }

    #[test]
    fn 自定义命令_替换两个占位符() {
        let mut c = cfg("/app/demo.jar", "-Xmx512m", "--x");
        c.custom_command = "{java} -cp lib/* com.example.Main --jar={jar}".to_string();
        assert_eq!(
            build_argv("/jdk/bin/java", &c),
            vec![
                "/jdk/bin/java",
                "-cp",
                "lib/*",
                "com.example.Main",
                "--jar=/app/demo.jar"
            ]
        );
    }

    /* 自定义命令优先：两处同时生效会让人不知道到底跑了什么 */
    #[test]
    fn 自定义命令非空时忽略_jvm_与程序参数() {
        let mut c = cfg("/app/demo.jar", "-Xmx512m", "--x");
        c.custom_command = "{java} -version".to_string();
        assert_eq!(build_argv("/jdk/bin/java", &c), vec!["/jdk/bin/java", "-version"]);
    }

    /*
     * 预览要给「含空格的参数」加引号，但**不含空格的不要加** ——
     * 全都加引号的话，`java -jar app.jar` 会显示成 `"java" "-jar" "app.jar"`，
     * 复制出去能跑，但读起来很脏。
     */
    #[test]
    fn 预览只给含空格的参数加引号() {
        let argv = vec!["/jdk/bin/java".to_string(), "-Dmsg=hello world".to_string()];
        assert_eq!(
            command_preview(&argv),
            "/jdk/bin/java \"-Dmsg=hello world\""
        );
        let plain = vec!["java".to_string(), "-jar".to_string(), "/a/b.jar".to_string()];
        assert_eq!(command_preview(&plain), "java -jar /a/b.jar");
    }

    #[test]
    fn 展示名去掉目录与后缀() {
        assert_eq!(display_name("/opt/app/order-service.jar"), "order-service");
        assert_eq!(display_name("/opt/app/plain"), "plain");
    }

    #[test]
    fn 默认工作目录是_jar_所在目录() {
        assert_eq!(default_work_dir("/opt/app/order-service.jar"), "/opt/app");
    }

    #[test]
    fn 校验_没选文件与文件不存在要分开说() {
        let mut c = cfg("", "", "");
        assert!(validate(&c).unwrap_err().contains("还没选"));

        c.jar_path = "/绝对/不存在/的.jar".into();
        assert!(validate(&c).unwrap_err().contains("不存在"));
    }

    #[test]
    fn 校验_工作目录不存在要报() {
        let mut c = cfg("/app/demo.jar", "", "");
        /* jar 本身也不存在 —— 先造一个真的，才能验到「工作目录」这一支 */
        let dir = std::env::temp_dir().join("jarrunner-test-wd");
        std::fs::create_dir_all(&dir).ok();
        let jar = dir.join("demo.jar");
        std::fs::write(&jar, b"x").ok();
        c.jar_path = jar.to_string_lossy().to_string();
        assert!(validate(&c).is_ok());

        c.work_dir = "/绝对/不存在/的目录".into();
        assert!(validate(&c).unwrap_err().contains("工作目录"));
    }

    #[test]
    fn 环境变量过滤空_key() {
        let mut c = cfg("/app/demo.jar", "", "");
        c.env = vec![
            EnvPair { key: " A ".into(), value: "1".into() },
            EnvPair { key: "  ".into(), value: "2".into() },
        ];
        assert_eq!(env_pairs(&c), vec![("A".to_string(), "1".to_string())]);
    }

    #[test]
    fn jdk_标签带来源与版本() {
        assert_eq!(jdk_label("17.0.10", "sdkman"), "Java 17.0.10 · sdkman");
        assert_eq!(jdk_label("21", "brew"), "Java 21 · Homebrew");
        assert_eq!(jdk_label("8", "env"), "Java 8 · JAVA_HOME");
        assert_eq!(jdk_label("11", "system"), "Java 11 · 系统");
        /* 版本读不出来时不能显示成「Java  · 」这种空档 */
        assert_eq!(jdk_label("", "system"), "Java 未知版本 · 系统");
    }

    #[test]
    fn 状态串与前端约定一致() {
        /* 前端按小写串上色，改这里必须同步改前端 RunStatus 类型 */
        let s = serde_json::to_string(&RunStatus::Running).unwrap_or_default();
        assert_eq!(s, "\"running\"");
        let l = serde_json::to_string(&LogStream::Stderr).unwrap_or_default();
        assert_eq!(l, "\"stderr\"");
    }

    /*
     * 配置文件走 Spring 规范参数，并且排在程序参数**之后**。
     * 顺序不是随便定的：它语义上是「附加」，排在用户自己写的参数后面，
     * 出问题时把末尾那段删掉就回到原样。
     */
    #[test]
    fn 配置文件拼成_spring_参数且排在程序参数之后() {
        let mut c = cfg("/app/demo.jar", "", "--server.port=8081");
        c.config_file = "/app/conf/application.yml".into();
        assert_eq!(
            build_argv("/jdk/bin/java", &c),
            vec![
                "/jdk/bin/java",
                "-jar",
                "/app/demo.jar",
                "--server.port=8081",
                "--spring.config.location=file:/app/conf/application.yml"
            ]
        );
    }

    /*
     * 路径带空格时必须**仍是 argv 里的单个元素**。
     * 我们直接 exec、不经 shell，所以这里天然安全；这个断言是给未来的人看的：
     * 谁要是哪天在 spring_config_arg 里「顺手加个引号」，这条就会红。
     */
    #[test]
    fn 配置文件路径带空格时仍是单个参数() {
        let mut c = cfg("/app/demo.jar", "", "");
        c.config_file = "/Users/me/My Config/application.yml".into();
        let argv = build_argv("/jdk/bin/java", &c);
        assert_eq!(
            argv.last(),
            Some(&"--spring.config.location=file:/Users/me/My Config/application.yml".to_string())
        );
        /* 参数个数：java / -jar / jar / 配置 = 4，没有被空格拆成 5 */
        assert_eq!(argv.len(), 4);
    }

    #[test]
    fn 配置文件为空或纯空白时不追加() {
        let mut c = cfg("/app/demo.jar", "", "");
        assert_eq!(build_argv("/jdk/bin/java", &c), vec!["/jdk/bin/java", "-jar", "/app/demo.jar"]);
        c.config_file = "   ".into();
        assert_eq!(build_argv("/jdk/bin/java", &c), vec!["/jdk/bin/java", "-jar", "/app/demo.jar"]);
    }

    /*
     * 用户自己写了 spring.config.location 就听他的，不重复追加。
     * 同一个键出现两次谁生效有讲究，与其猜 Spring 的取值顺序，不如让显式输入说了算。
     */
    #[test]
    fn 程序参数已含_spring_config_location_时不重复追加() {
        let mut c = cfg("/app/demo.jar", "", "--spring.config.location=file:/mine/a.yml");
        c.config_file = "/app/conf/application.yml".into();
        assert_eq!(
            build_argv("/jdk/bin/java", &c),
            vec![
                "/jdk/bin/java",
                "-jar",
                "/app/demo.jar",
                "--spring.config.location=file:/mine/a.yml"
            ]
        );
    }

    /*
     * `spring.config.additional-location` 是另一个键，不能误命中而把我们这条吞掉。
     * 它和 `spring.config.location` 是「附加」与「替换」的区别，用户同时用两个是合法的。
     */
    #[test]
    fn additional_location_不误命中() {
        let mut c = cfg("/app/demo.jar", "", "--spring.config.additional-location=file:/extra/");
        c.config_file = "/app/conf/application.yml".into();
        let argv = build_argv("/jdk/bin/java", &c);
        assert_eq!(
            argv.last(),
            Some(&"--spring.config.location=file:/app/conf/application.yml".to_string())
        );
    }

    /* 自定义命令是「整条按它跑」，往里塞东西就违背了这个承诺 */
    #[test]
    fn 自定义命令模式不追加配置文件() {
        let mut c = cfg("/app/demo.jar", "", "");
        c.custom_command = "{java} -jar {jar}".into();
        c.config_file = "/app/conf/application.yml".into();
        assert_eq!(build_argv("/jdk/bin/java", &c), vec!["/jdk/bin/java", "-jar", "/app/demo.jar"]);
    }

    #[test]
    fn spring_参数拼装_去掉首尾空白() {
        assert_eq!(
            spring_config_arg("  /a/b.yml  "),
            "--spring.config.location=file:/a/b.yml"
        );
    }

    /*
     * 配置文件路径写错时 Spring 会**静默退回默认配置照常启动** ——
     * 表现是「配置没生效但服务起来了」，比直接启动失败难查得多。
     * 所以这里要提前拦住。
     */
    #[test]
    fn 校验_配置文件不存在要报() {
        let mut c = cfg("/app/demo.jar", "", "");
        let dir = std::env::temp_dir().join("jarrunner-test-cf");
        std::fs::create_dir_all(&dir).ok();
        let jar = dir.join("demo.jar");
        std::fs::write(&jar, b"x").ok();
        c.jar_path = jar.to_string_lossy().to_string();

        c.config_file = "/绝对/不存在/的.yml".into();
        assert!(validate(&c).unwrap_err().contains("配置文件不存在"));

        /* 目录不是文件：写成目录 Spring 同样读不出配置，要单独说清 */
        c.config_file = dir.to_string_lossy().to_string();
        assert!(validate(&c).unwrap_err().contains("不是一个文件"));

        /* 真文件则通过 */
        let yml = dir.join("application.yml");
        std::fs::write(&yml, b"server:\n  port: 8080\n").ok();
        c.config_file = yml.to_string_lossy().to_string();
        assert!(validate(&c).is_ok());
    }

    /* 自定义命令模式下配置文件不参与拼装，也就不该校验它 —— 免得拦住一条根本不用的路径 */
    #[test]
    fn 校验_自定义命令模式不校验配置文件() {
        let mut c = cfg("/app/demo.jar", "", "");
        let dir = std::env::temp_dir().join("jarrunner-test-cf2");
        std::fs::create_dir_all(&dir).ok();
        let jar = dir.join("demo.jar");
        std::fs::write(&jar, b"x").ok();
        c.jar_path = jar.to_string_lossy().to_string();

        c.custom_command = "{java} -version".into();
        c.config_file = "/绝对/不存在/的.yml".into();
        assert!(validate(&c).is_ok());
    }

    /*
     * 加字段不能把老记录读废 —— 这是 `config_file` 上那个 `serde(default)` 的回归测试。
     *
     * 配置是 JSON 存进 sled 的，而 `StorageService::list_json` 对反序列化失败的记录
     * **静默跳过**。少了 `serde(default)`，加字段之前存下的 JSON（没有 `configFile` 键）
     * 会整条读不出来 —— 表现是「我保存的配置全没了」，界面上一个错都不报。
     */
    #[test]
    fn 老记录缺_config_file_键也能读出来() {
        let json = r#"{
            "id": "c1",
            "name": "order-service",
            "jarPath": "/opt/app/order-service.jar",
            "jdkHome": "",
            "jvmArgs": "-Xmx512m",
            "programArgs": "--server.port=8081",
            "workDir": "",
            "env": [],
            "customCommand": "",
            "updatedAt": 1700000000000
        }"#;
        let c: JarConfig = serde_json::from_str(json).expect("老记录必须还能读出来");
        assert_eq!(c.name, "order-service");
        assert_eq!(c.config_file, "");
        /* 读出来还得能正常拼命令：空配置文件 = 不追加那条参数 */
        assert_eq!(
            build_argv("/jdk/bin/java", &c),
            vec![
                "/jdk/bin/java",
                "-Xmx512m",
                "-jar",
                "/opt/app/order-service.jar",
                "--server.port=8081"
            ]
        );
    }

    /* 写出去再读回来，新字段要能原样往返（前后端契约就靠这个键名） */
    #[test]
    fn 配置文件能原样往返_json() {
        let mut c = cfg("/app/demo.jar", "", "");
        c.config_file = "/etc/conf/prod/application.yml".into();
        let s = serde_json::to_string(&c).expect("序列化");
        /* camelCase：前端读的是 configFile，不是 config_file */
        assert!(
            s.contains(r#""configFile":"/etc/conf/prod/application.yml""#),
            "键名必须是 camelCase 的 configFile，实际：{s}"
        );
        let back: JarConfig = serde_json::from_str(&s).expect("反序列化");
        assert_eq!(back.config_file, c.config_file);
    }
}
