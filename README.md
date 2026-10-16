# ai-agent-study

一个用于**学习 LLM Agent 调用流程**的最小示例项目：基于 `deepagents` + LangGraph 搭建 Agent，注册自定义工具（计算器、获取时间），挂载文件系统后端（读写文件、搜索文件、执行 shell 命令），接入持久记忆（`AGENTS.md`）与领域技能（`skills/`），还能把任务委派给专职子 Agent（`subagents`），并把整轮 **ReAct**（推理 → 调工具 → 观察 → 再推理）的执行细节完整打印到终端。

重点不在"做出一个能用的 Agent"，而在**看清每一步到底发生了什么**：请求发了什么、响应回了什么、工具是谁执行的、上下文是怎么一轮轮累积的。

---

## 技术栈

| 依赖 | 作用 |
| --- | --- |
| `deepagents` | 创建 Agent；提供 `LocalShellBackend`（文件系统 + shell 后端），内部用 LangGraph 编排节点与流转 |
| `@langchain/langgraph` | 状态图运行时；`MemorySaver` 提供多轮记忆 |
| `@langchain/anthropic` | 模型客户端（本项目指向 DeepSeek 的 Anthropic 兼容端点） |
| `@langchain/core` | 消息、工具等基础抽象 |
| `zod` | 定义工具参数结构（会转成 JSON Schema 发给模型） |
| `tsx` | 直接运行 TypeScript，免编译 |
| `ws` | WebSocket 服务端（`src/server.ts`），把 Agent 的执行过程实时推给前端 |
| `React 19` + `Vite` | `frontend/` 里的实时聊天界面（pnpm workspace 子包） |

环境：Node.js 20+，包管理器 pnpm。

---

## 快速开始

### 命令行示例

```bash
# 1. 安装依赖
pnpm install

# 2. 创建模型接入配置（该文件已被 .gitignore 忽略，不会随仓库分发）
#    新建 src/config.ts，内容见下方「配置」

# 3. 运行
pnpm dev
# 或
npm run dev
# 或
npx tsx src/index.ts
```

> 注意：`tsx` 必须作为项目依赖安装（`pnpm add -D tsx`），否则 npm scripts 会报 `tsx: command not found`。
> 用 `npx tsx` 能跑是因为 npx 会临时下载，绕过了本地依赖。

### 实时聊天界面（两个终端）

```bash
# 终端 1：后端 WebSocket 服务（默认 3001）
pnpm server

# 终端 2：前端开发服务器（默认 5173）
cd frontend && pnpm dev
```

打开 http://localhost:5173 即可对话，详见下方「实时聊天界面」。

---

## 目录结构

```
ai-agent-study/
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml   # 声明 frontend 为子包
├── frontend/           # 实时聊天界面（Vite + React 19 + TS）
│   ├── index.html
│   ├── vite.config.ts  # 把 /ws 代理到后端 3001，前端只管连自己的 host
│   └── src/
│       ├── main.tsx / App.tsx / styles.css
│       ├── types.ts    # 与后端共享的通信协议类型
│       ├── hooks/useWebSocket.ts        # 协议 → React 状态
│       └── components/  # ChatInterface / ApprovalModal / ToolCallViewer / SubagentMonitor / icons
├── workspace/          # Agent 的文件操作根目录（backend 的 rootDir），也是它的"沙箱"
│   ├── AGENTS.md       # 持久记忆：用户偏好、项目上下文、编码约束（memory 选项加载）
│   ├── conversation_history/   # 记忆机制落盘的会话记录（运行时生成，未纳入版本控制）
│   ├── index.html      # Demo 4 运行后由 Agent 写入的文件
│   ├── public/
│   │   └── script.sh   # Demo 6 运行后由 Agent 创建并执行的脚本
│   └── skills/         # 领域技能库：每个子目录是一个技能，内含 SKILL.md
│       ├── code-review/SKILL.md      # 代码审查规范
│       ├── product-faq/SKILL.md      # 产品常见问题
│       └── refund-policy/SKILL.md    # 退款政策
└── src/
    ├── config.ts       # 模型接入配置（含密钥，已被 .gitignore 忽略，需自行创建）
    ├── backend.ts      # 文件系统后端（LocalShellBackend，rootDir 指向 workspace/）
    ├── agents.ts       # 模型实例 + Agent 组装（含 interruptOn 审批配置），全项目共用
    ├── tools.ts        # 自定义工具（calculator、get_current_time）
    ├── utils.ts        # 终端打印：printStream / printModelRequest / printModelResponse
    ├── middleware.ts   # 中间件：摘要压缩（summarization）+ 记忆注入（memory）
    ├── subagents.ts    # 子 Agent 定义：researcher（研究）/ coder（编码）/ reviewer（审查）
    ├── hitl.ts         # 命令行人工审批：中断检测、展示待审批操作、收集决策并恢复执行
    ├── server.ts       # WebSocket 服务：把 Agent 执行过程推给前端，并接收审批决策
    ├── demos.ts        # 示例集合：demo1~9（调用流程）+ demo13~15（人工审批）
    └── index.ts        # 入口：启动某个示例
```

