import { SourcePrototypePreviewModule } from "./modules/source-prototype-preview/source-prototype-preview.module.js";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { WorkbenchDbModule } from "./platform/database/workbench-db.module.js";
import { WorkbenchQueueModule } from "./platform/queue/workbench-queue.module.js";
import { WorkbenchTelemetryModule } from "./platform/telemetry/workbench-telemetry.module.js";
import { ArtifactsModule } from "./modules/artifacts/artifacts.module.js";
import { BoardsModule } from "./modules/boards/boards.module.js";
import { DesignSystemsModule } from "./modules/design-systems/design-systems.module.js";
import { DesignPresetsModule } from "./modules/design-presets/design-presets.module.js";
import { IdentityModule } from "./modules/identity/identity.module.js";
import { KnowledgeModule } from "./modules/knowledge/knowledge.module.js";
import { FilesModule } from "./modules/files/files.module.js";
import { ExportsModule } from "./modules/exports/exports.module.js";
import { ProjectsModule } from "./modules/projects/projects.module.js";
import { ReleasesModule } from "./modules/releases/releases.module.js";
import { RemixesModule } from "./modules/remixes/remixes.module.js";
import { RunsModule } from "./modules/runs/runs.module.js";
import { RuntimeModule } from "./modules/runtime/runtime.module.js";
import { SystemModule } from "./modules/system/system.module.js";
import { SharesModule } from "./modules/shares/shares.module.js";
import { ThreadsModule } from "./modules/threads/threads.module.js";
import { WorkspacesModule } from "./modules/workspaces/workspaces.module.js";
import { SubmissionIntentsModule } from "./modules/submission-intents/submission-intents.module.js";
import { CanvasAgentModule } from "./modules/canvas-agent/canvas-agent.module.js";
import { PrototypePatchesModule } from "./modules/prototype-patches/prototype-patches.module.js";
import { ImportSourcesModule } from "./modules/import-sources/import-sources.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", "../../.env"],
    }),
    WorkbenchDbModule,
    WorkbenchQueueModule,
    WorkbenchTelemetryModule,
    ArtifactsModule,
    BoardsModule,
    CanvasAgentModule,
    DesignSystemsModule,
    DesignPresetsModule,
    IdentityModule,
    KnowledgeModule,
    FilesModule,
    ExportsModule,
    ProjectsModule,
    PrototypePatchesModule,
    ImportSourcesModule,
    ReleasesModule,
    RemixesModule,
    RunsModule,
    RuntimeModule,
    SystemModule,
    SharesModule,
    SourcePrototypePreviewModule,
    ThreadsModule,
    SubmissionIntentsModule,
    WorkspacesModule,
  ],
})
export class AppModule {}
