#!/usr/bin/env python3
"""Sync trusted APITable members to Workbench without handling plaintext passwords.

Run on the verified origin host. Default is a read-only plan. Docker supplies
database credentials inside each existing database container; never print them.
"""
import argparse
import csv
import fcntl
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import uuid

SPACE_ID = "spchwV2gnndQw"
PROVIDER = "apitable-sync"
HASH_RE = re.compile(r"\$2[aby]\$(0[4-9]|1[0-4])\$[./A-Za-z0-9]{53}")


def db(engine, sql):
    if engine == "mysql":
        command = ["docker", "exec", "-i", "workbench-apitable-mysql-1", "sh", "-c",
                   'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql --default-character-set=utf8mb4 '
                   '-uroot "$MYSQL_DATABASE" --batch --raw --skip-column-names']
    else:
        command = ["docker", "exec", "-i", "workbench-postgres-1", "sh", "-c",
                   'psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"']
    result = subprocess.run(command, input=sql, text=True, capture_output=True, timeout=45)
    if result.returncode:
        # SQL diagnostics can contain credential values; leave them out of logs.
        raise RuntimeError(engine + " account query failed; transaction was not committed")
    return result.stdout.strip()


def read_source():
    result = db("mysql", """
SELECT JSON_OBJECT('sourceId', u.uuid, 'email', u.email,
 'name', COALESCE(NULLIF(m.member_name,''),NULLIF(u.nick_name,''),u.email),
 'password',u.password,'active',IF(u.is_deleted=0 AND u.is_paused=0
 AND m.is_deleted=0 AND m.is_active=1 AND m.status=1,TRUE,FALSE))
FROM apitable_user u JOIN apitable_unit_member m ON m.user_id=u.id
WHERE m.space_id='""" + SPACE_ID + "';")
    return [json.loads(row) for row in result.splitlines() if row]


def read_target():
    result = db("pg", """
SELECT json_build_object('users',COALESCE((SELECT json_agg(u) FROM
 (SELECT id::text,name,email FROM workbench.auth_users) u),'[]'::json),
 'accounts',COALESCE((SELECT json_agg(a) FROM
 (SELECT id::text,user_id::text,account_id,provider_id,password
 FROM workbench.auth_accounts WHERE provider_id IN ('credential','apitable-sync')) a),'[]'::json));
""")
    return json.loads(result)


def plan_sync(source, target):
    users = {u["id"]: u for u in target["users"]}
    links = {}
    credentials = {}
    for account in target["accounts"]:
        if account["provider_id"] == PROVIDER:
            key = account["account_id"]
            if key in links or account["user_id"] not in users:
                raise ValueError("Invalid source identity mapping")
            links[key] = account["user_id"]
        else:
            key = account["user_id"]
            if key in credentials:
                raise ValueError("Multiple credential accounts for a user")
            credentials[key] = account
    changes, seen, emails, assigned = [], set(), set(), set()
    for row in source:
        source_id = row.get("sourceId") or ""
        if not re.fullmatch(r"[a-f0-9]{32}", source_id) or source_id in seen:
            raise ValueError("Invalid or duplicate APITable identity")
        seen.add(source_id)
        if not row.get("active"):
            continue
        email = (row.get("email") or "").strip().lower()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email) or email in emails:
            raise ValueError("Invalid or ambiguous source email")
        emails.add(email)
        password = row.get("password") or ""
        if not HASH_RE.fullmatch(password):
            raise ValueError("Unsupported source password encoding")
        user_id = links.get(source_id)
        matches = [u for u in users.values() if u["email"].lower() == email]
        if len(matches) > 1 or (user_id and matches and matches[0]["id"] != user_id):
            raise ValueError("Email conflicts with an existing Workbench account")
        if not user_id:
            user_id = matches[0]["id"] if matches else str(uuid.uuid4())
        if user_id in assigned or any(uid == user_id and sid != source_id for sid, uid in links.items()):
            raise ValueError("Source identities would merge into one Workbench user")
        assigned.add(user_id)
        encoded = "apitable-bcrypt:" + password
        previous = users.get(user_id)
        previous_password = credentials.get(user_id, {}).get("password")
        name = str(row.get("name") or email).strip() or email
        if (not previous or previous["email"] != email or previous["name"] != name
                or previous_password != encoded or source_id not in links):
            changes.append(dict(sourceId=source_id, userId=user_id, email=email,
                                name=name, password=encoded, active=True,
                                created=previous is None,
                                revoke=bool(previous and (previous_password != encoded
                                                        or previous["email"] != email))))
    for source_id, user_id in links.items():
        if user_id not in assigned:
            encoded = "apitable-disabled:" + source_id
            if credentials.get(user_id, {}).get("password") != encoded:
                changes.append(dict(sourceId=source_id, userId=user_id, active=False,
                                    password=encoded, created=False, revoke=True))
    return changes


