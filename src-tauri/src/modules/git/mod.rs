/*
 * Git 管理模块
 * ------------------------------------------------------------------
 * 轻量 Git 客户端（IDEA 新 UI 风格）的后端：薄薄一层 git CLI 封装。
 * 分工见 commands.rs 文件头 —— 解析全在前端，这里只负责把 git 跑对。
 * @Author: fu
 */
pub mod commands;
pub mod models;
pub mod runner;
