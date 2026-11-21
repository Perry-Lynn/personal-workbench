/*
 * Spring Boot 服务台 · 命令行识别与参数解析（纯逻辑）
 * ------------------------------------------------------------------
 * 这里的判断**全部只看命令行**，不碰文件系统、不发网络请求，所以可以直接单测。
 *
 * 核心问题是「怎么认出一个 Java 进程是 Spring Boot 应用」。三种信息来源，
 * 可靠性依次递减：
 *   1. **actuator 探活**（最可靠）—— 能连上 `/actuator/health` 并拿到 Spring 的
 *      JSON 结构，那就一定是。缺点是服务没开 actuator 就完全没用。
 *   2. **命令行强特征** —— classpath 里出现 spring-boot、显式指定了
 *      `spring.profiles.active` / `server.port`。基本不会误判。
 *   3. **名字里带 spring**（最弱）—— 单独看完全不够，只用来在界面里提示。
 *
 * 所以本模块的取舍是：**只把「有强特征」或「actuator 探活成功」的算数**，
 * 光靠 `java -jar app.jar` 是认不出来的 —— 宁可少列，也不要列一堆不相干的 Java 进程
 * 让用户在一堆假阳性里找真服务。
 * @Author: fu
 */
use std::path::Path;

/* =============================================
   ====== 是不是一个 Java 进程 ======
   ============================================= */

/**
 * 命令行是不是 java 起的。
 *
 * 只看**第一个 token 的可执行文件名**，不做全文匹配 —— 全文匹配会被
 * 路径里含 "java" 的进程骗到（比如 `/Users/x/java-tools/bin/node`），
 * 而 ps 输出的第一个 token 就是可执行文件本身，用它最准。
 */
pub fn looks_like_java(command: &str) -> bool {
    let first = match command.split_whitespace().next() {
        Some(s) => s,
        None => return false,
    };
    let base = Path::new(first)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| first.to_string());
    base == "java" || base == "java.exe"
}

/* =============================================
   ====== 强特征 ======
   ============================================= */

/**
 * 命令行里的强特征。返回的是**给人看的依据**，直接显示在界面上 ——
 * 「为什么这个进程被认成 Spring Boot」必须能自证，否则用户没法判断误判。
 */
pub fn strong_evidence(command: &str) -> Vec<String> {
    let lower = command.to_lowercase();
    let mut out: Vec<String> = Vec::new();

    if lower.contains("spring-boot") {
        out.push("类路径含 spring-boot".to_string());
    }
    if lower.contains("springframework.boot") {
        out.push("类路径含 org.springframework.boot".to_string());
    }
    /*
     * profile 参数几乎只有 Spring 用。`spring.profiles.include` 也算 ——
     * 有些项目不用 active 而用 include 拼环境。
     */
    if lower.contains("spring.profiles.active") || lower.contains("spring.profiles.include") {
        out.push("指定了 spring.profiles".to_string());
    }
    if lower.contains("server.port=") {
        out.push("指定了 server.port".to_string());
    }
    out
}

/** 弱特征：单独不足以断定，只在界面上作为提示 */
pub fn weak_hint(name: &str) -> Option<String> {
    if name.to_lowercase().contains("spring") {
        Some("名字里带 spring".to_string())
    } else {
        None
    }
}

/* =============================================
   ====== 参数解析 ======
   ============================================= */

/**
 * 取 `--key=value` 或 `--key value` 形式的值。
 *
 * 两种写法都得支持：`--spring.profiles.active=dev` 是命令行常见写法，
 * 而 IDEA 的 Program arguments 里用户也可能写成空格分隔。
 * `-D` 形式（JVM 参数）同样按这两种写法处理。
 */
