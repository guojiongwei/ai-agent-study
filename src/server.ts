// WebSocket 后端服务器：把 Agent 的执行过程实时推给前端，并把前端的人工审批决策送回 Agent
// 启动：pnpm server（默认 3001 端口）
// 前端 Vite 通过 /ws 代理连过来（见 frontend/vite.config.ts）
//
// 协议（类型定义见 frontend/src/types.ts）：
//   上行 2 种：chat（发消息）、decision（提交审批决策）
//   下行 7 种：text / thinking / tool_call / tool_result / interrupt / done / error
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Command } from '@langchain/langgraph';
import type { HITLRequest } from 'langchain';
import { agent } from './agents';
import type {
  ServerEvent,
  Decision,
  ActionRequest,
  ReviewConfig,
} from '../frontend/src/types';

const PORT = Number(process.env.PORT ?? 3001);

// ============ 1. HTTP + WebSocket 骨架 ============

const server = http.createServer((req, res) => {
  // 健康检查：用来确认服务是否起来（curl http://localhost:3001/health）
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(404);
  res.end('Not Found');
});

const wss = new WebSocketServer({ server });

// 当前所有连接（前端可以同时开多个标签页，各聊各的）
const clients = new Set<WebSocket>();

// 发送一个事件给指定前端（连接已断开时静默跳过）
function send(ws: WebSocket, event: ServerEvent) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

// ============ 2. 消息入口：decision 必须单独路由 ============

// 待决策队列：waitForDecision 只往队列里放 waiter，不额外注册 message 监听器；
// 真正的消息分发统一在下面的 ws.on('message') 里做。
// 如果图省事写成 ws.once('message') 来等 decision，会和外层 ws.on('message') 竞争同一条消息。
type Waiter = {
  resolve: (decisions: Decision[]) => void;
  reject: (err: Error) => void;
};
const pendingDecisions = new Map<WebSocket, Waiter[]>();

function waitForDecision(ws: WebSocket): Promise<Decision[]> {
  return new Promise((resolve, reject) => {
    const entry: Waiter = { resolve, reject };
    if (!pendingDecisions.has(ws)) {
      pendingDecisions.set(ws, []);
    }
    pendingDecisions.get(ws)!.push(entry);

    // 前端中途关掉页面时，让 promise 失败，避免请求永远挂在这里
    ws.once('close', () => {
      const waiters = pendingDecisions.get(ws);
      if (waiters) {
        const idx = waiters.indexOf(entry);
        if (idx !== -1) waiters.splice(idx, 1);
      }
      reject(new Error('客户端断开连接'));
    });
  });
}

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`🔌 前端已连接，当前连接数：${clients.size}`);

  ws.on('message', async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', message: '消息不是合法 JSON' });
      return;
    }

    // ---- decision 单独路由：交给等待中的 waiter，绝不进入 handleChat ----
    if (msg.type === 'decision') {
      const waiters = pendingDecisions.get(ws);
      if (waiters?.length) {
        const { resolve } = waiters.shift()!;
        resolve(msg.data as Decision[]);
      } else {
        console.log('⚠️ 收到孤立的 decision 消息（当前没有等待审批的请求）');
      }
      return;
    }

    // ---- 普通聊天消息 ----
    if (msg.type === 'chat') {
      await handleChat(ws, msg.threadId as string, msg.message as string);
      return;
    }

    send(ws, { type: 'error', message: `未知消息类型：${msg.type}` });
  });

  ws.on('close', () => {
    clients.delete(ws);
    pendingDecisions.delete(ws);
    console.log(`❌ 前端已断开，当前连接数：${clients.size}`);
  });

  ws.on('error', (err) => {
    console.error('⚠️ WebSocket 出错：', err.message);
  });
});

// ============ 3. 一轮对话的处理：流式输出 + 中断审批循环 ============

// 去重集合：恢复执行时 LangGraph 会重放被中断的节点，同一条消息可能再次流出
// 按 thread_id 分开记录，避免多个会话互相干扰
const sentMessageIds = new Map<string, Set<string>>();
const sentToolCallIds = new Map<string, Set<string>>();

