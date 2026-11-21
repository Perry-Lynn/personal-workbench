/*
 * JVM 进程看板模块 · 数据模型
 * ------------------------------------------------------------------
 * 采集口径：jps 负责「有哪些 JVM」，ps 负责「吃多少资源」，
 * lsof 负责「占了哪些端口」，jstat 负责「堆用了多少」。
 * 四路各自独立失败互不影响 —— 任何一路拿不到，对应字段为 None / 空，
 * 其余字段照常展示（见 commands.rs 的 warnings）。
 *
 * 注意：**不做业务判断**（归类 / 健康度 / 角标）都在前端 format.ts，
 * 那边配纯逻辑断言；这里只产出原始字段。
 *
 * JDK 的字段定义不在本文件，见 core/jdk.rs。
 * @Author: fu
 */
use serde::{Deserialize, Serialize};

/*
 * JdkInfo / JdkSource 已上收 core/jdk.rs —— JAR 运行器也要列 JDK，
 * 而模块之间不互相依赖是本仓的硬约定（共用能力只能放 core）。
 * 这里只把它引进来供 JvmSnapshot 使用，序列化出的字段名不变。
 */
use crate::core::jdk::JdkInfo;

/* 一个本地 Java 进程 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaProcess {
    pub pid: u32,
    /** jps -l 的第二列：全限定主类名，或 -jar 时的 jar 路径 */
    pub main_class: String,
    /** 以 .jar 启动时才有的 jar 绝对路径 */
    pub jar_path: Option<String>,
    /** ps 拿到的完整命令行（判定 Spring Boot profile、jar 名都靠它） */
    pub command: String,
    /** 监听中的 TCP 端口（已去重、升序） */
    pub ports: Vec<u16>,
    /** ps 的 %cpu：进程生命周期内的平均占用，不是瞬时值 */
    pub cpu_percent: f64,
    /** RSS，MB */
    pub mem_mb: f64,
    /** 已运行秒数（ps etime 解析） */
    pub uptime_sec: Option<u64>,
    /** 堆已用 MB（jstat -gc 的 S0U+S1U+EU+OU） */
    pub heap_used_mb: Option<f64>,
    /** 堆容量 MB（S0C+S1C+EC+OC，≈ 当前已提交堆，不等于 -Xmx） */
    pub heap_max_mb: Option<f64>,
    /** 运行它的 JDK 版本（jcmd VM.version 取，失败为 None） */
    pub jdk_version: Option<String>,
}

/* 一次扫描的结果 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JvmSnapshot {
    pub processes: Vec<JavaProcess>,
    pub jdks: Vec<JdkInfo>,
    /** 实际用来跑 jps/jstat 的 JDK；None 表示一台能用的 JDK 都没找到 */
    pub tool_home: Option<String>,
    /** 降级说明（例如「jstat 不可用，堆占用读不到」），界面上直接展示 */
    pub warnings: Vec<String>,
    pub scanned_at: i64,
    /** 本次扫描耗时，用于判断轮询是否该降频 */
    pub elapsed_ms: u64,
    pub platform: String,
}

/* 线程栈 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadDumpResult {
    pub pid: u32,
    pub text: String,
    pub taken_at: i64,
}

/* 堆转储产物 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeapDumpResult {
    pub pid: u32,
    pub path: String,
    pub size_mb: f64,
}

/* 「这个端口是谁占的」 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortOwner {
    pub port: u16,
    /** 没人监听时为 null */
    pub pid: Option<u32>,
    pub command: Option<String>,
    pub found: bool,
}
