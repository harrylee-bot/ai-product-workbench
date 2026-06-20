import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { ApiKeyEncryptionService } from "./api-key-encryption.service";
import { ModelGatewayAdminController } from "./model-gateway-admin.controller";
import { ModelGatewayAdminService } from "./model-gateway-admin.service";
import { ModelGatewayService } from "./model-gateway.service";
import { OpenAICompatibleAdapter } from "./openai-compatible.adapter";

@Module({
  imports: [PrismaModule],
  controllers: [ModelGatewayAdminController],
  providers: [
    ApiKeyEncryptionService,
    OpenAICompatibleAdapter,
    ModelGatewayService,
    ModelGatewayAdminService,
  ],
  exports: [ModelGatewayService],
})
export class ModelGatewayModule {}
