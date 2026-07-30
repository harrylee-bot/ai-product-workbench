import "reflect-metadata";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  MODULE_METADATA,
  PARAMTYPES_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";

type Constructor = abstract new (...args: never[]) => unknown;

type DynamicModuleLike = {
  module?: unknown;
  imports?: unknown[];
  providers?: unknown[];
  controllers?: unknown[];
};

type ExplicitDependency = {
  index: number;
  param: unknown;
};

type RegisteredClass = {
  target: Constructor;
  registeredAs: "controller" | "provider" | "useClass";
  moduleName: string;
};

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const compileTimeoutMs = 100_000;
const testTimeoutMs = 120_000;

describe("compiled Nest dependency injection metadata", () => {
  it("keeps every registered constructor dependency available at runtime", async () => {
    const outputDirectory = await mkdtemp(join(apiRoot, ".nest-di-metadata-"));

    try {
      await execFileAsync(process.execPath, [
        require.resolve("typescript/bin/tsc"),
        "--project",
        join(apiRoot, "tsconfig.build.json"),
        "--outDir",
        outputDirectory,
      ], { cwd: apiRoot, timeout: compileTimeoutMs });

      const compiledAppModule = await import(
        pathToFileURL(join(outputDirectory, "app.module.js")).href
      ) as { AppModule?: unknown };
      expect(compiledAppModule.AppModule, "The compiled app.module.js must export AppModule")
        .toBeTypeOf("function");

      const registrations = await collectRegisteredClasses(compiledAppModule.AppModule);
      const failures = registrations.flatMap(validateConstructorMetadata);

      expect(
        failures,
        `Invalid compiled Nest DI metadata:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
      ).toEqual([]);

      const artifactsService = registeredClass(registrations, "ArtifactsService");
      const workbenchDbService = registeredClass(registrations, "WorkbenchDbService");
      const artifactTypes = reflectedParameterTypes(artifactsService.target);
      const artifactOverrides = explicitDependencies(artifactsService.target);

      expect(
        artifactTypes[0],
        "ArtifactsService constructor dependency at index 0 must be WorkbenchDbService",
      ).toBe(workbenchDbService.target);
      expect(
        artifactOverrides.get(1),
        "ArtifactsService constructor dependency at index 1 must use @Inject(READY_BLOB_STORAGE_PORT)",
      ).toBeTypeOf("symbol");
      expect(
        String(artifactOverrides.get(1)),
        "ArtifactsService constructor dependency at index 1 must use READY_BLOB_STORAGE_PORT",
      ).toBe("Symbol(READY_BLOB_STORAGE_PORT)");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }, testTimeoutMs);
});

async function collectRegisteredClasses(root: unknown): Promise<RegisteredClass[]> {
  const visitedStaticModules = new Set<Constructor>();
  const visitedDynamicModules = new Set<object>();
  const registrations = new Map<Constructor, RegisteredClass>();

  const register = (
    candidate: unknown,
    moduleName: string,
    registeredAs: RegisteredClass["registeredAs"],
  ) => {
    if (typeof candidate !== "function") return;
    const target = candidate as Constructor;
    registrations.set(target, { target, moduleName, registeredAs });
  };

  const registerProvider = (provider: unknown, moduleName: string) => {
    if (typeof provider === "function") {
      register(provider, moduleName, "provider");
      return;
    }
    if (!provider || typeof provider !== "object") return;

    const definition = provider as {
      useClass?: unknown;
      useFactory?: unknown;
      useValue?: unknown;
      useExisting?: unknown;
    };
    if ("useFactory" in definition || "useValue" in definition || "useExisting" in definition) {
      return;
    }
    register(definition.useClass, moduleName, "useClass");
  };

  const visit = async (candidate: unknown): Promise<void> => {
    const resolved = await Promise.resolve(candidate);
    const forwarded = forwardReferenceTarget(resolved);
    if (forwarded !== resolved) {
      await visit(forwarded);
      return;
    }

    const dynamicModule = dynamicModuleDefinition(resolved);
    if (dynamicModule) {
      if (visitedDynamicModules.has(dynamicModule)) return;
      visitedDynamicModules.add(dynamicModule);
    }

    const moduleClass = dynamicModuleClass(resolved);
    if (!moduleClass) return;
    const includeStaticMetadata = !visitedStaticModules.has(moduleClass);
    visitedStaticModules.add(moduleClass);

    const staticImports = includeStaticMetadata
      ? metadataArray(moduleClass, MODULE_METADATA.IMPORTS)
      : [];
    const dynamicImports = arrayValue(dynamicModule?.imports);
    for (const imported of [...staticImports, ...dynamicImports]) await visit(imported);

    const moduleName = moduleClass.name || "<anonymous module>";
    const staticProviders = includeStaticMetadata
      ? metadataArray(moduleClass, MODULE_METADATA.PROVIDERS)
      : [];
    const staticControllers = includeStaticMetadata
      ? metadataArray(moduleClass, MODULE_METADATA.CONTROLLERS)
      : [];
    for (const provider of [...staticProviders, ...arrayValue(dynamicModule?.providers)]) {
      registerProvider(provider, moduleName);
    }
    for (const controller of [...staticControllers, ...arrayValue(dynamicModule?.controllers)]) {
      register(controller, moduleName, "controller");
    }
  };

  await visit(root);
  return [...registrations.values()];
}

function validateConstructorMetadata(registration: RegisteredClass): string[] {
  const parameterTypes = reflectedParameterTypes(registration.target);
  const overrides = explicitDependencies(registration.target);
  const parameterCount = Math.max(
    registration.target.length,
    parameterTypes.length,
    ...[...overrides.keys()].map((index) => index + 1),
  );
  const failures: string[] = [];

  for (let index = 0; index < parameterCount; index += 1) {
    if (overrides.has(index)) continue;
    const reflectedType = parameterTypes[index];
    if (reflectedType !== undefined && reflectedType !== Object && reflectedType !== Function) continue;

    failures.push(
      `${registration.target.name || "<anonymous class>"} constructor dependency at index ${index} `
      + `(${registration.registeredAs} in ${registration.moduleName}) is ${runtimeTypeName(reflectedType)} `
      + `without an @Inject token override`,
    );
  }
  return failures;
}

function reflectedParameterTypes(target: Constructor): unknown[] {
  const value = Reflect.getMetadata(PARAMTYPES_METADATA, target) as unknown;
  return Array.isArray(value) ? value : [];
}

function explicitDependencies(target: Constructor): Map<number, unknown> {
  const value = Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, target) as unknown;
  if (!Array.isArray(value)) return new Map();

  return new Map(
    value
      .filter((dependency): dependency is ExplicitDependency => isExplicitDependency(dependency))
      .map((dependency) => [dependency.index, dependency.param]),
  );
}

function isExplicitDependency(value: unknown): value is ExplicitDependency {
  if (!value || typeof value !== "object") return false;
  const index = (value as { index?: unknown }).index;
  return typeof index === "number" && Number.isSafeInteger(index) && index >= 0;
}

function registeredClass(registrations: RegisteredClass[], name: string): RegisteredClass {
  const matches = registrations.filter((registration) => registration.target.name === name);
  expect(matches, `Expected exactly one registered Nest class named ${name}`).toHaveLength(1);
  return matches[0]!;
}

function dynamicModuleClass(candidate: unknown): Constructor | null {
  if (typeof candidate === "function") return candidate as Constructor;
  const dynamicModule = dynamicModuleDefinition(candidate);
  return typeof dynamicModule?.module === "function" ? dynamicModule.module as Constructor : null;
}

function dynamicModuleDefinition(candidate: unknown): DynamicModuleLike | null {
  if (!candidate || typeof candidate !== "object") return null;
  const dynamicModule = candidate as DynamicModuleLike;
  return typeof dynamicModule.module === "function" ? dynamicModule : null;
}

function forwardReferenceTarget(candidate: unknown): unknown {
  if (!candidate || typeof candidate !== "object" || !("forwardRef" in candidate)) return candidate;
  const forwardRef = (candidate as { forwardRef?: unknown }).forwardRef;
  return typeof forwardRef === "function" ? forwardRef() : candidate;
}

function metadataArray(module: Constructor, key: string): unknown[] {
  return arrayValue(Reflect.getMetadata(key, module) as unknown);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function runtimeTypeName(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === Object) return "Object";
  if (value === Function) return "Function";
  return String(value);
}
