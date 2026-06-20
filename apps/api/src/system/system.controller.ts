import { Controller, Get } from "@nestjs/common";

@Controller("system")
export class SystemController {
  @Get("health")
  health() {
    return {
      ok: true,
      service: "ai-product-workbench-api",
      modules: ["auth", "admin-users", "projects", "files", "ai-vibe"],
    };
  }
}
