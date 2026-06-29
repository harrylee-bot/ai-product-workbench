import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ApiKeyEncryptionService } from "./api-key-encryption.service";
import { ModelGatewayAdminController } from "./model-gateway-admin.controller";
import { ModelGatewayAdminService } from "./model-gateway-admin.service";
import { ModelGatewayDefaultsService } from "./model-gateway-defaults.service";
import { ModelGatewayService } from "./model-gateway.service";
import { OpenAICompatibleAdapter } from "./openai-compatible.adapter";

// ModelGatewayService 当前为 admin-only 基础设施：负责模型供应商/配置/任务映射/调用日志的可观测与管理。
// DeerFlow-first 生成路径不经此（DeerFlow 用裸 fetch 直连），因此这里仅向 admin 控制器提供能力。
// 首个运行时消费者将由 requirement_mode 预分类（vibe.service）接入；在此之前 exports 保留以备未来场景。
@Module({
  imports: [AdminModule, PrismaModule],
  controllers: [ModelGatewayAdminController],
  providers: [
    ApiKeyEncryptionService,
    OpenAICompatibleAdapter,
    ModelGatewayService,
    ModelGatewayAdminService,
    ModelGatewayDefaultsService,
  ],
  exports: [ModelGatewayService],
})
export class ModelGatewayModule {}
