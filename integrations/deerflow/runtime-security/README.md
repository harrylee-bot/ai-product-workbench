# DeerFlow runtime source and security policy

Workbench 1.0.0 builds from the stable DeerFlow 2.1.0 release, commit
`345f08be00c8a9495079b732a39b46aa9af1584e`. `upstream-2.1.0/` contains the
source-only archive, its complete SHA-256 inventory, upstream license, exact
security dependency constraints and the secured `uv.lock`. No virtualenv,
environment file or live business history is included.

Verify the source before building its source image:

```sh
python3 integrations/deerflow/runtime-security/verify_source.py
python3 -B -m unittest discover -s integrations/deerflow/runtime-security -p 'test*source.py'
docker buildx build \
  --file integrations/deerflow/runtime-security/source.Dockerfile \
  --tag workbench-deerflow-source:2.1.0 \
  integrations/deerflow/runtime-security
```

Use Python 3.12 for source preparation and tests. The source image is an
immutable input for `integrations/deerflow/Dockerfile`; release configuration
must bind its actual OCI digest as `WORKBENCH_DEERFLOW_BASE_IMAGE_REF`. It is
not an executable runtime. Runtime publication, signing, private configuration
updates and production cutover follow the existing release procedure.

`prepare_release.py` verifies every upstream file before copying an explicit
source allowlist. It injects the security constraints and verified lock. The
runtime build then applies the matching source patch and verifies every
resulting file hash. Its contracts run against the installed LangChain and
LangGraph dependencies.

The 2.1.0 patch retains Workbench's authenticated context and secret isolation,
lead/subagent tool scopes, bounded recursion budgets, exact Run metadata
history filtering, offset run pagination and checkpoint rollback on terminal
model fallback. It uses the new materialized full/delta history and rollback
accessors. Upstream 2.1.0 already contains the local/store duplicate pagination
fix; the new patch does not replace that implementation.

The earlier `source.tar.gz`, `source-snapshot.json`, `dependencies.json`,
`uv.lock`, `prepare_source.py` and `base-recovery/` remain unchanged rollback
inputs for commit `7a6c4a994a86583d2a3c056ee9d0f157d4f030c2`. They are not the
active build input. `verify_source.py` also accepts those explicitly supplied
legacy archives. Local execution results belong only in
`docs/audit/1.0.0.md` and `output/audit/1.0.0/`.
