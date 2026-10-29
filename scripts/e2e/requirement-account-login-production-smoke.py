#!/usr/bin/env python3
"""Use disposable identities to verify shared-password production login.

Run explicitly on the verified origin after deploying the password verifier.
Credentials stay in memory; no real APITable users or passwords are modified.
"""
import http.cookiejar
import importlib.util
import json
import pathlib
import secrets
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

spec = importlib.util.spec_from_file_location("account_sync", pathlib.Path(__file__).parents[2] / "deploy/sync-requirement-accounts.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


def hashes(password):
    javascript = """let s='';for await(const c of process.stdin)s+=c;
const {hash}=await import('bcryptjs');const {hashPassword}=await import('better-auth/crypto');
process.stdout.write(JSON.stringify({bcrypt:await hash(s,10),scrypt:await hashPassword(s)}));"""
    p = subprocess.run(["docker", "exec", "-i", "workbench-workbench-web-1", "node", "--input-type=module", "-e", javascript],
                       input=password, text=True, capture_output=True, timeout=30)
    if p.returncode:
        raise RuntimeError("Fixture hash generation failed")
    return json.loads(p.stdout)


def native_requirement_verify(password, encoded):
    directory = "/tmp/workbench-shared-login-" + uuid.uuid4().hex
    container = "workbench-apitable-backend-server-1"
    java = """import java.io.*;
import com.apitable.shared.security.PasswordService;
import com.apitable.shared.security.PasswordServiceImpl;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
public class SharedPasswordFixture {
 public static void main(String[] args) throws Exception {
  BufferedReader input=new BufferedReader(new InputStreamReader(System.in));
  String password=input.readLine(), encoded=input.readLine();
  PasswordService service=new PasswordServiceImpl(new BCryptPasswordEncoder());
  if(!service.matches(password,encoded)||service.matches(password+"wrong",encoded))
   throw new IllegalStateException("Native password verification failed");
  System.out.print("native-password-verifier-passed");
 }
}"""
    try:
        command = "mkdir -p " + directory + "; cat > " + directory + "/SharedPasswordFixture.java"
        subprocess.run(["docker", "exec", "-i", container, "sh", "-c", command], input=java, text=True, check=True, capture_output=True)
        command = "cd " + directory + "; jar xf /app/app.jar BOOT-INF/lib/spring-jcl-6.1.2.jar " \
                  "BOOT-INF/lib/spring-security-crypto-6.2.1.jar " \
                  "BOOT-INF/classes/com/apitable/shared/security/PasswordService.class " \
                  "BOOT-INF/classes/com/apitable/shared/security/PasswordServiceImpl.class; " \
                  "javac -cp 'BOOT-INF/classes:BOOT-INF/lib/*' SharedPasswordFixture.java && " \
                  "java -cp '.:BOOT-INF/classes:BOOT-INF/lib/*' SharedPasswordFixture"
        p = subprocess.run(["docker", "exec", "-i", container, "sh", "-c", command],
                           input=password + "\n" + encoded + "\n", text=True, capture_output=True, timeout=60)
        if p.returncode or p.stdout != "native-password-verifier-passed":
            raise RuntimeError("Installed requirement-pool password verification failed")
    finally:
        subprocess.run(["docker", "exec", container, "rm", "-rf", directory], check=True, capture_output=True)


def client():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def request(opener, path, data=None):
    headers = {"Origin": "https://aionbench.com", "Content-Type": "application/json"}
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request("https://aionbench.com/api/auth/" + path, data=body, headers=headers)
    try:
        with opener.open(req, timeout=25) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, None


def login(opener, row, password, expected=200):
    status, body = request(opener, "sign-in/email", {"email": row["email"], "password": password})
    assert status == expected
    if expected == 200:
        assert body["user"]["id"] == row["userId"]
        status, body = request(opener, "get-session")
        assert status == 200 and body["user"]["id"] == row["userId"]


def main():
    suffix = uuid.uuid4().hex
    password = "Shared" + secrets.token_hex(7) + "Aa1"
    encoded = hashes(password)
    native_requirement_verify(password, encoded["bcrypt"])
    changes = [dict(sourceId=secrets.token_hex(16), userId=str(uuid.uuid4()),
                    email="sync-" + suffix + "@example.test", name="Disposable shared login",
                    password="apitable-bcrypt:" + encoded["bcrypt"], active=True, created=True, revoke=False),
               dict(sourceId=secrets.token_hex(16), userId=str(uuid.uuid4()),
                    email="native-" + suffix + "@example.test", name="Disposable native login",
                    password=encoded["scrypt"], active=True, created=True, revoke=False)]
    try:
        sync.db("pg", sync.sync_sql(changes))
        shared, native = client(), client()
        login(shared, changes[0], password)
        login(native, changes[1], password)
        login(client(), changes[0], password + "wrong", 401)
        changed_password = "Changed" + secrets.token_hex(6) + "Aa1"
        changes[0].update(password="apitable-bcrypt:" + hashes(changed_password)["bcrypt"], created=False, revoke=True)
        sync.db("pg", sync.sync_sql([changes[0]]))
        assert request(shared, "get-session") == (200, None)
        login(client(), changes[0], password, 401)
        changed = client()
        login(changed, changes[0], changed_password)
        changes[0].update(active=False, password="apitable-disabled:" + changes[0]["sourceId"])
        sync.db("pg", sync.sync_sql([changes[0]]))
        assert request(changed, "get-session") == (200, None)
        login(client(), changes[0], changed_password, 401)
        result = dict(passed=True, installedApitablePasswordService=True,
                      publicSharedPasswordLogin=True, protectedSessionIdentity=True,
                      nativeWorkbenchLoginPreserved=True, wrongPasswordRejected=True,
                      passwordChangeRevokesSessions=True, oldPasswordRejected=True,
                      disabledMemberRejected=True, disposableAccounts=2)
    finally:
        ids = ",".join("'" + row["userId"] + "'" for row in changes)
        sync.db("pg", "DELETE FROM workbench.auth_users WHERE id IN (" + ids + ");")
        count = sync.db("pg", "SELECT count(*) FROM workbench.auth_users WHERE id IN (" + ids + ");")
        assert count == "0"
    result["disposableAccountsRemoved"] = True
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Disposable account login verification failed; no credential values were logged.", file=sys.stderr)
        sys.exit(1)
