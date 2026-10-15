// 终端输出相关工具：把 agent.stream 产出的流以可读的形式打印出来

// 消费 agent.stream 产出的流，把整轮过程分门别类打印到终端：
// [用户] 提问 → [调用模型] 标记 → [思考] 推理 → 正文（流式逐字） → [调用工具] → [工具结果]
// 入参是 AsyncIterable<[message, metadata]>：每个元素是一条消息，外加它附带的运行元数据
export async function printStream(stream: AsyncIterable<[any, any]>) {
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
