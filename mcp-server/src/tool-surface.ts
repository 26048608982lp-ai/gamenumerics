/**
 * MCP server 工具面单源（Spec R1：docs/specs/v9-w2-mcp-server-spec.md）
 *
 * registry 全量 34 工具 → 14 映射 + 20 排除（三向闭合，新增工具漏归类即测试红）。
 * Wave2 注册面终态 = 14 映射 + 3 meta（list_workspaces / set_workspace /
 * import_xlsx）= 17。
 */

/**
 * 14 个映射工具：全部 access === "read" 且不硬依赖身份注入
 * （ctx.projectData / profileId 缺省时核心通道可用，如 read_memory 回落公共 facts.md）
 */
export const MAPPED_TOOLS = [
  // 工作区 2
  "list_tables",
  "read_table",
  // 计算 8
  "battle_simulate",
  "simulate_gacha",
  "compute_power",
  "power_curve",
  "eval_formula",
  "audit_column",
  "infer_column_rule",
  "infer_table_relation",
  // 结构 3（save_structure 是 write 档，归排除）
  "grade_workspace",
  "profile_table",
  "infer_foreign_keys",
  // 记忆 1（save_memory 是 write 档，归排除）
  "read_memory",
] as const;

/** 20 个排除工具（MCP stdio 面不可达，理由见分组注释） */
export const EXCLUDED_TOOLS = [
  // 11 个 write 档：MCP 面无人在回路写确认回路（confirmWrite 面板是 Web 前端语义），一律不暴露
  "write_table",
  "write_plan_rules",
  "restore_table",
  "save_structure",
  "save_memory",
  "plan_module",
  "plan_tasks",
  "update_task",
  "submit_answer",
  "finalize_framework",
  "experience_expectation",
  // 5 个身份硬依赖：Supabase 登录闭包 ctx.projectData（stdio 无登录态）
  "simulate_progression",
  "preview_difficulty",
  "acceptance_report",
  "list_projects",
  "project_summary",
  // 2 个 PLANNING_ONLY 工作区门控 + 问卷状态 DB 行键依赖（ctx.workspaceId）
  "questionnaire_status",
  "ask_question",
  // 1 个会话 UI 载荷依赖：uiPayload 前端选项卡通道，stdio 无宿主
  "ask_clarification",
  // 1 个下载载荷：不可枚举 _downloadContent + uiPayload 前端下载通道，stdio 无宿主
  "export_deliverable",
] as const;
