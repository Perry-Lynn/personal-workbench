import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import pkg from './package.json' with { type: 'json' };

/*
 * 工作台 Vite 构建配置
 * - 别名 @ -> src（核心层与各功能模块共用）
 * - 别名 @logsight -> src/features/logsight（LogSight 模块内部相对导入）
 * - 注入 __APP_VERSION__ 供界面展示
 * @Author: fu
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@logsight': path.resolve(import.meta.dirname, './src/features/logsight'),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
  },
  envPrefix: ['VITE_', 'TAURI_'],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'es2020',
    minify: 'esbuild',
    sourcemap: false,
  },
});
