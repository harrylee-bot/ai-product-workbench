import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { CEOLayerService } from "./ceo/ceo.service";
import { CompanyController } from "./company.controller";
import { CompanyRuntimeService } from "./company-runtime.service";
import { DesignDepartmentService } from "./design/design-department.service";
import { EngineeringDepartmentService } from "./engineering/engineering-department.service";
import { EvolutionDepartmentService } from "./evolution/evolution-department.service";
import { GrowthDepartmentService } from "./growth/growth-department.service";
import { ProductDepartmentService } from "./product/product-department.service";
import { QADepartmentService } from "./qa/qa-department.service";

@Module({
  imports: [PrismaModule],
  controllers: [CompanyController],
  providers: [
    CompanyRuntimeService,
    CEOLayerService,
    ProductDepartmentService,
    EngineeringDepartmentService,
    DesignDepartmentService,
    QADepartmentService,
    GrowthDepartmentService,
    EvolutionDepartmentService,
  ],
  exports: [CompanyRuntimeService],
})
export class CompanyModule {}
