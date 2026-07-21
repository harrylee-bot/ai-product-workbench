#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

deploy_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app_dir=$(CDPATH= cd -- "$deploy_dir/.." && pwd)
web_container=${WORKBENCH_UPLOAD_SMOKE_WEB_CONTAINER:-workbench-workbench-web-1}
postgres_container=${WORKBENCH_UPLOAD_SMOKE_POSTGRES_CONTAINER:-workbench-postgres-1}
internal_network=${WORKBENCH_UPLOAD_SMOKE_INTERNAL_NETWORK:-workbench_workbench-internal}
bootstrap_network=${WORKBENCH_UPLOAD_SMOKE_BOOTSTRAP_NETWORK:-workbench_workbench-ingress}
bootstrap_port=${WORKBENCH_UPLOAD_SMOKE_BOOTSTRAP_PORT:-3300}
base_url=${WORKBENCH_UPLOAD_SMOKE_BASE_URL:?WORKBENCH_UPLOAD_SMOKE_BASE_URL is required}
upload_origin=${WORKBENCH_UPLOAD_SMOKE_EXPECTED_UPLOAD_ORIGIN:?WORKBENCH_UPLOAD_SMOKE_EXPECTED_UPLOAD_ORIGIN is required}
smoke_script=${WORKBENCH_UPLOAD_SMOKE_SCRIPT:-$app_dir/scripts/workbench-public-upload-smoke.mjs}
evidence_root=${WORKBENCH_UPLOAD_SMOKE_EVIDENCE_ROOT:-/root}
forbidden_storage_targets=${WORKBENCH_UPLOAD_SMOKE_FORBIDDEN_STORAGE_TARGETS:-}

