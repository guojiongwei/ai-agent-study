// 模型实例 + Agent 组装：整个项目共用一个 agent
// 命令行示例（index.ts / demos.ts）和 WebSocket 服务（server.ts）都从这里拿 agent
// 这里虽然用的是 ChatAnthropic，但通过自定义 anthropicApiUrl 指向了 DeepSeek 的兼容端点
import { ChatAnthropic } from '@langchain/anthropic';
import { MemorySaver } from '@langchain/langgraph';
import { createDeepAgent } from 'deepagents';
import { config } from './config'
import { backend } from './backend'
import { calculatorTool, getCurrentTimeTool } from './tools';
import { subagents } from './subagents'
import { memoryAgentsMiddleware, summarizationMiddleware } from './middleware';

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

// 创建 Agent：deepagents 内部会用 LangGraph 把流程编排成一张状态图，核心是两个节点来回跳
// 「模型节点」判断要不要调工具 → 需要就去「工具节点」执行 → 结果回灌后再问模型，直到模型不再调工具
export const agent = createDeepAgent({
  model, // 用哪个模型（见上方）
  tools: [calculatorTool, getCurrentTimeTool], // 注册给模型的工具，会被转成 JSON Schema 一起发给模型
  backend,   // 文件系统后端（见 backend.ts）
  // 人工审批（HITL）：声明哪些工具在真正执行前需要用户确认
  // - execute: 危险操作 — shell 命令可能删除文件、修改系统配置
  // - write_file / edit_file: 写操作 — 防止 Agent 意外创建或改坏文件
  // 未配置的工具（calculator、read_file 等）自动放行，不打断
  // ⚠️ 需要 checkpointer（已有 MemorySaver），否则无法在中断后恢复
  // 命令行下的审批交互见 hitl.ts；WebSocket 下的审批见 server.ts
  interruptOn: {
    execute: {
      allowedDecisions: ['approve', 'reject'] as const,
      description: '⚠️ Shell 命令即将执行，请确认后审批',
    },
    write_file: {
      allowedDecisions: ['approve', 'edit', 'reject'] as const,
      description: '📝 文件写入操作，请审批',
    },
    edit_file: {
      allowedDecisions: ['approve', 'edit', 'reject'] as const,
      description: '📝 文件编辑操作，请审批',
    },
  },
  // 注意：这里没有 permissions，因为 LocalShellBackend 支持 execute，两者不兼容
  // 系统提示词：相当于每轮请求里的第一条 system 消息，用来交代身份与"什么时候该用工具"
  systemPrompt:
    '你是一个乐于助人的 AI 助手。\n' +
    '你可以进行数学计算、查询时间，还可以读写文件、搜索文件、执行 shell 命令。\n' +
    '操作文件时，路径是相对于工作目录的。' +
    '你有持久记忆（AGENTS.md），可以记住用户偏好。\n' +
    '你还有领域知识库（Skills），可以回答产品相关问题。\n' +
    '当用户要求你写代码、创建文件时，请使用 write_file 工具将代码保存到文件中，而不是只在回复中展示代码。',
  // 检查点：把每一步的对话状态（消息列表）持久化下来
  // 这样同一个 thread_id 的下一次调用会自动带上历史消息，实现"多轮记忆"
  checkpointer: new MemorySaver(),
  // 持久记忆：加载该文件作为长期上下文（路径相对 backend 的 rootDir，即 workspace/）
  memory: ['/AGENTS.md'],
  // 领域知识：扫描 /skills/ 下所有子目录
  // 每个含 SKILL.md 的子目录被注册为一个 skill
  skills: ['/skills/'],
  // 子 Agent：主 Agent 用 task 工具按 description 委派任务（定义见 subagents.ts）
  subagents,
  // 中间件：摘要压缩 + 记忆注入（定义见 middleware.ts）
  middleware: [summarizationMiddleware, memoryAgentsMiddleware],
});
