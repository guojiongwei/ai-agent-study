// 入口文件：启动 demos.ts 里的示例
// 打印顺序大致是：模型请求 → [调用模型] → 流式思考/正文 → 模型响应 → 工具执行 → 下一次模型请求
// 文件分工：Agent 组装在 agents.ts，示例都在 demos.ts，人工审批（HITL）在 hitl.ts，
//          给前端用的 WebSocket 服务在 server.ts（pnpm server 启动）
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
