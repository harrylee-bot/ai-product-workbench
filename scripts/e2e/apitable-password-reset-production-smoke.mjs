import assert from 'node:assert/strict';

// Anonymous checks only: no real member IDs, passwords, or authenticated sessions.
const origin = new URL(process.env.APITABLE_SMOKE_ORIGIN || 'https://requirements.aionbench.com');
const checks = [];
const request = async (path, options = {}) => {
  const response = await fetch(new URL(path, origin), {
    redirect: 'manual', signal: AbortSignal.timeout(30000), ...options,
  });
  const content = await response.text();
  return { response, content };
};

const login = await request('/login');
assert.equal(login.response.status, 200, 'login page should load');
assert.match(login.content, /__NEXT_DATA__/, 'login should render the application');
checks.push({ check: 'login page', status: login.response.status, passed: true });

if (process.env.APITABLE_RESET_BUNDLE_PATH) {
  const bundlePath = process.env.APITABLE_RESET_BUNDLE_PATH;
  assert.ok(bundlePath.startsWith('/_next/static/'), 'check only an application asset');
  const bundle = await request(bundlePath);
  assert.equal(bundle.response.status, 200, 'new feature bundle should load publicly');
  assert.ok(bundle.content.includes('/org/member/passwordResetCapability'));
  assert.ok(bundle.content.includes('/org/member/resetPassword'));
  checks.push({ check: 'deployed password-reset UI bundle', path: bundlePath, passed: true });
}

const capability = await request('/api/v1/org/member/passwordResetCapability?memberId=0', {
  headers: { 'X-Space-Id': 'spchwV2gnndQw', Accept: 'application/json' },
});
const capabilityBody = JSON.parse(capability.content);
assert.equal(capabilityBody.success, false, 'anonymous capability request must fail');
assert.equal(capabilityBody.code, 201, 'capability route should require a login (APITable UNAUTHORIZED)');
checks.push({ check: 'anonymous capability denied', status: capability.response.status, code: capabilityBody.code, passed: true });

// Use an intentionally nonexistent member. This request must be rejected by CSRF/auth.
const mutation = await request('/api/v1/org/member/resetPassword', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: origin.origin, 'X-Space-Id': 'spchwV2gnndQw' },
  body: JSON.stringify({ memberId: '0', password: '', confirmPassword: '' }),
});
let mutationCode;
if (![401, 403].includes(mutation.response.status)) {
  const mutationBody = JSON.parse(mutation.content);
  assert.equal(mutationBody.success, false, 'anonymous reset must fail');
  assert.ok([201, 202].includes(mutationBody.code), 'APITable authentication must reject reset');
  mutationCode = mutationBody.code;
}
checks.push({ check: 'anonymous reset denied', status: mutation.response.status, code: mutationCode, passed: true });

const share = await request('/api/v1/node/readShareInfo/shrPUYuZSibCBSVwCFJ97');
const shareBody = JSON.parse(share.content);
assert.equal(shareBody.success, true, 'public share should remain readable');
assert.equal(shareBody.data.allowEdit, false, 'public share must remain read-only');
assert.equal(shareBody.data.isDeleted, false);
checks.push({ check: 'public share stays read-only', status: share.response.status, passed: true });

console.log(JSON.stringify({ origin: origin.origin, checks }, null, 2));