base_host=$(node -e '
  const url = new URL(process.argv[1]);
  if (url.protocol !== "https:" || url.origin !== process.argv[1]) process.exit(1);
  process.stdout.write(url.host);
' "$base_url") || { printf 'invalid WORKBENCH_UPLOAD_SMOKE_BASE_URL\n' >&2; exit 64; }
web_image=${WORKBENCH_UPLOAD_SMOKE_WEB_IMAGE:-$(docker inspect "$web_container" --format '{{.Config.Image}}')}
[ -n "$web_image" ] || { printf 'unable to derive deployed Web image\n' >&2; exit 69; }

stamp=$(date -u +%Y%m%dT%H%M%SZ)
email_stamp=$(printf '%s' "$stamp" | tr '[:upper:]' '[:lower:]')
container="workbench-auth-bootstrap-${stamp}"
runtime_env=$(mktemp /root/workbench-auth-bootstrap.XXXXXX)
register_body=$(mktemp /root/workbench-auth-register.XXXXXX)
evidence="${evidence_root}/workbench-oss-http-upload-${stamp}.json"
email="oss-smoke-${email_stamp}@example.test"
username=$(printf 'oss_smoke_%s' "$stamp" | tr '[:upper:]' '[:lower:]' | cut -c1-30)
password="Wb!$(openssl rand -hex 18)Aa1"
identity_removed=0

remove_identity() {
  if [ "$identity_removed" -eq 0 ]; then
    if ! docker exec -i -e WB_SMOKE_EMAIL="$email" "$postgres_container" sh -lc \
      "psql -v ON_ERROR_STOP=1 -v smoke_email=\"\$WB_SMOKE_EMAIL\" -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"" \
      >/dev/null <<'SQL'
BEGIN;
CREATE TEMP TABLE wb_smoke_auth_users ON COMMIT DROP AS
  SELECT id FROM workbench.auth_users WHERE email = :'smoke_email';
CREATE TEMP TABLE wb_smoke_principals ON COMMIT DROP AS
  SELECT id FROM workbench.principals WHERE email = :'smoke_email';
CREATE TEMP TABLE wb_smoke_workspaces ON COMMIT DROP AS
  SELECT id FROM workbench.workspaces WHERE created_by_id IN (SELECT id FROM wb_smoke_principals);
DELETE FROM workbench.workspaces WHERE id IN (SELECT id FROM wb_smoke_workspaces);
DELETE FROM workbench.principals WHERE id IN (SELECT id FROM wb_smoke_principals);
DELETE FROM workbench.auth_users WHERE email = :'smoke_email';
DO $cleanup$
BEGIN
  IF EXISTS (SELECT 1 FROM workbench.workspaces WHERE id IN (SELECT id FROM wb_smoke_workspaces))
     OR EXISTS (SELECT 1 FROM workbench.principals WHERE id IN (SELECT id FROM wb_smoke_principals))
     OR EXISTS (SELECT 1 FROM workbench.auth_users WHERE id IN (SELECT id FROM wb_smoke_auth_users)) THEN
    RAISE EXCEPTION 'temporary smoke identity cleanup incomplete';
  END IF;
END
$cleanup$;
COMMIT;
SQL
    then
      printf 'temporary smoke identity cleanup failed\n' >&2
      return 1
    fi
    identity_removed=1
  fi
}

cleanup() {
  exit_status=$?
  trap - EXIT
  set +e
  docker rm -f "$container" >/dev/null 2>&1 || true
  remove_identity
  account_status=$?
  rm -f "$runtime_env" "$register_body"
  if [ "$exit_status" -ne 0 ]; then
    exit "$exit_status"
  fi
  exit "$account_status"
}
trap cleanup EXIT

docker inspect "$web_container" --format '{{range .Config.Env}}{{println .}}{{end}}' > "$runtime_env"
chmod 600 "$runtime_env"
docker run -d --rm \
  --name "$container" \
  --network "$bootstrap_network" \
  --env-file "$runtime_env" \
  -e WORKBENCH_PUBLIC_REGISTRATION_ENABLED=true \
  -p "127.0.0.1:${bootstrap_port}:3000" \
  --read-only \
  --tmpfs /tmp \
  "$web_image" >/dev/null
docker network connect "$internal_network" "$container"

for attempt in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${bootstrap_port}/api/healthz" >/dev/null; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    docker logs "$container" >&2
    exit 1
  fi
  sleep 1
done

register_status=$(curl -sS \
  -o "$register_body" \
  -w '%{http_code}' \
  -X POST "http://127.0.0.1:${bootstrap_port}/api/auth/sign-up/email" \
  -H "Host: ${base_host}" \
  -H 'X-Forwarded-Proto: https' \
  -H "Origin: ${base_url}" \
  -H 'X-Workbench-Client-IP: 127.0.0.1' \
  -H 'Content-Type: application/json' \
  --data "$(jq -nc \
    --arg email "$email" \
    --arg password "$password" \
    --arg username "$username" \
    '{email:$email,name:"OSS Upload Smoke",password:$password,username:$username,displayUsername:"OSS Upload Smoke"}')")
if [ "$register_status" != 200 ]; then
  printf 'temporary registration returned HTTP %s: ' "$register_status" >&2
  jq -c 'del(.token,.session)' "$register_body" >&2 || true
  exit 1
fi

WORKBENCH_UPLOAD_SMOKE_BASE_URL="$base_url" \
WORKBENCH_UPLOAD_SMOKE_EXPECTED_UPLOAD_ORIGIN="$upload_origin" \
WORKBENCH_UPLOAD_SMOKE_EMAIL="$email" \
WORKBENCH_UPLOAD_SMOKE_PASSWORD="$password" \
WORKBENCH_UPLOAD_SMOKE_FORBIDDEN_STORAGE_TARGETS="$forbidden_storage_targets" \
node "$smoke_script" > "$evidence"
node -e '
  const evidence = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (evidence.result !== "PASS") process.exit(1);
  if (!Array.isArray(evidence.checks) || evidence.checks.length === 0
    || evidence.checks.some((check) => check.status !== "PASS")) process.exit(1);
  process.stdout.write(`checks=${evidence.checks.length}\n`);
' "$evidence"

docker rm -f "$container" >/dev/null
remove_identity
remaining=$(docker exec -e WB_SMOKE_EMAIL="$email" "$postgres_container" sh -lc \
  "psql -At -v ON_ERROR_STOP=1 -v smoke_email=\"\$WB_SMOKE_EMAIL\" -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -c \"SELECT (SELECT count(*) FROM workbench.auth_users WHERE email = :'smoke_email') + (SELECT count(*) FROM workbench.principals WHERE email = :'smoke_email');\"")
if [ "$remaining" != 0 ]; then
  printf 'temporary smoke identity cleanup failed\n' >&2
  exit 1
fi

negative_email="closed-${stamp}@example.test"
negative_status=$(curl -sS \
  -o "$register_body" \
  -w '%{http_code}' \
  -X POST "${base_url}/api/auth/sign-up/email" \
  -H "Origin: ${base_url}" \
  -H 'Content-Type: application/json' \
  --data "$(jq -nc \
    --arg email "$negative_email" \
    --arg password "$password" \
    '{email:$email,name:"Closed Registration",password:$password,username:"closed_registration_2026",displayUsername:"Closed Registration"}')")
if [ "$negative_status" != 400 ] \
  || [ "$(jq -r '.code // empty' "$register_body")" != EMAIL_PASSWORD_SIGN_UP_DISABLED ]; then
  printf 'public registration negative check failed with HTTP %s\n' "$negative_status" >&2
  exit 1
fi

printf 'evidence=%s\n' "$evidence"
printf 'sha256=%s\n' "$(sha256sum "$evidence" | awk '{print $1}')"
printf 'temporary_identity_record_count=%s\n' "$remaining"
printf 'public_registration_negative_status=%s\n' "$negative_status"
