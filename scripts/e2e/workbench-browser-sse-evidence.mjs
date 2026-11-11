export function installBrowserSseEvidenceObserver({ webOrigin }) {
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== "function") return;
  globalThis.fetch = async function workbenchEvidenceFetch(...args) {
    const response = await nativeFetch.apply(this, args);
    try {
      const url = new URL(response.url);
      if (
        url.origin === webOrigin
        && /^\/api\/v1\/runs\/[^/]+\/events$/u.test(url.pathname)
        && response.headers.get("content-type")?.startsWith("text/event-stream")
      ) {
        const afterSequence = Number(url.searchParams.get("afterSequence") ?? "0");
        observeApplicationSseReads(response.body, afterSequence);
      }
    } catch {
      // The application owns fetch errors; evidence collection must stay observational.
    }
    return response;
  };

  function observeApplicationSseReads(body, afterSequence) {
    if (!body) return;
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "message";
    let eventId = null;
    let sawData = false;

    const record = () => {
      const sequence = Number(eventId);
      const shouldRecord = sawData;
      const recordedEventName = eventName;
      eventName = "message";
      eventId = null;
      sawData = false;
      if (!shouldRecord) return;
      const binding = globalThis.__workbenchRecordSseEvidence;
      if (typeof binding === "function") {
        void Promise.resolve(binding({
          afterSequence,
          eventName: recordedEventName,
          sequence,
        })).catch(() => undefined);
      }
    };
    const consumeLine = (rawLine) => {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "") {
        record();
        return;
      }
      if (line.startsWith(":")) return;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      const rawValue = separator < 0 ? "" : line.slice(separator + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") eventName = value;
      else if (field === "id") eventId = value;
      else if (field === "data") sawData = true;
    };

    let observing = true;
    const consumeChunk = ({ done, value }) => {
      if (!observing) return;
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      if (buffer.length > 1_048_576) {
        observing = false;
        buffer = "";
        const binding = globalThis.__workbenchRecordSseEvidence;
        if (typeof binding === "function") {
          void Promise.resolve(binding(null)).catch(() => undefined);
        }
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (done) {
        if (buffer) consumeLine(buffer);
        record();
        observing = false;
      }
    };

    // Tap the exact bytes consumed by the application before its event handler
    // can abort a terminal subscription. A Response.clone reader races with
    // that cleanup and can lose the final event despite the app receiving it.
    // Keep the original response, reader, chunks, backpressure, and errors.
    const nativeGetReader = body.getReader;
    body.getReader = function evidenceGetReader(...args) {
      const reader = nativeGetReader.apply(this, args);
      const nativeRead = reader.read;
      reader.read = async function evidenceRead(...readArgs) {
        const chunk = await nativeRead.apply(this, readArgs);
        try {
          consumeChunk(chunk);
        } catch {
          observing = false;
        }
        return chunk;
      };
      return reader;
    };
  }
}