---

## 核心流程

一次提问在框架内部的流转过程：

```
用户提问
   ↓
【模型节点】请求模型（带完整上下文：system + 历史消息 + 工具定义）
   ↓
模型返回 AIMessage：
   ├─ 有 tool_calls → 去【工具节点】执行 → 结果包成 ToolMessage 回灌 → 回到模型节点
   └─ 无 tool_calls → 结束，输出最终回答
```

几个关键认知：

- **模型不执行任何代码**，它只产出"调用意图"（`tool_calls: [{ id, name, args }]`）。
- 真正执行工具的是 LangGraph 的 `ToolNode`：按 `name` 在本地工具表里查找，用 `args` 调用对应的 JS 函数。
- 工具的**返回值**（字符串）会作为 `ToolMessage` 回灌给模型，成为下一轮的"观察结果"。
- 流式返回下，`tool_use` block 的 `input` 是**空字符串**，真正的参数在随后的 `input_json_delta` 碎片里，需要拼接；LangChain 已帮你拼好并解析成 `tool_calls[].args`。
- 上下文是**累积**的：第二轮请求的 messages 会包含第一轮的 AI 消息（含工具调用）和工具结果。

---

## Agent 的能力：自定义工具 + 文件后端

Agent 实际可用的工具比 `createDeepAgent` 里手写的多，来源有两处：

| 来源 | 工具 | 说明 |
| --- | --- | --- |
| `tools` 选项（自己写的） | `calculator`、`get_current_time` | 见 [src/tools.ts](src/tools.ts) |
| `backend` 选项（deepagents 自动注入） | `ls`、`read_file`、`write_file`、`edit_file`、`delete`、`glob`、`grep`、`task` | 文件读写、检索，以及派生子任务 |

所以运行日志里会看到 `[工具清单] 共 10 个`——就是这两部分相加的结果。

文件后端在 [src/agents.ts](src/agents.ts) 中创建：

```ts
export const backend = await LocalShellBackend.create({
  rootDir: workspaceDir,   // Agent 的文件操作根目录（项目下的 workspace/）
  virtualMode: true,       // 虚拟路径模式
  timeout: 30,             // shell 命令超时时间（秒）
  maxOutputBytes: 50000,   // 命令输出最大字节数，防止输出刷屏
});
```

| 参数 | 含义 |
| --- | --- |
| `rootDir` | 文件操作与 shell 命令的工作目录，即 `workspace/` 的绝对路径（用 `import.meta.dirname` 从 `src/` 上跳一级解析） |
| `virtualMode` | `true` 时把 `rootDir` 当作**虚拟根文件系统**：传入的路径按虚拟绝对路径处理，禁止 `..`、`~` 这类向上穿越，并确保解析结果始终落在 root 内 |
| `timeout` | 单条 shell 命令的超时时间 |
| `maxOutputBytes` | 命令输出的截断上限 |

