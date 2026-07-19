import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it } from "vitest";

import {
  configureWorkbenchRequestBody,
  defaultMaximumJsonRequestBytes,
  workbenchApiMaximumRequestBytes,
} from "../src/common/request-body.js";

class PayloadModule {}
Module({})(PayloadModule);

describe("Workbench API request body boundary", () => {
  const applications: NestExpressApplication[] = [];

  afterEach(async () => {
    await Promise.all(applications.splice(0).map((app) => app.close()));
  });

  it("accepts Board-sized JSON beyond the Express 100 KiB default and rejects above 2 MiB", async () => {
    const app = await NestFactory.create<NestExpressApplication>(PayloadModule, { logger: false });
    applications.push(app);
    configureWorkbenchRequestBody(app);
    app.use("/payload", (request: Request, response: Response) => {
      const body = request.body as { value?: string };
      response.json({ length: body.value?.length ?? 0 });
    });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
    const endpoint = `http://127.0.0.1:${address.port}/payload`;

    const acceptedValue = "x".repeat(256 * 1024);
    const accepted = await fetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: acceptedValue }),
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({ length: acceptedValue.length });

    const rejected = await fetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(defaultMaximumJsonRequestBytes) }),
    });
    expect(rejected.status).toBe(413);
  });

  it("validates the deployment override as a positive safe integer", () => {
    expect(workbenchApiMaximumRequestBytes(undefined)).toBe(defaultMaximumJsonRequestBytes);
    expect(workbenchApiMaximumRequestBytes(" 1048576 ")).toBe(1_048_576);
    expect(() => workbenchApiMaximumRequestBytes("0")).toThrow(/positive integer/);
    expect(() => workbenchApiMaximumRequestBytes("2mb")).toThrow(/positive integer/);
    expect(() => workbenchApiMaximumRequestBytes("9007199254740992")).toThrow(/safe integer/);
  });
});
