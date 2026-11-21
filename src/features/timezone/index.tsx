/*
 * 时区对比模块入口
 * ------------------------------------------------------------------
 * 不做成首页的弹窗，理由见 TimezoneView 顶部与 README 的记录，简单说：
 *   · 两个面板 + 两个下拉 + 日期/时间输入，需要 700px 以上的宽度，
 *     首页右栏只有 312px，弹窗又得自己实现遮罩/焦点/ESC（AntD Modal 会把
 *     motion 带进主包，首页那边已经刻意避开过一次）；
 *   · 它有自己的持久化偏好（两个时区）、自己的 1Hz 计时器 —— 这些塞进首页
 *     会让「首页不触发 IPC、不碰主密钥」的边界越来越糊；
 *   · 做成模块自动获得侧栏入口、⌘K 命令面板、模块显隐开关、首页列表项，
 *     这些是弹窗拿不到的。
 * 首页世界时钟右上角的「对比」按钮负责跳到这里（只是个 id，不是依赖）。
 *
 * 无常驻副作用：不订阅蓝牙、不连远端、不轮询，计时器只在本模块挂载时跑。
 * 所以不设 keepAlive，只做代码分割。
 * @Author: fu
 */
import { lazy } from 'react';
import { GlobalOutlined } from '@ant-design/icons';
import type { WorkbenchModule } from '@/core/types';

const TimezoneView = lazy(() => import('./TimezoneView'));

export const timezoneModule: WorkbenchModule = {
  id: 'timezone',
  name: '时区对比',
  description: '两个时区并排对照，改哪边另一边跟着走；支持美国夏令时与 PST / PDT 等缩写',
  icon: <GlobalOutlined />,
  group: '效率',
  order: 33,
  keywords: [
    '时区',
    'timezone',
    'time zone',
    'tz',
    '时差',
    '世界时间',
    '对比',
    '对照',
    '换算',
    '夏令时',
    'dst',
    'pst',
    'pdt',
    'pt',
    'est',
    'edt',
    'et',
    'cst',
    'utc',
    'gmt',
    '洛杉矶',
    '纽约',
  ],
  component: TimezoneView,
};

export default timezoneModule;
