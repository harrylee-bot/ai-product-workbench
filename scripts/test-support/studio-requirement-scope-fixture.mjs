// Local test-only corpus. The intentionally incompatible regional rules have no
// authority outside this fixture. The normal seed path builds real index rows.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startLiveKnowledgeFixture } from "./studio-live-knowledge.mjs";

export const scopeFixtureId = "synthetic-conflict-scope-fixture";
export async function seedRequirementScopes(databaseUrl, serviceRoot) {
  const documents = [
    ["产品能力地图/活动管理.md", "营销活动平台能力地图", "营销活动平台有活动列表和运营用户；现有活动模块管理渠道、试点和优惠券，可复用活动详情与权限。省级发券政策需要各自批准，全国范围不统一设置限额。"],
    ["区域案例/青岚试点周一发券规则.md", "青岚试点周一发券规则（试点 V1）", "青岚省春风活动当前生效的试点文件 V1 规定：每周一每名用户仅限领取一张优惠券。本条仅适用青岚省春风活动试点，不可推广全国。"],
    ["区域案例/青岚试点周一补充规则.md", "青岚试点周一补充规则（试点 V2）", "青岚省春风活动当前生效的试点补充文件 V2 规定：每周一每名用户可以领取三张优惠券。仅适用青岚省春风活动。本文件没有指明替代或废止 V1，两个文件之间尚待业务负责人裁决。"],
  ];
  const directory = await mkdtemp(path.join(tmpdir(), "requirement-scopes-"));
  const publishedPath = path.join(directory, "synthetic.json");
  try {
    await writeFile(publishedPath, JSON.stringify({ release: { id: scopeFixtureId, version: 1 },
      chunks: documents.map(([source_path, title, content]) => ({ source_path, title, content, document_id: randomUUID(), chunk_id: randomUUID() })) }));
    const fixture = await startLiveKnowledgeFixture({ serviceRoot, publishedPath });
    await fixture.seed(databaseUrl);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
