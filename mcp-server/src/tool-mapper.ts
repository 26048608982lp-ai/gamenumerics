/**
 * 核心薄映射层（Spec R2/R3：docs/specs/v9-w2-mcp-server-spec.md）
 *
 * ToolRegistry（OpenAI tools JSON Schema 协议）→ McpServer（MCP tools 协议）
 * 的协议适配器：name + description + JSON Schema parameters + handler 两层同构，
 * 映射器只做形状搬运与结果映射，不实现任何数值逻辑。
 *
 * 映射器是通用能力（toMcpToolConfig 对 34 个全量可跑，R2 round-trip 钉死），
 * surface 过滤（MAPPED_TOOLS）是应用层装配语义，见 tool-surface.ts。
 */

import { fromJsonSchema } from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  JsonSchemaType,
  jsonSchemaValidator,
  JsonSchemaValidator,
  McpServer,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import type {
  ToolContext,
  ToolDefinition,
  ToolRegistry,
  ToolResult,
} from "@/lib/agent/tools/protocol";
import { MAPPED_TOOLS } from "./tool-surface";

/**
 * 透传 validator：SDK v2 的 fromJsonSchema 缺省自带 DefaultJsonSchemaValidator
 * （AJV 类，required 缺失先于 handler 拦截并返回英文错误）。传本透传实现关闭
 * 前置校验——参数防御由各工具 execute 内部既有解析承担（工具层本就拒绝坏参数
 * 并返回中文可行动错误，Spec 边界条件语义），同时保证会话守卫文案先于参数
 * 校验可达（未设工作区时统一引导，而非错误文案发散）。
 */
export const passthroughValidator: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input: unknown) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

/** 映射纯函数产物：MCP registerTool 三键域 + readOnlyHint 注解（映射面全部 read 档） */
export interface MappedToolConfig {
  name: string;
  description: string;
  inputSchema: StandardSchemaWithJSON;
  annotations: { readOnlyHint: true };
}

/**
 * 单工具映射纯函数（R2 测试对象，不经 server）：
 * name/description 原样透传，parameters 经 fromJsonSchema 包装为
 * StandardSchemaWithJSON（协议输出侧 round-trip 还原原 schema）。
 */
export function toMcpToolConfig(tool: ToolDefinition): MappedToolConfig {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: fromJsonSchema(
      tool.parameters as unknown as JsonSchemaType,
      passthroughValidator,
    ),
    annotations: { readOnlyHint: true },
  };
}

/** ToolResult → MCP CallToolResult（R3）：成功双通道（text JSON + structuredContent），失败 isError */
export function toMcpResult(result: ToolResult): CallToolResult {
  if (result.success) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data) }],
      structuredContent: result.data as Record<string, unknown>,
    };
  }
  return { content: [{ type: "text", text: result.error }], isError: true };
}

/** 会话守卫文案 → 引导性 isError（不进 registry，绝无 undefined workspaceRoot） */
function guardResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export interface MapRegistryOptions {
  /** 每次调用时构造 ToolContext（工作区切换后下一次调用生效） */
  getContext: () => ToolContext;
  /** 会话守卫：返回非 null 文案时以 isError 拒绝（先于 getContext，不进 registry） */
  guard?: () => string | null;
}

/**
 * 把 registry 中名字 ∈ MAPPED_TOOLS 的 ToolDefinition 逐个注册为 MCP 工具
 * （Wave1 应用面 = 14）。handler 经 registry.execute 分发——工具执行、
 * 参数防御、异常归一（try-catch → success:false）全部复用既有实现，零重写。
 */
export function mapRegistryTools(
  server: McpServer,
  registry: ToolRegistry,
  opts: MapRegistryOptions,
): void {
  for (const name of MAPPED_TOOLS) {
    const tool = registry.get(name);
    if (!tool) continue; // 名单与 registry 的偏差由三向闭合测试钉死，此处静默跳过即可
    const config = toMcpToolConfig(tool);
    server.registerTool(
      config.name,
      {
        description: config.description,
        inputSchema: config.inputSchema,
        annotations: config.annotations,
      },
      async (args: unknown): Promise<CallToolResult> => {
        const guardMessage = opts.guard?.() ?? null;
        if (guardMessage) return guardResult(guardMessage);
        const result = await registry.execute(name, args, opts.getContext());
        return toMcpResult(result);
      },
    );
  }
}