fn arg_value<'a>(args: &[&'a str], keys: &[&str]) -> Option<&'a str> {
    for (i, a) in args.iter().enumerate() {
        for k in keys {
            if let Some(rest) = a.strip_prefix(k) {
                if let Some(v) = rest.strip_prefix('=') {
                    return Some(v);
                }
            }
            if *a == *k {
                if let Some(v) = args.get(i + 1) {
                    return Some(v);
                }
            }
        }
    }
    None
}

const PROFILE_KEYS: [&str; 4] = [
    "--spring.profiles.active",
    "-Dspring.profiles.active",
    "--spring.profiles.include",
    "-Dspring.profiles.include",
];

const PORT_KEYS: [&str; 2] = ["--server.port", "-Dserver.port"];

/** 从命令行取 profile 列表（逗号分隔，去重去空） */
pub fn parse_profiles(command: &str) -> Vec<String> {
    let args: Vec<&str> = command.split_whitespace().collect();
    let raw = match arg_value(&args, &PROFILE_KEYS) {
        Some(v) => v,
        None => return Vec::new(),
    };
    let mut out: Vec<String> = Vec::new();
    for p in raw.split(',') {
        let p = p.trim();
        if !p.is_empty() && !out.iter().any(|x| x == p) {
            out.push(p.to_string());
        }
    }
    out
}

/** 从命令行取 server.port（非法值返回 None，不猜） */
pub fn parse_server_port(command: &str) -> Option<u16> {
    let args: Vec<&str> = command.split_whitespace().collect();
    let raw = arg_value(&args, &PORT_KEYS)?;
    let cleaned = raw.trim_matches(|c: char| !c.is_ascii_digit());
    cleaned.parse::<u16>().ok()
}

/*
 * 最终端口：**实测的优先，没有实测才用命令行声明的**。
 *
 * 为什么需要这个后备：端口唯一的实测来源是 lsof，而 lsof 在受限环境里会被拦掉
 * （本项目的开发环境就已经拦掉了 ps）。那种情况下端口一列会全空，
 * 而 `--server.port=8080` 是命令行上写死的，照样能读出来。
 *
 * 为什么只在实测为空时才用：命令行声明的是「想绑哪个」，实测的是「真的绑上了」。
 * 两者不一致时（被配置文件覆盖、绑定失败后退让）以实测为准。
 * 也**不做合并**：把声明值也塞进列表会出现一个根本没在监听的端口，
 * 而界面上的端口是要点开去看的。
 *
 * 命令行的 `--server.port` 在 Spring 的属性优先级里仅次于 SPRING_APPLICATION_JSON，
 * 所以这个后备的可信度是够的。
 */
pub fn resolve_ports(observed: &[u16], declared: Option<u16>) -> Vec<u16> {
    if !observed.is_empty() {
        return observed.to_vec();
    }
    declared.map(|p| vec![p]).unwrap_or_default()
}

/* =============================================
   ====== 入口（main class 或 jar） ======
   ============================================= */

/**
 * 一个 token 像不像 Java 的**全限定类名**（`com.example.demo.DemoApplication`）。
 *
 * 为什么要卡这个：`java -Xmx512m com.example.Main --env=prod` 里，
 * 如果只按「第一个不以 - 开头的 token」取，会把 `com.example.Main` 取对；
 * 但 `java -jar a.jar` 之后如果漏判，就会把 `a.jar` 当成类名。
 * 段名必须是合法 Java 标识符，能挡掉 `a.jar` 之外的大部分噪声
 * （`--server.port=8080` 本来就以 - 开头，先被排除了）。
 */
fn looks_like_fqcn(tok: &str) -> bool {
    if !tok.contains('.') || tok.starts_with('-') {
        return false;
    }
    tok.split('.').all(|seg| {
        let mut chars = seg.chars();
        match chars.next() {
            Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$' => {}
            _ => return false,
        }
        chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
    })
}

