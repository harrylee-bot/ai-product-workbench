"use client";

import { getApiBase } from "@/lib/api/config";

export async function downloadApiFile(path: string, fallbackFileName: string) {
  const response = await fetch(`${getApiBase()}${path}`, {
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(await readApiError(response));
  }

  const blob = await response.blob();
  const fileName =
    fileNameFromDisposition(response.headers.get("content-disposition")) ||
    fallbackFileName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function readApiError(response: Response) {
  try {
    const body = await response.json();
    return body.message ?? body.error ?? `请求失败 (${response.status})`;
  } catch {
    return `请求失败 (${response.status})`;
  }
}

function fileNameFromDisposition(disposition: string | null) {
  if (!disposition) return undefined;
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const asciiMatch = disposition.match(/filename="([^"]+)"/i);
  return asciiMatch?.[1];
}
