const UTF8 = new TextDecoder("utf-8", { fatal: true });
const UTF8_LOSSY = new TextDecoder("utf-8");

export function normalizeMarkdownInput(content: string | Uint8Array): string {
  const decoded = typeof content === "string" ? content : UTF8.decode(content);
  return normalizeMarkdownText(decoded);
}

export function normalizeMarkdownInputLossy(content: Uint8Array): string {
  return normalizeMarkdownText(UTF8_LOSSY.decode(content));
}

function normalizeMarkdownText(decoded: string): string {
  return decoded
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFC");
}
