import { Global, Module } from "@nestjs/common";
import { WorkbenchQueueService } from "./workbench-queue.service.js";

@Global()
@Module({
  providers: [WorkbenchQueueService],
  exports: [WorkbenchQueueService],
})
export class WorkbenchQueueModule {}
