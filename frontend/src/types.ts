// 前后端共享的通信协议类型
// 后端 src/server.ts 通过相对路径 import type 复用这里的定义（只导类型，运行时不产生依赖）
// 协议一共 2 种上行消息 + 7 种下行事件

// ============ 上行：前端 → 后端 ============

// 发一条聊天消息
export interface ChatMessage {
  type: 'chat';
  message: string;
  threadId: string;
}

// 提交人工审批的决策（后端收到后用它恢复被中断的 Agent）
export interface DecisionMessage {
  type: 'decision';
  threadId: string;
  data: Decision[];
}

// 单条决策：批准 / 拒绝（可带原因）/ 编辑参数后执行
export type Decision =
  | { type: 'approve' }
  | { type: 'reject'; message?: string }
  | {
      type: 'edit';
      editedAction: {
        name: string;
        args: Record<string, unknown>;
      };
    };

// ============ 下行：后端 → 前端 ============

// 一个待审批的操作（来自 Agent 的中断请求）
export interface ActionRequest {
  name: string;
  args: Record<string, unknown>;
  description?: string;
}

// 该操作允许的决策类型（来自 createDeepAgent 的 interruptOn 配置）
export interface ReviewConfig {
  actionName: string;
  allowedDecisions: string[];
}

export type ServerEvent =
  | { type: 'text'; content: string } // 正文增量
  | { type: 'thinking'; content: string } // 思考过程增量
  | {
      type: 'tool_call';
      name: string;
      args: Record<string, unknown>;
      id: string;
    }
  | {
      type: 'tool_result';
      name: string;
      result: string;
      id: string;
    }
  | {
      type: 'interrupt';
      actionRequests: ActionRequest[];
      reviewConfigs: ReviewConfig[];
    }
  | { type: 'done' } // 本轮（含所有中断恢复）结束
  | { type: 'error'; message: string };

// ============ 前端内部使用的数据结构 ============

export type ToolCallStatus = 'pending' | 'completed' | 'error';

// 一次工具调用的完整信息（前端按 id 把 tool_call 和 tool_result 配对）
export interface ToolCallInfo {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  status: ToolCallStatus;
}

// 消息列表里的一条
export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  toolCalls?: ToolCallInfo[];
  createdAt: number;
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';
