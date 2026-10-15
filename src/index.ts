// 入口文件：组装 Agent、发起一次对话，并把整轮 ReAct 的执行过程完整打印到终端
// 打印顺序大致是：模型请求 → [调用模型] → 流式思考/正文 → 模型响应 → 工具执行 → 下一次模型请求
import { createDeepAgent } from 'deepagents';
import { MemorySaver } from '@langchain/langgraph';
import { model } from './agents'
import { calculatorTool, getCurrentTimeTool } from './tools';
import { printStream } from './utils';

// 创建 Agent：deepagents 内部会用 LangGraph 把流程编排成一张状态图，核心是两个节点来回跳
// 「模型节点」判断要不要调工具 → 需要就去「工具节点」执行 → 结果回灌后再问模型，直到模型不再调工具
export const agent = createDeepAgent({
  model, // 用哪个模型（见 agents.ts）
  tools: [calculatorTool, getCurrentTimeTool], // 注册给模型的工具，会被转成 JSON Schema 一起发给模型
  // 注意：这里没有 permissions，因为 LocalShellBackend 支持 execute，两者不兼容
  // 系统提示词：相当于每轮请求里的第一条 system 消息，用来交代身份与"什么时候该用工具"
  systemPrompt:
    '你是一个乐于助人的 AI 助手。当用户需要进行数学计算或查询时间时，请使用相应的工具来完成。',
  // 检查点：把每一步的对话状态（消息列表）持久化下来
  // 这样同一个 thread_id 的下一次调用会自动带上历史消息，实现"多轮记忆"
  checkpointer: new MemorySaver(),
});
// 会话标识：同一个 thread_id 视为同一段对话（记忆共享），不同 thread_id 相互隔离
const config1 = { configurable: { thread_id: 'session-1' } };
const config2 = { configurable: { thread_id: 'session-2' } };

// ============ 模型请求的完整参数展示（学习调用流程用） ============
// 每次真正向模型发起请求前，LangChain 都会触发 handleChatModelStart，
// 这里可以拿到"这次到底把什么发给了模型"：模型配置 + 工具清单 + 完整消息列表
let modelRequestCount = 0; // 第几次调用模型（从 1 开始计数）

// 把消息内容转成方便终端阅读的文本：
// content 可能是字符串，也可能是 text / thinking / tool_use / tool_result 等 block 组成的数组
// skipToolUse：消息自带完整 tool_calls 时传 true，避免和 content 里的 tool_use 重复展示
function formatContent(content: any, skipToolUse = false): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((block: any) => {
      if (typeof block === 'string') return block;
      if (block.type === 'text') return block.text ?? '';
      if (block.type === 'thinking') return `[思考] ${block.thinking ?? ''}`;
      // input_json_delta 是工具参数的流式碎片（历史消息里会残留），不是正式内容，跳过
      if (block.type === 'input_json_delta') return '';
      if (block.type === 'tool_use') {
        return skipToolUse ? '' : `[工具调用] ${block.name}(${JSON.stringify(block.input)})`;
      }
      if (block.type === 'tool_result') return `[工具结果] ${JSON.stringify(block.content)}`;
      return `[${block.type}] ${JSON.stringify(block)}`;
    })
    .filter(Boolean)
    .join('\n');
}

// 不同角色的显示颜色，尽量和 printStream 里的配色保持一致
const roleColorMap: Record<string, string> = {
  system: '90', // 灰：系统提示通常很长，弱化显示
  human: '36', // 青
  ai: '35', // 品红
  tool: '32', // 绿
};

// 打印一次模型请求的完整参数
function printModelRequest(llm: any, messages: any[][], extraParams?: any) {
  const kwargs = llm?.kwargs ?? {};
  const tools = extraParams?.options?.tools ?? [];
  modelRequestCount += 1;

  console.log(`\x1b[35m──────── 模型请求 #${modelRequestCount} ────────\x1b[0m`);

  // 1）请求参数：取自模型配置（api key 被序列化成 secret 引用，不会打印出明文）
  const params = [
    kwargs.model && `模型=${kwargs.model}`,
    kwargs.anthropic_api_url && `接口地址=${kwargs.anthropic_api_url}`,
    kwargs.max_tokens && `maxTokens=${kwargs.max_tokens}`,
    kwargs.thinking?.budget_tokens && `思考预算=${kwargs.thinking.budget_tokens}`,
    kwargs.streaming !== undefined && `streaming=${kwargs.streaming}`,
  ]
    .filter(Boolean)
    .join(' | ');
  console.log(`\x1b[35m[请求参数] ${params}\x1b[0m`);

  // 2）工具清单：本轮模型可用的工具（deepagents 会额外注入内置工具，所以比 createDeepAgent 里手写的多）
  console.log(`\x1b[35m[工具清单] 共 ${tools.length} 个\x1b[0m`);
  for (const tool of tools) {
    const argNames = Object.keys(tool?.input_schema?.properties ?? {});
    // 描述只取第一行，完整描述在多行文本里会刷屏
    const summary = (tool?.description ?? '').split('\n')[0];
    console.log(`\x1b[35m  - ${tool?.name}(${argNames.join(', ')})\x1b[0m ${summary}`);
  }

  // 3）消息列表：模型实际看到的上下文（多轮时能看到历史消息是怎么带上的）
  // messages 是二维数组：外层是批次，内层才是本次请求的消息列表
  for (const batch of messages) {
    console.log(`\x1b[35m[消息列表] 共 ${batch.length} 条\x1b[0m`);
    batch.forEach((message: any, index: number) => {
      const role = message?._getType?.() ?? message?.type ?? 'unknown';
      // ai 消息里的工具调用不在 content 中，单独取出来拼上，否则会显示成空内容
      const toolCalls = message?.tool_calls ?? [];
      const toolCallText = toolCalls
        .map((call: any) => `[工具调用] ${call?.name}(${JSON.stringify(call?.args)})`)
        .join('\n');
      // 有完整 tool_calls 时，content 里的 tool_use block 就不再重复展示
      const text = [formatContent(message?.content, toolCalls.length > 0), toolCallText]
        .filter(Boolean)
        .join('\n');
      // 多行内容统一缩进，方便区分不同消息
      const indented = text
        .split('\n')
        .map((line) => `     ${line}`)
        .join('\n');
      console.log(`\x1b[${roleColorMap[role] ?? '0'}m  #${index + 1} ${role}:\n${indented}\x1b[0m`);
    });
  }
  console.log('');
}