/**
 * 从命令行取入口：`-jar` 后面是 jar 路径，否则是 main class。
 *
 * 三种真实写法都要认：
 *   `java -jar app.jar`                       → jar 路径
 *   `java -cp a.jar:b.jar com.a.Main`         → classpath 之后第一个非选项 token
 *   `java -Dx=y -javaagent:/p/x.jar com.a.Main` → 跳过所有 - 开头的，取 FQCN
 */
pub fn main_class_of(command: &str) -> Option<String> {
    let args: Vec<&str> = command.split_whitespace().collect();

    if let Some(i) = args.iter().position(|a| *a == "-jar") {
        return args.get(i + 1).map(|s| s.to_string());
    }

    for key in ["-cp", "-classpath", "--class-path"] {
        if let Some(i) = args.iter().position(|a| *a == key) {
            /* i 是 -cp，i+1 是 classpath 的值，i+2 起才是类名 */
            if let Some(mc) = args.iter().skip(i + 2).find(|a| !a.starts_with('-')) {
                return Some(mc.to_string());
            }
        }
    }

    args.iter().find(|a| looks_like_fqcn(a)).map(|s| s.to_string())
}

/* =============================================
   ====== 应用名 ======
   ============================================= */

/**
 * 去掉结尾的版本号：`demo-0.0.1-SNAPSHOT` → `demo`、`my-app-1.2.3` → `my-app`。
 *
 * 取**最后一个** `-<数字>` 作为切点：`my-app-1.2.3` 里 `my-app` 自带横线，
 * 从第一个横线切会变成 `my`。
 */
fn strip_version(s: &str) -> String {
    let mut cut: Option<usize> = None;
    for (i, ch) in s.char_indices() {
        if ch == '-' {
            let rest = &s[i + 1..];
            if rest.starts_with(|c: char| c.is_ascii_digit()) {
                cut = Some(i);
            }
        }
    }
    match cut {
        /* i > 0：`-1.0` 这种整个都是版本号的名字不该被切成空串 */
        Some(i) if i > 0 => s[..i].to_string(),
        _ => s.to_string(),
    }
}

/**
 * 展示名。优先用 jar 文件名（用户认得），其次用 main class 简名。
 *
 * main class 的 `Application` 后缀要去掉：`DemoApplication` → `Demo`，
 * 因为一屏好几个 `XxxApplication` 很难区分。
 */
pub fn app_name(jar: Option<&str>, main_class: Option<&str>) -> String {
    if let Some(j) = jar {
        let base = Path::new(j)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| j.to_string());
        let stem = base.strip_suffix(".jar").unwrap_or(&base);
        let name = strip_version(stem);
        if !name.is_empty() {
            return name;
        }
    }
    if let Some(mc) = main_class {
        let last = mc.rsplit('.').next().unwrap_or(mc);
        if let Some(s) = last.strip_suffix("Application") {
            if !s.is_empty() {
                return s.to_string();
            }
        }
        if !last.is_empty() {
            return last.to_string();
        }
    }
    "未知应用".to_string()
}

/* =============================================
   ====== 杂项展示 ======
   ============================================= */

