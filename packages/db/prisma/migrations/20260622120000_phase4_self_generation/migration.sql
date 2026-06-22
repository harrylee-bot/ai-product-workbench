CREATE TABLE "system_nodes" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "graph_id" TEXT NOT NULL,
  "node_key" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "config" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "system_nodes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "system_edges" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "graph_id" TEXT NOT NULL,
  "edge_key" TEXT NOT NULL,
  "from_node" TEXT NOT NULL,
  "to_node" TEXT NOT NULL,
  "relation" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "system_edges_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "system_change_proposals" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "source_trace_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'preview',
  "mutations" JSONB NOT NULL,
  "impact_analysis" JSONB NOT NULL,
  "risk_level" TEXT NOT NULL,
  "preview_graph" JSONB NOT NULL,
  "created_by" TEXT NOT NULL,
  "applied_graph_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "applied_at" TIMESTAMP(3),

  CONSTRAINT "system_change_proposals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "system_mutation_logs" (
  "id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "proposal_id" TEXT,
  "graph_id" TEXT,
  "mutation" JSONB NOT NULL,
  "status" TEXT NOT NULL,
  "rollback_data" JSONB,
  "result" JSONB,
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "system_mutation_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "system_nodes_graph_id_node_key_key" ON "system_nodes"("graph_id", "node_key");
CREATE INDEX "system_nodes_project_id_idx" ON "system_nodes"("project_id");
CREATE INDEX "system_nodes_graph_id_idx" ON "system_nodes"("graph_id");
CREATE INDEX "system_nodes_type_idx" ON "system_nodes"("type");
CREATE INDEX "system_nodes_status_idx" ON "system_nodes"("status");

CREATE UNIQUE INDEX "system_edges_graph_id_edge_key_key" ON "system_edges"("graph_id", "edge_key");
CREATE INDEX "system_edges_project_id_idx" ON "system_edges"("project_id");
CREATE INDEX "system_edges_graph_id_idx" ON "system_edges"("graph_id");
CREATE INDEX "system_edges_from_node_idx" ON "system_edges"("from_node");
CREATE INDEX "system_edges_to_node_idx" ON "system_edges"("to_node");

CREATE INDEX "system_change_proposals_project_id_idx" ON "system_change_proposals"("project_id");
CREATE INDEX "system_change_proposals_source_trace_id_idx" ON "system_change_proposals"("source_trace_id");
CREATE INDEX "system_change_proposals_status_idx" ON "system_change_proposals"("status");
CREATE INDEX "system_change_proposals_risk_level_idx" ON "system_change_proposals"("risk_level");
CREATE INDEX "system_change_proposals_created_at_idx" ON "system_change_proposals"("created_at");

CREATE INDEX "system_mutation_logs_project_id_idx" ON "system_mutation_logs"("project_id");
CREATE INDEX "system_mutation_logs_proposal_id_idx" ON "system_mutation_logs"("proposal_id");
CREATE INDEX "system_mutation_logs_graph_id_idx" ON "system_mutation_logs"("graph_id");
CREATE INDEX "system_mutation_logs_status_idx" ON "system_mutation_logs"("status");
CREATE INDEX "system_mutation_logs_created_at_idx" ON "system_mutation_logs"("created_at");

ALTER TABLE "system_nodes"
  ADD CONSTRAINT "system_nodes_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "system_nodes"
  ADD CONSTRAINT "system_nodes_graph_id_fkey"
  FOREIGN KEY ("graph_id") REFERENCES "system_graphs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "system_edges"
  ADD CONSTRAINT "system_edges_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "system_edges"
  ADD CONSTRAINT "system_edges_graph_id_fkey"
  FOREIGN KEY ("graph_id") REFERENCES "system_graphs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "system_change_proposals"
  ADD CONSTRAINT "system_change_proposals_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "system_mutation_logs"
  ADD CONSTRAINT "system_mutation_logs_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "system_mutation_logs"
  ADD CONSTRAINT "system_mutation_logs_proposal_id_fkey"
  FOREIGN KEY ("proposal_id") REFERENCES "system_change_proposals"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "system_mutation_logs"
  ADD CONSTRAINT "system_mutation_logs_graph_id_fkey"
  FOREIGN KEY ("graph_id") REFERENCES "system_graphs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
