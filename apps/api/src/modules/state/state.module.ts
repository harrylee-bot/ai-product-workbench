import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { StateService } from "./state.service";

@Module({
  imports: [PrismaModule],
  providers: [StateService],
  exports: [StateService],
})
export class StateModule {}
