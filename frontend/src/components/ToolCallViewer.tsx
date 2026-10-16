// 工具调用卡片：可折叠，展示参数和结果
// 状态由 useWebSocket 维护（pending → completed）
import { useState } from 'react';
import type { ToolCallInfo } from '../types';
import { IconChevron, IconWrench } from './icons';

// 状态 → 文案 / 样式类名
const STATUS_TEXT: Record<ToolCallInfo['status'], string> = {
  pending: '执行中',
  completed: '完成',
  error: '失败',
};

export function ToolCallViewer({ call }: { call: ToolCallInfo }) {
  // 默认展开：用户最关心的就是"Agent 到底传了什么参数"
  const [open, setOpen] = useState(true);

  return (
    <div className="tool-card">
      {/* 头部：点一下折叠/展开 */}
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <IconWrench size={14} />
        <span className="tool-name">{call.name}</span>
        <span className="tool-spacer" />
        <span className={`tool-badge ${call.status}`}>{STATUS_TEXT[call.status]}</span>
        <IconChevron size={14} className={`tool-chevron${open ? ' open' : ''}`} />
      </button>

      {open && (
        <div className="tool-body">
          {/* 参数：后端已经把流式碎片拼成完整 JSON 了 */}
          <div>
            <div className="tool-label">参数</div>
            <pre>{JSON.stringify(call.args ?? {}, null, 2)}</pre>
          </div>

          {/* 结果：还没回来时占位，让用户知道在等 */}
          <div>
            <div className="tool-label">结果</div>
            <pre>{call.result ?? '（等待返回…）'}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
