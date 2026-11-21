/*
 * Maven 助手模块 · 数据模型
 * ------------------------------------------------------------------
 * 两块能力，数据分开：
 *   1. 本地仓库（~/.m2/repository）的体积与重复版本 —— 纯文件系统扫描，很快
 *   2. 单个项目的依赖树与版本冲突 —— 要跑 mvn，慢（几十秒），按需触发
 *
 * 业务判断（格式化、排序取前 N、摘要文案）都在前端 format.ts 配断言，
 * 这里只产出原始字段。
 * @Author: fu
 */
use serde::{Deserialize, Serialize};

/* mvn 是从哪儿找到的 */
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MavenSource {
    Sdkman,
    Brew,
    System,
    /* 项目自带的 Maven Wrapper（./mvnw）—— 最可靠，版本与项目一致 */
    Wrapper,
}

/** mvn 可执行文件的位置与版本 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MavenInfo {
    pub found: bool,
    /** mvn 绝对路径；未找到时为空串 */
    pub path: String,
    pub version: String,
    pub source: Option<MavenSource>,
    /** 本地仓库路径（默认 ~/.m2/repository；可由 ~/.m2/settings.xml 改） */
    pub repo_path: String,
    pub repo_exists: bool,
}

/* =============================================
   ====== 本地仓库 ======
   ============================================= */

/** 一个「包」的某个版本（仓库扫描的最小单位） */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVersion {
    pub group: String,
    pub artifact: String,
    pub version: String,
    /** 该版本目录下所有文件的总大小（字节） */
    pub bytes: u64,
    /** 目录最后修改时间（Unix 秒，即这个依赖是什么时候拉下来的） */
    pub modified_at: i64,
    pub is_snapshot: bool,
}

/** 体积排行里的一项（按 group 或 artifact 聚合后的结果） */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SizeEntry {
    /** groupId，或 "groupId:artifactId" —— 取决于聚合维度 */
    pub key: String,
    pub bytes: u64,
    /** 该 key 下有多少个 artifact（group 维度时）/ 多少个版本（artifact 维度时） */
    pub count: usize,
}

/** 同一个 artifact 存了多个版本 —— 清理的主要目标 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateEntry {
    pub group: String,
    pub artifact: String,
    /** 已存的版本列表（按目录名原样保留） */
    pub versions: Vec<String>,
    /** 这些版本加起来占多少字节 */
    pub bytes: u64,
    /**
     * 单个版本里**最大**的那个占多少字节。
     *
     * 有了它才能算出「清掉旧版本能释放多少」= bytes - largest_bytes。
     * 不给这个数的话只能按「版本数平分」估算，而真实仓库里
     * 一个 SNAPSHOT 往往比其它版本大得多，估算会偏得离谱。
     */
    pub largest_bytes: u64,
    /** 其中 SNAPSHOT 版本的数量 */
    pub snapshot_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStats {
    pub repo_path: String,
    pub total_bytes: u64,
    /** 仓库里有多少个 group:artifact */
    pub artifact_count: usize,
    /** 有多少个版本目录 */
    pub version_count: usize,
    pub snapshot_count: usize,
    /** 体积最大的若干 group（已按体积降序，最多 15 条） */
    pub top_groups: Vec<SizeEntry>,
    /** 体积最大的若干 artifact（已按体积降序，最多 15 条） */
    pub top_artifacts: Vec<SizeEntry>,
    /** 存了多个版本的 artifact（已按占用降序，最多 30 条） */
    pub duplicates: Vec<DuplicateEntry>,
    pub scanned_at: i64,
    pub elapsed_ms: u64,
}

/* =============================================
   ====== 依赖树 ======
   ============================================= */

/** 为什么这一条被 Maven 丢掉了 */
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OmitReason {
    /** 与另一个版本冲突（仲裁输了） */
    Conflict,
    /** 同一版本已经在别处出现过了 */
    Duplicate,
    /** 版本被 dependencyManagement 改写了 */
    Managed,
    /** 被 <exclusions> 排除了 */
    Excluded,
    /** 其它 / 认不出来 */
    Other,
}

/** 依赖树的一行 */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepLine {
    pub depth: usize,
    pub group: String,
    pub artifact: String,
    pub version: String,
    /** packaging（jar / war / pom），解析不出时为空串 */
    pub packaging: String,
    /** compile / test / provided / runtime */
    pub scope: String,
    /** 被丢弃的原因；None = 这条真的被引入 */
    pub omit_reason: Option<OmitReason>,
    /**
     * 冲突时赢家是哪个版本（来自 "omitted for conflict with X" 的 X）。
     * 这是「到底谁赢了」的唯一来源 —— 输家那行写着自己的版本，
     * 而赢家的版本只出现在这个短语里。
     */
    pub conflict_with: Option<String>,
}

/** 一次版本仲裁（同一个包有多个版本在竞争） */
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub group: String,
    pub artifact: String,
    /** 胜出的版本 */
    pub winner: String,
    /** 被仲裁掉的版本（可能多个） */
    pub losers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeResult {
    /** 项目自己的坐标，如 com.example:demo:1.0.0 */
    pub root: String,
    pub lines: Vec<DepLine>,
    pub conflicts: Vec<Conflict>,
    /** mvn 的原始输出（界面上「查看原始输出」用） */
    pub raw: String,
    pub elapsed_ms: u64,
    /** 非致命提示，例如「离线模式下有插件没解析到」 */
    pub warnings: Vec<String>,
}