async function handleChat(ws: WebSocket, threadId: string, userMessage: string) {
  // 同一个 thread_id 共享 checkpointer 里的历史消息，实现多轮记忆
  const config = { configurable: { thread_id: threadId } };

  try {
    // input 第一次是用户消息，之后每次恢复都换成 Command
    let input: any = { messages: [{ role: 'user', content: userMessage }] };

    // 循环处理：一次执行可能连续触发多次中断（多个工具都要审批）
    for (;;) {
      const interrupt = await runStream(ws, input, config, threadId);

      if (!interrupt) break;

      // 把待审批操作推给前端 → 前端弹窗
      send(ws, {
        type: 'interrupt',
        actionRequests: interrupt.actionRequests,
        reviewConfigs: interrupt.reviewConfigs,
      });
      console.log(
        `🛑 等待前端审批：${interrupt.actionRequests.map((a) => a.name).join(', ')}`,
      );

      // 挂起，直到前端把 decision 发回来（decision 分支会 resolve 这个 promise）
      const decisions = await waitForDecision(ws);
      console.log(`✅ 收到审批决策：${JSON.stringify(decisions)}`);

      // 用 Command 恢复执行。注意 resume 的值是 HITLResponse 形状：{ decisions }
      input = new Command({ resume: { decisions } });
    }

    send(ws, { type: 'done' });
  } catch (err) {
    console.error('❌ 处理聊天消息失败：', err);
    send(ws, {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    // 出错也要发 done，否则前端输入框会一直锁着
    send(ws, { type: 'done' });
  }
}

// 执行一次流，把过程推给前端；返回中断信息（没有中断则返回 null）
async function runStream(
  ws: WebSocket,
  input: any,
  config: any,
  threadId: string,
): Promise<{ actionRequests: ActionRequest[]; reviewConfigs: ReviewConfig[] } | null> {
  // 同时订阅两种模式：
  // - messages：逐片拿到模型输出（text / thinking / tool_use）和工具结果
  // - updates：用来捕获中断信息 __interrupt__（messages 模式下拿不到）
  // 多模式时每个 chunk 是 [mode, payload]
  const stream = await agent.stream(input, {
    ...config,
    streamMode: ['messages', 'updates'],
  });

  let interrupt: {
    actionRequests: ActionRequest[];
    reviewConfigs: ReviewConfig[];
  } | null = null;

  // 流式下的工具调用是"分片"到达的，按 index 攒成完整的一条再发给前端：
  //   - 头部片：带 id 和 name（content 里的 tool_use block，或 tool_call_chunks 里同名的一项），
  //             注意此时 input 往往是空对象 {}，不能把它当成"参数就是空"，否则前端会看到 {}
  //   - 参数片：只有一段 args 字符串（content 里的 input_json_delta，或 tool_call_chunks.args）
  // 同一个 index 归属同一个工具调用，攒到能解析成合法 JSON 才发 tool_call
  type ToolAcc = { id: string; name: string; argsRaw: string };
  const toolAcc = new Map<number, ToolAcc>();

  // 吸收一片工具信息（id / name / 参数碎片，缺哪个补哪个）
  const absorbToolPiece = (
    index: number,
    piece: { id?: string; name?: string; argsFragment?: string },
  ) => {
    const acc = toolAcc.get(index) ?? { id: '', name: '', argsRaw: '' };
    if (piece.id) acc.id = piece.id;
    if (piece.name) acc.name = piece.name;
    if (piece.argsFragment) acc.argsRaw += piece.argsFragment;
    toolAcc.set(index, acc);
  };

  // 尝试把攒好的工具调用发出去（force = true 表示流已结束/工具即将执行，参数不完整也要发）
  const flushToolCalls = (force = false) => {
    for (const [index, acc] of toolAcc) {
      // id / name 还没到，说明头部片还在路上，等下一片
      if (!acc.id || !acc.name) continue;

      const raw = acc.argsRaw.trim();
      if (!raw && !force) continue; // 参数片还没到

      let args: Record<string, unknown> = {};
      if (raw) {
        try {
          args = JSON.parse(raw);
        } catch {
          if (!force) continue; // 还没拼完，等下一片
        }
      }

      // 同一个工具调用 id 只发一次（恢复执行时完整消息会再次出现）
      const sent = sentToolCallIds.get(threadId) ?? new Set<string>();
      sentToolCallIds.set(threadId, sent);
      if (!sent.has(acc.id)) {
        sent.add(acc.id);
        send(ws, { type: 'tool_call', name: acc.name, args, id: acc.id });
      }
      toolAcc.delete(index);
    }
  };

  for await (const chunk of stream) {
    const [mode, data] = chunk as unknown as [string, any];

    // ---- updates：只关心中断 ----
    if (mode === 'updates') {
      const found = extractInterrupt(data);
      if (found) interrupt = found;
      continue;
    }

    if (mode !== 'messages') continue;

    // ---- messages：payload 是 [消息, 元数据] ----
    const msg: any = Array.isArray(data) ? data[0] : data;
    if (!msg) continue;

    const msgType = msg._getType?.();

    // 去重：只对"带工具调用的完整消息"和工具消息按 id 去重。
    // 纯文本的流式分片会共享同一个 id，绝不能按 id 去重，否则会把内容吞掉
    const msgId: string | undefined = msg.id;
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    const isFullMessage = !!msgId && (hasToolCalls || msgType === 'tool');
    if (isFullMessage) {
      const sent = sentMessageIds.get(threadId) ?? new Set<string>();
      sentMessageIds.set(threadId, sent);
      if (sent.has(msgId)) continue;
      sent.add(msgId);
    }

    if (msgType === 'ai') {
      // 情况 1：content 是字符串（部分网关的流式分片）
      if (typeof msg.content === 'string') {
        if (msg.content) send(ws, { type: 'text', content: msg.content });
      }
      // 情况 2：content 是 block 数组
      else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'thinking' && block.thinking) {
            send(ws, { type: 'thinking', content: block.thinking });
          } else if (block.type === 'text' && block.text) {
            send(ws, { type: 'text', content: block.text });
          } else if (block.type === 'tool_use' && block.name) {
            // 头部片：记下 id / name。
            // 注意 block.input 在流式头部通常是空对象 {}（真正的参数在后面以碎片形式到达），
            // 所以只有 input 里有实际内容时才把它当参数吸收
            const input = block.input as unknown;
            const hasRealInput =
              typeof input === 'string'
                ? input.length > 0
                : !!input && Object.keys(input as object).length > 0;
            absorbToolPiece(block.index ?? 0, {
              id: block.id,
              name: block.name,
              argsFragment: hasRealInput
                ? typeof input === 'string'
                  ? input
                  : JSON.stringify(input)
                : '',
            });
          } else if (block.type === 'input_json_delta' && typeof block.input === 'string') {
            // 参数碎片：累加到对应 index 上，能解析成完整 JSON 时就会发出去
            absorbToolPiece(block.index ?? 0, { argsFragment: block.input });
          }
        }
      }

      // 兼容另一条路径：有些网关不在 content 里放工具信息，只在标准化的 tool_call_chunks 里给。
      // 两者是同一份数据的两种表示，同一片里只取其一，避免参数被重复拼接
      const hasToolBlocks =
        Array.isArray(msg.content) &&
        msg.content.some(
          (b: any) => b.type === 'tool_use' || b.type === 'input_json_delta',
        );
      if (!hasToolBlocks) {
        for (const chunk of msg.tool_call_chunks ?? []) {
          absorbToolPiece(chunk.index ?? 0, {
            id: chunk.id,
            name: chunk.name,
            argsFragment: typeof chunk.args === 'string' ? chunk.args : '',
          });
        }
      }

      // 每片都尝试发一次：参数一拼齐，前端就能立刻看到工具卡片
      flushToolCalls();

      // 兜底：完全不流式（直接给完整 tool_calls）的网关，参数只在 msg.tool_calls 里出现。
      // 关键点：流式头部那一帧也会带 msg.tool_calls，但此时 args 还是空的 {}，
      // 所以只要这个 id 正在流式累积（toolAcc 里有它），就跳过兜底，交给 flushToolCalls 发完整参数
      const streamingIds = new Set<string>();
      for (const acc of toolAcc.values()) {
        if (acc.id) streamingIds.add(acc.id);
      }
      for (const call of msg.tool_calls ?? []) {
        if (!call?.id || streamingIds.has(call.id)) continue;
        const sent = sentToolCallIds.get(threadId) ?? new Set<string>();
        sentToolCallIds.set(threadId, sent);
        if (sent.has(call.id)) continue;
        sent.add(call.id);
        send(ws, {
          type: 'tool_call',
          name: call.name,
          args: call.args ?? {},
          id: call.id,
        });
      }
    } else if (msgType === 'tool') {
      // 工具执行完，先把还没发的调用信息补发出去（保证卡片顺序在结果之前）
      flushToolCalls(true);
      send(ws, {
        type: 'tool_result',
        name: msg.name,
        result:
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        id: msg.tool_call_id,
      });
    }
  }

  // 流结束后兜底：万一工具调用信息还没发出去（比如流程被中断）
  flushToolCalls(true);

  return interrupt;
}

