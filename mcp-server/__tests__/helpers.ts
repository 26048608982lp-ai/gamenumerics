/**
 * 测试装配 helpers（Wave2 提取）
 *
 * 「registry + session + meta + import_xlsx」完整注册面装配在 tool-surface 与
 * import-xlsx 两测试文件第三次重复出现（session/tool-mapper 测试的装配形状
 * 不同——无 session / 仅 meta 子集——保持本地装配，不强行归一）。
 */

import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpRegistry } from "../src/registry";
import { createSession, registerMetaTools } from "../src/session";
import type { McpSessionState } from "../src/session";
import { registerImportXlsxTool } from "../src/import-xlsx";
import { mapRegistryTools } from "../src/tool-mapper";

/** 装配完整 Wave2 注册面（14 映射 + 3 meta）的 server 与 session */
export function assembleMcpFace(workspacesRoot: string): {
  session: McpSessionState;
  server: McpServer;
} {
  const session = createSession({ workspacesRoot });
  const server = new McpServer({ name: "mcp-face-test", version: "0.0.0" });
  mapRegistryTools(server, buildMcpRegistry(), {
    getContext: () => session.getContext(),
    guard: () => session.guardMissingWorkspace(),
  });
  registerMetaTools(server, session);
  registerImportXlsxTool(server, session);
  return { session, server };
}

/** 内存传输对连接（协议侧 Client 视角，等价 stdio 链路不拉子进程） */
export async function connectInMemory(server: McpServer): Promise<Client> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-face-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}
