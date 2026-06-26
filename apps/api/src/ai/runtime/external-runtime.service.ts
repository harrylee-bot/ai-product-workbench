import { Injectable } from "@nestjs/common";
import { CodexRuntimeAdapter } from "./codex-runtime.adapter";
import { DeerFlowRuntimeAdapter } from "./deerflow-runtime.adapter";
import type {
  RuntimeAdapter,
  RuntimeProvider,
  RuntimeResult,
  RuntimeTask,
} from "./external-runtime.types";

@Injectable()
export class ExternalRuntimeService {
  constructor(
    private readonly codex: CodexRuntimeAdapter,
    private readonly deerflow: DeerFlowRuntimeAdapter,
  ) {}

  async runTask<TInput, TOutput>(
    task: Omit<RuntimeTask<TInput>, "provider">,
    provider: Exclude<RuntimeProvider, "local">,
  ): Promise<RuntimeResult<TOutput>> {
    return this.adapter(provider).runTask<TInput, TOutput>({ ...task, provider });
  }

  private adapter(provider: Exclude<RuntimeProvider, "local">): RuntimeAdapter {
    if (provider === "codex") return this.codex;
    return this.deerflow;
  }
}
