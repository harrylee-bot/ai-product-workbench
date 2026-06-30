import { BadGatewayException, Injectable } from "@nestjs/common";

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
    return this.request<{ skills: DeerflowSkill[] }>("/api/skills");
  }

  async updateSkill(skillName: string, enabled: boolean) {
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
