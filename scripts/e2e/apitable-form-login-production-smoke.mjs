import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// Real deployed pages with fresh anonymous browser contexts. All writes are blocked;
// the successful sign-in response below is a browser-only navigation fixture.
const origin = new URL(process.env.APITABLE_SMOKE_ORIGIN || 'https://requirements.aionbench.com');
const output = path.resolve('output/audit/1.0.0/apitable-form-login');
const workbench = new URL('/workbench/fom56i1yeByua9NWye', origin).href;
const share = new URL('/share/shrFkh595KUCsuR5Q3hS8/fom56i1yeByua9NWye', origin);
share.searchParams.set('return_probe', 'a&b 中文');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];

const waitForLogin = async (page) => {
  await page.waitForURL(url => url.origin === origin.origin && url.pathname === '/login');
  await page.getByRole('heading', { name: '登录', exact: true }).waitFor({ state: 'visible' });
  await page.getByPlaceholder('请输入邮箱', { exact: true }).waitFor({ state: 'visible' });
  await page.getByPlaceholder('请输入密码', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.getByPlaceholder('再次输入新密码').count(), 0, 'must show sign-in, not registration');
};

try {
  for (const [device, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, locale: 'zh-CN' });
    let simulatedSignIns = 0;
    const blockedWrites = [];
    await context.route('**/*', async (route) => {
      const request = route.request();
      if (request.method() === 'POST' && new URL(request.url()).origin === origin.origin && new URL(request.url()).pathname === '/api/v1/signIn') {
        const body = request.postDataJSON();
        assert.equal(body.username, 'form-login-smoke@example.invalid');
        simulatedSignIns += 1;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, code: 200, data: { isNewUser: false } }) });
        return;
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        blockedWrites.push({ method: request.method(), pathname: new URL(request.url()).pathname });
        await route.abort();
        return;
      }
      await route.continue();
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      await page.goto(workbench);
      await waitForLogin(page);
      assert.equal(new URL(page.url()).searchParams.get('reference'), workbench);
      checks.push({ device, check: 'private form opens sign-in and preserves return address', passed: true });
      await page.screenshot({ path: path.join(output, `${device}-login.png`) });

      await page.goto(share.href);
      await page.getByRole('textbox').first().waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.title === '需求收集表单');
      const loadedShare = page.url();
      assert.equal(new URL(loadedShare).searchParams.get('return_probe'), 'a&b 中文');
      await page.getByRole('textbox').first().click();
      const notice = page.getByText('当前神奇表单需要登录填写', { exact: false });
      await notice.waitFor({ state: 'visible' });
      await notice.getByText('登录', { exact: true }).click();
      await waitForLogin(page);
      const loginUrl = new URL(page.url());
      assert.equal(loginUrl.searchParams.get('reference'), loadedShare);
      assert.equal(loginUrl.searchParams.get('spaceId'), 'spchwV2gnndQw');
      checks.push({ device, check: 'real form warning opens sign-in with encoded return query', passed: true });

      // These synthetic values never reach the server; the route above intercepts it.
      await page.getByPlaceholder('请输入邮箱', { exact: true }).fill('form-login-smoke@example.invalid');
      await page.getByPlaceholder('请输入密码', { exact: true }).fill('FixtureOnly123!');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.waitForURL(url => url.href === loadedShare);
      assert.equal(simulatedSignIns, 1);
      checks.push({ device, check: 'browser-only successful sign-in returns to exact form', passed: true, authentication: 'mocked; no real account used' });
      assert.equal(blockedWrites.some(item => /register|form.*submit|record|resetPassword/i.test(item.pathname)), false, 'must not attempt registration, record writes, or password resets');
    } finally {
      await context.close();
    }
  }
  console.log(JSON.stringify({ origin: origin.origin, checks }, null, 2));
} finally {
  await browser.close();
}
