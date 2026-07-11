import { BadGatewayException, BadRequestException, Injectable } from "@nestjs/common";

type DeerflowSkill = {
  name: string;
  description: string;
  license?: string | null;
  category: "public" | "custom" | string;
  enabled: boolean;
};

@Injectable()
export class AdminDeerflowService {
  async listSkills() {
    if (!isDeerFlowEnabled()) return { skills: [] };

    return this.request<{ skills: DeerflowSkill[] }>("/api/skills");
  }

  async updateSkill(skillName: string, enabled: boolean) {
    if (!isDeerFlowEnabled()) {
      throw new BadRequestException("DeerFlow 未启用，无法更新 Skill。");
    }

    return this.request<DeerflowSkill>(
      `/api/skills/${encodeURIComponent(cleanPathSegment(skillName))}`,
      {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      },
    );
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = joinUrl(process.env.DEERFLOW_GATEWAY_URL ?? "http://localhost:8001", path);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...deerFlowAuthHeaders(),
          ...(init?.headers ?? {}),
        },
      });
    } catch (error) {
      throw new BadGatewayException(`DeerFlow Gateway 不可用: ${errorMessage(error)}`);
    }

    if (!response.ok) {
      throw new BadGatewayException(
        `DeerFlow Gateway 请求失败 (${response.status}): ${await safeResponseText(response)}`,
      );
    }

    return response.json() as Promise<T>;
  }
}

function deerFlowAuthHeaders(): Record<string, string> {
  const token = process.env.DEERFLOW_INTERNAL_AUTH_TOKEN?.trim()
    || process.env.DEER_FLOW_INTERNAL_AUTH_TOKEN?.trim();
  return token ? { "X-DeerFlow-Internal-Token": token } : {};
}

function isDeerFlowEnabled() {
  return process.env.DEERFLOW_ENABLED === "true";
}

function cleanPathSegment(value: string) {
  return value.replace(/[\r\n/]/g, "").trim();
}

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function safeResponseText(response: Response) {
  return (await response.text().catch(() => "")).trim().slice(0, 800);
}
