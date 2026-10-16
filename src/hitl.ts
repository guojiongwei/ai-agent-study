// HITL（Human-in-the-Loop，人工介入审批）：Agent 执行到"需要审批"的工具时会中断，
// 这里负责把待审批的操作展示给用户、收集决策（批准 / 拒绝 / 编辑），再用 Command 恢复执行
// 配套配置见 agents.ts 里 createDeepAgent 的 interruptOn（中断与恢复都依赖 checkpointer）
import { Command, INTERRUPT, isInterrupted } from '@langchain/langgraph';
import type { HITLRequest, HITLResponse } from 'langchain';
import { agent } from './agents';

// 会话标识：中断恢复必须用同一个 thread_id，否则恢复不回原来的执行状态
const config = { configurable: { thread_id: 'session-1' } };

// 处理一次中断：展示待审批操作 → 收集用户决策 → 恢复执行
// 返回恢复后的最终状态；若本次没有中断则返回 null
async function handleInterrupt(result: any, runConfig: any): Promise<any | null> {
  // 1. 检测中断
  if (!isInterrupted(result)) {
    return null;
  }

  // 2. 解析 HITLRequest
  const interruptData = result[INTERRUPT];
  const interruptValue = interruptData?.[0]?.value;

  if (!interruptValue) {
    console.log('\n⚠️ 检测到中断，但无法解析中断内容');
    return null;
  }

  const hitlRequest = interruptValue as HITLRequest;
  // actionRequests：待审批的操作列表；reviewConfigs：每个工具允许的决策类型（来自 interruptOn）
  const actionRequests = hitlRequest.actionRequests || [];
  const reviewConfigs = hitlRequest.reviewConfigs || [];

  // 3. 向用户展示待审批的操作
  console.log('\n\n🛑 ════════════════════════════════════════════════════════════');
  console.log('🛑  Agent 执行被中断，需要人工审批');
  console.log('🛑 ════════════════════════════════════════════════════════════\n');

  for (let i = 0; i < actionRequests.length; i++) {
    const action = actionRequests[i];
    const reviewConfig = reviewConfigs.find(rc => rc.actionName === action.name);

    console.log(`📋 操作 ${i + 1}/${actionRequests.length}:`);
    console.log(`   工具: ${action.name}`);
    console.log(`   参数: ${JSON.stringify(action.args, null, 2)}`);

    if (action.description) {
      console.log(`   描述: ${action.description}`);
    }

    if (reviewConfig) {
      console.log(`   允许的决策: ${reviewConfig.allowedDecisions.join(', ')}`);
    }
    console.log();
  }

  // 4. 等待用户输入决策
  // 使用 process.stdin.once 替代 readline，避免 readline 生命周期影响后续 agent.invoke
  const decisions: HITLResponse['decisions'] = [];

  // 辅助函数：读取一行用户输入
  const readLine = (prompt: string): Promise<string> => {
    return new Promise<string>((resolve) => {
      process.stdout.write(prompt);
      process.stdin.once('data', (data) => {
        resolve(data.toString().trim());
      });
    });
  };

  // 确保 stdin 处于 flowing 状态
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  for (let i = 0; i < actionRequests.length; i++) {
    const action = actionRequests[i];
    const reviewConfig = reviewConfigs.find(rc => rc.actionName === action.name);
    const allowedDecisions = reviewConfig?.allowedDecisions || ['approve', 'reject'];

    console.log(`\n─── 操作 ${i + 1}: ${action.name} ───`);

    // 根据允许的决策类型构建提示
    const choices = allowedDecisions.map(d => {
      if (d === 'approve') return 'y (批准)';
      if (d === 'reject') return 'n (拒绝)';
      if (d === 'edit') return 'e (编辑)';
      return d;
    }).join(' / ');

    const answer = await readLine(`请决策 [${choices}]: `);
    const normalizedAnswer = answer.toLowerCase();

    // 解析用户决策
    if (normalizedAnswer === 'y' || normalizedAnswer === 'yes' || normalizedAnswer === 'approve') {
      decisions.push({ type: 'approve' });
      console.log('✅ 已批准');
    } else if (normalizedAnswer === 'n' || normalizedAnswer === 'no' || normalizedAnswer === 'reject') {
      const reason = await readLine('拒绝原因（可选，按回车跳过）: ');
      decisions.push({
        type: 'reject',
        message: reason || '用户拒绝此操作',
      });
      console.log('❌ 已拒绝');
    } else if (normalizedAnswer === 'e' || normalizedAnswer === 'edit') {
      if (!allowedDecisions.includes('edit')) {
        console.log('⚠️ 此操作不允许编辑，自动拒绝');
        decisions.push({ type: 'reject', message: '用户尝试编辑但不被允许' });
      } else {
        // 编辑模式：让用户输入新的参数
        console.log('当前参数:', JSON.stringify(action.args, null, 2));
        const newArgsStr = await readLine('请输入新的参数 JSON（按回车保持原样）: ');

        let newArgs = action.args;
        if (newArgsStr) {
          try {
            newArgs = JSON.parse(newArgsStr);
          } catch {
            console.log('⚠️ JSON 解析失败，使用原参数');
          }
        }

        decisions.push({
          type: 'edit',
          editedAction: {
            name: action.name,
            args: newArgs,
          },
        });
        console.log('✏️ 已编辑参数');
      }
    } else {
      console.log('⚠️ 无法识别的输入，默认拒绝');
      decisions.push({ type: 'reject', message: '用户未做出明确决策' });
    }
  }

  // 5. 构造 HITLResponse 并用 Command 恢复执行
  const hitlResponse: HITLResponse = { decisions };

  console.log('\n🔄 正在恢复 Agent 执行...');

  // 暂停 stdin，防止干扰后续的 agent.invoke
  process.stdin.pause();

  // 用 Command 恢复 Agent，传入决策
  const resumeResult = await agent.invoke(
    new Command({ resume: hitlResponse }),
    runConfig
  );

  // 6. 递归处理：恢复后可能还有新的中断（多个工具连续需要审批）
  // ⚠️ 必须返回 resumeResult 本身（而不是让递归返回 null 时丢失它）
  const nextInterrupt = await handleInterrupt(resumeResult, runConfig);
  return nextInterrupt ?? resumeResult;
}

// 带人工审批的调用入口：执行 → 遇到中断就交给用户决策 → 恢复，直到整轮跑完
// 注意用的是 agent.invoke（不是 stream）：中断后要靠 Command 恢复，需要拿到完整状态
// ⚠️ 必须在真实终端里运行，交互过程中需要键盘输入 y / n
export async function runWithInterruptHandling(userMessage: string) {
  // 第一步：invoke Agent，让它执行到完成或被中断
  const result = await agent.invoke(
    { messages: [{ role: 'user', content: userMessage }] },
    config
  );

  // 第二步：检查是否有中断
  const afterInterrupt = await handleInterrupt(result, config);

  // 第三步：获取最终结果（可能经过多次中断-恢复循环）
  const finalResult = afterInterrupt || result;

  // 第四步：从最终结果中提取 AI 的最后一条消息并展示
  const messages = finalResult.messages || [];
  const lastAiMessage = [...messages].reverse().find(
    (m: any) => m._getType?.() === 'ai' && m.content
  );

  if (lastAiMessage) {
    if (typeof lastAiMessage.content === 'string') {
      process.stdout.write(lastAiMessage.content);
    } else if (Array.isArray(lastAiMessage.content)) {
      for (const block of lastAiMessage.content) {
        if (block.type === 'text' && block.text) {
          process.stdout.write(block.text);
        }
      }
    }
  }
  console.log('\n');
}
