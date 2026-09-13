/**
 * 工作区会话状态与 meta 工具（Spec R5：docs/specs/v9-w2-mcp-server-spec.md）
 *
 * MCP server 是本地长驻进程，与 Web 工作台（Supabase 会话）不同——
 * 会话状态只有「当前工作区」单变量。工作区根由 GND_WORKSPACES_DIR 控制，
 * 缺省 ~/.gamenumerics/workspaces（MCP 用户机器无本仓库，绝不落仓库 workspaces/）。
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ToolContext } from "@/lib/agent/tools/protocol";
import { passthroughValidator } from "./tool-mapper";

/**
 * 工作区根解析：env GND_WORKSPACES_DIR 优先，缺省 ~/.gamenumerics/workspaces。
 * 绝对路径化（resolve）不依赖 process.cwd()（Spec 边界——server 进程 cwd 不定）：
 * 相对值一律按用户主目录解析；目录确保存在（recursive）。
 */
export function resolveWorkspacesRoot(
  env: { GND_WORKSPACES_DIR?: string | undefined; [key: string]: string | undefined } = process.env,
): string {
  const raw = (env.GND_WORKSPACES_DIR ?? "").trim();
  const dir = isAbsolute(raw)
    ? resolve(raw)
    : resolve(homedir(), raw.length > 0 ? raw : join(".gamenumerics", "workspaces"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 工作区名 sanitize 白名单：首字符必须字母/数字，主体仅允许 [A-Za-z0-9._-]，
 * 禁含路径分隔符与 .. 序列（防路径穿越——set_workspace 与 Wave2 import_xlsx 同源守卫）。
 */
export function sanitizeWorkspaceName(name: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
  if (name.includes("..")) return null;
  return name;
}

/** 未设工作区时的引导文案（import_xlsx 已随 Wave2 落地，直接引导调用） */
const GUARD_MESSAGE =
  "尚未设置当前工作区：请先调用 set_workspace 切换到已有工作区" +
  "（可先用 list_workspaces 查看可用列表），或调用 import_xlsx 从本地 xlsx 文件" +
  "导入并自动创建工作区。";

export interface SetWorkspaceResult {
  success: true;
  data: { workspace: string; workspaceRoot: string };
}
export interface SetWorkspaceError {
  success: false;
  error: string;
}

/** 会话状态：当前工作区单变量 + 上下文构造 + 守卫（映射工具统一经 guard 拦截） */
export interface McpSessionState {
  readonly workspacesRoot: string;
  readonly currentWorkspace: string | null;
  /** 构造 ToolContext（仅 workspaceRoot，其余可选字段不注入）；未设工作区时调用即抛错 */
  getContext(): ToolContext;
  /** 未设工作区时返回引导文案；已设返回 null（放行） */
  guardMissingWorkspace(): string | null;
  /** 列工作区根下全部目录名（排序稳定） */
  listWorkspaces(): string[];
  /** 按名切换当前工作区（sanitize 防穿越；不存在返回 error） */
  setWorkspace(name: string): SetWorkspaceResult | SetWorkspaceError;
}

export function createSession(opts?: { workspacesRoot?: string }): McpSessionState {
  const workspacesRoot = opts?.workspacesRoot ?? resolveWorkspacesRoot();
  let currentWorkspace: string | null = null;

  return {
    workspacesRoot,
    get currentWorkspace() {
      return currentWorkspace;
    },
    getContext(): ToolContext {
      // 守卫先于此调用（mapRegistryTools handler 内 guard 先行），到这里仍为空
      // 属编程错误——防御性抛错，绝不以 undefined workspaceRoot 进入 registry
      if (!currentWorkspace) {
        throw new Error("尚未设置当前工作区（getContext 不应在守卫未通过时被调用）");
      }
      return { workspaceRoot: join(workspacesRoot, currentWorkspace) };
    },
    guardMissingWorkspace(): string | null {
      return currentWorkspace ? null : GUARD_MESSAGE;
    },
    listWorkspaces(): string[] {
      if (!existsSync(workspacesRoot)) return [];
      return readdirSync(workspacesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    },
    setWorkspace(name: string): SetWorkspaceResult | SetWorkspaceError {
      const clean = sanitizeWorkspaceName(name);
      if (!clean) {
        return {
          success: false,
          error: `非法工作区名: ${name}（仅允许字母/数字与 -._ 组合，禁路径分隔符与 ..）`,
        };
      }
      const wsRoot = join(workspacesRoot, clean);
      let isDir = false;
      try {
        isDir = statSync(wsRoot).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        return {
          success: false,
          error: `工作区不存在: ${clean}，请用 list_workspaces 查看可用工作区`,
        };
      }
      currentWorkspace = clean;
      return { success: true, data: { workspace: clean, workspaceRoot: wsRoot } };
    },
  };
}

/** meta 工具错误统一映射（isError，绝不冒泡崩 stdio 进程——R4 meta 兜底纪律） */
function metaError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * 注册 2 个 meta 工具（Wave1）：
 * - list_workspaces：列工作区根下目录
 * - set_workspace：按名切换当前工作区（sanitize 白名单防穿越）
 * handler 统一 try-catch 兜底（meta 工具不经 registry.execute 的既有归一，自设同款）。
 */
export function registerMetaTools(server: McpServer, session: McpSessionState): void {
  server.registerTool(
    "list_workspaces",
    {
      description:
        "列出全部可用工作区（位于本机工作区根，GND_WORKSPACES_DIR 环境变量控制，" +
        "缺省 ~/.gamenumerics/workspaces）。切换工作区用 set_workspace。",
      inputSchema: fromJsonSchema(
        {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        passthroughValidator,
      ),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const workspaces = session.listWorkspaces();
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ workspaces }) }],
          structuredContent: { workspaces },
        };
      } catch (error) {
        return metaError(`list_workspaces 执行异常: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    "set_workspace",
    {
      description:
        "切换当前工作区（后续全部数值工具调用均作用于它）。name 须来自 list_workspaces 的列表。",
      inputSchema: fromJsonSchema(
        {
          type: "object",
          properties: {
            name: { type: "string", description: "工作区名（来自 list_workspaces）" },
          },
          required: ["name"],
          additionalProperties: false,
        },
        passthroughValidator,
      ),
    },
    async (args: unknown) => {
      try {
        const { name } = (args ?? {}) as { name?: string };
        if (!name || typeof name !== "string") {
          return metaError("缺少 name 参数（string，来自 list_workspaces 的列表）");
        }
        const result = session.setWorkspace(name);
        if (!result.success) return metaError(result.error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
          structuredContent: result.data,
        };
      } catch (error) {
        return metaError(`set_workspace 执行异常: ${(error as Error).message}`);
      }
    },
  );
}
