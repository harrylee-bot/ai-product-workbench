import { Global, Module } from "@nestjs/common";
import { WorkbenchDbService } from "./workbench-db.service.js";

@Global()
@Module({
  providers: [WorkbenchDbService],
  exports: [WorkbenchDbService],
})
export class WorkbenchDbModule {}
