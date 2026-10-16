// 入口文件：组装 Agent，然后启动 demos.ts 里的示例
// 打印顺序大致是：模型请求 → [调用模型] → 流式思考/正文 → 模型响应 → 工具执行 → 下一次模型请求
// 文件分工：示例都在 demos.ts，人工审批（HITL）的交互逻辑在 hitl.ts，这里只负责组装与启动
import { createDeepAgent } from 'deepagents';
import { MemorySaver } from '@langchain/langgraph';
import { model, backend } from './agents'
import { calculatorTool, getCurrentTimeTool } from './tools';
import {
  demoCalculator,
  demoFollowUp,
  demo4ExecuteShell,
  demo5ExecuteShell,
  demo6ExecuteShell,
  demo6SkillsRefound,
  demo7Agents,
  demo8SkillsProduct,
  demo9SubAgentResearcher,
  demo13InterruptExecute,
  demo14InterruptWriteFile,
  demo15MixedApproval,
} from './demos';
import { memoryAgentsMiddleware, summarizationMiddleware } from './middleware';
import { subagents } from './subagents'

// 创建 Agent：deepagents 内部会用 LangGraph 把流程编排成一张状态图，核心是两个节点来回跳
// 「模型节点」判断要不要调工具 → 需要就去「工具节点」执行 → 结果回灌后再问模型，直到模型不再调工具
export const agent = createDeepAgent({
  model, // 用哪个模型（见 agents.ts）
  tools: [calculatorTool, getCurrentTimeTool], // 注册给模型的工具，会被转成 JSON Schema 一起发给模型
  backend,   // ← 新增：传入文件系统后端
  // 人工审批（HITL）：声明哪些工具在真正执行前需要用户确认
  // - execute: 危险操作 — shell 命令可能删除文件、修改系统配置
  // - write_file / edit_file: 写操作 — 防止 Agent 意外创建或改坏文件
  // 未配置的工具（calculator、read_file 等）自动放行，不打断
  // ⚠️ 需要 checkpointer（已有 MemorySaver），否则无法在中断后恢复
  // 审批的交互逻辑见 hitl.ts
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

// 会话标识：同一个 thread_id 视为同一段对话（记忆共享），不同 thread_id 相互隔离
// 导出给 hitl.ts 使用：中断恢复必须用同一个 config，否则恢复不回原来的执行状态
export const config = { configurable: { thread_id: 'session-1' } };

// 启动入口：跑 demos.ts 里的示例（所有示例都集中在那里）
async function main() {
  // 切换示例：注释掉当前行、放开目标行即可
  // await demoCalculator();
  // await demoFollowUp()
  // await demo4ExecuteShell()
  // await demo5ExecuteShell()
  // await demo6ExecuteShell()
  // await demo6SkillsRefound()
  // await demo7Agents()
  // await demo8SkillsProduct()
  // await demo9SubAgentResearcher()

  // 下面三个是人工审批（HITL）示例：运行到需要审批的工具时，终端会暂停等待键盘输入
  // await demo14InterruptWriteFile()
  await demo15MixedApproval()
  // await demo13InterruptExecute()
}

main()
