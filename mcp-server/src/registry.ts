/**
 * MCP 面裁剪版 registry 装配：只注册 17 工具面依赖的四组定义
 * （工作区 2 + 计算 8 + 结构 3 + 记忆 1 的来源文件），不装配 Web 侧
 * write/身份/问卷/交付工具——stdio 面不可达的代码不进 bundle
 * （分发体积与开源面 = 产品暴露面）。MAPPED_TOOLS 过滤语义不变。
 */

import { ToolRegistry } from "@/lib/agent/tools/protocol";
import { workspaceToolDefinitions } from "@/lib/agent/tools/definitions/workspace-tools";
import { engineToolDefinitions } from "@/lib/agent/tools/definitions/engine-tools";
import { memoryToolDefinitions } from "@/lib/agent/tools/definitions/memory-tools";
import { structureToolDefinitions } from "@/lib/agent/tools/definitions/structure-tools";

export function buildMcpRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  [
    ...workspaceToolDefinitions,
    ...engineToolDefinitions,
    ...memoryToolDefinitions,
    ...structureToolDefinitions,
  ].forEach((tool) => registry.register(tool));
  return registry;
}
