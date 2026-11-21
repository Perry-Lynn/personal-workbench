/*
 * JAR 运行器模块
 * ------------------------------------------------------------------
 * 把 jar 拖进来（或用文件选择器选中），配好 JDK 与参数，一键跑起来看日志。
 *
 * 与 spring 模块的差别要记清楚：spring 是**识别已经跑着的** Spring Boot 进程，
 * 本模块是**自己把 jar 跑起来** —— 前者只读，后者要管进程的一生（启动 / 日志 / 停止 / 收尾）。
 *
 * 子模块：
 *   models     配置与运行态的数据结构 + 命令行拼装的纯逻辑（带单测）
 *   storage    sled 持久化（命名空间 jarrunner:configs）
 *   runner     进程管理：长期存活的子进程、逐行输出、批量推送、kill 与收尾
 *   commands   Tauri IPC 命令层
 *
 * 不涉及主密钥：jar 路径与启动参数不是凭据，明文落 sled 即可。
 * 不涉及网络：只在本机 fork java。
 * @Author: fu
 */
pub mod commands;
pub mod models;
pub mod runner;
pub mod storage;

/* 事件名：前端 listen 的必须是这两个字符串 */
pub const EVENT_LOG_LINES: &str = "jarrunner:log-lines";
pub const EVENT_RUN_STATUS: &str = "jarrunner:run-status";
