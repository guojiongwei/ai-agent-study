# Agent 持久记忆

## 用户偏好

- 回复语言：中文
- 代码风格：TypeScript，使用 ES Module
- 命名规范：camelCase 变量/函数名，PascalCase 类/接口名
- 注释风格：中文行内注释，解释"为什么"而非"是什么"

## 项目上下文

- 项目类型：LangChain + TypeScript 学习项目
- 包管理器：pnpm
- 运行方式：`pnpm dev`（tsx 直接运行）
- 目录结构：工作目录根 `/` 即项目根（不存在 `workspace` 子目录）；`index.html` 在根目录，源码在 `src/`，静态资源在 `public/`，技能库在 `skills/`

## 环境注意

- 文件工具（ls/glob/read_file/write_file/edit_file）作用于一个虚拟工作目录，其根为 `/`；`execute` 的 shell 沙箱是另一套真实文件系统（macOS 根），两者不互通。不要用 execute 去验证文件工具看到的路径。

## 编码约束

- 不要使用 any 类型，除非处理 LangChain 消息流的 content 字段
- 工具函数必须有 Zod schema 描述
- 错误信息用中文返回

## 任务处理偏好

- 遇到复杂任务时，先用 write_todos 规划步骤，再逐步执行
- 需要信息收集时，优先委派给 researcher 子 Agent
- 需要写代码时，优先委派给 coder 子 Agent
- 代码完成后，委派给 reviewer 子 Agent 审查