def sync_sql(changes):
    payload = io.StringIO()
    csv.writer(payload, lineterminator="\n").writerow([json.dumps(changes, ensure_ascii=True)])
    return """BEGIN;
SELECT pg_advisory_xact_lock(hashtext('workbench-apitable-account-sync'));
CREATE TEMP TABLE _account_sync_payload(data jsonb) ON COMMIT DROP;
COPY _account_sync_payload(data) FROM STDIN WITH (FORMAT csv);
""" + payload.getvalue() + r"""\.
DO $sync$
DECLARE r jsonb; uid uuid; prior text; matches integer;
BEGIN
 FOR r IN SELECT jsonb_array_elements(data) FROM _account_sync_payload LOOP
  uid := (r->>'userId')::uuid;
  IF (r->>'active')::boolean THEN
   -- Primary keys and all project/principal relations remain stable on updates.
   INSERT INTO workbench.auth_users(id,name,email,email_verified,created_at,updated_at)
   VALUES(uid,r->>'name',r->>'email',false,now(),now())
   ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,
     email_verified=CASE WHEN workbench.auth_users.email=EXCLUDED.email
       THEN workbench.auth_users.email_verified ELSE false END,updated_at=now();
   INSERT INTO workbench.auth_accounts(id,account_id,provider_id,user_id,created_at,updated_at)
   VALUES(gen_random_uuid(),r->>'sourceId','apitable-sync',uid,now(),now())
   ON CONFLICT(provider_id,account_id) DO NOTHING;
   IF NOT EXISTS(SELECT 1 FROM workbench.auth_accounts WHERE provider_id='apitable-sync'
      AND account_id=r->>'sourceId' AND user_id=uid) THEN
    RAISE EXCEPTION 'External identity mapping conflict';
   END IF;
  END IF;
  SELECT count(*) INTO matches FROM workbench.auth_accounts
   WHERE provider_id='credential' AND user_id=uid;
  IF matches>1 THEN RAISE EXCEPTION 'Ambiguous credential identity'; END IF;
  SELECT password INTO prior FROM workbench.auth_accounts
   WHERE provider_id='credential' AND user_id=uid FOR UPDATE;
  IF prior IS DISTINCT FROM r->>'password' OR (r->>'revoke')::boolean THEN
   DELETE FROM workbench.auth_sessions WHERE user_id=uid;
  END IF;
  IF matches=0 THEN
   INSERT INTO workbench.auth_accounts(id,account_id,provider_id,user_id,password,created_at,updated_at)
   VALUES(gen_random_uuid(),uid::text,'credential',uid,r->>'password',now(),now());
  ELSE
   UPDATE workbench.auth_accounts SET password=r->>'password',updated_at=now()
   WHERE provider_id='credential' AND user_id=uid;
  END IF;
 END LOOP;
END $sync$;
COMMIT;
"""


def backup_auth(directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    temporary = directory / "requirement-account-sync.dump.tmp"
    command = ["docker", "exec", "workbench-postgres-1", "sh", "-c",
               'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB" '
               '-t workbench.auth_users -t workbench.auth_accounts -t workbench.auth_sessions']
    try:
        with temporary.open("wb") as output:
            temporary.chmod(0o600)
            result = subprocess.run(command, stdout=output, stderr=subprocess.PIPE, timeout=90)
        if result.returncode or not temporary.stat().st_size:
            raise RuntimeError("Account backup failed; no accounts were changed")
        os.replace(temporary, directory / "requirement-account-sync.dump")
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--backup-dir", type=pathlib.Path,
                        default=pathlib.Path("/home/data/workbench-private/1.0.0/recovery"))
    args = parser.parse_args()
    if subprocess.check_output(["hostname"], text=True).strip() != "C202607221115992":
        raise RuntimeError("Run only on the verified requirement-pool origin")
    if not pathlib.Path("/opt/apitable").is_dir():
        raise RuntimeError("Requirement-pool application directory is missing")
    resolved = subprocess.check_output(["getent", "ahostsv4", "requirements.aionbench.com"], text=True)
    if {line.split()[0] for line in resolved.splitlines()} != {"45.207.206.119"}:
        raise RuntimeError("Requirement-pool DNS does not match the verified origin")
    with open("/run/lock/workbench-requirement-account-sync.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        source = read_source()
        if not source:
            raise RuntimeError("Empty source snapshot; refusing to disable linked accounts")
        changes = plan_sync(source, read_target())
        if args.execute and changes:
            backup_auth(args.backup_dir)
            db("pg", sync_sql(changes))
        print(json.dumps(dict(executed=args.execute, activeSourceMembers=sum(bool(r["active"]) for r in source),
                              created=sum(r["created"] for r in changes),
                              updated=sum(r["active"] and not r["created"] for r in changes),
                              disabled=sum(not r["active"] for r in changes),
                              sessionRevocations=sum(r["revoke"] for r in changes))))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never log exception arguments: driver errors may echo credentials.
        print("Requirement account synchronization failed; inspect service and database health.", file=sys.stderr)
        sys.exit(1)
