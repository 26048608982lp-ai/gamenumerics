/**
 * Agent 工具协议 — 注册表 + 权限注解 + 沙箱上下文
 *
 * 骨架源自 git 6f6d049 的 lib/ai/tools/protocol.ts（编排层删除前版本），
 * 扩展三点：access 权限注解（写工具需人工确认）、execute 注入 ToolContext
 * （工作区沙箱边界随环境注入，工具不自行读全局路径）、listForLLM 直接产出
 * provider 的 AIToolDefinition 形状。
 */

import type { AIToolDefinition } from "@/lib/ai/provider/types";

/** 工具权限档：read 工作区内自由执行；write 需经人工确认回路 */
export type ToolAccess = "read" | "write";

/**
 * 项目概览（agent-p1-tools T3 契约 3）：项目类工具的数据形状。
 * 老数据字段缺失 → gameType/description/status 可为 null，工具层逐字段防御性读取。
 */
export interface ProjectOverview {
  id: string;
  name: string;
  gameType: string | null;
  description: string | null;
  status: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 单模块确认状态行（planning_results 投影） */
export interface ProjectModuleStatus {
  moduleType: string;
  status: string;
  updatedAt: string | null;
}

/** 数值体检最近快照摘要（acceptance_reports 投影；null = 尚未生成） */
export interface AcceptanceBrief {
  ruleVersion: string | null;
  healthSummary: string | null;
  totalFindings: number | null;
  passedFindings: number | null;
  createdAt: string | null;
}

/**
 * 项目数据访问闭包（agent-p1-tools T3 契约 3）：api 域 createProjectDataApi(profileId)
 * 实现并注入，身份在构造时绑定（profileId 不透传方法签名、不进 ToolContext）——
 * 依赖倒置：ai 域只定义接口，不依赖 Supabase。方法约定：
 * - 「不存在/越权」= 返回 null/[]（不抛错，工具层同文案拒绝）；「查询失败」= throw（registry 兜底转 error）
 * - listProjects 与 GET /api/projects 同口径（module_type 非空的旧架构行过滤），updated_at 倒序
 */
export interface ProjectDataApi {
  listProjects(): Promise<ProjectOverview[]>;
  fetchProject(projectId: string): Promise<ProjectOverview | null>;
  fetchModuleStatuses(projectId: string): Promise<ProjectModuleStatus[]>;
  fetchAllConfirmed(projectId: string): Promise<Record<string, Record<string, unknown>> | null>;
  fetchAcceptanceBrief(projectId: string): Promise<AcceptanceBrief | null>;
}

/** 工具执行上下文 — 由 agent loop 注入，工作区根即路径沙箱边界 */
export interface ToolContext {
  workspaceRoot: string;
  /**
   * 工作区身份（可选，向后兼容——既有工具零感知）：serverless 部署下作为问卷
   * 状态 DB 通道的行键（questionnaire-state-store：VERCEL+携 id → Supabase
   * 直读直写）；未注入（冒烟/单测/磁盘部署）时问卷状态走文件态，行为与历史
   * 版本一致。鉴权路由与 apply-write 从 resolveWorkspaceRoot 的 workspaceInfo.id 注入。
   */
  workspaceId?: string;
  /**
   * 项目数据访问闭包（可选，向后兼容——既有工具零感知）：鉴权路由从登录身份
   * 构造注入；冒烟/单测直调不注入，项目类工具以单谓词 !projectData 诚实拒绝
   * （存在即蕴含已登录，身份已绑定进闭包实现）。
   */
  projectData?: ProjectDataApi;
  /**
   * 当前绑定项目 id（可选，A3 缺省回退）：工作台携 projectId 进入时由鉴权路由
   * 归属校验后绑定，项目类工具未传 projectId 参数时回退取它（显式参数优先）。
   * 语义辨析（防与 ProjectDataApi 身份语义混淆）：profileId = 登录身份，
   * createProjectDataApi(profileId) 构造时闭包绑定倒置，不进 ToolContext；
   * projectId = 当前绑定项目，是数据选择器——显式上下文进 ToolContext 合法。
   * 服务端绑定前已归一化（空串/空白视同未传），此处取值直接用不再清洗。
   */
  currentProjectId?: string;
  /**
   * 当前会话 id（可选，taskboard-session-scope T1）：route 从请求体 sessionId
   * （UUID 校验通过）注入，任务板工具据此分片读写 tasks-{sessionId}.json——
   * 会话级任务板从首轮对话起稳定（前端预生成）。与 currentProjectId 并存：
   * 项目域工具继续消费 currentProjectId（语义不动），任务板只看会话键。
   * 缺省（undefined/空白，旧前端包部署窗口）时任务工具诚实报错，不回退缺省文件。
   */
  currentSessionId?: string;
  /**
   * 登录身份（可选，记忆隔离 pendfix-wave3）：profileId 进 ToolContext 的语义
   * 是「隔离命名空间」而非数据选择——save_memory/read_memory 据此读写
   * memory/facts-{profileId}.md（用户私有记忆）。与 createProjectDataApi 的
   * 身份闭包分工：闭包管「能访问什么数据」（能力语义），本字段管「写到哪个
   * 命名空间」（隔离语义），两分法与上方 currentProjectId 辨析一致。缺省
   * （evals/冒烟/单测无登录态）时记忆工具回落公共 facts.md，行为与历史版本一致。
   */
  profileId?: string;
  /**
   * 自纠回路计数器（可选，R7 plan_module 双源自纠）：键 = moduleType，值 = 该
   * 模块 dryRun 预演路径已触发的 needs_repair 次数——errors>0 且计数 0 → 拒绝
   * 回传自纠载荷；计数 ≥1 → 放行携 qualityWarnings（单模块上限 1 次自纠）。
   * 挂 ctx = 每请求生命周期：鉴权路由每请求新建 Map；apply-write 是独立 HTTP
   * 请求（ctx 计数归零）→ 落盘路径状态机自然不生效（人在回路已兜底）。缺省
   * （既有测试/冒烟的裸 ctx 字面量）由工具内懒初始化，调用方不强制注入。
   */
  selfRepairCounts?: Map<string, number>;
}

/** 工具执行结果（判别联合，坏数据不放行） */
export type ToolResult =
  | { success: true; data: unknown }
  | { success: false; error: string };

/** 工具定义 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 参数描述（LLM 据此构造调用参数） */
  parameters: Record<string, unknown>;
  /** 权限注解：write 档在 loop 层强制走确认回调 */
  access: ToolAccess;
  /** 所属模块（工具多起来后按会话主题做子集筛选） */
  module?: string;
  /**
   * 不透明 UI 载荷钩子（可选）：工具执行成功后由 loop 调用，返回值原样附进
   * tool_result 事件的 ui 字段直发前端——loop 不解释、不截断，形状由工具层
   * 定义；返回 null 不附 ui。
   */
  uiPayload?: (data: unknown) => Record<string, unknown> | null;
  execute: (params: unknown, ctx: ToolContext) => Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] 覆盖已存在的工具: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** 产出 provider function-calling 所需的工具定义（不含 execute 等实现细节） */
  listForLLM(): AIToolDefinition[] {
    return Array.from(this.tools.values()).map(({ name, description, parameters }) => ({
      type: "function" as const,
      function: { name, description, parameters },
    }));
  }

  async execute(name: string, params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, error: `工具 "${name}" 不存在` };
    }
    try {
      return await tool.execute(params, ctx);
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }
}
