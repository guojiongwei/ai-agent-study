// 前端入口：挂载 App 到 #root
// 这里不用 StrictMode 的副作用：StrictMode 在开发模式下会重复挂载一次，
// 会让 WebSocket 多连一次（虽然 Hook 里已经做了防抖处理，但日志会显得吵）
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点');

createRoot(container).render(<App />);
