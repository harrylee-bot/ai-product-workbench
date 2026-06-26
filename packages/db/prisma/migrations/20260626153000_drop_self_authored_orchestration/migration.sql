-- Remove the abandoned self-authored orchestration experiments.
-- Runtime logs remain mapped to the existing agent_run_logs/agent_step_logs tables.

DROP TABLE IF EXISTS "company_runtime_runs" CASCADE;
DROP TABLE IF EXISTS "company_evolution_plans" CASCADE;
DROP TABLE IF EXISTS "growth_plans" CASCADE;
DROP TABLE IF EXISTS "company_qa_reports" CASCADE;
DROP TABLE IF EXISTS "design_plans" CASCADE;
DROP TABLE IF EXISTS "engineering_plans" CASCADE;
DROP TABLE IF EXISTS "product_initiatives" CASCADE;
DROP TABLE IF EXISTS "agents" CASCADE;
DROP TABLE IF EXISTS "departments" CASCADE;
DROP TABLE IF EXISTS "companies" CASCADE;

DROP TABLE IF EXISTS "system_mutation_logs" CASCADE;
DROP TABLE IF EXISTS "system_change_proposals" CASCADE;
DROP TABLE IF EXISTS "system_edges" CASCADE;
DROP TABLE IF EXISTS "system_nodes" CASCADE;
DROP TABLE IF EXISTS "system_graphs" CASCADE;
DROP TABLE IF EXISTS "system_policies" CASCADE;

DROP TABLE IF EXISTS "evolution_signals" CASCADE;
DROP TABLE IF EXISTS "strategies" CASCADE;
DROP TABLE IF EXISTS "decision_traces" CASCADE;
DROP TABLE IF EXISTS "orchestration_runs" CASCADE;
DROP TABLE IF EXISTS "product_memories" CASCADE;
DROP TABLE IF EXISTS "evolution_patch_executions" CASCADE;
DROP TABLE IF EXISTS "evolution_plans" CASCADE;
DROP TABLE IF EXISTS "product_review_reports" CASCADE;
DROP TABLE IF EXISTS "product_insights" CASCADE;
DROP TABLE IF EXISTS "product_interaction_events" CASCADE;
