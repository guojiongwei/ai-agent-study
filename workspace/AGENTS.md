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

## 编码约束

- 不要使用 any 类型，除非处理 LangChain 消息流的 content 字段
- 工具函数必须有 Zod schema 描述
- 错误信息用中文返回
