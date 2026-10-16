// 子 Agent 监控面板：主 Agent 通过内置的 task 工具把活派给子 Agent，
// 这里把所有 name === 'task' 的工具调用筛出来，按 subagent_type 显示不同图标和状态
import type { ToolCallInfo } from '../types';
import {
  IconCheck,
  IconCpu,
  IconHourglass,
  IconSearch,
  IconTerminal,
  type IconProps,
} from './icons';

// 子 Agent 类型 → 图标（找不到就退回通用「芯片」图标）
const SUBAGENT_ICONS: Record<string, React.FC<IconProps>> = {
  researcher: IconSearch,
  coder: IconTerminal,
  reviewer: IconCheck,
  'general-purpose': IconCpu,
};

// 从工具参数里读出子 Agent 类型（deepagents 的 task 工具参数：description / subagent_type）
function readSubagentType(args: Record<string, unknown>): string {
  const type = args.subagent_type;
  return typeof type === 'string' && type ? type : 'general-purpose';
}

// 描述可能被截断，这里取原始文本交给 CSS 做多行省略
function readDescription(args: Record<string, unknown>): string {
  const desc = args.description ?? args.prompt;
  return typeof desc === 'string' ? desc : '（无描述）';
}

export function SubagentMonitor({ calls }: { calls: ToolCallInfo[] }) {
  // 只关心委派类调用
  const subagentTasks = calls.filter((t) => t.name === 'task');

  return (
    <aside className="monitor">
      <div className="monitor-head">
        <IconCpu size={15} />
        子 Agent 任务
        <span className="tool-spacer" />
        <span className="action-desc">{subagentTasks.length}</span>
      </div>

      <div className="monitor-body">
        {subagentTasks.length === 0 && (
          <div className="monitor-empty">
            还没有子 Agent 任务
            <br />
            试着让主 Agent 委派一次研究或编码任务
          </div>
        )}

        {/* 最新派发的排在最上面 */}
        {[...subagentTasks].reverse().map((task) => {
          const type = readSubagentType(task.args);
          const Icon = SUBAGENT_ICONS[type] ?? IconCpu;
          const running = task.status === 'pending';

          return (
            <div className="subagent-card" key={task.id}>
              <div className="subagent-icon">
                <Icon size={16} />
              </div>
              <div className="subagent-main">
                <div className="subagent-title">
                  {type}
                  <span className="tool-spacer" />
                  <span className={`tool-badge ${task.status}`}>
                    {running ? <IconHourglass size={11} /> : null}
                    {running ? '进行中' : task.status === 'error' ? '失败' : '完成'}
                  </span>
                </div>
                <div className="subagent-desc">{readDescription(task.args)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
