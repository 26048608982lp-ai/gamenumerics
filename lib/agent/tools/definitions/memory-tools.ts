/**
 * 记忆工具 — 项目级事实记忆（markdown 文件，agent 可读写）
 *
 * 记忆是 agent 的笔记本而非项目数据：save_memory 标记为 write 档保持统一权限模型，
 * 宿主（API 路由 confirmWrite）对 save_memory 豁免人工确认直接放行——纯追加、
 * 低风险、只写记忆文件（overlay），无需弹变更审查面板。
 * PROFILE.md 为项目画像（导入/人工维护），facts.md 为 agent 追记的事实流。
 */

import { join } from "path";
import { appendWorkspaceText, loadWorkspaceText } from "../../storage";
import type { ToolDefinition } from "../protocol";

const MEMORY_DIR = "memory";
const FACTS_FILE = "facts.md";
// content 上限（trim 后）：save_memory 免确认直写 + 注入 system prompt，
// 无上限即跨用户持久化注入面——入口截断是注入链收敛的第一道闸
const MAX_CONTENT_LENGTH = 500;

/**
 * 记忆文件名解析单源（记忆隔离 pendfix-wave3）：有登录身份 → 用户私有
 * facts-{profileId}.md（跨用户隔离）；缺省（evals/冒烟/单测）→ 公共 facts.md
 * （单进程评测环境无跨用户面，行为与历史版本一致）。route.ts 注入段 /
 * read_memory / 记忆侧栏 / complexity.ts 固化检测四处共用——读写检测同文件。
 */
export function resolveFactsFileName(profileId?: string): string {
  return profileId ? `facts-${profileId}.md` : FACTS_FILE;
}

export const memoryToolDefinitions: ToolDefinition[] = [
  {
    name: "save_memory",
    description:
      "把跨会话需要记住的项目事实写入工作区记忆（如「该项目战力公式为乘法结构」「装备强化消耗铜币与材料双轨」）。下次会话自动携带。只记结论性事实，不记一次性查询结果。content 上限 500 字（一句话事实，超限请精简或拆成多条记忆）。",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "要记住的事实，一句话，上限 500 字" },
      },
      required: ["content"],
    },
    access: "write",
    module: "memory",
    execute: async (params, ctx) => {
      const { content } = (params ?? {}) as { content?: string };
      if (!content?.trim()) return { success: false, error: "缺少 content" };
      const trimmed = content.trim();
      if (trimmed.length > MAX_CONTENT_LENGTH) {
        return {
          success: false,
          error: `content 过长（${trimmed.length} 字，上限 ${MAX_CONTENT_LENGTH}）——请精简为一句话事实；信息较多时可拆成多条记忆分次保存`,
        };
      }
      // facts 行格式为「- 日期 一行事实」：换行与连续空白压平为单空格，多行 content 不破坏行格式
      const flat = trimmed.replace(/\s+/g, " ");
      const line = `- ${new Date().toISOString().slice(0, 16).replace("T", " ")} ${flat}\n`;
      // 记忆隔离：登录态写用户私有文件（facts-{profileId}.md），缺省回落公共文件
      appendWorkspaceText(join(ctx.workspaceRoot, MEMORY_DIR, resolveFactsFileName(ctx.profileId)), line);
      return { success: true, data: { saved: flat } };
    },
  },
  {
    name: "read_memory",
    description: "读取工作区全部项目记忆（项目画像 PROFILE.md + 事实流 facts.md）。回答与历史结论相关的问题前先查记忆。",
    parameters: { type: "object", properties: {} },
    access: "read",
    module: "memory",
    execute: async (_params, ctx) => {
      const dir = join(ctx.workspaceRoot, MEMORY_DIR);
      const memories: Record<string, string> = {};
      // 记忆隔离白名单：公共基底（PROFILE.md 画像 + facts.md 种子）+ 用户私有
      // facts-{profileId}.md——禁全目录读（readdirSync 会带出他人私有文件）
      const privateFacts = resolveFactsFileName(ctx.profileId);
      const readable = ctx.profileId
        ? ["PROFILE.md", FACTS_FILE, privateFacts]
        : ["PROFILE.md", FACTS_FILE];
      for (const file of readable) {
        // 基底目录（git 提交的 PROFILE 等）+ overlay 中的 facts（只读部署环境）
        const text = loadWorkspaceText(join(dir, file));
        if (text !== null) memories[file] = text;
      }
      if (Object.keys(memories).length === 0) {
        return { success: true, data: { memories, note: "尚无项目记忆" } };
      }
      return { success: true, data: { memories } };
    },
  },
];
