import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@workbench/workbench-db';
import { vi } from 'vitest';
import { AccessService } from '../../workbench-api/src/modules/access/access.service.js';
import { DesignPresetsService } from '../../workbench-api/src/modules/design-presets/design-presets.service.js';
import { PrototypeV2Service } from '../../workbench-api/src/modules/prototypes/prototype-v2.service.js';
import { RunEventStore } from '../../workbench-api/src/modules/runs/run-event.store.js';
import { RunsService } from '../../workbench-api/src/modules/runs/runs.service.js';
import { requirementFlow } from '../../workbench-api/test/fixtures/requirement-flow.js';

// The worker sees the API's actual frozen request and one-time confirmation.
// Queue/model availability and workflow transport stay under the test's control.
export function workerRequirementFlow(db: PrismaClient, principalId: string, projectId: string) {
  const runs = new RunsService(db as never, new AccessService(db as never), new RunEventStore(),
    { sendInTransaction: vi.fn() } as never, { assertAvailable: vi.fn() } as never, new DesignPresetsService());
  const workflows = { configured: true, startPlan: vi.fn(), cancelPlan: vi.fn(), startExport: vi.fn(), cancelExport: vi.fn() };
  const prototypes = new PrototypeV2Service(db as never, workflows, new ConfigService(), {} as never, runs);
  return { ...requirementFlow(db, runs, prototypes, principalId, projectId), runs, prototypes };
}
