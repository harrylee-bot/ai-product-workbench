import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { RemixesController } from "./remixes.controller.js";
import { RemixesService } from "./remixes.service.js";

@Module({
  imports: [IdentityModule],
  controllers: [RemixesController],
  providers: [RemixesService],
})
export class RemixesModule {}
