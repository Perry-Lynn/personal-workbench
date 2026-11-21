/*
 * Spring Boot 服务台 · 用户偏好
 * ------------------------------------------------------------------
 * 只存一个开关：要不要自动探活 actuator。
 *
 * 为什么值得持久化：探活会向每个候选端口发 HTTP 请求。用户如果刻意关掉它
 * （比如某些端口上挂着自己写的服务，不希望被工作台戳），
 * 下次启动又被打开就很烦。
 * @Author: fu
 */
import { create } from 'zustand';

const LS_KEY = 'workbench:spring-prefs';

interface PrefsState {
  /** 扫描时是否自动探活 actuator（默认开：这是最可靠的识别手段） */
  probeEnabled: boolean;
  setProbeEnabled: (v: boolean) => void;
}

function loadProbe(): boolean {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return true;
    const p = JSON.parse(raw) as { probeEnabled?: unknown };
    return typeof p.probeEnabled === 'boolean' ? p.probeEnabled : true;
  } catch {
    return true;
  }
}

export const useSpringPrefs = create<PrefsState>((set) => ({
  probeEnabled: loadProbe(),
  setProbeEnabled: (v) => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ probeEnabled: v }));
    } catch {
      /* 隐私模式等场景下忽略 */
    }
    set({ probeEnabled: v });
  },
}));
