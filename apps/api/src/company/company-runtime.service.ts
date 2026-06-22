import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CEOLayerService } from "./ceo/ceo.service";
import type {
  AgentView,
  CEOPlan,
  CompanyEvolutionPlanView,
  CompanyQAReportView,
  CompanyRuntimeView,
  CompanyView,
  DepartmentType,
  DepartmentView,
  DesignPlanView,
  EngineeringPlanView,
  GrowthPlanView,
  ProductInitiativeView,
} from "./company.types";
import { DesignDepartmentService } from "./design/design-department.service";
import { EngineeringDepartmentService } from "./engineering/engineering-department.service";
import { EvolutionDepartmentService } from "./evolution/evolution-department.service";
import { GrowthDepartmentService } from "./growth/growth-department.service";
import { ProductDepartmentService } from "./product/product-department.service";
import { QADepartmentService } from "./qa/qa-department.service";

const COMPANY_BUDGET = 100000;

const DEPARTMENTS: Array<{
  type: DepartmentType;
  ratio: number;
  agent: Omit<AgentView, "id" | "departmentId">;
}> = [
  {
    type: "ceo",
    ratio: 0.08,
    agent: {
      name: "CEO Agent",
      role: "Strategic approval, product prioritization, and budget control.",
      capabilities: ["strategy", "approval", "budget_allocation"],
    },
  },
  {
    type: "product",
    ratio: 0.2,
    agent: {
      name: "Product Department Agent",
      role: "Define PRD-ready initiatives and feature modules.",
      capabilities: ["prd", "feature_breakdown", "scope_control"],
    },
  },
  {
    type: "engineering",
    ratio: 0.27,
    agent: {
      name: "Engineering Department Agent",
      role: "Plan modules, APIs, orchestration, and system changes.",
      capabilities: ["api_design", "module_planning", "system_mutation"],
    },
  },
  {
    type: "design",
    ratio: 0.15,
    agent: {
      name: "Design Department Agent",
      role: "Shape workspace UI, UX flows, and prototype structure.",
      capabilities: ["ui_layout", "ux_flow", "prototype_structure"],
    },
  },
  {
    type: "qa",
    ratio: 0.1,
    agent: {
      name: "QA Department Agent",
      role: "Check lifecycle consistency and delivery risk.",
      capabilities: ["test_planning", "consistency_check", "risk_detection"],
    },
  },
  {
    type: "growth",
    ratio: 0.12,
    agent: {
      name: "Growth Department Agent",
      role: "Find activation and conversion improvements.",
      capabilities: ["growth_strategy", "experimentation", "conversion"],
    },
  },
  {
    type: "evolution",
    ratio: 0.08,
    agent: {
      name: "Evolution Department Agent",
      role: "Optimize organization structure and collaboration loops.",
      capabilities: ["organization_design", "agent_distribution", "policy_feedback"],
    },
  },
];

