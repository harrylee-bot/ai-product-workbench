import type { Request, Response } from "express";

const responseAbortSignals = new WeakMap<Response, AbortSignal>();

export function bindHttpRequestAbortSignal(request: Request, response: Response) {
  const controller = new AbortController();
  const socket = response.socket ?? request.socket;
  let settled = false;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    request.off("aborted", abort);
    response.off("finish", finish);
    response.off("close", close);
    response.off("error", abort);
    socket.off("close", close);
    socket.off("error", abort);
    responseAbortSignals.delete(response);
  };
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("HTTP client disconnected", "AbortError"));
    }
    cleanup();
  };
  const finish = () => cleanup();
  const close = () => {
    if (response.writableFinished) cleanup();
    else abort();
  };

  responseAbortSignals.set(response, controller.signal);
  request.once("aborted", abort);
  response.once("finish", finish);
  response.once("close", close);
  response.once("error", abort);
  socket.once("close", close);
  socket.once("error", abort);
  if (request.aborted || response.destroyed || socket.destroyed) abort();
}

export function httpResponseAbortSignalArgument(response: Response): [] | [AbortSignal] {
  const signal = responseAbortSignals.get(response);
  return signal ? [signal] : [];
}
