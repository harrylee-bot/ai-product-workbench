-- The current application no longer writes legacy project/product-design
-- columns. Some databases already removed those columns before this migration
-- was recorded, so only relax columns that are physically present.

DO $$
DECLARE
  legacy_columns text[][] := ARRAY[
    ARRAY['conversations', 'project_id'],
    ARRAY['messages', 'project_id'],
    ARRAY['file_assets', 'project_id'],
    ARRAY['file_chunks', 'project_id'],
    ARRAY['file_parse_results', 'project_id'],
    ARRAY['knowledge_candidates', 'project_id'],
    ARRAY['prototype_conversion_jobs', 'project_id'],
    ARRAY['agent_run_logs', 'project_id'],
    ARRAY['vibe_stream_event_logs', 'project_id'],
    ARRAY['comments', 'project_id'],
    ARRAY['constraint_rules', 'project_id'],
    ARRAY['requirement_documents', 'project_id'],
    ARRAY['requirement_documents', 'product_design_state_id'],
    ARRAY['requirement_documents', 'product_design_state_version'],
    ARRAY['requirement_document_versions', 'project_id'],
    ARRAY['prototype_spec_records', 'project_id'],
    ARRAY['prototype_spec_records', 'product_design_state_id'],
    ARRAY['prototype_spec_records', 'product_design_state_version'],
    ARRAY['prototype_artifacts', 'project_id'],
    ARRAY['prototype_artifacts', 'product_design_state_id'],
    ARRAY['prototype_artifacts', 'product_design_state_version'],
    ARRAY['prototype_versions', 'project_id'],
    ARRAY['qa_reports', 'project_id'],
    ARRAY['qa_reports', 'product_design_state_id'],
    ARRAY['qa_reports', 'product_design_state_version'],
    ARRAY['share_links', 'project_id'],
    ARRAY['rollback_records', 'project_id'],
    ARRAY['rollback_records', 'from_product_design_state_version'],
    ARRAY['rollback_records', 'to_product_design_state_version']
  ];
  item text[];
BEGIN
  FOREACH item SLICE 1 IN ARRAY legacy_columns LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = item[1]
        AND column_name = item[2]
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I DROP NOT NULL', item[1], item[2]);
    END IF;
  END LOOP;
END $$;
