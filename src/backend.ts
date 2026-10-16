// 文件系统后端：Agent 读写文件、搜索、执行 shell 命令都走它
// 单独成文件是为了避免「agents.ts ↔ middleware.ts」在模块顶层互相引用形成循环：
// agents.ts 需要 middleware.ts 导出的中间件，middleware.ts 又需要这里的 backend
import { LocalShellBackend } from 'deepagents';
import path from 'node:path';

// 解析 workspace 目录的绝对路径
// import.meta.dirname 是当前文件所在目录（src/），往上一层是项目根目录
const workspaceDir = path.resolve(import.meta.dirname, '..', 'workspace');

export const backend = await LocalShellBackend.create({
  rootDir: workspaceDir,   // Agent 的文件操作根目录
  virtualMode: true,       // 虚拟路径模式（后面详细讲）
  timeout: 30,             // shell 命令超时时间（秒）
  maxOutputBytes: 50000,   // 命令输出最大字节数，防止输出刷屏
});
