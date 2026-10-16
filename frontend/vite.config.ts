import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 前端开发服务器：把 /ws 的 WebSocket 请求代理到后端的 3001 端口，
// 这样前端代码里直接连 `ws://当前host/ws` 即可，不用关心后端地址
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
});
