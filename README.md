# 个人工作台

> 一个可扩展的桌面工作台：**外壳稳定，功能以模块形式接入**。
> 当前内置 LogSight 日志查看模块，后续新功能只需新增一个模块目录 + 注册一行，不需要动外壳。

技术栈：Tauri 2 · React 18 · TypeScript · Ant Design 6 · Zustand · Tailwind CSS · Rust

---

## 界面

| 工作台首页（浅色） | 日志查看模块 |
| --- | --- |
| ![首页](docs/screenshots/01-首页-浅色.png) | ![日志查看](docs/screenshots/02-日志查看模块.png) |

| 设置 | 工作台首页（深色） |
| --- | --- |
| ![设置](docs/screenshots/03-设置模块.png) | ![深色](docs/screenshots/04-首页-深色.png) |

---

## 快速开始

```bash
npm install
npm run tauri:dev      # 启动桌面应用（开发模式）
```

只调试前端界面（不含 Tauri 能力）：

```bash
npm run dev
```

构建与检查：

```bash
npm run typecheck      # TypeScript 类型检查
npm run build          # 前端生产构建
npm run tauri:build    # 打桌面安装包
```

环境要求：Node.js 20+、Rust stable 与 Cargo、Tauri 2 所需的系统构建工具、macOS 12+。

---

## 目录结构

```text
src/
├── core/                     # 工作台核心层（所有模块共用）
│   ├── types.ts              #   WorkbenchModule 模块契约
│   ├── registry.ts           #   模块注册表（查询 / 分组 / 搜索）
│   ├── modules.ts            #   ★ 模块清单：新增模块的唯一注册点
│   ├── theme.ts              #   双主题色板 + AntD 配置 + 基准字号
│   ├── useModules.ts         #   模块列表 Hook
│   ├── ipc.ts                #   call()：invoke + ApiResponse 拆包
│   ├── export.ts             #   导出到磁盘（走系统保存对话框，见「约定 · 导出到磁盘」）
│   ├── lifecycle.ts          #   窗口生命周期（关窗转后台 / 唤回）
│   ├── tray.ts               #   系统菜单栏（主项 + 平台项的能力层）
│   ├── masterKey.ts          #   主密钥的前端消费封装
│   ├── dockIcon.ts           #   程序坞图标切换
│   ├── clipboard.ts          #   剪贴板
│   └── text.ts               #   文本工具
├── shell/                    # 工作台外壳（不含任何业务逻辑）
│   ├── AppShell.tsx          #   整体布局（根容器透明，供磨砂玻璃透出）
│   ├── SidebarNav.tsx        #   侧栏模块导航（分组 / 搜索 / 拖拽调宽）
│   ├── TopBar.tsx            #   顶部栏（折叠 / 当前位置 / 主题切换）
│   ├── ModuleHost.tsx        #   模块挂载：懒加载 + 保活 + 错误隔离
│   └── titlebarDrag.ts       #   顶栏拖动（WKWebView 不认 -webkit-app-region）
├── store/
│   └── useWorkbenchStore.ts  # 工作台级状态（主题 / 当前模块 / 侧栏 / 模块偏好）
├── features/                 # ★ 各功能模块，一个目录一个模块
│   ├── home/                 #   工作台首页
│   ├── logsight/             #   日志查看（SSH 实时 tail / 历史查询 / logback 解析）
│   ├── jvm/                  #   JVM 进程看板
│   ├── jarrunner/            #   JAR 运行器（复用日志查看器的输出面板）
│   ├── spring/               #   Spring Boot 服务识别与探活
│   ├── maven/                #   Maven 仓库与依赖分析
│   ├── snippets/             #   片段库
│   ├── aipassport/           #   AI-Passport 徽章（BLE 推送）
│   ├── balances/             #   智能体余额 / 用量（含系统菜单栏）
│   └── settings/             #   设置
├── App.tsx                   # 主题接入 AntD + 渲染外壳
├── main.tsx                  # 入口：注册模块 → 同步主题 → 校验当前模块 → 挂载
└── index.css                 # 核心设计令牌 --wb-* + 全局样式

src-tauri/src/
├── main.rs                   # 入口：注册工作台级命令 + 各模块命令
├── core/                     # 工作台级 Rust 能力（所有模块共用）
│   ├── api.rs                #   ApiResponse 统一响应包
│   ├── crypto.rs             #   AES-256-GCM + Argon2id
│   ├── storage.rs            #   sled KV（按命名空间隔离）+ app_data_dir 唯一入口
│   ├── master.rs             #   主密钥（系统钥匙串优先，本地兜底）
│   ├── lifecycle.rs          #   窗口生命周期：关窗转后台 / 唤回 / 退出收尾
│   ├── tray.rs               #   系统菜单栏（主项与平台项的可见性规则）
│   ├── dock.rs               #   程序坞图标（NSApp.setApplicationIconImage_）
│   ├── jdk.rs                #   JDK 探测（jvm 与 jarrunner 共用）
│   ├── export.rs             #   写盘导出（WKWebView 不接 Blob 下载，见「约定 · 导出到磁盘」）
│   └── proc.rs / ps.rs       #   子进程执行 / ps 采集
└── modules/                  # 每个模块一个目录，命令前缀 <模块名>_*
    ├── logsight/             #   ssh / log_stream / logback_parser
    ├── jvm/  jarrunner/  spring/  maven/  snippets/
    ├── aipassport/           #   BLE 徽章设备协议
    └── balances/             #   各平台取数 + 后台刷新调度 + 菜单栏推送
```

