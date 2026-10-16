# ai-agent-study

一个用于**学习 LLM Agent 调用流程**的最小示例项目：基于 `deepagents` + LangGraph 搭建 Agent，注册自定义工具（计算器、获取时间），挂载文件系统后端（读写文件、搜索文件、执行 shell 命令），并接入持久记忆（`AGENTS.md`）与领域技能（`skills/`），把整轮 **ReAct**（推理 → 调工具 → 观察 → 再推理）的执行细节完整打印到终端。

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

环境：Node.js 20+，包管理器 pnpm。

---

## 快速开始

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

---

## 目录结构

```
ai-agent-study/
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── workspace/          # Agent 的文件操作根目录（backend 的 rootDir），也是它的"沙箱"
│   ├── AGENTS.md       # 持久记忆：用户偏好、项目上下文、编码约束（memory 选项加载）
│   ├── index.html      # Demo 4 运行后由 Agent 写入的文件
│   ├── public/
│   │   └── script.sh   # Demo 6 运行后由 Agent 创建并执行的脚本
│   └── skills/         # 领域技能库：每个子目录是一个技能，内含 SKILL.md
│       ├── code-review/SKILL.md      # 代码审查规范
│       ├── product-faq/SKILL.md      # 产品常见问题
│       └── refund-policy/SKILL.md    # 退款政策
└── src/
    ├── config.ts       # 模型接入配置（含密钥，已被 .gitignore 忽略，需自行创建）
    ├── agents.ts       # 模型实例 + 文件系统后端 backend
    ├── tools.ts        # 自定义工具（calculator、get_current_time）
    ├── utils.ts        # 终端打印：printStream / printModelRequest / printModelResponse
    ├── middleware.ts   # 中间件：摘要压缩（summarization）+ 记忆注入（memory）
    ├── demos.ts        # 示例集合：createTraceCallbacks / demoCalculator / demoFollowUp / demo4~6ExecuteShell / demo6Skills
    └── index.ts        # 入口：组装 Agent 并启动某个示例
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

[src/index.ts](src/index.ts) 里 `createDeepAgent` 还配了两个选项，让 Agent 拥有"跨会话的知识"：

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

[workspace/AGENTS.md](workspace/AGENTS.md) 里写的是用户偏好（中文回复、camelCase 命名、中文行内注释）和项目上下文（pnpm、`pnpm dev` 运行）以及编码约束（工具必须有 Zod schema、错误信息用中文等）。

`skills/` 下的每个子目录是一个技能，`SKILL.md` 用 YAML frontmatter 声明 `name` 和 `description`：

```markdown
---
name: refund-policy
description: 退款政策知识库，回答退款条件、退款时限、退款比例、申请流程、不予退款情形等问题时使用
---
```

当前有三个技能：`code-review`（代码审查规范）、`product-faq`（产品常见问题）、`refund-policy`（退款政策）。`description` 是模型判断"这次要不要用这个技能"的依据，写得越具体越好。

验证方式见示例 `demo6Skills()`：直接问"退款政策是什么"。

### 通过中间件增强记忆

除上面两个选项外，[src/middleware.ts](src/middleware.ts) 里还定义了两个中间件，通过 `middleware` 选项挂到 Agent 上：

| 中间件 | 作用 | 关键配置 |
| --- | --- | --- |
| `summarizationMiddleware` | 对话变长时把早期消息压缩成摘要，避免上下文无限增长（同时省 token） | 超过 20 条消息触发，保留最近 10 条原文 |
| `memoryAgentsMiddleware` | 把 `AGENTS.md` 注入请求，让偏好与约束跨会话生效 | `sources: ['/AGENTS.md']`；`addCacheControl: true` 启用 prompt 缓存 |

两者都复用同一个 `backend`，所以路径同样以 `workspace/` 为根。

> 注意：`memory: ['/AGENTS.md']` 与 `memoryAgentsMiddleware` 的 `sources` 指向同一个文件，如果两者都生效，模型看到的 `AGENTS.md` 内容可能是双份。跑 `demo6Skills` 时对比 `[消息列表]` 里这段内容出现的次数，就能验证。

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

切换示例：改 [src/index.ts](src/index.ts) 里 `main()` 调用的函数即可（当前默认跑 `demo6SkillsRefound()`）。

```ts
async function main() {
  // await demoCalculator();
  // await demoFollowUp()

  // await demo4ExecuteShell()

  // await demo6ExecuteShell()

  await demo6SkillsRefound()
  // await demo7Agents()
}
```

> Demo 4/5/6 共用 `config3`（`session-3`），`demo6SkillsRefound` / `demo7Agents` / `demo8SkillsProduct` 用 `config1`（`session-1`），且这几例都没有挂 `traceCallbacks`，所以终端只输出流式的思考、工具调用与结果；想连"请求参数 / 响应结构"一起看，在它们的 `agent.stream` 选项里补上 `callbacks: createTraceCallbacks()` 即可。

> `demos.ts` 与 `index.ts` 之间存在循环引用（后者引前者触发示例，前者引后者的 `agent`）。因为 `demos.ts` 只在函数体内使用 `agent`、模块顶层不访问，ESM 的 live binding 可以正常工作。

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
| v1.4.0 | 2026-10-16 | 工作区改动（尚未提交）：新增 `src/middleware.ts`，定义 `summarizationMiddleware`（超过 20 条消息触发摘要压缩、保留最近 10 条原文）与 `memoryAgentsMiddleware`（把 `AGENTS.md` 注入请求、启用 prompt 缓存）；`index.ts` 增加 `middleware` 选项挂载两者；README 新增「通过中间件增强记忆」小节；新增示例 `demo6SkillsRefound`（退款金额计算，验证 `refund-policy`）、`demo7Agents`（写工具函数，验证 `AGENTS.md`）、`demo8SkillsProduct`（项目 FAQ，验证 `product-faq`） |
| v1.3.0 | 2026-10-16 | 对应提交 `c86d287`：新增 `workspace/AGENTS.md`（用户偏好、项目上下文、编码约束），`createDeepAgent` 增加 `memory: ['/AGENTS.md']` 与 `skills: ['/skills/']` 两个选项；新增三个技能文档 `code-review`、`product-faq`、`refund-policy`（均含带 YAML frontmatter 的 `SKILL.md`）；新增示例 `demo6Skills`（问「退款政策是什么」验证技能加载），`demoFollowUp` 的提问改为「再加10」；README 新增「持久记忆与领域技能」章节 |
| v1.2.0 | 2026-10-15 | 对应提交 `5052487`：新增三个文件 / shell 操作示例 `demo4ExecuteShell`（写入 HTML）、`demo5ExecuteShell`（列目录并统计文件数）、`demo6ExecuteShell`（创建并执行 `script.sh`），共用会话 `config3`（`session-3`）；`workspace/` 下生成 `index.html` 与 `public/script.sh`；`index.ts` 默认改为跑 `demo6ExecuteShell()`；README 补充文件后端能力、示例用法与项目结构 |
| v1.1.0 | 2026-10-15 | 对应提交 `40ccb94`：新增文件系统后端 `LocalShellBackend`（根目录 `workspace/`、开启 `virtualMode`、限制命令超时与输出大小），Agent 获得读写文件 / 搜索 / 执行 shell 的能力；示例代码抽到 `src/demos.ts`（`createTraceCallbacks`、`demoCalculator`、`demoFollowUp`、`demoExecuteShell`）；`index.ts` 精简为"组装 Agent + 启动示例"；请求/响应打印函数迁入 `src/utils.ts`；`pnpm-workspace.yaml` 中 esbuild 构建脚本设为 `false` |
| v1.0.0 | 2026-10-15 | 初始版本：搭建 deepagents Agent（calculator、get_current_time 两个工具）；`printStream` 输出流式过程（用户提问、调用模型标记、思考、正文、工具调用与结果）；新增 `traceCallbacks`（`handleChatModelStart` / `handleLLMEnd`）展示模型请求与响应的完整结构；`printStream` 抽取到 `src/utils.ts`；补充各文件关键注释；补装 `tsx` 依赖，修复 `npm run dev` 找不到命令的问题 |
