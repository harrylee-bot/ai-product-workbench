import { Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";
import { validationProblem } from "./problem-details.js";

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    const errors: Record<string, string[]> = {};
    for (const issue of result.error.issues) {
      const key = issue.path.join(".") || "request";
      errors[key] = [...(errors[key] ?? []), issue.message];
    }
    throw validationProblem("The request body does not match the contract", errors);
  }
}