> 注意：`virtualMode` **只约束文件操作，不限制 shell 命令**。也就是说模型仍可通过 shell 访问 `workspace/` 之外的内容——这是学习项目里的默认行为，真实产品务必配合权限与沙箱策略。

另外，由于 backend 用的是支持 `execute` 的 `LocalShellBackend`，`createDeepAgent` 里不能再传 `permissions`（两者不兼容）。

---

## 持久记忆与领域技能

[src/agents.ts](src/agents.ts) 里 `createDeepAgent` 还配了两个选项，让 Agent 拥有"跨会话的知识"：

```ts
checkpointer: new MemorySaver(),   // 会话内的多轮记忆（按 thread_id 隔离）
memory: ['/AGENTS.md'],            // 持久记忆：加载该文件作为长期上下文
skills: ['/skills/'],              // 领域技能：扫描该目录下所有含 SKILL.md 的子目录
```

`memory` 和 `skills` 的路径都以 `/` 开头，指向 backend 的 `rootDir`（即 `workspace/`）下的位置。这三种"记忆"的区别值得分清：

| 机制 | 作用范围 | 存放位置 |
| --- | --- | --- |
| `checkpointer` + `thread_id` | **单次会话内**的历史消息，不同 `thread_id` 之间互不可见 | 进程内存（`MemorySaver`） |
| `memory` | **跨会话**的长期偏好与约束，相当于 Agent 的"人设" | `workspace/AGENTS.md` |
| `skills` | **按需取用**的领域知识，每个技能一份 `SKILL.md` | `workspace/skills/<技能名>/SKILL.md` |

[workspace/AGENTS.md](workspace/AGENTS.md) 里写的是用户偏好（中文回复、camelCase 命名、中文行内注释）和项目上下文（pnpm、`pnpm dev` 运行）以及编码约束（工具必须有 Zod schema、错误信息用中文等）。其中一条「环境注意」尤其值得记住：**文件工具（`ls` / `read_file` / `write_file` 等）作用于虚拟工作目录（根为 `/`），而 `execute` 的 shell 沙箱是另一套真实文件系统，两者不互通**——所以不要用 `execute` 去验证文件工具看到的路径。

`skills/` 下的每个子目录是一个技能，`SKILL.md` 用 YAML frontmatter 声明 `name` 和 `description`：

```markdown
---
name: refund-policy
description: 退款政策知识库，回答退款条件、退款时限、退款比例、申请流程、不予退款情形等问题时使用
---
```

当前有三个技能：`code-review`（代码审查规范）、`product-faq`（产品常见问题）、`refund-policy`（退款政策）。`description` 是模型判断"这次要不要用这个技能"的依据，写得越具体越好。

验证方式见示例 `demo6SkillsRefound()`：问"我前天买了 100 元的产品、用了 2 次，现在想退款，能退多少"，答案必须按 `refund-policy` 里的规则算出来。

### 通过中间件增强记忆

除上面两个选项外，[src/middleware.ts](src/middleware.ts) 里还定义了两个中间件，通过 `middleware` 选项挂到 Agent 上：

| 中间件 | 作用 | 关键配置 |
| --- | --- | --- |
| `summarizationMiddleware` | 对话变长时把早期消息压缩成摘要，避免上下文无限增长（同时省 token） | 超过 20 条消息触发，保留最近 10 条原文 |
| `memoryAgentsMiddleware` | 把 `AGENTS.md` 注入请求，让偏好与约束跨会话生效 | `sources: ['/AGENTS.md']`；`addCacheControl: true` 启用 prompt 缓存 |

两者都复用同一个 `backend`，所以路径同样以 `workspace/` 为根。

> 注意：`memory: ['/AGENTS.md']` 与 `memoryAgentsMiddleware` 的 `sources` 指向同一个文件，如果两者都生效，模型看到的 `AGENTS.md` 内容可能是双份。跑 `demo6SkillsRefound` 时对比 `[消息列表]` 里这段内容出现的次数，就能验证。

---

## 子 Agent（subagents）