@Injectable()
export class CompanyRuntimeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ceo: CEOLayerService,
    private readonly product: ProductDepartmentService,
    private readonly engineering: EngineeringDepartmentService,
    private readonly design: DesignDepartmentService,
    private readonly qa: QADepartmentService,
    private readonly growth: GrowthDepartmentService,
    private readonly evolution: EvolutionDepartmentService,
  ) {}

  async run(input: {
    projectId: string;
    marketSignal: string;
    createdBy: string;
    sourceType?: string;
    sourceId?: string;
  }): Promise<CompanyRuntimeView> {
    const company = await this.ensureCompany(input.projectId, input.createdBy);
    const ceoPlan = this.ceo.decide({ marketSignal: input.marketSignal, company });
    this.assertCEOApproval(ceoPlan);

    const productInitiative = await this.createApprovedInitiative({
      projectId: input.projectId,
      companyId: company.id,
      sourceInput: input.marketSignal,
      createdBy: input.createdBy,
      ceoPlan,
    });
    const engineeringPlan = await this.persistEngineeringPlan({
      projectId: input.projectId,
      companyId: company.id,
      createdBy: input.createdBy,
      initiative: productInitiative,
    });
    const designPlan = await this.persistDesignPlan({
      projectId: input.projectId,
      companyId: company.id,
      createdBy: input.createdBy,
      initiative: productInitiative,
    });
    const qaReport = await this.persistQAReport({
      projectId: input.projectId,
      companyId: company.id,
      createdBy: input.createdBy,
      initiative: productInitiative,
      engineeringPlan,
      designPlan,
    });
    const growthPlan = await this.persistGrowthPlan({
      projectId: input.projectId,
      companyId: company.id,
      createdBy: input.createdBy,
      initiative: productInitiative,
    });
    const evolutionPlan = await this.persistEvolutionPlan({
      projectId: input.projectId,
      companyId: company.id,
      createdBy: input.createdBy,
      initiative: productInitiative,
    });

    const runtimeRun = await this.prisma.companyRuntimeRun.create({
      data: {
        projectId: input.projectId,
        companyId: company.id,
        initiativeId: productInitiative.id,
        sourceType: input.sourceType ?? "manual",
        sourceId: input.sourceId,
        input: input.marketSignal,
        ceoPlan: ceoPlan as unknown as Prisma.InputJsonValue,
        productInitiative: productInitiative as unknown as Prisma.InputJsonValue,
        engineeringPlan: engineeringPlan as unknown as Prisma.InputJsonValue,
        designPlan: designPlan as unknown as Prisma.InputJsonValue,
        qaReport: qaReport as unknown as Prisma.InputJsonValue,
        growthPlan: growthPlan as unknown as Prisma.InputJsonValue,
        evolutionPlan: evolutionPlan as unknown as Prisma.InputJsonValue,
        budgetAllocation: ceoPlan.budgetAllocation as unknown as Prisma.InputJsonValue,
        status: "completed",
        createdBy: input.createdBy,
      },
    });

    return {
      company,
      ceoPlan,
      productInitiative,
      engineeringPlan,
      designPlan,
      qaReport,
      growthPlan,
      evolutionPlan,
      runtimeRun: {
        id: runtimeRun.id,
        status: runtimeRun.status,
        createdAt: runtimeRun.createdAt.toISOString(),
      },
    };
  }

  async decide(input: { projectId: string; marketSignal: string; createdBy: string }) {
    const company = await this.ensureCompany(input.projectId, input.createdBy);
    return {
      company,
      ceoPlan: this.ceo.decide({ marketSignal: input.marketSignal, company }),
    };
  }

  async createProduct(input: { projectId: string; marketSignal: string; createdBy: string }) {
    const company = await this.ensureCompany(input.projectId, input.createdBy);
    const ceoPlan = this.ceo.decide({ marketSignal: input.marketSignal, company });
    this.assertCEOApproval(ceoPlan);
    const initiative = await this.createApprovedInitiative({
      projectId: input.projectId,
      companyId: company.id,
      sourceInput: input.marketSignal,
      createdBy: input.createdBy,
      ceoPlan,
    });
    return { company, ceoPlan, productInitiative: initiative };
  }

  async buildEngineering(input: { projectId: string; initiativeId: string; createdBy: string }) {
    const initiative = await this.getApprovedInitiative(input.projectId, input.initiativeId);
    return this.persistEngineeringPlan({
      projectId: input.projectId,
      companyId: initiative.companyId,
      createdBy: input.createdBy,
      initiative: toInitiativeView(initiative),
    });
  }

  async generateDesign(input: { projectId: string; initiativeId: string; createdBy: string }) {
    const initiative = await this.getApprovedInitiative(input.projectId, input.initiativeId);
    return this.persistDesignPlan({
      projectId: input.projectId,
      companyId: initiative.companyId,
      createdBy: input.createdBy,
      initiative: toInitiativeView(initiative),
    });
  }

  async runQA(input: { projectId: string; initiativeId: string; createdBy: string }) {
    const initiative = await this.getApprovedInitiative(input.projectId, input.initiativeId);
    const initiativeView = toInitiativeView(initiative);
    return this.persistQAReport({
      projectId: input.projectId,
      companyId: initiative.companyId,
      createdBy: input.createdBy,
      initiative: initiativeView,
      engineeringPlan: this.engineering.build({ initiative: initiativeView }),
      designPlan: this.design.generate({ initiative: initiativeView }),
    });
  }

  async optimizeGrowth(input: { projectId: string; initiativeId: string; createdBy: string }) {
    const initiative = await this.getApprovedInitiative(input.projectId, input.initiativeId);
    return this.persistGrowthPlan({
      projectId: input.projectId,
      companyId: initiative.companyId,
      createdBy: input.createdBy,
      initiative: toInitiativeView(initiative),
    });
  }

  async applyEvolution(input: { projectId: string; initiativeId: string; createdBy: string }) {
    const initiative = await this.getApprovedInitiative(input.projectId, input.initiativeId);
    return this.persistEvolutionPlan({
      projectId: input.projectId,
      companyId: initiative.companyId,
      createdBy: input.createdBy,
      initiative: toInitiativeView(initiative),
    });
  }

  async dashboard(projectId: string) {
    const company = await this.prisma.company.findFirst({
      where: { projectId, status: "active" },
      orderBy: { createdAt: "desc" },
      include: {
        departments: { include: { agents: true }, orderBy: { type: "asc" } },
        initiatives: { orderBy: { createdAt: "desc" }, take: 5 },
        companyRuntimeRuns: { orderBy: { createdAt: "desc" }, take: 5 },
      },
    });
    if (!company) return { company: null, initiatives: [], runtimeRuns: [] };
    return {
      company: toCompanyView(company),
      initiatives: company.initiatives.map((initiative) => ({
        ...toInitiativeView(initiative),
        ceoApproved: initiative.ceoApproved,
        priority: initiative.priority,
        allocatedBudget: initiative.allocatedBudget,
      })),
      runtimeRuns: company.companyRuntimeRuns.map((run) => ({
        id: run.id,
        status: run.status,
        sourceType: run.sourceType,
        createdAt: run.createdAt.toISOString(),
      })),
    };
  }

  async ensureCompany(projectId: string, createdBy: string): Promise<CompanyView> {
    const existing = await this.prisma.company.findFirst({
      where: { projectId, status: "active" },
      orderBy: { createdAt: "desc" },
      include: { departments: { include: { agents: true } } },
    });
    if (existing) return toCompanyView(existing);

    const company = await this.prisma.company.create({
      data: {
        projectId,
        name: "AI Product Company",
        budget: COMPANY_BUDGET,
        strategy: "Build approved product initiatives through department-owned execution.",
        createdBy,
      },
    });

    for (const definition of DEPARTMENTS) {
      const department = await this.prisma.department.create({
        data: {
          projectId,
          companyId: company.id,
          type: definition.type,
          budgetAllocation: Math.round(COMPANY_BUDGET * definition.ratio),
        },
      });
      await this.prisma.agent.create({
        data: {
          projectId,
          companyId: company.id,
          departmentId: department.id,
          name: definition.agent.name,
          role: definition.agent.role,
          capabilities: definition.agent.capabilities as unknown as Prisma.InputJsonValue,
        },
      });
    }

    const created = await this.prisma.company.findUnique({
      where: { id: company.id },
      include: { departments: { include: { agents: true } } },
    });
    if (!created) throw new NotFoundException("Company 初始化失败");
    return toCompanyView(created);
  }

  private async createApprovedInitiative(input: {
    projectId: string;
    companyId: string;
    sourceInput: string;
    createdBy: string;
    ceoPlan: CEOPlan;
  }) {
    const productDraft = this.product.create({
      ceoPlan: input.ceoPlan,
      marketSignal: input.sourceInput,
    });
    const created = await this.prisma.productInitiative.create({
      data: {
        projectId: input.projectId,
        companyId: input.companyId,
        sourceInput: input.sourceInput,
        name: productDraft.name,
        goal: productDraft.goal,
        features: productDraft.features as unknown as Prisma.InputJsonValue,
        ceoApproved: true,
        priority: input.ceoPlan.priority[0] ?? "product",
        allocatedBudget: input.ceoPlan.budgetAllocation.product,
        createdBy: input.createdBy,
      },
    });
    return {
      ...toInitiativeView(created),
      ceoApproved: created.ceoApproved,
      priority: created.priority,
      allocatedBudget: created.allocatedBudget,
    };
  }

  private async persistEngineeringPlan(input: {
    projectId: string;
    companyId: string;
    createdBy: string;
    initiative: ProductInitiativeView;
  }): Promise<EngineeringPlanView> {
    const plan = this.engineering.build({ initiative: input.initiative });
    const created = await this.prisma.engineeringPlan.create({
      data: {
        projectId: input.projectId,
        companyId: input.companyId,
        initiativeId: input.initiative.id,
        modules: plan.modules as unknown as Prisma.InputJsonValue,
        apis: plan.apis as unknown as Prisma.InputJsonValue,
        systemChanges: plan.systemChanges as unknown as Prisma.InputJsonValue,
        createdBy: input.createdBy,
      },
    });
    return { ...plan, id: created.id };
  }

  private async persistDesignPlan(input: {
    projectId: string;
    companyId: string;
    createdBy: string;
    initiative: ProductInitiativeView;
  }): Promise<DesignPlanView> {
    const plan = this.design.generate({ initiative: input.initiative });
    const created = await this.prisma.designPlan.create({
      data: {
        projectId: input.projectId,
        companyId: input.companyId,
        initiativeId: input.initiative.id,
        layouts: plan.layouts as unknown as Prisma.InputJsonValue,
        uxFlows: plan.uxFlows as unknown as Prisma.InputJsonValue,
        createdBy: input.createdBy,
      },
    });
    return { ...plan, id: created.id };
  }

  private async persistQAReport(input: {
    projectId: string;
    companyId: string;
    createdBy: string;
    initiative: ProductInitiativeView;
    engineeringPlan: EngineeringPlanView;
    designPlan: DesignPlanView;
  }): Promise<CompanyQAReportView> {
    const report = this.qa.run({
      engineeringPlan: input.engineeringPlan,
      designPlan: input.designPlan,
    });
    const created = await this.prisma.companyQAReport.create({
      data: {
        projectId: input.projectId,
        companyId: input.companyId,
        initiativeId: input.initiative.id,
        issues: report.issues as unknown as Prisma.InputJsonValue,
        riskLevel: report.riskLevel,
        recommendations: report.recommendations as unknown as Prisma.InputJsonValue,
        createdBy: input.createdBy,
      },
    });
    return { ...report, id: created.id };
  }

  private async persistGrowthPlan(input: {
    projectId: string;
    companyId: string;
    createdBy: string;
    initiative: ProductInitiativeView;
  }): Promise<GrowthPlanView> {
    const plan = this.growth.optimize({ initiative: input.initiative });
    const created = await this.prisma.growthPlan.create({
      data: {
        projectId: input.projectId,
        companyId: input.companyId,
        initiativeId: input.initiative.id,
        optimizations: plan.optimizations as unknown as Prisma.InputJsonValue,
        experiments: plan.experiments as unknown as Prisma.InputJsonValue,
        createdBy: input.createdBy,
      },
    });
    return { ...plan, id: created.id };
  }

  private async persistEvolutionPlan(input: {
    projectId: string;
    companyId: string;
    createdBy: string;
    initiative: ProductInitiativeView;
  }): Promise<CompanyEvolutionPlanView> {
    const plan = this.evolution.apply({ initiative: input.initiative });
    const created = await this.prisma.companyEvolutionPlan.create({
      data: {
        projectId: input.projectId,
        companyId: input.companyId,
        initiativeId: input.initiative.id,
        structuralChanges: plan.structuralChanges as unknown as Prisma.InputJsonValue,
        agentChanges: plan.agentChanges as unknown as Prisma.InputJsonValue,
        createdBy: input.createdBy,
      },
    });
    return { ...plan, id: created.id };
  }

  private async getApprovedInitiative(projectId: string, initiativeId: string) {
    const initiative = await this.prisma.productInitiative.findFirst({
      where: { id: initiativeId, projectId },
    });
    if (!initiative) throw new NotFoundException("ProductInitiative 不存在");
    if (!initiative.ceoApproved) throw new ForbiddenException("产品未经过 CEO 审批");
    return initiative;
  }

  private assertCEOApproval(plan: CEOPlan) {
    if (!plan.approved || plan.initiatives.length === 0) {
      throw new ForbiddenException("CEO 未批准产品创建");
    }
  }
}

