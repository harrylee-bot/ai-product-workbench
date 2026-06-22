import { Controller, Get, UseGuards } from "@nestjs/common";
import { AgentSkillRegistryService } from "../../ai/agent-skill-registry.service";
import { CurrentUser } from "../auth/current-user.decorator";
import type { Phase1User } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

@Controller("ai/vibe")
@UseGuards(JwtAuthGuard)
export class VibeSkillsController {
  constructor(private readonly skillRegistry: AgentSkillRegistryService) {}

  @Get("skills")
  async listSkills(@CurrentUser() user: Phase1User) {
    const skills = await this.skillRegistry.listSkills();
    return {
      items: skills,
      count: skills.length,
      source: "kepano/obsidian-skills",
      userId: user.id,
    };
  }
}
