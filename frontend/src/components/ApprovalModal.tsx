// 审批弹窗：Agent 触发敏感操作（如 execute / write_file）被中断时弹出
// 每个待审批操作都可以独立选择：批准 / 拒绝（可写原因）/ 编辑参数后执行
// 决策会一次性打包成 Decision[] 发回后端，后端用 Command({ resume }) 恢复 Agent
import { useState } from 'react';
import type { Decision, ReviewConfig } from '../types';
import type { InterruptState } from '../hooks/useWebSocket';
import { IconAlert, IconCheck, IconEdit, IconShield, IconX } from './icons';

type Mode = 'approve' | 'reject' | 'edit';

// 每个待审批操作在前端的一份草稿（用户改到一半的状态都放这里）
interface Draft {
  mode: Mode;
  rejectMessage: string; // 拒绝原因
  argsText: string; // 编辑模式下的 JSON 文本
  editConfirmed: boolean; // 参数是否已通过 JSON 校验
}

// 后端没给 allowedDecisions 时的兜底：三种都允许
const DEFAULT_ALLOWED: Mode[] = ['approve', 'edit', 'reject'];

const MODE_LABEL: Record<Mode, string> = {
  approve: '批准',
  edit: '编辑参数',
  reject: '拒绝',
};

export function ApprovalModal({
  interrupt,
  onSubmit,
}: {
  interrupt: InterruptState;
  onSubmit: (decisions: Decision[]) => void;
}) {
  const { actionRequests, reviewConfigs } = interrupt;

  // 初始化每个操作的草稿：默认选中第一个被允许的决策
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    actionRequests.map((action, idx) => {
      const allowed = allowedOf(reviewConfigs[idx]);
      return {
        mode: allowed[0],
        rejectMessage: '',
        argsText: JSON.stringify(action.args ?? {}, null, 2),
        editConfirmed: false,
      };
    }),
  );

  // 某个操作的决策选项（按 reviewConfigs 过滤）
  function allowedOf(config?: ReviewConfig): Mode[] {
    const list = config?.allowedDecisions as Mode[] | undefined;
    const filtered = (list ?? DEFAULT_ALLOWED).filter((m) =>
      DEFAULT_ALLOWED.includes(m),
    );
    return filtered.length ? filtered : DEFAULT_ALLOWED;
  }

  const update = (idx: number, patch: Partial<Draft>) => {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  };

  // 编辑参数：先校验 JSON，通过了才标记为已确认
  const confirmEdit = (idx: number) => {
    try {
      JSON.parse(drafts[idx].argsText);
      update(idx, { editConfirmed: true });
    } catch {
      alert('JSON 格式错误，请检查');
    }
  };

  // 汇总提交
  const handleSubmit = () => {
    const decisions: Decision[] = [];

    for (let i = 0; i < actionRequests.length; i++) {
      const draft = drafts[i];

      if (draft.mode === 'approve') {
        decisions.push({ type: 'approve' });
        continue;
      }

      if (draft.mode === 'reject') {
        decisions.push({ type: 'reject', message: draft.rejectMessage || undefined });
        continue;
      }

      // 编辑模式：提交前必须再校验一次（用户可能改完没点确认）
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(draft.argsText);
      } catch {
        alert(`「${actionRequests[i].name}」的参数不是合法 JSON，请检查`);
        return;
      }
      decisions.push({
        type: 'edit',
        editedAction: { name: actionRequests[i].name, args: parsed },
      });
    }

    onSubmit(decisions);
  };

  // 只有真的存在待审批操作时才渲染弹窗
  if (actionRequests.length === 0) return null;

  return (
    <div className="modal-mask">
      <div className="modal">
        <div className="modal-head">
          <IconShield size={18} />
          <div>
            <div className="modal-title">需要你确认的操作</div>
            <div className="modal-sub">
              Agent 想执行 {actionRequests.length} 个敏感操作，请逐条选择处理方式
            </div>
          </div>
        </div>

        <div className="modal-body">
          {actionRequests.map((action, idx) => {
            const draft = drafts[idx];
            const allowed = allowedOf(reviewConfigs[idx]);

            return (
              <div className="action-card" key={`${action.name}-${idx}`}>
                <div className="action-card-head">
                  <IconAlert size={15} />
                  <span className="action-name">{action.name}</span>
                  <span className="tool-spacer" />
                  <span className="action-desc">
                    {action.description ?? `允许的决策：${allowed.join(' / ')}`}
                  </span>
                </div>

                <div className="action-card-body">
                  {/* 决策选项：只显示该操作允许的类型 */}
                  <div className="decision-row">
                    {allowed.map((mode) => (
                      <button
                        type="button"
                        key={mode}
                        className={`${mode}${draft.mode === mode ? ' active' : ''}`}
                        onClick={() => update(idx, { mode })}
                      >
                        {mode === 'approve' && <IconCheck size={13} />}
                        {mode === 'edit' && <IconEdit size={13} />}
                        {mode === 'reject' && <IconX size={13} />}
                        {MODE_LABEL[mode]}
                      </button>
                    ))}
                  </div>

                  {/* 拒绝：可选填原因 */}
                  {draft.mode === 'reject' && (
                    <textarea
                      value={draft.rejectMessage}
                      placeholder="拒绝原因（可选），会作为反馈交回 Agent"
                      onChange={(e) => update(idx, { rejectMessage: e.target.value })}
                      style={{ minHeight: 70 }}
                    />
                  )}

                  {/* 编辑：改 JSON 参数（默认展示原参数，方便照着改） */}
                  {draft.mode === 'edit' ? (
                    <>
                      <textarea
                        value={draft.argsText}
                        onChange={(e) =>
                          update(idx, { argsText: e.target.value, editConfirmed: false })
                        }
                      />
                      <div className="edit-row">
                        <button type="button" onClick={() => confirmEdit(idx)}>
                          确认参数
                        </button>
                        {draft.editConfirmed && (
                          <span className="edit-ok">
                            <IconCheck size={13} /> 参数已确认
                          </span>
                        )}
                      </div>
                    </>
                  ) : (
                    // 非编辑模式：只读展示将要执行的参数
                    <div>
                      <div className="tool-label">参数</div>
                      <pre>{JSON.stringify(action.args ?? {}, null, 2)}</pre>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="modal-foot">
          <button type="button" onClick={handleSubmit}>
            提交决策
          </button>
        </div>
      </div>
    </div>
  );
}
