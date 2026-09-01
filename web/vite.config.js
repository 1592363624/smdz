/**
 * Vite 前端构建配置
 * - 开发时代理 /api 和 /ws 到后端，避免跨域并支持热更新
 * - 端口 5173
 * - 后端目标可用环境变量 API_TARGET 覆盖（默认 http://localhost:3333），
 *   例如后端临时跑在 13443：API_TARGET=http://localhost:13443 npm run dev
 */
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const apiTarget = process.env.API_TARGET || 'http://localhost:3333';

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
        target: apiTarget,
        changeOrigin: true,
      },
      // WebSocket 公屏代理到后端
      '/ws': {
        target: apiTarget,
        ws: true,
        changeOrigin: true,
      },
      // 上传附件静态资源代理到后端（反馈/私聊的图片与文件）
      '/uploads': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
