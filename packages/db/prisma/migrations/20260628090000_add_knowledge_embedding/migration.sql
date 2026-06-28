-- knowledge-core-3：为知识项增加 embedding 列（存储真实向量嵌入，Json 数组形式，应用层余弦相似度）。
ALTER TABLE "knowledge_items" ADD COLUMN "embedding" JSONB NULL;
