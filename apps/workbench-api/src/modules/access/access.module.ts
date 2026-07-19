import { Module } from "@nestjs/common";
import { AccessService } from "./access.service.js";

@Module({
  providers: [AccessService],
  exports: [AccessService],
})
export class AccessModule {}