[src/subagents.ts](src/subagents.ts) 里定义了三个专职子 Agent，通过 `createDeepAgent` 的 `subagents` 选项注册：

| 子 Agent | 职责 | 能力约束 |
| --- | --- | --- |
| `researcher` | 收集信息、搜索文件、阅读内容，产出结构化分析报告 | 提示词要求"只研究和报告，不修改任何文件" |
| `coder` | 编写代码、创建文件、执行命令、运行测试 | 读写文件 + shell |
| `reviewer` | 审查代码的正确性、可读性、性能、安全性 | 提示词要求"只审查和建议，不修改任何文件" |

委派机制：主 Agent 不必自己做所有事——它可以调用内置的 `task` 工具把子任务交出去，子 Agent 在**独立上下文**中完成后把结果返回。**选哪个子 Agent 由各自的 `description` 决定**（和技能的 `description` 同理，写得越具体，选择越准）：

```ts
export const researcher: SubAgent = {
  name: 'researcher',
  description: '研究助手，擅长信息收集、文件搜索和内容分析。当需要查找资料、阅读文件、总结内容时，委派给这个子 Agent。',
  systemPrompt: '...',
};
```

三点注意：

- 三个子 Agent 都**没有单独指定 `tools` / `backend`**，能力继承自主 Agent，差异主要来自 `systemPrompt` 的职责约束。
- [src/subagents.ts](src/subagents.ts) 里 `reviewer` 有一段被注释掉的 `permissions`：`permissions` 会**替换**而非合并主 Agent 的权限配置，且与支持 `execute` 的 `LocalShellBackend` 不兼容。所以"只读"目前靠提示词约束，**不是真正的隔离**。
- 子 Agent 有自己的上下文，主 Agent 只拿到它返回的结论——这也是控制上下文膨胀的常用手段。

验证方式见示例 `demo9SubAgentResearcher()`：给一个"研究目录结构 + 顺手改 HTML 字体颜色"的复合任务，观察主 Agent 如何把两个子任务分别交给 `researcher` 和 `coder`。

---

## 人工审批（HITL）

有些工具不该让 Agent 直接执行——`execute` 能删文件、`write_file` 能覆盖内容。`createDeepAgent` 的 `interruptOn` 选项用来声明"哪些工具在执行前必须人工确认"：

```ts
interruptOn: {
  execute: {
    allowedDecisions: ['approve', 'reject'] as const,
    description: '⚠️ Shell 命令即将执行，请确认后审批',
  },
  write_file: {
    allowedDecisions: ['approve', 'edit', 'reject'] as const,
    description: '📝 文件写入操作，请审批',
  },
  edit_file: { /* 同上 */ },
},
```

| 配置项 | 含义 |
| --- | --- |
| 工具名（`execute` / `write_file` / `edit_file`） | 需要审批的工具；**没列出的工具自动放行**（如 `calculator`、`read_file`） |
| `allowedDecisions` | 该工具允许的决策：`approve`（批准）、`reject`（拒绝）、`edit`（改参数后执行） |
| `description` | 展示给审批人的说明，会出现在中断提示里 |

中断 → 审批 → 恢复的完整流程（实现见 [src/hitl.ts](src/hitl.ts)）：

```
agent.invoke(消息, config)
   ↓ 模型决定调用 execute
【中断】isInterrupted(result) 为 true，result[INTERRUPT] 拿出 actionRequests
   ↓ 展示待审批操作 → 用户在终端输入 y / n / e
构造 HITLResponse = { decisions: [...] }
   ↓ 用 new Command({ resume: hitlResponse }) 恢复
agent.invoke(Command, config)     ← 必须传同一个 config（同一个 thread_id）
   ↓ 可能再次中断（多个工具连续需要审批），递归处理
拿到最终状态 → 打印最后一条 AI 消息
```

四点关键：

