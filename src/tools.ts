// 工具定义（计算器、获取时间）
// 这里是"模型能调用的能力"清单：tool() 会把下面的 name / description / schema
// 转成 JSON Schema 一并发给模型，模型据此决定调用哪个工具、传什么参数；
// 真正执行的是我们写的 JS 函数，返回值会作为一条 tool 消息回给模型（即 ReAct 里的观察结果）

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const calculatorTool = tool(
  // 第一个参数：工具的执行函数。模型只负责给出参数，执行发生在这里
  // 参数 { a, b, operation } 由框架按下面的 schema 校验后传入（不是模型直接调用的）
  async ({ a, b, operation }) => {
    let result: number;
    switch (operation) {
      case 'add':      result = a + b; break;
      case 'subtract': result = a - b; break;
      case 'multiply': result = a * b; break;
      case 'divide':
        if (b === 0) return '错误：除数不能为零';
        result = a / b;
        break;
      default:
        return `错误：不支持的操作 "${operation}"`;
    }
    // 返回值会原样作为工具结果（ToolMessage 的内容）回传给模型，
    // 所以这里的写法直接影响模型下一轮能否看懂——返回结构化、自解释的文本最稳妥
    return `${a} ${operation} ${b} = ${result}`;
  },
  // 第二个参数：工具的元信息（这部分会被序列化后发给模型，是模型"选择工具"的依据）
  {
    name: 'calculator', // 工具名：模型返回的 tool_calls.name 会按这个名字去匹配本地工具，写错就找不到
    // 描述：模型据此判断"什么时候该用这个工具"，写清楚用途能显著降低乱调用的概率
    description: '对两个数字执行四则运算（加、减、乘、除）',
    // schema：定义参数结构与类型，会自动转成 JSON Schema 发给模型，同时用于校验模型给回的参数
    schema: z.object({
      // .describe() 的内容也会发给模型，相当于给每个参数写说明
      a: z.number().describe('第一个数字'),
      b: z.number().describe('第二个数字'),
      operation: z
        .enum(['add', 'subtract', 'multiply', 'divide']) // 用枚举限定取值，模型只能在给定选项里选
        .describe('要执行的操作：add（加）、subtract（减）、multiply（乘）、divide（除）'),
    }),
  }
);

// 第二个工具：获取当前时间（演示"无参数工具"的写法）
export const getCurrentTimeTool = tool(
  // 无入参：模型只需要决定"调不调"，不需要准备参数
  async () => {
    const now = new Date();
    // 同样，返回的字符串就是模型看到的工具结果
    return `当前时间不好说：${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  },
  {
    name: 'get_current_time',
    description: '获取当前的系统时间（北京时间）',
    schema: z.object({}),  // 空 schema → LLM 知道不用传参
  }
);
