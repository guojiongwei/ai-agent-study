// 应用外壳：左侧聊天区 + 右侧子 Agent 监控 + 中断时弹出的审批窗
import { useMemo, useState } from 'react';
import { ChatInterface } from './components/ChatInterface';
import { SubagentMonitor } from './components/SubagentMonitor';
import { ApprovalModal } from './components/ApprovalModal';
import { IconCpu } from './components/icons';
import { useWebSocket } from './hooks/useWebSocket';
import type { ConnectionStatus } from './types';

// 连接状态 → 展示文案
const STATUS_TEXT: Record<ConnectionStatus, string> = {
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开',
};

export default function App() {
  // 每个页面（标签页）生成一个会话 id，后端用它作为 LangGraph 的 thread_id，实现多轮记忆。
  // 同一个 id 内 Agent 记得上下文；刷新页面会换新 id，等价于开一段新会话
  const [threadId] = useState(
    () => `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  );

  const { sendMessage, sendDecision, messages, interrupt, status, isLoading } =
    useWebSocket(threadId);

  // 把所有消息里的工具调用拍平，交给右侧面板筛选子 Agent 任务
  const allToolCalls = useMemo(
    () => messages.flatMap((m) => m.toolCalls ?? []),
    [messages],
  );

  return (
    <div className="app">
      <header className="app-header">
        <IconCpu size={18} />
        <span className="app-title">Agent 实时对话</span>
        <span className="app-thread">{threadId}</span>
        <span className="tool-spacer" />
        <span className={`status status-${status}`}>
          <span className="status-dot" />
          <span className="status-text">{STATUS_TEXT[status]}</span>
        </span>
      </header>

      <div className="app-body">
        <ChatInterface messages={messages} isLoading={isLoading} onSend={sendMessage} />
        <SubagentMonitor calls={allToolCalls} />
      </div>

      {/* 有中断（待审批操作）时弹出 */}
      {interrupt && <ApprovalModal interrupt={interrupt} onSubmit={sendDecision} />}
    </div>
  );
}
