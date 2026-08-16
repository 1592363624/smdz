/**
 * Vite 前端构建配置
 * - 开发时代理 /api 和 /ws 到后端，避免跨域并支持热更新
 * - 端口 5173
 */
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    // 关闭 HMR 错误浮窗(右下角那个"Send errors"按钮)
    hmr: {
      overlay: false,
    },
    proxy: {
      // HTTP 接口代理到后端
      '/api': {
        target: 'http://localhost:3333',
        changeOrigin: true,
      },
      // WebSocket 公屏代理到后端
      '/ws': {
        target: 'http://localhost:3333',
        ws: true,
        changeOrigin: true,
      },
      // 上传附件静态资源代理到后端（反馈/私聊的图片与文件）
      '/uploads': {
        target: 'http://localhost:3333',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