/** 字节数 → 人读的字符串（actuator 的 diskSpace 组件会给原始字节） */
pub fn human_bytes(n: f64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut v = n;
    let mut i = 0usize;
    while v >= 1024.0 && i + 1 < UNITS.len() {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{} {}", v as u64, UNITS[i])
    } else {
        format!("{v:.1} {}", UNITS[i])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ---- looks_like_java ---- */
    #[test]
    fn 只看第一个_token_的可执行名() {
        assert!(looks_like_java("/opt/jbr/bin/java -jar app.jar"));
        assert!(looks_like_java("java -version"));
        /* 路径里含 java 但不是 java 可执行文件 —— 全文匹配会在这里误判 */
        assert!(!looks_like_java("/Users/fu/java-tools/bin/node index.js"));
        assert!(!looks_like_java(""));
        assert!(!looks_like_java("/usr/bin/javac Foo.java"));
    }

    /* ---- strong_evidence ---- */
    #[test]
    fn 认出_spring_boot_的几种命令行() {
        assert!(strong_evidence("java -cp /root/spring-boot-3.2.jar org.springframework.boot.loader.JarLauncher")
            .iter()
            .any(|e| e.contains("spring-boot")));
        assert!(strong_evidence("java -Dspring.profiles.active=dev -jar a.jar")
            .iter()
            .any(|e| e.contains("spring.profiles")));
        assert!(strong_evidence("java -jar a.jar --server.port=9000")
            .iter()
            .any(|e| e.contains("server.port")));
    }

    /* 大小写不该影响判断（IDEA 有时把 -D 写成 -d，路径也可能有大写） */
    #[test]
    fn 特征匹配不区分大小写() {
        assert!(!strong_evidence("java -DSpring.Profiles.Active=dev -jar a.jar").is_empty());
        assert!(!strong_evidence("java -cp /X/SPRING-BOOT-1.0.jar L").is_empty());
    }

    /* 裸 jar 认不出来 —— 这是**设计如此**，靠 actuator 兜底 */
    #[test]
    fn 裸_jar_没有强特征() {
        assert!(strong_evidence("java -jar /Users/fu/app/target/demo-0.0.1.jar").is_empty());
    }

    #[test]
    fn 弱提示只在名字带_spring_时给() {
        assert_eq!(weak_hint("spring-demo"), Some("名字里带 spring".into()));
        assert_eq!(weak_hint("demo"), None);
    }

    /* ---- profiles ---- */
    #[test]
    fn profile_两种写法都要认() {
        assert_eq!(parse_profiles("java -jar a.jar --spring.profiles.active=dev"), vec!["dev"]);
        assert_eq!(parse_profiles("java -jar a.jar --spring.profiles.active dev"), vec!["dev"]);
        assert_eq!(
            parse_profiles("java -Dspring.profiles.active=prod -jar a.jar"),
            vec!["prod"]
        );
    }

    #[test]
    fn profile_支持逗号多个与去重() {
        assert_eq!(
            parse_profiles("java -jar a.jar --spring.profiles.active=dev,test"),
            vec!["dev", "test"]
        );
        assert_eq!(
            parse_profiles("java -jar a.jar --spring.profiles.active=dev, dev"),
            vec!["dev"]
        );
        /* include 也算 */
        assert_eq!(
            parse_profiles("java -jar a.jar --spring.profiles.include=extra"),
            vec!["extra"]
        );
    }

    #[test]
    fn profile_没有就返回空() {
        assert!(parse_profiles("java -jar a.jar").is_empty());
        assert!(parse_profiles("java -jar a.jar --spring.profiles.active=").is_empty());
    }

    /* ---- server.port ---- */
    #[test]
    fn server_port_解析() {
        assert_eq!(parse_server_port("java -jar a.jar --server.port=9000"), Some(9000));
        assert_eq!(parse_server_port("java -Dserver.port=8081 -jar a.jar"), Some(8081));
        assert_eq!(parse_server_port("java -jar a.jar --server.port 8082"), Some(8082));
        assert_eq!(parse_server_port("java -jar a.jar"), None);
        /* 非法值不猜 */
        assert_eq!(parse_server_port("java -jar a.jar --server.port=abc"), None);
        assert_eq!(parse_server_port("java -jar a.jar --server.port=99999"), None);
    }

    /* ---- resolve_ports（实测优先，声明值只做后备） ---- */
    #[test]
    fn 有实测端口时以实测为准() {
        assert_eq!(resolve_ports(&[9090], Some(8080)), vec![9090]);
    }

    #[test]
    fn 实测有多个端口时原样保留() {
        assert_eq!(resolve_ports(&[8080, 35729], Some(9999)), vec![8080, 35729]);
    }

    #[test]
    fn 没有实测端口时退回声明值() {
        assert_eq!(resolve_ports(&[], Some(8080)), vec![8080]);
    }

    #[test]
    fn 两边都没有就是空() {
        assert_eq!(resolve_ports(&[], None), Vec::<u16>::new());
    }

    /* 不做合并：把声明值也塞进去会出现一个根本没在监听的端口 */
    #[test]
    fn 实测与声明不一致时不合并() {
        let out = resolve_ports(&[9090], Some(8080));
        assert_eq!(out.len(), 1);
        assert!(!out.contains(&8080));
    }

    /* ---- main_class_of ---- */
    #[test]
    fn 入口从_jar_取() {
        assert_eq!(
            main_class_of("java -jar /x/demo-0.0.1.jar --server.port=8080").as_deref(),
            Some("/x/demo-0.0.1.jar")
        );
        assert_eq!(main_class_of("java -Xmx512m -jar a.jar").as_deref(), Some("a.jar"));
    }

    #[test]
    fn 入口从_classpath_之后取() {
        assert_eq!(
            main_class_of("java -cp /a/b.jar:/c/d.jar com.example.Main").as_deref(),
            Some("com.example.Main")
        );
        assert_eq!(
            main_class_of("java -classpath x com.a.B --env=prod").as_deref(),
            Some("com.a.B")
        );
    }

    /* IDEA 起服务时不写 -cp，入口就夹在一堆 -D 与 -javaagent 中间 */
    #[test]
    fn 入口能跳过各种_选项() {
        assert_eq!(
            main_class_of("java -Dspring.profiles.active=dev -javaagent:/p/a.jar com.example.DemoApplication")
                .as_deref(),
            Some("com.example.DemoApplication")
        );
        assert_eq!(
            main_class_of("java -Xmx1g -XX:+UseG1GC com.a.B --server.port=9000").as_deref(),
            Some("com.a.B")
        );
    }

    /* 应用参数不能被当成类名 */
    #[test]
    fn 应用参数不会被当成入口() {
        assert_eq!(main_class_of("java -Xmx1g --env=prod"), None);
        assert_eq!(main_class_of("java"), None);
        assert_eq!(main_class_of(""), None);
        /* 带冒号的 classpath 值不是 FQCN */
        assert_eq!(main_class_of("java /a.jar:/b.jar"), None);
    }

    /* ---- app_name ---- */
    #[test]
    fn 名字从_jar_取并去掉版本号() {
        assert_eq!(app_name(Some("/x/demo-0.0.1-SNAPSHOT.jar"), None), "demo");
        assert_eq!(app_name(Some("/x/my-app-1.2.3.jar"), None), "my-app");
        /* 没有版本号就原样 */
        assert_eq!(app_name(Some("/x/gateway.jar"), None), "gateway");
    }

    #[test]
    fn 名字从_main_class_取并去掉_Application() {
        assert_eq!(app_name(None, Some("com.example.demo.DemoApplication")), "Demo");
        assert_eq!(app_name(None, Some("com.example.Gateway")), "Gateway");
        /* 只有 Application 一个词时别切成空串 */
        assert_eq!(app_name(None, Some("Application")), "Application");
    }

    #[test]
    fn 两者都没有时给占位() {
        assert_eq!(app_name(None, None), "未知应用");
    }

    /* jar 优先于 main class：用户更认得 jar 名 */
    #[test]
    fn jar_优先() {
        assert_eq!(app_name(Some("/x/order-1.0.jar"), Some("com.a.BApplication")), "order");
    }

    /* ---- human_bytes ---- */
    #[test]
    fn 字节换算() {
        assert_eq!(human_bytes(512.0), "512 B");
        assert_eq!(human_bytes(1024.0), "1.0 KB");
        assert_eq!(human_bytes(1024.0 * 1024.0 * 1.5), "1.5 MB");
        assert_eq!(human_bytes(1024.0 * 1024.0 * 1024.0 * 2.0), "2.0 GB");
    }
}
