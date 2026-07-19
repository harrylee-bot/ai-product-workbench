import { Module } from "@nestjs/common";
import { ObjectStorageModule } from "../../platform/object-storage/object-storage.module.js";
import { AccessModule } from "../access/access.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { PublicSharesController, ShareGrantsController } from "./shares.controller.js";
import { SharesService } from "./shares.service.js";

@Module({
  imports: [AccessModule, IdentityModule, ObjectStorageModule],
  controllers: [ShareGrantsController, PublicSharesController],
  providers: [SharesService],
  exports: [SharesService],
})
export class SharesModule {}
