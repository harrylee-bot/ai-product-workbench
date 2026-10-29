#!/usr/bin/env python3
"""Exercise synchronization against isolated tables in the origin PostgreSQL.

Run explicitly on the origin after reviewing deploy/sync-requirement-accounts.py.
Creates a random test schema and always drops it; never uses real user records.
"""
import importlib.util
import json
import pathlib
import uuid

spec = importlib.util.spec_from_file_location("account_sync", pathlib.Path(__file__).parents[2] / "deploy/sync-requirement-accounts.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)
schema = "account_sync_test_" + uuid.uuid4().hex


def query(sql):
    return sync.db("pg", sql.replace("workbench.", schema + "."))


def target():
    return json.loads(query("""SELECT json_build_object('users',COALESCE((SELECT json_agg(u) FROM
 (SELECT id::text,name,email FROM workbench.auth_users) u),'[]'::json),
 'accounts',COALESCE((SELECT json_agg(a) FROM
 (SELECT id::text,user_id::text,account_id,provider_id,password FROM workbench.auth_accounts) a),'[]'::json));"""))


checks = []
try:
    sync.db("pg", "CREATE SCHEMA " + schema + ";" + "".join(
        "CREATE TABLE " + schema + "." + table + " (LIKE workbench." + table + " INCLUDING ALL);"
        for table in ["auth_users", "auth_accounts", "auth_sessions"]))
    row = dict(sourceId="c" * 32, email="sync@example.test", name="Member's , \\ \n name",
               password="$2a$10$" + "a" * 53, active=True)
    changes = sync.plan_sync([row], target())
    query(sync.sync_sql(changes))
    uid = changes[0]["userId"]
    assert target()["users"][0]["name"] == row["name"]
    assert sync.plan_sync([row], target()) == []
    checks.append("create, quoted profile, stable mapping and idempotence")
    query("INSERT INTO workbench.auth_sessions(id,token,user_id,expires_at,created_at,updated_at) "
          "VALUES(gen_random_uuid(),'synthetic-session','" + uid + "',now()+interval '1 day',now(),now());")
    row["password"] = "$2a$10$" + "b" * 53
    query(sync.sync_sql(sync.plan_sync([row], target())))
    assert query("SELECT count(*) FROM workbench.auth_sessions;") == "0"
    assert target()["users"][0]["id"] == uid
    checks.append("password change revokes old sessions and preserves identity")
    query(sync.sync_sql(sync.plan_sync([], target())))
    assert any(a.get("password", "").startswith("apitable-disabled:")
               for a in target()["accounts"] if a["provider_id"] == "credential")
    query(sync.sync_sql(sync.plan_sync([row], target())))
    assert sync.plan_sync([row], target()) == []
    checks.append("removed-member disable and reactivation")
    query("INSERT INTO workbench.auth_users(id,name,email,email_verified,created_at,updated_at) "
          "VALUES(gen_random_uuid(),'Unrelated','native@example.test',false,now(),now());")
    assert sync.plan_sync([row], target()) == []
    checks.append("unrelated existing users preserved")
    fresh = dict(row, sourceId="d" * 32, email="new@example.test")
    failing = sync.plan_sync([fresh, row], target())
    assert len(failing) == 1
    failing.append(dict(failing[0], sourceId="e" * 32, userId=str(uuid.uuid4())))
    try:
        query(sync.sync_sql(failing))
        raise AssertionError("Expected duplicate email to roll back the transaction")
    except RuntimeError:
        pass
    assert len(target()["users"]) == 2
    assert sync.plan_sync([row], target()) == []
    checks.append("entire batch rolls back on a constraint failure")
    print(json.dumps(dict(passed=True, checks=checks)))
finally:
    sync.db("pg", "DROP SCHEMA IF EXISTS " + schema + " CASCADE;")