// 从 updates 模式的 chunk 里提取中断信息
// 形状大致是 { __interrupt__: [ { value: { actionRequests: [...], reviewConfigs: [...] } } ] }
function extractInterrupt(data: any): {
  actionRequests: ActionRequest[];
  reviewConfigs: ReviewConfig[];
} | null {
  if (!data || typeof data !== 'object') return null;

  // __interrupt__ 可能在顶层，也可能挂在某个节点名下面，两种都找一遍
  let node = data['__interrupt__'];
  if (!Array.isArray(node)) {
    for (const value of Object.values(data)) {
      if (value && typeof value === 'object' && Array.isArray((value as any)['__interrupt__'])) {
        node = (value as any)['__interrupt__'];
        break;
      }
    }
  }
  if (!Array.isArray(node) || node.length === 0) return null;

  const hitlRequest = node[0]?.value as HITLRequest | undefined;
  return {
    actionRequests: (hitlRequest?.actionRequests ?? []) as unknown as ActionRequest[],
    reviewConfigs: (hitlRequest?.reviewConfigs ?? []) as unknown as ReviewConfig[],
  };
}

// ============ 4. 启动 ============

server.listen(PORT, () => {
  console.log(`🚀 WebSocket 服务已启动：ws://localhost:${PORT}`);
  console.log(`   健康检查：http://localhost:${PORT}/health`);
});
