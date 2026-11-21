/*
 * JAR 运行器 · 配置表单
 * ------------------------------------------------------------------
 * 表单里每一格都对应后端 JarConfig 的一个字段，命令预览由后端算
 * （见 ipc.preview）—— 界面不自己拼命令，避免「预览和真跑的不是一条」。
 *
 * 四个取舍：
 *   1. **jar 路径与配置文件路径都只读**：它们只能来自拖放或文件选择器。
 *      手打路径拼错的概率很高，而拼错的表现是「启动时报一句 No such file」
 *      或「配置没生效但服务照常起来了」，排查成本远高于点一下选择器。
 *   2. **配置文件单独一格**，不塞进「程序参数」让用户手打
 *      `--spring.config.location=file:…`：那条参数长、含空格与中文，
 *      手打一遍就多一个出错的地方。
 *   3. **拆成「基本 / 高级」两个页签**。字段铺开有十来格，一屏放不下就得滚动，
 *      而「往下滑才能看到启动按钮」是最劝退的形态；拆开之后基本页一屏到底，
 *      常用路径（选 jar → 选 JDK → 启动）完全不涉及滚动。
 *   4. **JVM 参数与程序参数是带候选的下拉**（历史 + 常用建议）：
 *      这两格的内容是「调一次、记不住、下次还得翻聊天记录」的典型。
 *      候选只影响输入框，不改变「直接手打也完全可以」这件事。
 *
 * 「将执行」预览与启动按钮**不在页签里**，在表单下方 —— 两个页签下都要能看到
 * 自己到底会跑什么，切页签不该把启动入口藏起来。
 * @Author: fu
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AutoComplete,
  Button,
  Collapse,
  Input,
  Select,
  Space,
  Tabs,
  Tooltip,
  Typography,
} from 'antd';
import {
  ClearOutlined,
  CloseOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  SelectOutlined,
} from '@ant-design/icons';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { jdkLabel } from './format';
import { listArgs, suggestionsFor, type ArgHistory, type ArgKind } from './argHistory';
import { useJarRunnerStore } from './store';
import type { EnvPair } from './types';

const { Text } = Typography;

/** 参数下拉的一组候选 */
interface ArgOptionGroup {
  label: React.ReactNode;
  options: { value: string; label: React.ReactNode }[];
}

/**
 * 拼出某一格参数的下拉候选：**这个 jar 用过的**在前，**常用建议**在后。
 *
 * 历史为空时不显示「用过」那一组 —— 一个空标题比没有标题更让人困惑。
 */
function buildArgOptions(h: ArgHistory, jarPath: string, kind: ArgKind): ArgOptionGroup[] {
  const groups: ArgOptionGroup[] = [];

  const hist = listArgs(h, jarPath, kind);
  if (hist.length > 0) {
    groups.push({
      label: '这个 jar 用过',
      options: hist.map((e) => ({
        value: e.args,
        label: (
          <span className="jar-arg-opt">
            <span className="jar-arg-opt-val">{e.args}</span>
            <span className="jar-arg-opt-note">用过 {e.count} 次</span>
          </span>
        ),
      })),
    });
  }

  groups.push({
    label: '常用',
    options: suggestionsFor(kind).map((s) => ({
      value: s.args,
      label: (
        <span className="jar-arg-opt">
          <span className="jar-arg-opt-val">{s.args}</span>
          <span className="jar-arg-opt-note">{s.note}</span>
        </span>
      ),
    })),
  });

  return groups;
}

