// 终端输出相关工具：把 agent.stream 产出的流以可读的形式打印出来

// 消费 agent.stream 产出的流，把整轮过程分门别类打印到终端：
// [用户] 提问 → [调用模型] 标记 → [思考] 推理 → 正文（流式逐字） → [调用工具] → [工具结果]
// 入参是流本身，每个元素形如 [message, metadata]：一条消息 + 它附带的运行元数据。
// 元素类型用 any：streamMode 不同时流出的结构不同（messages 模式下是元组，TS 无法自动收窄）
export async function printStream(stream: AsyncIterable<any>) {
  // 标记思考区是否已经开始输出：用于只打印一次 "[思考]" 前缀（流式下思考是分片返回的，
  // 若每个分片都带前缀，终端会被刷满 "[思考] [思考] …"）
  let thinkingStarted = false;
  // 标记本轮模型调用是否已经打过 "[调用模型]"：流式下 ai 消息会分成很多片，
  // 只在第一片时打一次，用来区分多轮 ReAct 里"第几次调用模型"
  let modelCallStarted = false;
  // 当前正在拼装的工具调用：流式下工具名先到，参数是 input_json_delta 碎片（'{'、'"a":'、'128' …），
  // 所以要先把碎片攒起来，等工具执行结果到达前再一次性打印，否则终端上会是一堆乱码般的碎片
  let pendingTool: { name: string; args: string } | null = null;

  for await (const [message, metadata] of stream) {
    const type = message?._getType?.();

    // 调试用：想看每个流式 chunk 的类型和内容快照时再打开，正式输出时注释掉，
    // 否则调试日志会和下面的流式文本交错在一起
    // console.log(type, message.content)

    // ---- 用户消息：把这一轮的问题也打出来，方便看清整轮 ReAct 的起点 ----
    if (type === 'human') {
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      process.stdout.write(`\x1b[36m[用户] ${text}\x1b[0m\n`);
      // 新一轮提问开始，后面的 ai 消息属于新的一次模型调用
      modelCallStarted = false;
      thinkingStarted = false;
      continue;
    }

    // ---- 工具消息：工具的返回值（ReAct 里"观察"这一步） ----
    if (type === 'tool') {
      // 模型思考完直接调工具、没有正文时，思考区还没收尾，
      // 这里先换行并重置灰色，避免 "[调用工具]" 贴在同一行灰色思考文字后面
      if (thinkingStarted) {
        process.stdout.write('\x1b[0m\n');
        thinkingStarted = false;
      }
      // 工具结果到达前，先把这轮工具调用的名称和参数补打出来（黄色）
      if (pendingTool) {
        process.stdout.write(`\x1b[33m[调用工具] ${pendingTool.name}(${pendingTool.args})\x1b[0m\n`);
        pendingTool = null;
      }
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      process.stdout.write(`\x1b[32m[工具结果] ${text}\x1b[0m\n`);
      // 一轮工具调用结束，模型也即将开始新一轮调用
      modelCallStarted = false;
      continue;
    }

    // ---- 其余类型（ai 之外）不处理 ----
    if (type !== 'ai') continue;

    // 模型开始输出（本轮的第一片 ai 消息）时打一次标记，用来区分 ReAct 里每次调用模型
    // 同时把本次调用的关键参数一并展示：这些信息来自流里每片 chunk 附带的 metadata
    // （由 LangChain/LangGraph 注入，不属于模型回复内容）
    if (!modelCallStarted) {
      const info = [
        metadata?.ls_model_name && `模型=${metadata.ls_model_name}`,
        metadata?.ls_provider && `服务商=${metadata.ls_provider}`,
        metadata?.ls_max_tokens && `maxTokens=${metadata.ls_max_tokens}`,
        metadata?.langgraph_step !== undefined && `step=${metadata.langgraph_step}`,
        metadata?.thread_id && `thread=${metadata.thread_id}`,
      ]
        .filter(Boolean)
        .join(' | ');
      process.stdout.write(`\x1b[35m[调用模型]${info ? ' ' + info : ''}\x1b[0m\n`);
      modelCallStarted = true;
    }

    // 情况 1：content 是字符串
    if (typeof message.content === 'string' && message.content) {
      process.stdout.write(message.content);
    }
    // 情况 2：content 是数组，遍历找 text / thinking / tool_use block
    // 流式模式下每个 chunk 只带一小段增量文本，拿到就写出去即可，不需要手动拼接
    else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        // thinking block：模型的内部推理过程，用灰色（ANSI 90）输出，与正式回答区分开
        // 注意：部分 chunk 只带 signature 没有正文（thinking 为空串），所以要判空后再输出
        if (block.type === 'thinking' && block.thinking) {
          // 思考区第一次出现内容时才打前缀
          if (!thinkingStarted) {
            process.stdout.write('\x1b[90m[思考] ');
            thinkingStarted = true;
          }
          process.stdout.write(block.thinking);
        }
        // text block：模型的最终文本回复
        else if (block.type === 'text' && block.text) {
          // 思考结束转入正文时，先换行并重置颜色，避免正文一直是灰色、贴在思考文字后面
          if (thinkingStarted) {
            process.stdout.write('\x1b[0m\n');
            thinkingStarted = false;
          }
          process.stdout.write(block.text);
        }
        // tool_use block：模型决定调用某个工具，这里先记下工具名
        // 有些非流式的返回会一次性给全参数（input 是对象），这里一并兼容
        else if (block.type === 'tool_use' && block.name) {
          const args = typeof block.input === 'string' ? block.input : block.input ? JSON.stringify(block.input) : '';
          pendingTool = { name: block.name, args };
        }
        // input_json_delta：工具参数的流式碎片，先攒进 pendingTool，等工具结果到达时统一打印
        else if (block.type === 'input_json_delta' && typeof block.input === 'string' && pendingTool) {
          pendingTool.args += block.input;
        }
      }
    }
  }

  // 收尾：正常情况下工具结果消息一定会到、pendingTool 会被打印掉；
  // 这里兜底处理异常情况（比如模型发起工具调用后流程被中断），避免参数信息丢失
  if (pendingTool) {
    process.stdout.write(`\x1b[33m[调用工具] ${pendingTool.name}(${pendingTool.args})\x1b[0m\n`);
    pendingTool = null;
  }

  // 流结束后补一个换行：流式输出全程不换行，若最后一行没有换行符，
  // 进程退出后 shell 提示符会直接贴上来把它覆盖掉（看起来像"输出闪一下就没了"）
  // \x1b[0m 用于兜底重置颜色：万一这轮只输出了思考、没有正文，也不会让终端一直是灰的
  process.stdout.write('\x1b[0m\n');
}

// ============ 模型请求 / 响应的完整结构展示（学习调用流程用） ============
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
export function printModelRequest(llm: any, messages: any[][], extraParams?: any) {
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

export function printModelResponse(output: any) {
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