---

## 新增一个功能模块

只需三步，**不需要修改侧栏、首页、设置页、ModuleHost**——它们全部从注册表读数据。

### 1. 写模块主体

```text
src/features/<模块名>/
├── index.tsx        # 模块定义（导出 WorkbenchModule）
├── MyView.tsx       # 模块主体组件
└── <模块名>.css      # 模块专属样式（可选）
```

`src/features/demo/index.tsx`：

```tsx
import { lazy } from 'react';
import { ThunderboltOutlined } from '@ant-design/icons';
import type { WorkbenchModule } from '@/core/types';

/* 用 React.lazy 做代码分割：不进这个模块就不加载它的代码 */
const DemoView = lazy(() => import('./DemoView'));

export const demoModule: WorkbenchModule = {
  id: 'demo',                    // 唯一 id，同时是本地偏好与存储的 key
  name: '示例功能',               // 侧栏与首页卡片显示名
  description: '一句话说明这个模块做什么',
  icon: <ThunderboltOutlined />, // 侧栏 + 首页卡片图标
  group: '效率',                  // 总览 / 运维 / 效率 / 内容 / 系统
  order: 100,                    // 同组内排序，越小越靠前
  keywords: ['demo', '示例'],     // 侧栏搜索关键词
  version: '0.1.0',
  keepAlive: false,              // 切走是否保留状态（有长连接才需要 true）
  component: DemoView,
};

export default demoModule;
```

### 2. 注册到模块清单

`src/core/modules.ts` 加两行：

```ts
import demoModule from '@/features/demo';

const FEATURE_MODULES: WorkbenchModule[] = [logsightModule, demoModule];
```

### 3. （可选）加后端能力

在 `src-tauri/src/modules/demo/` 下写命令，然后：

- 命令名统一加 `demo_` 前缀（避免与 `workbench_*`、`logsight_*` 撞名）
- 在 `src-tauri/src/modules/mod.rs` 加 `pub mod demo;`
- 在 `src-tauri/src/main.rs` 的 `generate_handler!` 里注册
- 存储用 `StorageService` 的命名空间接口，前缀统一为 `demo:`
- 主密钥 / 加解密直接复用 `crate::core::{master, crypto}`，不要自己实现

---

## 模块契约

`WorkbenchModule` 的完整字段见 `src/core/types.ts`，几个关键点：

| 字段 | 作用 |
| --- | --- |
| `component` | 模块主体。推荐用 `React.lazy` 包裹以获得按需加载 |
| `keepAlive` | `true` 时切走不卸载（`display:none` 隐藏），保留滚动位置与长连接。日志流这类模块必须开 |
| `badge` + `badgeSubscribe` | 侧栏角标。只给 `badge` 会随侧栏重渲染更新；要实时刷新再配 `badgeSubscribe` |
| `hiddenInSidebar` | 声明为不在侧栏显示（仍可从首页卡片进入） |
| `group` / `order` | 决定侧栏位置 |
| `onActivate` / `onDeactivate` | 切入 / 切走回调 |

