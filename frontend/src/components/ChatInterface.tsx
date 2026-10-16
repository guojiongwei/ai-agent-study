// 聊天主界面：消息列表 + 思考过程 + 工具卡片 + 输入框
// 自动滚动的策略：只有「用户本来就在底部」且「没有主动上滚」时才跟随新内容滚动，
// 否则用户往上翻历史时会被不断打断
import { useEffect, useRef, useState } from 'react';
import type { ChatEntry } from '../types';
import { ToolCallViewer } from './ToolCallViewer';
import {
  IconArrowDown,
  IconBot,
  IconChevron,
  IconSend,
  IconSparkle,
  IconUser,
} from './icons';

// 判定"贴着底部"的容差（px），避免亚像素误差导致判定失败
const BOTTOM_THRESHOLD = 40;

// 思考过程：折叠展示，默认收起（内容通常很长，展开会淹没正文）
function ThinkingBox({ text }: { text: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="thinking-box">
      <button type="button" className="thinking-toggle" onClick={() => setOpen((v) => !v)}>
        <IconSparkle size={13} />
        思考过程
        <IconChevron size={12} className={`tool-chevron${open ? ' open' : ''}`} />
      </button>
      {open && <div className="thinking-text">{text}</div>}
    </div>
  );
}

// 单条消息
function MessageItem({
  entry,
  streaming,
}: {
  entry: ChatEntry;
  streaming: boolean;
}) {
  const isUser = entry.role === 'user';

  return (
    <div className={`message message-${entry.role}`}>
      <div className="message-avatar">{isUser ? <IconUser size={15} /> : <IconBot size={15} />}</div>
      <div className="message-body">
        <div className="message-role">{isUser ? '你' : 'Agent'}</div>

        {/* 思考过程（灰色，可折叠） */}
        {entry.thinking ? <ThinkingBox text={entry.thinking} /> : null}

        {/* 正文；流式生成中在末尾加一个闪烁光标 */}
        {entry.content ? (
          <div className="message-content">
            {entry.content}
            {streaming && <span className="caret" />}
          </div>
        ) : null}

        {/* 工具调用卡片：按发生顺序排列 */}
        {entry.toolCalls?.map((call) => (
          <ToolCallViewer key={call.id} call={call} />
        ))}
      </div>
    </div>
  );
}

interface ChatInterfaceProps {
  messages: ChatEntry[];
  isLoading: boolean;
  onSend: (message: string) => void;
}

export function ChatInterface({ messages, isLoading, onSend }: ChatInterfaceProps) {
  const [draft, setDraft] = useState('');
  // 用户上滚后显示"回到底部"按钮（ref 变化不会触发渲染，所以这里额外用一个 state 镜像）
  const [scrolledUp, setScrolledUp] = useState(false);

  // ---- 自动滚动用的三个 ref ----
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 当前是否贴着底部
  const isAtBottomRef = useRef(true);
  // 用户是否主动往上滚了（一旦上滚就不再自动跟随，直到他自己回到底部）
  const userScrolledUpRef = useRef(false);
  // 程序滚动的时间戳上限：程序滚动也会触发 scroll 事件，这段时间内忽略，避免误判成"用户上滚"
  const programmaticScrollUntilRef = useRef(0);

  // 滚动到底部（标记为程序滚动）
  const scrollToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    programmaticScrollUntilRef.current = Date.now() + 500;
    el.scrollTop = el.scrollHeight;
    isAtBottomRef.current = true;
    userScrolledUpRef.current = false;
    setScrolledUp(false);
  };

  // 用户滚动：更新"是否在底部"
  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    // 程序滚动期间产生的 scroll 事件直接忽略
    if (Date.now() < programmaticScrollUntilRef.current) return;

    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distance < BOTTOM_THRESHOLD;
    userScrolledUpRef.current = !isAtBottomRef.current;
    setScrolledUp(!isAtBottomRef.current);
  };

  // 消息变化时：满足条件才自动跟随
  useEffect(() => {
    if (isAtBottomRef.current && !userScrolledUpRef.current) {
      scrollToBottom();
    }
  }, [messages]);

  // 发送：清空草稿并重置滚动状态（新消息一定要看到）
  const handleSend = () => {
    const text = draft.trim();
    if (!text || isLoading) return;
    onSend(text);
    setDraft('');
    // 清空后把输入框高度还原成单行
    const el = textareaRef.current;
    if (el) el.style.height = 'auto';
  };

  // 输入框按键：Enter 发送，Shift+Enter 换行（常规聊天习惯）
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // 输入框高度自适应内容
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  return (
    <section className="chat">
      <div className="message-list" ref={listRef} onScroll={handleScroll}>
        {messages.length === 0 && (
          <div className="empty-hint">
            和 Agent 说点什么吧
            <br />
            例如：「帮我计算 128 × 47」「执行 ls -la」
          </div>
        )}

        {messages.map((entry, idx) => (
          <MessageItem
            key={entry.id}
            entry={entry}
            // 只有最后一条助手消息在加载中时才显示光标
            streaming={isLoading && idx === messages.length - 1 && entry.role === 'assistant'}
          />
        ))}
      </div>

      {/* 用户上滚时给个"回到底部"的快捷入口 */}
      {scrolledUp && (
        <button type="button" className="scroll-bottom" onClick={scrollToBottom} title="回到底部">
          <IconArrowDown size={16} />
        </button>
      )}

      <div className="composer">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={isLoading ? '等待 Agent 完成…' : '输入消息，Enter 发送，Shift + Enter 换行'}
          rows={1}
        />
        <button type="button" onClick={handleSend} disabled={isLoading || !draft.trim()}>
          <IconSend size={14} />
          发送
        </button>
      </div>
    </section>
  );
}
