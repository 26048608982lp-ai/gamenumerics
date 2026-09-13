// 项目类型定义

export type GameType = 'rpg' | 'slg' | 'roguelike' | 'moba' | 'card' | 'casual';
export type ProjectStatus = 'planning' | 'designing' | 'active' | 'archived';

export interface Project {
  id: string;
  userId: string;
  name: string;
  gameType: GameType;
  description: string;
  status: ProjectStatus;
  /**
   * P2-W3：确认方案后自动执行数值体检（POST /api/planning-state confirmed
   * 副作用区触发，复用 W2 快照链路）。引擎/DB 列 auto_acceptance 映射。
   */
  autoAcceptance?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PlanningModuleType = 'battle' | 'economy' | 'progression' | 'level' | 'monetization' | 'gacha' | 'game-framework';

export type PlanningStatus =
  | 'pending'
  | 'ai_generating'
  | 'ai_completed'
  | 'user_confirming'
  | 'confirmed'
  | 'needs_revision';

export interface PlanningResult {
  id: string;
  projectId: string;
  moduleType: PlanningModuleType;
  status: PlanningStatus;
  questionnaireData: Record<string, unknown>;
  aiMessages: AiMessage[];
  planningData: Record<string, unknown>;
  constraintContributions: Record<string, unknown>;
  confirmedData: Record<string, unknown>;
  aiSessionId: string | null;
  aiApplied: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureResult {
  id: string;
  projectId: string;
  parentModuleType: PlanningModuleType;
  parentPlanningId: string | null;
  featureKey: string;
  featureName: string;
  status: PlanningStatus;
  questionnaireData: Record<string, unknown>;
  aiMessages: AiMessage[];
  featureData: Record<string, unknown>;
  confirmedData: Record<string, unknown>;
  aiSessionId: string | null;
  aiApplied: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}
