// 中间件：在不改动 Agent 主流程的前提下扩展"记忆"相关行为
// 两个中间件都复用同一个 backend，所以文件路径同样是相对 workspace/ 的虚拟路径
import { createMemoryMiddleware, createSummarizationMiddleware } from 'deepagents';
import { backend } from './backend'

// 摘要压缩：对话变长时把早期消息总结成摘要，避免上下文无限增长（同时省 token）
export const summarizationMiddleware = createSummarizationMiddleware({
  backend,  // 复用已有的 LocalShellBackend
  // 当消息数超过 20 条时触发摘要压缩
  trigger: { type: 'messages', value: 20 },
  // 压缩后保留最近 10 条消息的原文
  keep: { type: 'messages', value: 10 },
});

// 持久记忆：把 AGENTS.md 的内容注入请求，让偏好和约束跨会话依然生效
export const memoryAgentsMiddleware = createMemoryMiddleware({
  backend,
  sources: ['/AGENTS.md'],
  addCacheControl: true,  // 启用 prompt caching
});