/*
 * Maven 助手模块
 * ------------------------------------------------------------------
 * 组成：
 *   models    数据模型（MavenInfo / 仓库统计 / 依赖树与冲突）
 *   locate    找 mvn（项目自带 mvnw > sdkman > Homebrew > /usr/local）与本地仓库
 *   repo      扫 ~/.m2/repository：体积排行、多版本重复、SNAPSHOT
 *   tree      跑 mvn dependency:tree -Dverbose 并解析冲突
 *   commands  IPC 命令层
 *
 * 共用能力一律走 crate::core（进程执行用 core::proc），不直接依赖别的模块。
 * @Author: fu
 */
pub mod models;
pub mod locate;
pub mod repo;
pub mod tree;
pub mod commands;
