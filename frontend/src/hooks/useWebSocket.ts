// WebSocket Hook：把后端推来的 7 种事件翻译成 React 状态
// 组件侧只关心 { sendMessage, sendDecision, messages, interrupt, status, isLoading }
// 协议定义见 frontend/src/types.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ActionRequest,
  ChatEntry,
  ConnectionStatus,
  Decision,
  ReviewConfig,
  ServerEvent,
  ToolCallInfo,
} from '../types';

// 中断（待审批）信息：后端 interrupt 事件里的两项内容
export interface InterruptState {
  actionRequests: ActionRequest[];
  reviewConfigs: ReviewConfig[];
}

// 重连间隔（毫秒）
const RECONNECT_DELAY = 5000;

// 生成一个前端本地的唯一 id（用于消息列表的 key 和按 id 定位）
let seq = 0;
function nextId(prefix: string) {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

export function useWebSocket(threadId: string) {
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [interrupt, setInterrupt] = useState<InterruptState | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [isLoading, setIsLoading] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  // ---- 两个关键的 ref ----
  // 当前正在流式生成的助手消息：流式分片是高频的，用 ref 同步累积，避免 setState 的闭包陷阱；
  // 一轮结束后置空，下一次输出就会新建一条助手消息（模型可能输出多段文本，中间夹着工具调用）
  const currentAssistantRef = useRef<ChatEntry | null>(null);
  // 已发出、还没拿到结果的工具调用，按 id 索引；tool_result 回来时靠它配对
  const pendingToolsRef = useRef<Map<string, ToolCallInfo>>(new Map());

  // 把当前助手消息的快照提交到 state。
  // 注意必须创建新对象（浅拷贝），否则 React 认为引用没变，不会重渲染
  const commit = useCallback(() => {
    const cur = currentAssistantRef.current;
    if (!cur) return;
    const snapshot: ChatEntry = {
      ...cur,
      toolCalls: cur.toolCalls ? [...cur.toolCalls] : undefined,
    };
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === snapshot.id);
      if (idx === -1) return [...prev, snapshot];
      const next = [...prev];
      next[idx] = snapshot;
      return next;
    });
  }, []);

  // 拿到"当前助手消息"，没有就新建一条（第一次收到 text / thinking / tool_call 时触发）
  const ensureAssistant = useCallback((): ChatEntry => {
    if (currentAssistantRef.current) return currentAssistantRef.current;
    const entry: ChatEntry = {
      id: nextId('assistant'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
    };
    currentAssistantRef.current = entry;
    // 先放一条空消息占位，后续 commit 会按 id 更新它
    setMessages((prev) => [...prev, { ...entry }]);
    return entry;
  }, []);

  // ---- 事件分发：7 种下行事件都在这里落地 ----
  const handleEvent = useCallback(
    (event: ServerEvent) => {
      switch (event.type) {
        // 正文增量：直接拼到当前助手消息末尾
        case 'text': {
          const cur = ensureAssistant();
          cur.content += event.content;
          commit();
          break;
        }

        // 思考过程增量：单独累积到 thinking 字段，UI 里折叠展示
        case 'thinking': {
          const cur = ensureAssistant();
          cur.thinking = (cur.thinking ?? '') + event.content;
          commit();
          break;
        }

        // 工具调用开始：建一条 pending 记录，挂到当前助手消息上
        case 'tool_call': {
          const cur = ensureAssistant();
          const info: ToolCallInfo = {
            id: event.id,
            name: event.name,
            args: event.args ?? {},
            status: 'pending',
          };
          pendingToolsRef.current.set(event.id, info);
          cur.toolCalls = [...(cur.toolCalls ?? []), info];
          commit();
          break;
        }

        // 工具结果：按 id 找回那条 pending 记录，补上结果并改成 completed
        case 'tool_result': {
          const info = pendingToolsRef.current.get(event.id);
          if (info) {
            info.result = event.result;
            info.status = 'completed';
            pendingToolsRef.current.delete(event.id);
          }
          // 无论有没有配上，都提交一次，保证 UI 状态及时刷新
          commit();
          break;
        }

        // 中断：Agent 触发敏感操作，弹出审批窗；此时本轮还没结束，解锁输入框让用户处理弹窗
        case 'interrupt':
          setInterrupt({
            actionRequests: event.actionRequests,
            reviewConfigs: event.reviewConfigs,
          });
          setIsLoading(false);
          break;

        // 本轮（含所有中断恢复）结束：收尾清理
        case 'done':
          currentAssistantRef.current = null;
          pendingToolsRef.current.clear();
          setIsLoading(false);
          break;

        // 错误：追加到当前助手消息里，让用户看得到
        case 'error': {
          const cur = ensureAssistant();
          cur.content += `${cur.content ? '\n\n' : ''}⚠️ 错误：${event.message}`;
          commit();
          setIsLoading(false);
          break;
        }
      }
    },
    [commit, ensureAssistant],
  );

  // ---- 建立连接 + 断线自动重连 ----
  useEffect(() => {
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      setStatus('connecting');

      // 走 Vite 的 /ws 代理，所以直接用当前页面的 host 即可
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => setStatus('connected');

      ws.onmessage = (ev) => {
        try {
          handleEvent(JSON.parse(ev.data as string) as ServerEvent);
        } catch {
          // 忽略解析失败的消息，避免一条脏数据打断整条流
        }
      };

      ws.onclose = () => {
        // 只有当前这条连接才清空引用（避免 React 严格模式下旧连接的 close 覆盖新连接）
        if (wsRef.current === ws) wsRef.current = null;
        setStatus('disconnected');
        if (!disposed) {
          // 5 秒后自动重连
          reconnectTimerRef.current = window.setTimeout(connect, RECONNECT_DELAY);
        }
      };

      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [handleEvent]);

  // ---- 对外动作：发聊天消息 ----
  const sendMessage = useCallback(
    (message: string) => {
      const text = message.trim();
      if (!text) return;

      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        setStatus('disconnected');
        return;
      }

      // 先把用户消息上屏（乐观更新，不等后端回包）
      setMessages((prev) => [
        ...prev,
        { id: nextId('user'), role: 'user', content: text, createdAt: Date.now() },
      ]);

      // 新一轮开始：重置流式累积状态
      currentAssistantRef.current = null;
      pendingToolsRef.current.clear();
      setIsLoading(true);

      ws.send(JSON.stringify({ type: 'chat', message: text, threadId }));
    },
    [threadId],
  );

  // ---- 对外动作：提交审批决策（approve / reject / edit）----
  const sendDecision = useCallback(
    (decisions: Decision[]) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      ws.send(JSON.stringify({ type: 'decision', threadId, data: decisions }));
      // 关闭弹窗并重新进入"等待中"状态，Agent 会继续跑
      setInterrupt(null);
      setIsLoading(true);
    },
    [threadId],
  );

  return { sendMessage, sendDecision, messages, interrupt, status, isLoading };
}
