import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { PrismaModule } from "../prisma/prisma.module";
import { ApiKeyEncryptionService } from "./api-key-encryption.service";
import { ModelGatewayAdminController } from "./model-gateway-admin.controller";
import { ModelGatewayAdminService } from "./model-gateway-admin.service";
import { ModelGatewayDefaultsService } from "./model-gateway-defaults.service";
import { ModelGatewayService } from "./model-gateway.service";
import { OpenAICompatibleAdapter } from "./openai-compatible.adapter";

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
