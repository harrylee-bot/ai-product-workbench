import type { SystemMutation } from "../ai/self-generation/mutation.engine";

export type DepartmentType =
  | "ceo"
  | "product"
  | "engineering"
  | "design"
  | "qa"
  | "growth"
  | "evolution";

export type CompanyView = {
  id: string;
  name: string;
  budget: number;
  strategy: string;
  departments: DepartmentView[];
};

export type DepartmentView = {
  id: string;
  type: DepartmentType;
  budgetAllocation: number;
  agents: AgentView[];
};

export type AgentView = {
  id: string;
  name: string;
  role: string;
  departmentId: string;
  capabilities: string[];
};

export type ProductInitiativeView = {
  id: string;
  name: string;
  goal: string;
  features: string[];
};

export type CEOPlan = {
  initiatives: ProductInitiativeView[];
  budgetAllocation: Record<DepartmentType, number>;
  priority: string[];
  approved: boolean;
};

export type EngineeringPlanView = {
  id?: string;
  modules: string[];
  apis: string[];
  systemChanges: SystemMutation[];
};

export type DesignPlanView = {
  id?: string;
  layouts: string[];
  uxFlows: string[];
};

export type CompanyQAReportView = {
  id?: string;
  issues: string[];
  riskLevel: "low" | "medium" | "high";
  recommendations: string[];
};

export type GrowthPlanView = {
  id?: string;
  optimizations: string[];
  experiments: string[];
};

export type AgentMutation = {
  op: "add" | "move" | "update" | "disable";
  agentId?: string;
  departmentType: DepartmentType;
  value: Record<string, unknown>;
  reason: string;
};

export type CompanyEvolutionPlanView = {
  id?: string;
  structuralChanges: SystemMutation[];
  agentChanges: AgentMutation[];
};

export type CompanyRuntimeView = {
  company: CompanyView;
  ceoPlan: CEOPlan;
  productInitiative: ProductInitiativeView & {
    ceoApproved: boolean;
    priority: string;
    allocatedBudget: number;
  };
  engineeringPlan: EngineeringPlanView;
  designPlan: DesignPlanView;
  qaReport: CompanyQAReportView;
  growthPlan: GrowthPlanView;
  evolutionPlan: CompanyEvolutionPlanView;
  runtimeRun: {
    id: string;
    status: string;
    createdAt: string;
  };
};
