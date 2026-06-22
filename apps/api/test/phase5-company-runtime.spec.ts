import { describe, expect, it, vi } from "vitest";
import { CEOLayerService } from "../src/company/ceo/ceo.service";
import { CompanyRuntimeService } from "../src/company/company-runtime.service";
import { DesignDepartmentService } from "../src/company/design/design-department.service";
import { EngineeringDepartmentService } from "../src/company/engineering/engineering-department.service";
import { EvolutionDepartmentService } from "../src/company/evolution/evolution-department.service";
import { GrowthDepartmentService } from "../src/company/growth/growth-department.service";
import { ProductDepartmentService } from "../src/company/product/product-department.service";
import { QADepartmentService } from "../src/company/qa/qa-department.service";
import type { PrismaService } from "../src/prisma/prisma.service";

describe("Phase5 company runtime", () => {
  it("CEO approves initiatives and allocates budget across every department", () => {
    const ceo = new CEOLayerService();
    const plan = ceo.decide({
      marketSignal: "Create a product company dashboard",
      company: {
        id: "company_1",
        name: "智能产品公司",
        budget: 100000,
        strategy: "交付已批准的产品计划",
        departments: [],
      },
    });

    expect(plan.approved).toBe(true);
    expect(plan.initiatives).toHaveLength(1);
    expect(Object.keys(plan.budgetAllocation).sort()).toEqual([
      "ceo",
      "design",
      "engineering",
      "evolution",
      "growth",
      "product",
      "qa",
    ]);
    expect(Object.values(plan.budgetAllocation).reduce((sum, value) => sum + value, 0)).toBe(100000);
  });

  it("department services produce a complete company lifecycle", () => {
    const ceo = new CEOLayerService();
    const product = new ProductDepartmentService();
    const engineering = new EngineeringDepartmentService();
    const design = new DesignDepartmentService();
    const qa = new QADepartmentService();
    const growth = new GrowthDepartmentService();
    const evolution = new EvolutionDepartmentService();

    const ceoPlan = ceo.decide({
      marketSignal: "Launch AI PM runtime",
      company: {
        id: "company_1",
        name: "智能产品公司",
        budget: 100000,
        strategy: "部门负责制执行",
        departments: [],
      },
    });
    const initiative = product.create({ ceoPlan, marketSignal: "Launch AI PM runtime" });
    const engineeringPlan = engineering.build({ initiative });
    const designPlan = design.generate({ initiative });
    const qaReport = qa.run({ engineeringPlan, designPlan });
    const growthPlan = growth.optimize({ initiative });
    const evolutionPlan = evolution.apply({ initiative });

    expect(initiative.features.length).toBeGreaterThanOrEqual(4);
    expect(engineeringPlan.apis).toContain("POST /company/ceo/decide");
    expect(designPlan.layouts[0]).toContain("公司看板");
    expect(qaReport.riskLevel).toBe("low");
    expect(growthPlan.experiments.length).toBeGreaterThan(0);
    expect(evolutionPlan.structuralChanges[0].type).toBe("modify_pipeline");
  });

  it("persists the CEO-approved full runtime chain and assigns agents to departments", async () => {
    const departments = ["ceo", "product", "engineering", "design", "qa", "growth", "evolution"].map((type) => ({
      id: `department_${type}`,
      type,
      budgetAllocation: type === "engineering" ? 27000 : 10000,
      agents: [
        {
          id: `agent_${type}`,
          name: `${type} agent`,
          role: `${type} role`,
          departmentId: `department_${type}`,
          capabilities: ["mock"],
        },
      ],
    }));
    const prisma = {
      company: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: "company_1",
          name: "智能产品公司",
          budget: 100000,
          strategy: "部门负责制执行",
        }),
        findUnique: vi.fn().mockResolvedValue({
          id: "company_1",
          name: "智能产品公司",
          budget: 100000,
          strategy: "部门负责制执行",
          departments,
        }),
      },
      department: {
        create: vi.fn().mockImplementation(({ data }) =>
          Promise.resolve({ id: `department_${data.type}`, ...data }),
        ),
      },
      agent: {
        create: vi.fn().mockResolvedValue({ id: "agent_1" }),
      },
      productInitiative: {
        create: vi.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            id: "initiative_1",
            ...data,
          }),
        ),
      },
      engineeringPlan: {
        create: vi.fn().mockResolvedValue({ id: "engineering_1" }),
      },
      designPlan: {
        create: vi.fn().mockResolvedValue({ id: "design_1" }),
      },
      companyQAReport: {
        create: vi.fn().mockResolvedValue({ id: "qa_1" }),
      },
      growthPlan: {
        create: vi.fn().mockResolvedValue({ id: "growth_1" }),
      },
      companyEvolutionPlan: {
        create: vi.fn().mockResolvedValue({ id: "evolution_1" }),
      },
      companyRuntimeRun: {
        create: vi.fn().mockResolvedValue({
          id: "runtime_1",
          status: "completed",
          createdAt: new Date("2026-06-22T00:00:00.000Z"),
        }),
      },
    } as unknown as PrismaService;

    const runtime = new CompanyRuntimeService(
      prisma,
      new CEOLayerService(),
      new ProductDepartmentService(),
      new EngineeringDepartmentService(),
      new DesignDepartmentService(),
      new QADepartmentService(),
      new GrowthDepartmentService(),
      new EvolutionDepartmentService(),
    );

    const result = await runtime.run({
      projectId: "project_1",
      marketSignal: "Build an AI company runtime",
      createdBy: "user_1",
      sourceType: "message",
      sourceId: "message_1",
    });

    expect(result.ceoPlan.approved).toBe(true);
    expect(result.productInitiative.ceoApproved).toBe(true);
    expect(result.company.departments).toHaveLength(7);
    expect(result.company.departments.every((department) => department.agents[0]?.departmentId === department.id)).toBe(true);
    expect(prisma.department.create).toHaveBeenCalledTimes(7);
    expect(prisma.agent.create).toHaveBeenCalledTimes(7);
    expect(prisma.companyRuntimeRun.create).toHaveBeenCalledOnce();
  });
});
