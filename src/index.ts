// 入口文件：组装 Agent，然后启动 demos.ts 里的示例
// 打印顺序大致是：模型请求 → [调用模型] → 流式思考/正文 → 模型响应 → 工具执行 → 下一次模型请求
import { createDeepAgent } from 'deepagents';
import { MemorySaver } from '@langchain/langgraph';
import { model, backend } from './agents'
import { calculatorTool, getCurrentTimeTool } from './tools';
import { demoCalculator, demoFollowUp, demo4ExecuteShell, demo6ExecuteShell, demo6SkillsRefound, demo7Agents } from './demos';
import { memoryAgentsMiddleware, summarizationMiddleware } from './middleware';

// 创建 Agent：deepagents 内部会用 LangGraph 把流程编排成一张状态图，核心是两个节点来回跳
// 「模型节点」判断要不要调工具 → 需要就去「工具节点」执行 → 结果回灌后再问模型，直到模型不再调工具
export const agent = createDeepAgent({
  model, // 用哪个模型（见 agents.ts）
  tools: [calculatorTool, getCurrentTimeTool], // 注册给模型的工具，会被转成 JSON Schema 一起发给模型
  backend,   // ← 新增：传入文件系统后端
  // 注意：这里没有 permissions，因为 LocalShellBackend 支持 execute，两者不兼容
  // 系统提示词：相当于每轮请求里的第一条 system 消息，用来交代身份与"什么时候该用工具" // 注意：这里没有 permissions，因为 LocalShellBackend 支持 execute，两者不兼容
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
  // 中间件：摘要压缩 + 记忆注入（定义见 middleware.ts）
  middleware: [summarizationMiddleware, memoryAgentsMiddleware],
});

// 启动入口：跑 demos.ts 里的示例（所有示例都集中在那里）
async function main() {
  // 默认跑第一个示例；想验证多轮记忆，把这里换成 demoFollowUp() 即可
  // await demoCalculator();
  // await demoFollowUp()

  // await demo4ExecuteShell()

  // await demo6ExecuteShell()

  await demo6SkillsRefound()
  // await demo7Agents()
}

main()
