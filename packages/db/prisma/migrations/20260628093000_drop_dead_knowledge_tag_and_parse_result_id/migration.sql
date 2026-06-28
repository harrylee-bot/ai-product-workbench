-- data-core-4：drop 孤儿表 knowledge_tags（无关系、无写入路径、无业务读取）。
DROP TABLE IF EXISTS "knowledge_tags";

-- data-core-5：drop 死列 file_assets.parse_result_id（关系实际由 FileParseResult.fileAssetId 反向承载，此列无 FK 无写入）。
ALTER TABLE "file_assets" DROP COLUMN IF EXISTS "parse_result_id";
