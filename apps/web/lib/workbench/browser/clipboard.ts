export class WorkbenchClipboardError extends Error {
  constructor(message = "Clipboard write failed") {
    super(message);
    this.name = "WorkbenchClipboardError";
  }
}

export async function writeWorkbenchClipboard(
  text: string,
  environment: {
    navigator?: { clipboard?: { writeText: (text: string) => Promise<void> } };
    document?: Document;
  } = {
    navigator: typeof navigator === "undefined" ? undefined : navigator,
    document: typeof document === "undefined" ? undefined : document,
  },
): Promise<void> {
  try {
    if (environment.navigator?.clipboard?.writeText) {
      await environment.navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Browsers may expose Clipboard API while denying it outside a trusted gesture.
  }

  const target = environment.document;
  if (!target?.body || typeof target.execCommand !== "function") {
    throw new WorkbenchClipboardError();
  }
  const textarea = target.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.left = "-9999px";
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  target.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    if (!target.execCommand("copy")) throw new WorkbenchClipboardError();
  } finally {
    textarea.remove();
  }
}
