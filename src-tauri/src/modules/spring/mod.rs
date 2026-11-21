/*
 * Spring Boot 服务台模块
 * ------------------------------------------------------------------
 * 把本机跑着的 Spring Boot 服务聚到一起：端口、profile、健康状态、资源占用。
 *
 * 分层：
 *   models    数据模型（与前端 types.ts 一一对应）
 *   detect    命令行识别与参数解析（**纯逻辑**，带单测）
 *   actuator  /actuator/health 与 /actuator/info 探活（唯一的网络出口）
 *   commands  Tauri IPC 命令层
 *
 * 进程与端口的采集复用 core::ps（jvm 模块也用同一份，见那里的说明）。
 * @Author: fu
 */
pub mod actuator;
pub mod commands;
pub mod detect;
pub mod models;