- **必须有 `checkpointer`**：中断时的状态要靠它保存，否则恢复不回来（本项目已有 `MemorySaver`）。
- **恢复要用同一个 `config`**：中断状态是按 `thread_id` 存的，恢复时必须传同一个 id。[src/hitl.ts](src/hitl.ts) 自己定义了 `config`（`session-1`），和 `demos.ts` 里的 `config1` 恰好同 id 但互不相干。
- **这批示例用 `agent.invoke` 而不是 `agent.stream`**：需要拿到完整状态判断"是否中断"，并靠 `Command` 恢复。
- **必须在真实终端里运行**：审批要读键盘输入（`process.stdin`），管道或非交互式环境会一直等下去。

验证方式见示例 `demo13InterruptExecute()`（shell 审批，只允许 y / n）、`demo14InterruptWriteFile()`（写文件审批，可以试 `e` 改参数）、`demo15MixedApproval()`（计算自动放行 + shell 触发审批）。

---

## 实时聊天界面

上面那些示例是"在终端里看流程"，`src/server.ts` + `frontend/` 则把它做成一个网页：实时流式输出、弹窗审批、子 Agent 状态面板。

启动见「快速开始 → 实时聊天界面」。架构很简单——前端只负责展示和收输入，所有 Agent 逻辑仍在后端：

```
浏览器 (frontend/)  ──WebSocket /ws──▶  src/server.ts  ──▶  agents.ts 里的 agent
      │                                     │
      └────── 展示 7 种下行事件 ◀────────────┘  流式输出 / 中断审批 / 去重都在这里处理
```

前端连的是自己 host 的 `/ws`，由 Vite 代理到 `localhost:3001`，所以代码里不用写后端地址。

### 通信协议（2 种上行 + 7 种下行）

类型定义在 [frontend/src/types.ts](frontend/src/types.ts)，前后端共用（后端只 `import type`，运行时不产生依赖）。

| 方向 | 消息 | 说明 |
| --- | --- | --- |
| ↑ | `chat` | 发一条消息（`message` + `threadId`） |
| ↑ | `decision` | 提交审批决策：`approve` / `reject` / `edit` 三种 |
| ↓ | `text` | 正文增量 |
| ↓ | `thinking` | 思考过程增量 |
| ↓ | `tool_call` | 工具调用开始（已拼好完整参数） |
| ↓ | `tool_result` | 工具执行结果 |
| ↓ | `interrupt` | 需要审批，带 `actionRequests` + `reviewConfigs` |
| ↓ | `done` | 本轮（含所有中断恢复）结束 |
| ↓ | `error` | 出错 |

### 后端要点（[src/server.ts](src/server.ts)）

- **`decision` 单独路由**：不能再用 `ws.once('message')` 去等决策，否则会和外层 `ws.on('message')` 抢同一条消息。做法是维护 `pendingDecisions` 队列，`waitForDecision` 只往里放 waiter，真正的分发统一在最外层做。
- **用 `agent.stream` 而不是 `invoke`**：否则用户要干等整轮跑完。订阅 `['messages', 'updates']`——`messages` 出正文/思考/工具，`updates` 用来抓 `__interrupt__`（`getState().isInterrupted` 在 deepagents 中间件下不可靠）。
- **工具参数要攒**：流式下 `tool_use` 头部片的 `input` 是空对象 `{}`，参数在后续 `input_json_delta` / `tool_call_chunks` 碎片里。按 `index` 攒成合法 JSON 才发 `tool_call`，否则前端会看到空参数。
- **恢复后要去重**：LangGraph 从中断恢复会重放节点，同一条消息会再次流出，所以按 `message.id` / `tool_call.id` 记在 `sentMessageIds` / `sentToolCallIds` 里。

### 前端要点

