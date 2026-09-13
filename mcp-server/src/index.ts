/**
 * mcp-server-gamenumerics 入口（Spec R6：docs/specs/v9-w2-mcp-server-spec.md）
 *
 * stdio transport MCP server：34 工具 registry → Wave2 注册面 17
 * （14 映射 + 3 meta：list_workspaces / set_workspace / import_xlsx）。
 * 构建经 esbuild bundle 出单文件 dist/index.js（@/ 别名由 tsconfig paths 解析），
 * node dist/index.js 即 stdio server（bin: gnd-mcp）。
 */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildMcpRegistry } from "./registry";
import { mapRegistryTools } from "./tool-mapper";
import { createSession, registerMetaTools } from "./session";
import { registerImportXlsxTool } from "./import-xlsx";

function buildServer(): McpServer {
  const registry = buildMcpRegistry();
  const session = createSession();
  const server = new McpServer({ name: "mcp-server-gamenumerics", version: "0.1.0" });
  mapRegistryTools(server, registry, {
    getContext: () => session.getContext(),
    guard: () => session.guardMissingWorkspace(),
  });
  registerMetaTools(server, session);
  registerImportXlsxTool(server, session);
  return server;
}

serveStdio(buildServer);
