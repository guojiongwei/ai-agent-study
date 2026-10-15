# ai-agent-study

一个用于**学习 LLM Agent 调用流程**的最小示例项目：基于 `deepagents` + LangGraph 搭建 Agent，注册两个工具（计算器、获取时间），并把整轮 **ReAct**（推理 → 调工具 → 观察 → 再推理）的执行细节完整打印到终端。

重点不在"做出一个能用的 Agent"，而在**看清每一步到底发生了什么**：模型请求发了什么、模型响应回了什么、工具是谁执行的、上下文是怎么一轮轮累积的。

---

## 技术栈

| 依赖 | 作用 |
| --- | --- |
| `deepagents` | 创建 Agent，内部用 LangGraph 编排节点与流转 |
| `@langchain/langgraph` | 状态图运行时；`MemorySaver` 提供多轮记忆 |
| `@langchain/anthropic` | 模型客户端（本项目指向 DeepSeek 的 Anthropic 兼容端点） |
| `@langchain/core` | 消息、工具等基础抽象 |
| `zod` | 定义工具参数结构（会转成 JSON Schema 发给模型） |
| `tsx` | 直接运行 TypeScript，免编译 |

环境：Node.js 20+，包管理器 pnpm。

---

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 配置模型接入信息（见下方「配置」）
#    编辑 src/config.ts

# 3. 运行
pnpm dev
# 或
npm run dev
# 或
npx tsx src/index.ts
```

> 注意：`tsx` 必须作为项目依赖安装（`pnpm add -D tsx`），否则 npm scripts 会报 `tsx: command not found`。
> 用 `npx tsx` 能跑是因为 npx 会临时下载，绕过了本地依赖。

---

## 目录结构

```
ai-agent-study/
├── package.json
├── pnpm-lock.yaml
└── src/
    ├── config.ts   # 模型接入配置（密钥、接口地址、模型名）
    ├── agents.ts   # 模型实例（ChatAnthropic，含 streaming / maxTokens / thinking 配置）
    ├── tools.ts    # 工具定义（calculator、get_current_time）
    ├── utils.ts    # 终端输出工具：printStream（把流式过程分门别类打印出来）
    └── index.ts    # 入口：组装 Agent、发起对话、注册 trace 回调
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

其中"模型请求 / 模型响应"两块由 [src/index.ts](src/index.ts) 中的 `traceCallbacks` 提供，挂在两个 hook 上：

- `handleChatModelStart`：请求前触发，能拿到模型配置、工具定义、完整消息列表。
- `handleLLMEnd`：响应后触发，能拿到 AIMessage 的原始 content block、`tool_calls`、token 用量与响应 metadata。

---

## 配置

模型接入信息集中在 [src/config.ts](src/config.ts)：

```ts
export const config = {
  ANTHROPIC_API_KEY: '...',
  ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
  MODEL_NAME: 'deepseek-flash',
};
```

说明：

- 虽然用的是 `ChatAnthropic`，但通过 `anthropicApiUrl` 指向了 DeepSeek 的 Anthropic 兼容端点，所以实际调用的是 DeepSeek 的模型。
- **密钥目前是明文写在代码里的，仅供本地学习调试**。正式项目请改用环境变量（如 `process.env.ANTHROPIC_API_KEY`），并确保不要提交到仓库。
- 部分第三方网关不回传 `stop_reason` / `id` / `model`，此时 `[结束原因]` 会退化成"按有没有工具调用来推断"。
- Anthropic 系接口支持 prompt 缓存，日志里的 `缓存读取` / `缓存写入` 即为命中情况。

---

## 变更记录

约定：每次改动在表格**顶部**新增一行，格式为 `版本 | 日期 | 变更内容`；同一天多次改动可合并到同一条内，用分号分隔。

| 版本 | 日期 | 变更内容 |
| --- | --- | --- |
| v1.0.0 | 2026-10-15 | 初始版本：搭建 deepagents Agent（calculator、get_current_time 两个工具）；`printStream` 输出流式过程（用户提问、调用模型标记、思考、正文、工具调用与结果）；新增 `traceCallbacks`（`handleChatModelStart` / `handleLLMEnd`）展示模型请求与响应的完整结构；`printStream` 抽取到 `src/utils.ts`；补充各文件关键注释；补装 `tsx` 依赖，修复 `npm run dev` 找不到命令的问题 |
