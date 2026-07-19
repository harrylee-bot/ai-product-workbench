import "reflect-metadata";
import {
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { workbenchHttpRoutes } from "@workbench/workbench-contracts";
import { describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";

type Constructor = abstract new (...args: never[]) => unknown;

describe("OpenAPI route registry coverage", () => {
  it("matches every Nest HTTP method and path in both directions", () => {
    const actual = collectNestRoutes(AppModule);
    const declared = workbenchHttpRoutes.map((route) => `${route.method} ${route.path}`).sort();

    expect(actual).toHaveLength(workbenchHttpRoutes.length);
    expect(new Set(actual).size).toBe(actual.length);
    expect(new Set(workbenchHttpRoutes.map((route) => route.operationId)).size)
      .toBe(workbenchHttpRoutes.length);
    expect(actual).toEqual(declared);
  });

  it("does not expose direct Run creation outside SubmissionIntent submission", () => {
    const actual = collectNestRoutes(AppModule);
    const declared = workbenchHttpRoutes.map((route) => `${route.method} ${route.path}`);

    expect(actual).not.toContain("post /threads/{threadId}/runs");
    expect(declared).not.toContain("post /threads/{threadId}/runs");
    expect(actual).toContain("post /submission-intents/{intentId}/submit");
    expect(declared).toContain("post /submission-intents/{intentId}/submit");
  });
});

function collectNestRoutes(root: Constructor): string[] {
  const modules = new Set<Constructor>();
  const controllers = new Set<Constructor>();

  const visit = (candidate: unknown) => {
    const module = dynamicModuleClass(candidate);
    if (!module || modules.has(module)) return;
    modules.add(module);
    for (const controller of metadataArray(module, MODULE_METADATA.CONTROLLERS)) {
      if (typeof controller === "function") controllers.add(controller as Constructor);
    }
    metadataArray(module, MODULE_METADATA.IMPORTS).forEach(visit);
  };
  visit(root);

  const routes: string[] = [];
  for (const controller of controllers) {
    const controllerPaths = metadataPaths(controller) ?? [""];
    for (const property of Object.getOwnPropertyNames(controller.prototype)) {
      if (property === "constructor") continue;
      const handler = (controller.prototype as Record<string, unknown>)[property];
      if (typeof handler !== "function") continue;
      const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      const method = requestMethodName(requestMethod);
      if (!method) continue;
      const handlerPaths = metadataPaths(handler) ?? [""];
      for (const controllerPath of controllerPaths) {
        for (const handlerPath of handlerPaths) {
          routes.push(`${method} ${openApiPath(controllerPath, handlerPath)}`);
        }
      }
    }
  }
  return routes.sort();
}

function dynamicModuleClass(candidate: unknown): Constructor | null {
  if (typeof candidate === "function") return candidate as Constructor;
  if (!candidate || typeof candidate !== "object") return null;
  const module = (candidate as { module?: unknown }).module;
  return typeof module === "function" ? module as Constructor : null;
}

function metadataArray(module: Constructor, key: string): unknown[] {
  const value = Reflect.getMetadata(key, module) as unknown;
  return Array.isArray(value) ? value : [];
}

function metadataPaths(target: object): string[] | null {
  const value = Reflect.getMetadata(PATH_METADATA, target) as unknown;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((path) => typeof path === "string")) return value;
  return null;
}

function requestMethodName(method: RequestMethod | undefined) {
  if (method === RequestMethod.GET) return "get";
  if (method === RequestMethod.POST) return "post";
  if (method === RequestMethod.PUT) return "put";
  if (method === RequestMethod.PATCH) return "patch";
  if (method === RequestMethod.DELETE) return "delete";
  return null;
}

function openApiPath(...parts: string[]) {
  const path = `/${parts.map((part) => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")}`;
  return path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}");
}