function toCompanyView(company: {
  id: string;
  name: string;
  budget: number;
  strategy: string;
  departments: Array<{
    id: string;
    type: string;
    budgetAllocation: number;
    agents: Array<{
      id: string;
      name: string;
      role: string;
      departmentId: string;
      capabilities: Prisma.JsonValue;
    }>;
  }>;
}): CompanyView {
  return {
    id: company.id,
    name: company.name,
    budget: company.budget,
    strategy: company.strategy,
    departments: company.departments.map(toDepartmentView),
  };
}

function toDepartmentView(department: {
  id: string;
  type: string;
  budgetAllocation: number;
  agents: Array<{
    id: string;
    name: string;
    role: string;
    departmentId: string;
    capabilities: Prisma.JsonValue;
  }>;
}): DepartmentView {
  return {
    id: department.id,
    type: department.type as DepartmentType,
    budgetAllocation: department.budgetAllocation,
    agents: department.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      departmentId: agent.departmentId,
      capabilities: stringArray(agent.capabilities),
    })),
  };
}

function toInitiativeView(initiative: {
  id: string;
  name: string;
  goal: string;
  features: Prisma.JsonValue;
}): ProductInitiativeView {
  return {
    id: initiative.id,
    name: initiative.name,
    goal: initiative.goal,
    features: stringArray(initiative.features),
  };
}

function stringArray(value: Prisma.JsonValue) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