- [useWebSocket.ts](frontend/src/hooks/useWebSocket.ts) 把 7 种事件翻译成 React 状态，对外只暴露 `{ sendMessage, sendDecision, messages, interrupt, status, isLoading }`。流式数据用 `useRef` 同步累积、攒完再 `setState`（避免闭包陷阱），断线 5 秒后自动重连。
- [ApprovalModal.tsx](frontend/src/components/ApprovalModal.tsx) 按 `reviewConfigs` 里的 `allowedDecisions` 决定显示哪些按钮（比如 `execute` 只给批准/拒绝），编辑模式下先校验 JSON 再提交。
- [SubagentMonitor.tsx](frontend/src/components/SubagentMonitor.tsx) 从所有工具调用里筛 `name === 'task'` 的，按 `subagent_type` 显示 `researcher` / `coder` / `reviewer` 的状态。
- [ChatInterface.tsx](frontend/src/components/ChatInterface.tsx) 的自动滚动用三个 ref 区分"用户主动上滚"和"程序滚动"：用户上滚后不再自动跟随，点右下角按钮才回到底部。

---

## 示例（demos.ts）

所有"怎么调用 Agent"的示例集中在 [src/demos.ts](src/demos.ts)：

| 函数 | 会话 | 作用 |
| --- | --- | --- |
| `createTraceCallbacks()` | — | 返回请求/响应打印的两个 hook，供 `agent.stream` 的 `callbacks` 使用 |
| `demoCalculator()` | `session-1` | 让模型算 128 × 47，观察完整的"模型 → 工具 → 模型"链路（挂了 traceCallbacks） |
| `demoFollowUp()` | `session-1` | 在同一会话里追问"再加10"，观察 `checkpointer` 带来的多轮记忆（挂了 traceCallbacks） |
| `demo4ExecuteShell()` | `session-3` | 让模型往 HTML 文件里写入一个 `<h1>` 标签，观察文件写入能力 |
| `demo5ExecuteShell()` | `session-3` | 让模型列出当前目录下的文件并统计数量，观察 `ls` / `glob` / `grep` 这类文件检索工具 |
| `demo6ExecuteShell()` | `session-3` | 让模型在 `/public/` 下创建 `script.sh`（内容为 `echo "Hello World"`）并执行，观察 shell 执行与输出回灌 |
| `demo6SkillsRefound()` | `session-1` | 用"买了 100 元、用了 2 次，现在能退多少"这类需要规则计算的问题，验证 `refund-policy` 技能能否被取用 |
| `demo7Agents()` | `session-1` | 让模型写一个合并数组的工具函数，验证 `AGENTS.md` 里的编码约束（TypeScript、中文注释等）是否被遵守 |
| `demo8SkillsProduct()` | `session-1` | 问"这个项目支持哪些工具、怎么运行"，验证 `product-faq` 技能 |
| `demo9SubAgentResearcher()` | `session-1` | 给一个"研究目录结构 + 修改 `index.html` 字体颜色"的复合任务，观察主 Agent 如何把两个子任务分别委派给 `researcher` 和 `coder` |
| `demo13InterruptExecute()` | `session-1` | 让模型执行 `echo`，触发 `execute` 的审批中断（只允许 y / n） |
| `demo14InterruptWriteFile()` | `session-1` | 让模型在 `/public/` 下写 `hitl-test.txt`，触发 `write_file` 的审批中断（可试 `e` 改参数） |
| `demo15MixedApproval()` | `session-1` | 先算 256 ÷ 8（自动放行）再执行 `echo`（触发审批），观察同一轮里的两种处理 |

切换示例：改 [src/index.ts](src/index.ts) 里 `main()` 调用的函数即可（当前默认跑 `demo15MixedApproval()`）。

```ts
async function main() {
  // await demoCalculator();
  // await demoFollowUp()
  // await demo4ExecuteShell()
  // await demo5ExecuteShell()
  // await demo6ExecuteShell()
  // await demo6SkillsRefound()
  // await demo7Agents()
  // await demo8SkillsProduct()
  // await demo9SubAgentResearcher()

  // 下面三个是人工审批（HITL）示例：运行到需要审批的工具时，终端会暂停等待键盘输入
  // await demo14InterruptWriteFile()
  await demo15MixedApproval()
  // await demo13InterruptExecute()
}
```

