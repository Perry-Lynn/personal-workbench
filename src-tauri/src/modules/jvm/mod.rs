/*
 * JVM 进程看板模块
 * ------------------------------------------------------------------
 * 组成：
 *   models    数据模型（JavaProcess / JvmSnapshot / 转储结果）
 *   sys       采集与解析（jps / ps / lsof / jstat），带超时，纯函数配单测
 *   commands  IPC 命令层
 *
 * JDK 探测**不在这里**：JAR 运行器也要用它，已上收到 core/jdk.rs
 * （模块之间不互相依赖，共用能力只能放 core）。
 * @Author: fu
 */
pub mod models;
pub mod sys;
pub mod commands;
