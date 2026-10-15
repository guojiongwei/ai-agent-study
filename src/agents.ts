// 模型实例：整个项目共用一个（createDeepAgent 内部每轮都拿它去请求）
// 这里虽然用的是 ChatAnthropic，但通过自定义 anthropicApiUrl 指向了 DeepSeek 的兼容端点
import { ChatAnthropic } from '@langchain/anthropic';
import { config } from './config'

export const model = new ChatAnthropic({
  model: config.MODEL_NAME, // 模型名，来自 config
  anthropicApiKey: config.ANTHROPIC_API_KEY, // 密钥
  anthropicApiUrl: config.ANTHROPIC_BASE_URL, // 自定义接口地址（默认是官方 Anthropic，这里指向兼容端点）
  streaming: true, // 开启流式：配合 agent.stream 才能逐片（逐 token/逐 block）拿到输出
  maxTokens: 10000, // 单次回复的最大 token 数（思考内容也算在里面）
  // 扩展思考（Extended Thinking）：开启后模型会先输出一段内部推理过程再给正式答案
  // budget_tokens 是思考部分可用的 token 上限，它会占用上面的 maxTokens 预算
  thinking: {
    type: 'enabled',
    budget_tokens: 5000,
  },
});