模块之间**不直接互相引用**，需要共享能力时依赖 `@/core` 或 `@/store`。

---

## 约定

这些约定是为了「模块一多也不会乱」，新增模块请遵守。

### 命令命名

| 前缀 | 归属 | 位置 |
| --- | --- | --- |
| `workbench_*` | 工作台级能力（主密钥、通用加解密） | `src-tauri/src/core/` |
| `<模块名>_*` | 某个模块的能力 | `src-tauri/src/modules/<模块名>/` |

前端 `invoke` 命令名必须与 Rust 端 `#[tauri::command]` 函数名完全一致。

### 事件命名

`<模块名>:<事件名>`，例如 `logsight:log-lines`。
工作台级事件用 `workbench:` 前缀，例如 `workbench:app-closing`。

### 存储命名空间

`<模块名>:<用途>`，例如 `logsight:servers`。
工作台自身设置放在 `workbench` 命名空间。各模块数据互不干扰。

### 导出到磁盘

**不要用 `Blob` + `a[download]`** —— 主窗口是 `tauri.conf.json` 里声明的，挂不上 wry 的
`on_download`，下载请求会被**静默 Cancel**：点了什么都不发生，也不报错。
统一走 `@/core/export.ts` 的 `exportTextFile()`：系统保存对话框选路径 → 后端写盘
（用户取消时返回 `null`，那不是错误，别弹红条）。
（对照组：`<input type="file">` 打开面板是**能用**的，所以「导入」不受影响。）

### 样式与主题

- 核心设计令牌定义在 `src/index.css`，变量前缀 `--wb-*`，随 `html.dark` / `html.light` 自动切换
- 写样式请用 `--wb-*` 变量或 Tailwind 的 `wb-*` 类名（如 `text-wb-text-secondary`、`bg-wb-bg-surface`）
- **不要硬编码色值**，否则双主题会失效。覆盖 AntD 自带样式（Tooltip / Popover / 滚动条）时也一样：
  那些地方用 `--wb-overlay-*` / `--wb-scrollbar-*` 令牌，色值只写在主题块里
- 模块自己的组件类样式放在模块目录下的 css 文件里，不要写进 `src/index.css`

### 磨砂玻璃（窗口材质）

外壳的毛玻璃是**三处联动**，少一处就看不到效果、或者看着像坏了：

| 位置 | 做什么 |
| --- | --- |
| `src-tauri/Cargo.toml` | `tauri` 开 `macos-private-api` 特性（代价：无法上架 App Store） |
| `src-tauri/tauri.conf.json` | 窗口 `transparent: true` + `windowEffects`（`underWindowBackground` / `followsWindowActiveState`）+ `macOSPrivateApi: true` |
| 网页分层 | `html` / `body` / `AppShell` 根容器**必须透明**；侧栏与顶栏用 `--wb-glass-chrome`；`<main>` 与 `ModulePane` 保持不透明（正文不压在模糊背景上） |

材质跟随的是**窗口**的浅色/深色外观，不是网页的 `html.dark` class —— 所以切主题时要同步原生窗口
（`useWorkbenchStore` 的 `applyNativeWindowTheme`，`setTheme` 与启动时各调一次），否则深浅会错配。

### 状态划分

- 工作台级状态（主题、当前模块、侧栏、模块偏好、本地主密钥）→ `src/store/useWorkbenchStore.ts`
- 模块自己的状态 → `src/features/<模块名>/store/`
- 不要把模块业务状态塞进工作台 store

### 工作台级能力：本地主密钥

主密钥是所有模块加密本地敏感数据的根密钥，**一个工作台只有一把**，由后端
`src-tauri/src/core/master.rs` 统一管理。前端状态放在 `useWorkbenchStore`
（`masterKey` / `masterKeyStatus` / `masterKeySource` / `masterKeyWarning`），
启动时由 `src/main.tsx` 触发一次恢复（异步，不阻塞首帧），模块只消费、不自己初始化。

存储策略是**系统钥匙串优先、本地数据目录兜底**：

| 情况 | 行为 |
| --- | --- |
| 系统钥匙串可用 | 密钥存钥匙串，本地不留副本 |
| 钥匙串不可用（被锁定 / 无权限 / 受限启动环境） | 密钥暂存本地 `workbench/app_master_key`，界面提示降级原因 |
| 钥匙串恢复可用 | 下次启动或点「重试」时自动迁回钥匙串，并删除本地副本 |