> Demo 4/5/6 共用 `config3`（`session-3`），`demo6SkillsRefound` / `demo7Agents` / `demo8SkillsProduct` / `demo9SubAgentResearcher` 用 `config1`（`session-1`）。其中 `demo9SubAgentResearcher` 挂了 `traceCallbacks`，能在「模型请求」里看到主 Agent 是怎么向子 Agent 描述任务的；其余几例没挂，终端只输出流式的思考、工具调用与结果——想连"请求参数 / 响应结构"一起看，在它们的 `agent.stream` 选项里补上 `callbacks: createTraceCallbacks()` 即可。

> `demo13` ~ `demo15` 不走 `agent.stream`：它们调用 [src/hitl.ts](src/hitl.ts) 的 `runWithInterruptHandling`，用的是 [src/hitl.ts](src/hitl.ts) 里自己定义的 `config`。

> 文件职责：模型与 Agent 组装在 [src/agents.ts](src/agents.ts)，示例在 [src/demos.ts](src/demos.ts)，命令行审批在 [src/hitl.ts](src/hitl.ts)，WebSocket 服务在 [src/server.ts](src/server.ts)；[src/index.ts](src/index.ts) 只负责启动某个示例。`server.ts` 和 `demos.ts` / `hitl.ts` 都从 `agents.ts` 取同一个 `agent`。

---

## 终端输出说明

运行时终端会分门别类地打印整轮过程，颜色用于区分不同来源的信息：

| 前缀 | 颜色 | 含义 |
| --- | --- | --- |
| `[用户]` | 青 | 本轮提问（ReAct 的起点） |
| `[调用模型]` | 品红 | 标记"第几次调用模型"，附运行元数据（step、thread 等） |
| `[思考]` | 灰 | 模型的内部推理（扩展思考） |
| （正文） | 默认 | 模型给用户的正式回答，逐字流式输出 |
| `[调用工具]` | 黄 | 模型请求调用的工具及参数 |
| `[工具结果]` | 绿 | 工具执行后的返回值 |
| `──────── 模型请求 #N ────────` | 品红 | 发给模型的完整参数：请求参数 / 工具清单 / 消息列表 |
| `──────── 模型响应 #N ────────` | 品红 | 模型返回的原始结构：结束原因 / token 用量 / 原始 content / tool_calls |

其中"模型请求 / 模型响应"两块由 [src/demos.ts](src/demos.ts) 的 `createTraceCallbacks` 提供，挂在两个 hook 上：

- `handleChatModelStart`：请求前触发，能拿到模型配置、工具定义、完整消息列表。
- `handleLLMEnd`：响应后触发，能拿到 AIMessage 的原始 content block、`tool_calls`、token 用量与响应 metadata。

---

## 配置

模型接入信息集中在 `src/config.ts`。**该文件已被 `.gitignore` 忽略**（含密钥，不随仓库分发），拉取代码后需自行创建：

```ts
export const config = {
  ANTHROPIC_API_KEY: '...',
  ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  MODEL_NAME: 'deepseek-flash',
};
```

说明：

- 虽然用的是 `ChatAnthropic`，但通过 `anthropicApiUrl` 指向了 DeepSeek 的 Anthropic 兼容端点，所以实际调用的是 DeepSeek 的模型。
- **密钥目前是明文写在代码里的，仅供本地学习调试**。正式项目请改用环境变量（如 `process.env.ANTHROPIC_API_KEY`）。
- 部分第三方网关不回传 `stop_reason` / `id` / `model`，此时 `[结束原因]` 会退化成"按有没有工具调用来推断"。
- Anthropic 系接口支持 prompt 缓存，日志里的 `缓存读取` / `缓存写入` 即为命中情况。

---

## 变更记录

约定：每次改动在表格**顶部**新增一行，格式为 `版本 | 日期 | 变更内容`；同一天多次改动可合并到同一条内，用分号分隔。

