import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";

import {
  bindHttpRequestAbortSignal,
  httpResponseAbortSignalArgument,
} from "../src/common/http-request-abort.js";

describe("HTTP request abort signal", () => {
  it("aborts an in-flight object read when the outbound connection closes", () => {
    const connection = connectionDouble();
    bindHttpRequestAbortSignal(connection.request, connection.response);
    const [signal] = httpResponseAbortSignalArgument(connection.response);

    expect(signal?.aborted).toBe(false);
    connection.response.emit("close");

    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ name: "AbortError" });
    expect(httpResponseAbortSignalArgument(connection.response)).toEqual([]);
  });

  it("cleans up without aborting after the response finishes normally", () => {
    const connection = connectionDouble();
    bindHttpRequestAbortSignal(connection.request, connection.response);
    const [signal] = httpResponseAbortSignalArgument(connection.response);
    connection.response.writableFinished = true;
    connection.response.emit("finish");
    connection.response.emit("close");

    expect(signal?.aborted).toBe(false);
    expect(httpResponseAbortSignalArgument(connection.response)).toEqual([]);
  });
});

function connectionDouble() {
  const socket = Object.assign(new EventEmitter(), { destroyed: false });
  const request = Object.assign(new EventEmitter(), {
    aborted: false,
    socket,
  });
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    socket,
    writableFinished: false,
  });
  return {
    request: request as unknown as Request,
    response: response as unknown as Response & { writableFinished: boolean },
  };
}
