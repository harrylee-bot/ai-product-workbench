import { Injectable } from "@nestjs/common";
import type { Phase1ProductStateInput, Phase1Prototype } from "../../../state/state.types";

@Injectable()
export class PrototypeAgent {
  run(input: { state: Phase1ProductStateInput }): Phase1Prototype {
    const title = escapeHtml(input.state.title);
    return {
      html: `<!doctype html><html><body><main style="font-family: system-ui; padding: 32px;"><h1>${title}</h1><p>mock prototype</p><button>Primary Action</button></main></body></html>`,
    };
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
