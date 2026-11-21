/*
 * 智能体余额模块入口
 * ------------------------------------------------------------------
 * 读取各 AI 平台余额/用量并在面板展示，连上 AI-Passport 时可推送到徽章，
 * 也可把「使用 / 剩余额度」压成一行挂到系统菜单栏（macOS 顶部状态栏）。
 * 主体组件用 React.lazy 做代码分割，进入模块时才加载。
 * @Author: fu
 */
import { lazy } from 'react';
import { WalletOutlined } from '@ant-design/icons';
import type { WorkbenchModule } from '@/core/types';
import { balancesBadge, startBalancesService, subscribeBalancesBadge } from './service';

const BalancesView = lazy(() => import('./BalancesView'));

/*
 * 启动常驻服务（连上蓝牙时自动推送余额摘要）。
 * 放在这里而不是组件里：模块入口被 core/modules.ts 静态引用，
 * 因此应用一启动服务就在跑 —— 用户不必先打开过「智能体余额」，
 * 徽章连上也会收到推送。见 service.ts 顶部的说明。
 */
startBalancesService();

export const balancesModule: WorkbenchModule = {
  id: 'balances',
  name: '智能体余额',
  description: '读取 ChatGPT / Qoder CN / OpenAI / Claude / Gemini 等平台的余额或用量，可显示到系统菜单栏，也可推送到 AI-Passport 徽章',
  icon: <WalletOutlined />,
  group: '效率',
  order: 25,
  keywords: ['余额', '用量', 'quota', 'balance', 'chatgpt', 'qoder', 'openai', 'claude', 'gemini', '额度', '菜单栏', '状态栏', '托盘'],
  component: BalancesView,
  /*
   * 常驻：切走后不卸载。
   * 自动推送本身已经不依赖它了（那是 service.ts 的模块级订阅，与界面无关），
   * 这里保活只是免得每次切回来都重走一遍「拉平台列表 + 刷新」。
   */
  keepAlive: true,
  /*
   * 侧栏角标：额度跌破 50% 时显示最低的剩余百分比。
   * 它不依赖蓝牙 —— 徽章没连的时候，这是应用里唯一的提示。
   */
  badge: () => balancesBadge(),
  badgeSubscribe: (onChange) => subscribeBalancesBadge(onChange),
};

export default balancesModule;
