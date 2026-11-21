/*
 * 全局类型声明
 * 声明 Vite 特有的模块与 CSS 模块导入
 * @Author: fu
 * @LastEditors: fu
 * @Date: 2026-08-26
 */

/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

declare module '*.css' {
  const content: { readonly [key: string]: string };
  export default content;
}

declare module '*.scss' {
  const content: { readonly [key: string]: string };
  export default content;
}

declare module 'react-window' {
  import type { ComponentType, CSSProperties } from 'react';

  export interface VariableSizeListProps {
    height: number;
    itemCount: number;
    itemSize: (index: number) => number;
    estimatedItemSize?: number;
    width: number | string;
    overscanCount?: number;
    ref?: any;
    onItemsRendered?: (p: {
      overscanStartIndex: number;
      overscanStopIndex: number;
      visibleStartIndex: number;
      visibleStopIndex: number;
    }) => void;
    children: (p: { index: number; style: CSSProperties }) => React.ReactNode;
    scrollToItem?: (index: number, align?: 'auto' | 'start' | 'end' | 'center') => void;
    resetAfterIndex?: (index: number, shouldForceUpdate?: boolean) => void;
    /*
     * 下面两个是「关掉自动滚动后冻结画面」要用的（见 LogViewer 的跟随/冻结 effect）：
     * 倒序列表里新行插在最前面，必须读当前位置再把偏移补回去，否则整屏会被顶走。
     * ⚠️ 本文件是**手写**的 react-window 声明，它会顶掉 @types/react-window ——
     * 用到这里没列的成员时，加在这份声明里才管用（改 node_modules 没用）。
     */
    onScroll?: (p: {
      scrollDirection: 'forward' | 'backward';
      scrollOffset: number;
      scrollUpdateWasRequested: boolean;
    }) => void;
    scrollTo?: (scrollOffset: number) => void;
  }

  export const VariableSizeList: ComponentType<VariableSizeListProps>;
}
