import type { Artifact } from "@workbench/workbench-contracts";

import type { CursorPageOptions } from "../../../transport/contracts";

export type ArtifactListOptions = CursorPageOptions & { kind?: Artifact["kind"] };