| 版本 | 日期 | 变更内容 |
| --- | --- | --- |
| v1.6.0 | 2026-10-16 | 工作区改动（尚未提交）：`createDeepAgent` 增加 `interruptOn` 配置（`execute` / `write_file` / `edit_file` 执行前需人工审批）；新增 `src/hitl.ts`（中断检测、审批交互、`Command` 恢复，导出 `runWithInterruptHandling`）；新增示例 `demo13InterruptExecute` / `demo14InterruptWriteFile` / `demo15MixedApproval`；`index.ts` 精简为"组装 Agent + 启动示例"，审批交互与示例分别归入 `hitl.ts`、`demos.ts`；README 新增「人工审批（HITL）」章节 |
| v1.5.0 | 2026-10-16 | 对应提交 `9280b94`：新增 `src/subagents.ts`（`researcher` / `coder` / `reviewer` 三个子 Agent），`index.ts` 增加 `subagents` 选项；新增示例 `demo9SubAgentResearcher`（研究 + 改文件的复合任务，已挂 `traceCallbacks` 便于观察委派过程）；`workspace/AGENTS.md` 新增「环境注意」（文件工具的虚拟目录与 `execute` 的真实文件系统互不通用）；`workspace/conversation_history/` 为记忆机制落盘的会话记录；README 新增「子 Agent（subagents）」章节 |
| v1.4.0 | 2026-10-16 | 对应提交 `ffa8e32`：新增 `src/middleware.ts`，定义 `summarizationMiddleware`（超过 20 条消息触发摘要压缩、保留最近 10 条原文）与 `memoryAgentsMiddleware`（把 `AGENTS.md` 注入请求、启用 prompt 缓存）；`index.ts` 增加 `middleware` 选项挂载两者；README 新增「通过中间件增强记忆」小节；新增示例 `demo6SkillsRefound`（退款金额计算，验证 `refund-policy`）、`demo7Agents`（写工具函数，验证 `AGENTS.md`）、`demo8SkillsProduct`（项目 FAQ，验证 `product-faq`） |
| v1.3.0 | 2026-10-16 | 对应提交 `c86d287`：新增 `workspace/AGENTS.md`（用户偏好、项目上下文、编码约束），`createDeepAgent` 增加 `memory: ['/AGENTS.md']` 与 `skills: ['/skills/']` 两个选项；新增三个技能文档 `code-review`、`product-faq`、`refund-policy`（均含带 YAML frontmatter 的 `SKILL.md`）；新增示例 `demo6Skills`（问「退款政策是什么」验证技能加载），`demoFollowUp` 的提问改为「再加10」；README 新增「持久记忆与领域技能」章节 |
| v1.2.0 | 2026-10-15 | 对应提交 `5052487`：新增三个文件 / shell 操作示例 `demo4ExecuteShell`（写入 HTML）、`demo5ExecuteShell`（列目录并统计文件数）、`demo6ExecuteShell`（创建并执行 `script.sh`），共用会话 `config3`（`session-3`）；`workspace/` 下生成 `index.html` 与 `public/script.sh`；`index.ts` 默认改为跑 `demo6ExecuteShell()`；README 补充文件后端能力、示例用法与项目结构 |
| v1.1.0 | 2026-10-15 | 对应提交 `40ccb94`：新增文件系统后端 `LocalShellBackend`（根目录 `workspace/`、开启 `virtualMode`、限制命令超时与输出大小），Agent 获得读写文件 / 搜索 / 执行 shell 的能力；示例代码抽到 `src/demos.ts`（`createTraceCallbacks`、`demoCalculator`、`demoFollowUp`、`demoExecuteShell`）；`index.ts` 精简为"组装 Agent + 启动示例"；请求/响应打印函数迁入 `src/utils.ts`；`pnpm-workspace.yaml` 中 esbuild 构建脚本设为 `false` |
| v1.0.0 | 2026-10-15 | 初始版本：搭建 deepagents Agent（calculator、get_current_time 两个工具）；`printStream` 输出流式过程（用户提问、调用模型标记、思考、正文、工具调用与结果）；新增 `traceCallbacks`（`handleChatModelStart` / `handleLLMEnd`）展示模型请求与响应的完整结构；`printStream` 抽取到 `src/utils.ts`；补充各文件关键注释；补装 `tsx` 依赖，修复 `npm run dev` 找不到命令的问题 |