// 打印一次模型响应的原始结构（重点看 content block 里工具调用长什么样）
let modelResponseCount = 0; // 第几次模型响应（从 1 开始计数）

function printModelResponse(output: any) {
  // LLMResult.generations 是二维数组，取本次调用第一条候选消息即可
  const message = output?.generations?.[0]?.[0]?.message;
  if (!message) return;
  modelResponseCount += 1;

  console.log(`\x1b[35m──────── 模型响应 #${modelResponseCount} ────────\x1b[0m`);

  // 1）结束原因：tool_use 表示模型想调工具（后面会走工具节点），end_turn 表示这轮说完了
  // 注意：部分第三方网关（比如本项目的 deepseek 兼容端点）不回传 stop_reason / id / model，
  // 这时退化成"按有没有工具调用来推断"，并把原始 metadata 打出来供对照
  const meta = message.response_metadata ?? {};
  const hasToolCall = (message.tool_calls ?? []).length > 0;
  const stopReason = meta.stop_reason ?? meta.finish_reason;
  const stopText = stopReason
    ? String(stopReason)
    : hasToolCall
      ? 'tool_use（按有工具调用推断）'
      : 'end_turn（按无工具调用推断）';
  console.log(`\x1b[35m[结束原因] ${stopText} | 响应模型=${meta.model ?? meta.model_provider ?? '-'}\x1b[0m`);
  // 原始 metadata 直接打出来：不同网关给的字段差别很大，看原样最直观
  console.log(`\x1b[90m[响应 metadata] ${JSON.stringify(meta)}\x1b[0m`);

  // 2）token 用量：判断上下文增长、控制成本时很有用；Anthropic 系还会给 prompt 缓存命中情况
  const usage = message.usage_metadata ?? {};
  const cacheInfo = [
    meta.usage?.cache_read_input_tokens !== undefined && `缓存读取=${meta.usage.cache_read_input_tokens}`,
    meta.usage?.cache_creation_input_tokens !== undefined && `缓存写入=${meta.usage.cache_creation_input_tokens}`,
  ].filter(Boolean);
  console.log(
    `\x1b[35m[Token 用量] 输入=${usage.input_tokens ?? '-'} 输出=${usage.output_tokens ?? '-'} 总计=${usage.total_tokens ?? '-'}${
      cacheInfo.length ? ' | ' + cacheInfo.join(' ') : ''
    }\x1b[0m`,
  );

  // 3）原始 content：模型返回的 block 数组，直接看结构最直观
  // thinking block 里的 signature 是加密签名字符串（几百字符），这里截断显示，避免刷屏
  const rawContent = JSON.stringify(
    message.content,
    (key, value) =>
      key === 'signature' && typeof value === 'string' ? `${value.slice(0, 24)}...(已截断)` : value,
    2,
  );
  console.log(`\x1b[90m[原始 content] ${rawContent}\x1b[0m`);

  // 4）AIMessage.tool_calls：模型给出的"调用意图"，这才是 ToolNode 实际拿去执行工具的字段
  // （上面原始 content 里的 tool_use block 是它的来源，input 为空、参数在 input_json_delta 里，
  //   LangChain 已经把碎片拼好并解析成了这里的 args）
  const toolCalls = message.tool_calls ?? [];
  console.log(
    `\x1b[33m[AIMessage.tool_calls] ${
      toolCalls.length ? JSON.stringify(toolCalls, null, 2) : '[]（本轮没有调用工具）'
    }\x1b[0m`,
  );
  console.log('');
}

// 回调对象：LangChain 会在模型请求开始/结束等时机触发这里定义的 hook
const traceCallbacks = [
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

async function main() {
    // 第一轮：计算器
    // agent.stream：以流的方式执行整张图，边跑边产出（不是等全部跑完才返回）
    // streamMode: 'messages' 表示流出的每个元素是 [消息, 元数据]（模型 token、工具消息都会流出来）
    // callbacks：挂上两个 hook，把"发出去的请求"和"收到的响应"完整打印出来（见下方 traceCallbacks）
    const stream1 = await agent.stream(
    { messages: [{ role: 'user', content: '帮我计算 128 乘以 47 等于多少' }] },
    { ...config1, streamMode: 'messages', callbacks: traceCallbacks },
    );
    // Agent 回复："128 × 47 = 6016"
    // 加 await 等待流式消费完成，避免 main 提前结束、异常也捕获不到
    await printStream(stream1)
    // 第二轮：故意质疑（同一个 agent、不同 thread_id，用来对比"记忆是否共享"）
    // streamMode 与 callbacks 的用法同上，需要看这一轮日志时把下面几行取消注释即可
    // const stream2 = await agent.stream(
    //     { messages: [{ role: 'user', content: '算的不对吧' }] },
    //     { ...config2, streamMode: 'messages' },
    // );
    // printStream(stream2)
}

// 启动入口：执行 main（注意这里没加 catch，若流里抛错会静默退出，排查问题时可以改成 main().catch(console.error)）
main()
