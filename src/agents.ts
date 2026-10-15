// 模型实例：整个项目共用一个（createDeepAgent 内部每轮都拿它去请求）
// 这里虽然用的是 ChatAnthropic，但通过自定义 anthropicApiUrl 指向了 DeepSeek 的兼容端点
import { ChatAnthropic } from '@langchain/anthropic';
import { config } from './config'
import path from 'node:path';
import { LocalShellBackend } from 'deepagents';

// 解析 workspace 目录的绝对路径
// import.meta.dirname 是当前文件所在目录（src/），往上一层是项目根目录
const workspaceDir = path.resolve(import.meta.dirname, '..', 'workspace');

export const backend = await LocalShellBackend.create({
  rootDir: workspaceDir,   // Agent 的文件操作根目录
  virtualMode: true,       // 虚拟路径模式（后面详细讲）
  timeout: 30,             // shell 命令超时时间（秒）
  maxOutputBytes: 50000,   // 命令输出最大字节数，防止输出刷屏
});

export const model = new ChatAnthropic({
  model: config.MODEL_NAME, // 模型名，来自 config
  anthropicApiKey: config.ANTHROPIC_API_KEY, // 密钥
  anthropicApiUrl: config.ANTHROPIC_BASE_URL, // 自定义接口地址（默认是官方 Anthropic，这里指向兼容端点）
  streaming: true, // 开启流式：配合 agent.stream 才能逐片（逐 token/逐 block）拿到输出
  maxTokens: 10000, // 单次回复的最大 token 数（思考内容也算在里面）
  // 扩展思考（Extended Thinking）：开启后模型会先输出一段内部推理过程再给正式答案
  // budget_tokens 是思考部分可用的 token 上限，它会占用上面的 maxTokens 预算
  thinking: {
    type: 'enabled',
    budget_tokens: 5000,
  },
});
