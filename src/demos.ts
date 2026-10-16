// Demo 示例集合：所有"怎么调用 Agent"的示例都集中在这里
// index.ts 只负责组装 Agent 和启动，跑哪个示例由它调用下面的函数决定

import { agent } from './index';
import { printStream, printModelRequest, printModelResponse } from './utils';

// 会话标识：同一个 thread_id 视为同一段对话（记忆共享），不同 thread_id 相互隔离
// 导出给 demos.ts 使用：示例函数会带上它，从而共享同一段对话记忆
export const config1 = { configurable: { thread_id: 'session-1' } };
// 追踪回调：把"发出去的请求"和"收到的响应"完整打印出来
// 返回的对象数组直接传给 agent.stream 的 callbacks 选项
export function createTraceCallbacks() {
  return [
    {
      // 模型请求开始时触发：llm 是模型配置的序列化结果，messages 是二维消息数组，extraParams 里带 bind 的工具
      handleChatModelStart: (
        llm: any,
        messages: any[][],
        _runId: string,
        _parentRunId?: string,
        extraParams?: any,
      ) => printModelRequest(llm, messages, extraParams),
      // 模型响应结束时触发：output 里装着模型的完整回复（含原始 content block、tool_calls、token 用量）
      handleLLMEnd: (output: any) => printModelResponse(output),
    },
  ];
}

// Demo 1：让模型做一次计算，观察完整的"模型 → 工具 → 模型"链路
export async function demoCalculator() {
  // agent.stream：以流的方式执行整张图，边跑边产出（不是等全部跑完才返回）
  // streamMode: 'messages' 表示流出的每个元素是 [消息, 元数据]（模型 token、工具消息都会流出来）
  // callbacks：挂上两个 hook，把"发出去的请求"和"收到的响应"完整打印出来（见上面 createTraceCallbacks）
  const stream = await agent.stream(
    { messages: [{ role: 'user', content: '帮我计算 128 乘以 47 等于多少' }] },
    { ...config1, streamMode: 'messages', callbacks: createTraceCallbacks() },
  );
  // Agent 回复："128 × 47 = 6016"
  // 加 await 等待流式消费完成，避免提前结束、异常也捕获不到
  await printStream(stream);
}

// Demo 2：在同一会话里追问，观察 checkpointer 带来的多轮记忆
// （模型能看到上一轮的历史消息；想对比"不同 thread_id 记忆是否共享"，把 config1 换成另一个 thread_id 的配置即可）
export async function demoFollowUp() {
  const stream = await agent.stream(
    { messages: [{ role: 'user', content: '再加10' }] },
    { ...config1, streamMode: 'messages', callbacks: createTraceCallbacks() },
  );
  await printStream(stream);
}


export const config3 = { configurable: { thread_id: 'session-3' } };
// Demo 4
export async function demo4ExecuteShell() {
console.log('--- 测试 5：执行 shell 命令 ---');
process.stdout.write('助手：');

  const stream4 = await agent.stream(
    { messages: [{ role: 'user', content: '往idnex.html写入一个h1标签加上你好文案' }] },
    { ...config3, streamMode: 'messages' },
  );
  await printStream(stream4);
  console.log('\n');
}


// Demo 5
export async function demo5ExecuteShell() {
console.log('--- 测试 5：执行 shell 命令 ---');
process.stdout.write('助手：');

  const stream4 = await agent.stream(
    { messages: [{ role: 'user', content: '帮我查看当前目录下的文件列表，并统计文件数量' }] },
    { ...config3, streamMode: 'messages' },
  );
  await printStream(stream4);
  console.log('\n');
}

// Demo 5
export async function demo6ExecuteShell() {
console.log('--- 测试 5：执行 shell 命令 ---');
process.stdout.write('助手：');

  const stream4 = await agent.stream(
    { messages: [{ role: 'user', content: '在 /public/ 下创建一个 script.sh，内容是 echo "Hello World"，然后执行它' }] },
    { ...config3, streamMode: 'messages' },
  );
  await printStream(stream4);
  console.log('\n');
}


// Demo 6
export async function demo6Skills() {
console.log('--- 测试 5：执行测试 skill 配置 ---');
process.stdout.write('助手：');

  const stream4 = await agent.stream(
    { messages: [{ role: 'user', content: '退款政策是什么' }] },
    { ...config1, streamMode: 'messages' },
  );
  await printStream(stream4);
  console.log('\n');
}