const ConfigForm: React.FC = () => {
  const draft = useJarRunnerStore((s) => s.draft);
  const pendingConfigReload = useJarRunnerStore((s) => s.pendingConfigReload);
  const retainedConfigReload = useJarRunnerStore((s) => s.retainedConfigReload);
  const reloadPendingConfig = useJarRunnerStore((s) => s.reloadPendingConfig);
  const keepDraftAfterConfigReload = useJarRunnerStore((s) => s.keepDraftAfterConfigReload);
  const jdks = useJarRunnerStore((s) => s.jdks);
  const setDraft = useJarRunnerStore((s) => s.setDraft);
  const pickJar = useJarRunnerStore((s) => s.pickJar);
  const pickConfigFile = useJarRunnerStore((s) => s.pickConfigFile);
  const argHistory = useJarRunnerStore((s) => s.argHistory);
  const clearArgHistory = useJarRunnerStore((s) => s.clearArgHistory);

  const [tab, setTab] = useState<'basic' | 'advanced'>('basic');

  /*
   * 拖放区的视觉反馈：只在「正拖着」时高亮，别把整个面板搞得一闪一闪。
   *
   * ⚠️ 高亮**不能**靠 DOM 的 dragover / dragleave —— 实测（2026-09-24 查 Tauri/wry 源码）：
   * 本应用没配 `dragDropEnabled`，走默认值 **true**，于是 wry 在 macOS 的 NSView 层
   * （`wry/src/wkwebview/drag_drop.rs`）就把拖放接管了；而 `tauri-runtime-wry` 装的
   * handler **恒返回 true**，wry 便永远不落 `super`（即不调用系统默认实现），
   * WKWebView 根本收不到这次拖放 → **DOM 的 drag 事件一次都不会派发**。
   * 所以真正的高亮来自 Tauri 转发的 `tauri://drag-enter` / `drag-leave`
   * （见 `tauri/src/manager/webview.rs`，四个 drag 事件都会 emit_to_webview）。
   *
   * 下面那对 DOM handler 保留着，只给「万一哪天把 dragDropEnabled 关掉」兜底 ——
   * 那种配置下 DOM 事件才会真的来，且**不 preventDefault 会导航到 file:// 白屏**。
   * 默认配置下它们是死代码，别指望靠它们亮。
   */
  const [domHover, setDomHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const hover = dragging || domHover;

  useEffect(() => {
    const un = [
      listen('tauri://drag-enter', () => setDragging(true)),
      listen('tauri://drag-leave', () => setDragging(false)),
      /* 拖完要清掉：macOS 上落点成功后不一定再补一个 drag-leave */
      listen('tauri://drag-drop', () => setDragging(false)),
    ];
    return () => {
      un.forEach((p) => void p.then((off) => off()));
    };
  }, []);

  const pickFile = useCallback(async () => {
    const picked = await open({
      multiple: false,
      directory: false,
      title: '选择要运行的 jar',
      filters: [{ name: 'JAR 文件', extensions: ['jar'] }],
    });
    /* 多选关掉时返回 string；取消是 null。数组形态防御一下，免得以后打开多选就崩 */
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (typeof path === 'string' && path) pickJar(path);
  }, [pickJar]);

  /* 选配置文件。后缀与 format.ts::isConfigPath 认的那三个保持一致 */
  const pickConfig = useCallback(async () => {
    const picked = await open({
      multiple: false,
      directory: false,
      title: '选择 Spring 配置文件',
      filters: [{ name: '配置文件', extensions: ['yml', 'yaml', 'properties'] }],
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (typeof path === 'string' && path) pickConfigFile(path);
  }, [pickConfigFile]);

  const pickDir = useCallback(async () => {
    const picked = await open({
      multiple: false,
      directory: true,
      title: '选择工作目录（留空则用 jar 所在目录）',
    });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (typeof path === 'string' && path) setDraft({ workDir: path });
  }, [setDraft]);

  const setEnv = useCallback(
    (next: EnvPair[]) => setDraft({ env: next }),
    [setDraft],
  );

  const jdkOptions = [
    { value: '', label: '自动（默认 JDK）' },
    ...jdks.map((j) => ({
      value: j.home,
      label: `${jdkLabel(j.version, j.source)} — ${j.home}`,
    })),
  ];

  /* 自定义命令模式下配置文件不参与拼装，界面上要说清楚，免得用户以为设了没生效 */
  const customMode = draft.customCommand.trim().length > 0;

  /* 「高级」页签里有没有填过东西 —— 有就在标签上点一个小点，免得填完就忘了 */
  const advancedDirty =
    !!draft.jvmArgs.trim() ||
    !!draft.programArgs.trim() ||
    !!draft.workDir.trim() ||
    draft.env.length > 0 ||
    !!draft.customCommand.trim();

  const jvmOptions = useMemo(
    () => buildArgOptions(argHistory, draft.jarPath, 'jvm'),
    [argHistory, draft.jarPath],
  );
  const programOptions = useMemo(
    () => buildArgOptions(argHistory, draft.jarPath, 'program'),
    [argHistory, draft.jarPath],
  );
  const jvmHistCount = listArgs(argHistory, draft.jarPath, 'jvm').length;
  const programHistCount = listArgs(argHistory, draft.jarPath, 'program').length;

  /* ===== 拖放区（基本页签的第一格，也是整个模块的主入口） =====
      高亮由上面那对 tauri://drag-enter / drag-leave 驱动（原因见那段注释）。
      下面三个 DOM handler 只是「dragDropEnabled 被关掉」时的兜底 ——
      那种配置下 DOM 事件才会来，且 preventDefault 是必需的：不拦的话
      webview 会自己去「打开」这个文件（导航到 file://），页面直接白掉。
      路径始终由 Rust 侧的 tauri://drag-drop 事件给（见 service.ts），这里不管取路径；
      拖进来的可能是 jar 也可能是配置文件，分流也在 service.ts。 */
  const dropZone = (
    <div
      className={`jar-drop${hover ? ' jar-drop-hover' : ''}`}
      onClick={pickFile}
      onDragOver={(e) => {
        e.preventDefault();
        setDomHover(true);
      }}
      onDragLeave={() => setDomHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDomHover(false);
      }}
    >
      {draft.jarPath ? (
        <>
          <div className="jar-drop-title">{draft.name || '未命名'}</div>
          <div className="jar-drop-path">{draft.jarPath}</div>
          <div className="jar-drop-hint">
            点击可重新选择 · 也可以直接把 jar 或配置文件拖进窗口
          </div>
        </>
      ) : (
        <>
          <div className="jar-drop-title">把 jar 拖到这里</div>
          <div className="jar-drop-hint">或点击选择文件（.jar）</div>
        </>
      )}
    </div>
  );

  /*
   * 参数格共用的下拉属性。
   * `popupMatchSelectWidth={false}` 让弹层**不跟随输入框宽度**：候选里是完整参数串
   * （`-agentlib:jdwp=…` 那种一条就五六十字符），跟着输入框宽会被压成三四行。
   * 不额外写死 minWidth —— 宽度由内容撑开（候选文本在 CSS 里 nowrap），
   * 也就少一处要跟着 antd 版本改的 API。
   */
  const argPopup = {
    popupMatchSelectWidth: false as const,
    listHeight: 340,
  };

  const basicPane = (
    <div className="jar-form-pane">
      {dropZone}

      <div className="jar-field">
        <div className="jar-label">名称</div>
        <Input
          value={draft.name}
          placeholder="默认取 jar 文件名"
          onChange={(e) => setDraft({ name: e.target.value })}
        />
      </div>

      <div className="jar-field">
        <div className="jar-label">JDK</div>
        <Select<string>
          value={draft.jdkHome}
          options={jdkOptions}
          style={{ width: '100%' }}
          onChange={(v) => setDraft({ jdkHome: v ?? '' })}
          placeholder="自动（默认 JDK）"
        />
      </div>

      <div className="jar-field">
        <div className="jar-label">
          配置文件
          <Text type="secondary" className="jar-label-note">
            （application.yml / .properties）
          </Text>
        </div>
        <Space.Compact style={{ width: '100%' }}>
          <Input value={draft.configFile} readOnly placeholder="留空 = 用 jar 里自带的配置" />
          <Tooltip title="选择配置文件">
            <Button icon={<SelectOutlined />} onClick={pickConfig} />
          </Tooltip>
          <Tooltip title="清除">
            <Button
              icon={<CloseOutlined />}
              disabled={!draft.configFile}
              onClick={() => setDraft({ configFile: '' })}
            />
          </Tooltip>
        </Space.Compact>
        {customMode ? (
          <Text type="secondary" className="jar-hint">
            自定义命令模式下不生效：那时整条命令由你自己写，工作台不再往里追加参数。
          </Text>
        ) : (
          <Text type="secondary" className="jar-hint">
            会拼成 <code>--spring.config.location=file:…</code> 追加在程序参数之后；
            程序参数里已写了这个键时以你写的为准。注意这个键是「替换」掉 jar 内置的
            配置文件、不是叠加 —— 想让外部文件只做覆盖而保留 jar 里的默认值，
            请在程序参数里写 <code>--spring.config.additional-location=file:…</code>。
          </Text>
        )}
      </div>

      <div className="jar-field">
        <div className="jar-label">jar 路径</div>
        <Space.Compact style={{ width: '100%' }}>
          <Input value={draft.jarPath} readOnly placeholder="尚未选择" />
          <Tooltip title="选择文件">
            <Button icon={<SelectOutlined />} onClick={pickFile} />
          </Tooltip>
        </Space.Compact>
      </div>
    </div>
  );

  const advancedPane = (
    <div className="jar-form-pane">
      {/* 高级页签里看不到上面的拖放区，给一行「在给哪个 jar 配参数」的提示 */}
      <Text type="secondary" className="jar-hint">
        当前 jar：{draft.jarPath || '尚未选择'}
      </Text>

      <div className="jar-field">
        <div className="jar-label jar-label-row">
          <span>
            JVM 参数
            <Text type="secondary" className="jar-label-note">
              （在 -jar 之前）
            </Text>
          </span>
          {jvmHistCount > 0 && (
            <Tooltip title="清除这个 jar 的 JVM 参数历史">
              <Button
                type="text"
                size="small"
                className="jar-arg-clear"
                icon={<ClearOutlined />}
                onClick={() => clearArgHistory(draft.jarPath, 'jvm')}
              />
            </Tooltip>
          )}
        </div>
        <AutoComplete
          value={draft.jvmArgs}
          options={jvmOptions}
          placeholder="-Xmx512m -Dfile.encoding=UTF-8"
          onChange={(v) => setDraft({ jvmArgs: v })}
          {...argPopup}
        />
        <Text type="secondary" className="jar-hint">
          下拉里是这个 jar 用过的（启动成功过才会记）与常用的一套参数，选中即整格替换。
        </Text>
      </div>

      <div className="jar-field">
        <div className="jar-label jar-label-row">
          <span>
            程序参数
            <Text type="secondary" className="jar-label-note">
              （在 jar 之后）
            </Text>
          </span>
          {programHistCount > 0 && (
            <Tooltip title="清除这个 jar 的程序参数历史">
              <Button
                type="text"
                size="small"
                className="jar-arg-clear"
                icon={<ClearOutlined />}
                onClick={() => clearArgHistory(draft.jarPath, 'program')}
              />
            </Tooltip>
          )}
        </div>
        <AutoComplete
          value={draft.programArgs}
          options={programOptions}
          placeholder="--spring.profiles.active=dev --server.port=8081"
          onChange={(v) => setDraft({ programArgs: v })}
          {...argPopup}
        />
      </div>

      <div className="jar-field">
        <div className="jar-label">工作目录</div>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            value={draft.workDir}
            placeholder="留空 = jar 所在目录"
            onChange={(e) => setDraft({ workDir: e.target.value })}
          />
          <Tooltip title="选择目录">
            <Button icon={<FolderOpenOutlined />} onClick={pickDir} />
          </Tooltip>
        </Space.Compact>
      </div>

      <Collapse
        ghost
        items={[
          {
            key: 'env',
            label: (
              <span className="jar-adv-label">
                环境变量{draft.env.length ? `（${draft.env.length}）` : ''}
              </span>
            ),
            children: (
              <div className="jar-env">
                {draft.env.length === 0 && (
                  <Text type="secondary" className="jar-hint">
                    只覆盖同名项，不会清空继承来的环境
                  </Text>
                )}
                {draft.env.map((p, i) => (
                  <div className="jar-env-row" key={i}>
                    <Input
                      value={p.key}
                      placeholder="KEY"
                      onChange={(e) =>
                        setEnv(draft.env.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))
                      }
                    />
                    <Input
                      value={p.value}
                      placeholder="value"
                      onChange={(e) =>
                        setEnv(
                          draft.env.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                        )
                      }
                    />
                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => setEnv(draft.env.filter((_, j) => j !== i))}
                    />
                  </div>
                ))}
                <Button
                  size="small"
                  icon={<PlusOutlined />}
                  onClick={() => setEnv([...draft.env, { key: '', value: '' }])}
                >
                  添加一条
                </Button>
              </div>
            ),
          },
          {
            key: 'cmd',
            label: <span className="jar-adv-label">自定义命令</span>,
            children: (
              <div className="jar-env">
                <Text type="secondary" className="jar-hint">
                  填了就整条按它跑，JVM / 程序参数 / 配置文件都不再生效。占位符：
                  <code>{'{java}'}</code> <code>{'{jar}'}</code> 会替换成选中的 java 与 jar
                  绝对路径。
                </Text>
                <Input.TextArea
                  rows={3}
                  value={draft.customCommand}
                  placeholder="{java} -cp target/classes com.example.Main --server.port=8081"
                  onChange={(e) => setDraft({ customCommand: e.target.value })}
                />
              </div>
            ),
          },
        ]}
      />
    </div>
  );

  return (
    <>
      {pendingConfigReload && <Alert className="mb-3" type="warning" showIcon
        message={`安全配置备份已更新「${pendingConfigReload.name || pendingConfigReload.id}」，当前表单含未保存编辑。`}
        description={<Space wrap><Button size="small" type="primary" onClick={reloadPendingConfig}>重新载入恢复配置</Button><Button size="small" onClick={keepDraftAfterConfigReload}>保留未保存编辑</Button></Space>} />}
      {retainedConfigReload && <Alert className="mb-3" type="info" showIcon
        message="当前使用的是恢复前的未保存草稿，尚未载入恢复版本。"
        description={<Space wrap><Typography.Text>保存同一配置会覆盖刚恢复的值。</Typography.Text><Button size="small" type="primary" onClick={reloadPendingConfig}>载入恢复配置</Button></Space>} />}
      <Tabs
        size="small"
        className="jar-form"
        activeKey={tab}
        onChange={(k) => setTab(k as 'basic' | 'advanced')}
        items={[
          { key: 'basic', label: '基本', children: basicPane },
          {
            key: 'advanced',
            label: (
              <span className="jar-tab-label">
                高级
                {/* 小点：高级里填过东西（尤其是自定义命令，它会让别的参数失效）时要看得见 */}
                {advancedDirty && <span className="jar-tab-dot" title="这里填过东西" />}
              </span>
            ),
            children: advancedPane,
          },
        ]}
      />
    </>
  );
};

export default ConfigForm;
