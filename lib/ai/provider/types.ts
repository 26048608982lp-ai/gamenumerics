/**
 * AI Provider 抽象层 — 类型定义
 *
 * 解耦 AI 调用链与具体提供商实现。
 * 切换 AI 提供商只需新增一个实现类。
 */

/** 通用 AI 消息格式 */
export interface AIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** assistant 消息：模型请求执行的工具调用（OpenAI 兼容格式） */
  toolCalls?: AIToolCall[];
  /** tool 消息：本条结果对应的调用 id */
  toolCallId?: string;
}

/** LLM 生成的工具调用请求（OpenAI 兼容格式，智谱/DeepSeek 均支持） */
export interface AIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON 字符串形式的参数（模型逐 token 生成，需 JSON.parse） */
    arguments: string;
  };
}

/** 供 LLM 选择调用的工具定义（OpenAI function-calling 兼容） */
export interface AIToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema 参数描述 */
    parameters: Record<string, unknown>;
  };
}

/** AI 调用选项 */
export interface AICallOptions {
  stream?: boolean;
  temperature?: number;
  /** function-calling：可供模型自主路由选择的工具列表 */
  tools?: AIToolDefinition[];
  /** 工具选择策略；默认 auto（模型基于工具语义自主决策） */
  toolChoice?: "auto" | "none" | "required";
}

/** 非流式响应 */
export interface AICallResponse {
  content: string;
  raw: Response;
  /** 模型请求的工具调用（finishReason 为 tool_calls 时非空） */
  toolCalls?: AIToolCall[];
  /** 本轮结束原因：stop / tool_calls / length 等 */
  finishReason?: string;
}

/** AI 提供商接口 */
export interface AIProvider {
  /** 非流式调用 */
  call(
    messages: AIMessage[],
    options?: AICallOptions
  ): Promise<AICallResponse>;

  /** 流式调用 — 返回上游 Response（供 SSE 代理转发） */
  stream(
    messages: AIMessage[],
    options?: AICallOptions
  ): Promise<Response>;
}