恢复顺序：工作台钥匙串 → 本地兜底 / 旧版遗留 → 旧版 LogSight 钥匙串（`com.fu.logsight`，一次性继承）
→ 都没有则新建；若本地已有加密数据但密钥找不到，则报错并等待用户确认重建。

排查入口：**设置 → 本地密钥**，可查看状态、存储位置、降级原因，并提供「重试」与「重建」。
LogSight 模块在密钥不可用时会显示常驻提示条，而不是只闪一个 toast。

> 受限启动环境（例如被其它工具以沙箱方式拉起）会同时导致本地数据目录与系统钥匙串写入被拒。
> 此时应用会降级到本地存储并如实提示；正常从终端或访达启动即可回到钥匙串。

---

## 内置模块

模块清单的唯一真值来源是 `src/core/modules.ts`，下表按侧栏分组排列。

| 模块 | id | 分组 | 说明 |
| --- | --- | --- | --- |
| 工作台首页 | `home` | 总览 | 所有功能模块的入口总览，显示最近使用与模块分组 |
| 日志查看 | `logsight` | 运维 | SSH 远程日志查看：实时 `tail -F`、历史查询、关键字/正则/级别/线程/logger/traceId 过滤、logback 配置解析、多服务器多标签 |
| JVM 与 Spring | `jvm` | 运维 | 两个标签：本机 Java 进程看板（端口占用、CPU 与堆占用、一键线程栈 / 堆转储 / 结束进程）+ 本机 Spring Boot 服务（状态、端口、profile 与健康组件，可一键打开 actuator 页面） |
| JAR 运行器 | `jarrunner` | 运维 | 把 jar 拖进来就能跑：选 JDK、配 JVM 与程序参数，实时看 stdout / stderr（输出面板复用日志查看器） |
| Maven 助手 | `maven` | 效率 | 本地仓库体积与重复版本分析，以及单个项目的依赖树与版本冲突 |
| 片段库 | `snippets` | 效率 | 本地可复用的命令与代码片段：标签分类、搜索、一键复制 |
| AI Passport | `aipassport` | 设备 | 蓝牙连接 AI-Passport 徽章，推送通知 / 提醒 / 日程，或清空设备列表 |
| 智能体余额 | `balances` | 效率 | 读取 ChatGPT / Qoder CN / Trae / OpenAI / Claude / Gemini 等平台的余额或用量（Trae 支持「一键抓取」网页登录态），可显示到系统菜单栏，也可推送到 AI-Passport 徽章 |
| 设置 | `settings` | 系统 | 主题外观、侧栏行为、模块显示管理、本地数据、版本信息 |

### LogSight 模块说明

由原独立项目 LogSight v0.2.2 迁移而来，迁移时的改动：

1. 移除自带窗口标题栏与全局主题配置，改为模块内工具栏，主题由工作台统一提供
2. 主题状态上移到工作台 store，模块 store 不再持有；**主密钥同样上移**（见上文「工作台级能力：本地主密钥」），模块不再自己恢复/缓存
3. 命令加 `logsight_` 前缀，事件加 `logsight:` 前缀，存储命名空间改为 `logsight:*`
4. 加解密与 KV 存储上移到 `src-tauri/src/core/`，作为工作台级能力供后续模块复用
5. 开启 `keepAlive`，切换模块不会断开日志流

安全设计保持原样：日志只经 SSH 在本机处理，不上传第三方；凭据用系统钥匙串主密钥 + AES-256-GCM + Argon2id 加密后存本地；连接前校验 `~/.ssh/known_hosts` 主机指纹。

---

## 已知待办

- `src/core/modules.ts` 目前是静态清单。若将来需要运行时装卸模块，可基于 `registry` 的订阅能力扩展
- 侧栏角标依赖模块自己提供 `badgeSubscribe`，未提供时只在侧栏重渲染时刷新
- 一部分观感**只能真机确认**（开发环境起不了 GUI）：系统菜单栏文字的实际位置与字号、
  JAR 运行器复用日志查看器后的视觉、关窗转后台后左键唤回的手感
- `spring` 的 `ps` 采集路径在沙箱下会被拦，单测里走的是「跳过」而非真验证，真机需确认一次
