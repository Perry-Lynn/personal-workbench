/*
 * Spring Boot 服务台 · 数据模型
 * ------------------------------------------------------------------
 * 字段用 serde camelCase 下发，与前端 src/features/spring/types.ts 一一对应。
 * @Author: fu
 */
use serde::{Deserialize, Serialize};

/** 一个被认作 Spring Boot 应用的 Java 进程 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpringApp {
    pub pid: u32,
    /** 展示名：jar 文件名（去掉版本号）或 main class 的简名 */
    pub name: String,
    pub main_class: Option<String>,
    pub jar: Option<String>,
    pub ports: Vec<u16>,
    /** 从命令行推断的 profile（`--spring.profiles.active=dev`） */
    pub profiles: Vec<String>,
    pub command: String,
    pub cpu_percent: f64,
    pub mem_mb: f64,
    pub uptime_sec: Option<u64>,
    /** **强特征**判定依据（给人看的短句）。空 = 命令行上看不出是 Spring Boot */
    pub evidence: Vec<String>,
    /** 弱提示（名字里带 spring 之类），单独不足以判定 */
    pub hint: Option<String>,
    /**
     * actuator 探活成功 —— 最可靠的确认方式。
     * 「没有强特征但探活成功」也要留在列表里：那才是真实用起来最舒服的场景
     * （裸 jar 启动、没写任何 spring 参数）。
     */
    pub confirmed: bool,
    /** actuator 探测结果；没探测到为 None */
    pub actuator: Option<ActuatorInfo>,
    pub actuator_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActuatorInfo {
    pub base_url: String,
    pub app_name: Option<String>,
    pub app_version: Option<String>,
    /** `/actuator/health` 的 status：UP / DOWN / OUT_OF_SERVICE / UNKNOWN */
    pub status: Option<String>,
    pub components: Vec<HealthComponent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthComponent {
    pub name: String,
    pub status: String,
    /** 组件自身的补充信息（数据库名、剩余磁盘、错误原因…） */
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpringSnapshot {
    pub apps: Vec<SpringApp>,
    /** 扫到的 Java 进程总数（用来解释「为什么只认出两个」） */
    pub java_processes: usize,
    pub elapsed_ms: u64,
    pub warnings: Vec<String>,
}
