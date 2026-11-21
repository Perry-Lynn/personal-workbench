/*
 * 工作台功能模块集合
 * ------------------------------------------------------------------
 * 每个模块一个目录，模块内部自带 commands / models / services / storage。
 * 模块之间不互相依赖；需要共用能力时依赖 crate::core。
 *
 * 新增模块步骤：
 *   1. 新建 src/modules/<模块名>/ 目录，参考 logsight 的划分
 *   2. 在下方 pub mod 声明
 *   3. 在 main.rs 的 generate_handler! 里注册该模块的命令
 * @Author: fu
 */
pub mod logsight;
pub mod aipassport;
pub mod balances;
pub mod jarrunner;
pub mod jvm;
pub mod maven;
pub mod spring;
pub mod snippets;
pub mod git;
pub mod community;
