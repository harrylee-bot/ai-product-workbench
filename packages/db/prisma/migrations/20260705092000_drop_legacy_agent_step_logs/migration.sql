-- DeerFlow-first runtime stores step progress as replayable stream events in
-- vibe_stream_event_logs. The legacy agent_step_logs table and its enums are
-- no longer written by the application and only add an empty admin dimension.
DROP TABLE IF EXISTS "agent_step_logs";
DROP TYPE IF EXISTS "AgentStepStatus";
DROP TYPE IF EXISTS "AgentName";
