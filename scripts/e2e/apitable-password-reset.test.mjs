import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = `
import React, { useSyncExternalStore } from 'react';
let state = {
  user: { info: { memberId: 'admin-1', isMainAdmin: true, isAdmin: true } },
  space: { activeId: 'space-1' },
  member: { memberId: 'member-2', memberName: '测试成员', email: 'fixture@example.test', isActive: true },
};
const listeners = new Set();
window.fixture = {
  update(patch) { state = { ...state, ...patch }; listeners.forEach(fn => fn()); },
  messages: [],
  completedRequests: 0,
};
export const useFixtureState = () => useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => state);
export const useAppSelector = selector => selector(useFixtureState());
export const getLanguage = () => new URLSearchParams(location.search).get('lang') || 'zh_CN';
export const TextButton = ({ children, color, size, ...props }) => <button {...props}>{children}</button>;
export const Message = { success: message => window.fixture.messages.push(message.content) };
export const Modal = ({ visible, title, children, onCancel, onOk, okText, cancelText, confirmLoading, okButtonProps, cancelButtonProps }) => visible ? (
  <section role="dialog" aria-label={title}>
    <h2>{title}</h2>{children}
    <button onClick={onCancel} disabled={cancelButtonProps?.disabled}>{cancelText}</button>
    <button onClick={onOk} disabled={confirmLoading || okButtonProps?.disabled}>{okText}</button>
  </section>
) : null;
export const Input = { Password: ({ onPressEnter, ...props }) => <input type="password" onKeyDown={event => { if (event.key === 'Enter') onPressEnter?.(event); }} {...props} /> };
const request = async (path, config, body) => {
  const query = config.params ? '?' + new URLSearchParams(config.params) : '';
  const response = await fetch('/api/v1' + path + query, {
    method: body ? 'POST' : 'GET',
    headers: { ...config.headers, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) { window.fixture.completedRequests += 1; throw new Error('Fixture transport failure'); }
  const data = await response.json();
  window.fixture.completedRequests += 1;
  return { data };
};
export default { get: (path, config) => request(path, config), post: (path, body, config) => request(path, config, body) };
`;

test('APITable member password reset browser behavior', { timeout: 60000 }, async (t) => {
  const bundle = await build({
    stdin: {
      contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
        import { MemberPasswordReset } from './deploy/apitable-community-web/src/member_password_reset.tsx';
        import { useFixtureState } from 'apitable-password-reset-fixture';
        const App = () => <MemberPasswordReset memberInfo={useFixtureState().member} />;
        createRoot(document.getElementById('root')).render(<App />);`,
      loader: 'tsx', resolveDir: root,
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    plugins: [{
      name: 'upstream-component-fixture',
      setup(builder) {
        builder.onResolve({ filter: /^(antd|axios|@apitable\/components|@apitable\/core|pc\/components\/common|pc\/store\/react-redux|apitable-password-reset-fixture)$/ }, () => ({ path: 'fixture', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: fixture, loader: 'tsx', resolveDir: root }));
        builder.onResolve({ filter: /\.less$/ }, () => ({ path: 'styles', namespace: 'styles' }));
        builder.onLoad({ filter: /.*/, namespace: 'styles' }, () => ({ contents: 'export default {};' }));
      },
    }],
  });
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url.startsWith('/fixture.js') ? 'application/javascript' : 'text/html');
    response.end(request.url.startsWith('/fixture.js') ? bundle.outputFiles[0].text : '<html><meta charset="utf-8"><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pages = [];
  const pageErrors = [];
  const open = async (options = {}) => {
    const page = await browser.newPage({ viewport: options.viewport || { width: 1280, height: 800 } });
    pages.push(page);
    page.on('pageerror', error => pageErrors.push(error.message));
    const requests = [];
    await page.route('**/api/v1/org/member/**', async (route) => {
      const request = route.request();
      requests.push({ method: request.method(), url: request.url(), headers: request.headers(), body: request.postDataJSON() });
      if (options.handler) {
        const handled = await options.handler(route, requests.at(-1));
        if (handled) return;
      }
      await route.fulfill({ json: request.method() === 'GET' ? { success: true, data: { allowed: options.allowed !== false } } : { success: true } });
    });
    await page.goto(`${origin}/?lang=${options.language || 'zh_CN'}`);
    return { page, requests };
  };
  const waitAction = page => page.getByRole('button', { name: '重置密码', exact: true }).waitFor();
  const openForm = async page => {
    await waitAction(page);
    await page.getByRole('button', { name: '重置密码', exact: true }).click();
    await page.getByRole('dialog').waitFor();
  };
  const fill = async (page, password = 'FixturePass123!', confirmation = password) => {
    await page.getByLabel('新密码', { exact: true }).fill(password);
    await page.getByLabel('确认新密码', { exact: true }).fill(confirmation);
  };
  const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  await t.test('permission denial and failed capability checks never expose the action', async () => {
    const denied = await open({ allowed: false });
    await denied.page.waitForFunction(() => window.fixture.completedRequests === 1);
    await settle(denied.page);
    assert.equal(await denied.page.getByRole('button').count(), 0);
    const failed = await open({ handler: async route => { await route.fulfill({ status: 503, body: 'Unavailable' }); return true; } });
    await failed.page.waitForFunction(() => window.fixture.completedRequests === 1);
    await settle(failed.page);
    assert.equal(await failed.page.getByRole('button').count(), 0);
  });

  await t.test('ordinary members, self, inactive members and protected admins have no reset action', async () => {
    const { page, requests } = await open();
    await waitAction(page);
    const originalRequests = requests.length;
    const variants = [
      { user: { info: { memberId: 'admin-1', isAdmin: false, isMainAdmin: false } } },
      { user: { info: { memberId: 'admin-1', isMainAdmin: true } }, member: { memberId: 'admin-1', isActive: true } },
      { member: { memberId: 'member-3', isActive: false } },
      { member: { memberId: 'member-3', isActive: true, isMainAdmin: true } },
      { member: { memberId: 'member-3', isActive: true, isPrimary: true } },
      { user: { info: { memberId: 'admin-1', isAdmin: true, isMainAdmin: false } }, member: { memberId: 'member-3', isActive: true, isSubAdmin: true } },
    ];
    for (const patch of variants) {
      await page.evaluate(value => window.fixture.update(value), patch);
      await settle(page);
      assert.equal(await page.getByRole('button').count(), 0);
    }
    assert.equal(requests.length, originalRequests);
  });

  await t.test('validation blocks invalid submissions and successful reset clears both password fields', async () => {
    const { page, requests } = await open();
    await openForm(page);
    for (const password of ['short1', 'abcdefgh', '12345678', 'Fixture123\\', '密码Abc12345']) {
      await fill(page, password);
      await page.getByRole('button', { name: '确认重置' }).click();
      await page.getByRole('alert').waitFor();
    }
    await fill(page, 'FixturePass123!', 'FixturePass321!');
    await page.getByRole('button', { name: '确认重置' }).click();
    assert.match(await page.getByRole('alert').textContent(), /不一致/);
    assert.equal(requests.filter(request => request.method === 'POST').length, 0);
    await fill(page);
    await page.getByRole('button', { name: '确认重置' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    const post = requests.find(request => request.method === 'POST');
    assert.deepEqual(post.body, { memberId: 'member-2', password: 'FixturePass123!', confirmPassword: 'FixturePass123!' });
    assert.equal(post.headers['x-space-id'], 'space-1');
    assert.equal((await page.evaluate(() => window.fixture.messages)).length, 1);
    await openForm(page);
    assert.equal(await page.getByLabel('新密码', { exact: true }).inputValue(), '');
    assert.equal(await page.getByLabel('确认新密码', { exact: true }).inputValue(), '');
    await fill(page);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await openForm(page);
    assert.equal(await page.getByLabel('新密码', { exact: true }).inputValue(), '');
  });

  await t.test('a pending capability response cannot authorize a different selected member', async () => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const { page, requests } = await open({ handler: async (route, request) => {
      if (new URL(request.url).searchParams.get('memberId') === 'member-2') {
        await held;
        await route.fulfill({ json: { success: true, data: { allowed: true } } });
      } else {
        await route.fulfill({ json: { success: true, data: { allowed: false } } });
      }
      return true;
    } });
    await page.waitForFunction(() => Boolean(window.fixture));
    await page.evaluate(() => window.fixture.update({ member: { memberId: 'member-3', isActive: true } }));
    await page.waitForFunction(() => window.fixture.completedRequests === 1);
    release();
    await page.waitForFunction(() => window.fixture.completedRequests === 2);
    await settle(page);
    assert.equal(await page.getByRole('button').count(), 0);
    assert.equal(requests.length, 2);
  });

  await t.test('member and space switches close the form and discard the entered password', async () => {
    const { page, requests } = await open();
    await openForm(page);
    await fill(page);
    await page.evaluate(() => window.fixture.update({ member: { memberId: 'member-3', memberName: '另一成员', isActive: true } }));
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await openForm(page);
    assert.equal(await page.getByLabel('新密码', { exact: true }).inputValue(), '');
    await fill(page);
    await page.evaluate(() => window.fixture.update({ space: { activeId: 'space-2' } }));
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await openForm(page);
    assert.equal(await page.getByLabel('新密码', { exact: true }).inputValue(), '');
    await fill(page);
    await page.getByRole('button', { name: '确认重置' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    const post = requests.find(request => request.method === 'POST');
    assert.equal(post.body.memberId, 'member-3');
    assert.equal(post.headers['x-space-id'], 'space-2');
  });

  await t.test('repeated submission sends one request and server errors allow a corrected retry', async () => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const { page, requests } = await open({ handler: async (route, request) => {
      if (request.method !== 'POST') return false;
      await held;
      await route.fulfill({ json: { success: false, message: '权限已变更，请刷新后重试。' } });
      return true;
    } });
    await openForm(page);
    await fill(page);
    await Promise.all([
      page.waitForRequest(request => request.method() === 'POST'),
      page.getByRole('button', { name: '确认重置' }).evaluate(button => { button.click(); button.click(); button.click(); }),
    ]);
    assert.equal(requests.filter(request => request.method === 'POST').length, 1);
    assert.equal(await page.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
    release();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').textContent(), /权限已变更/);
    assert.equal(await page.getByRole('button', { name: '确认重置' }).isDisabled(), false);
  });

  await t.test('the shared member action works with English labels at a mobile viewport', async () => {
    const { page } = await open({ language: 'en_US', viewport: { width: 390, height: 844 } });
    await page.getByRole('button', { name: 'Reset password', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Reset member password' });
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /existing sessions will stop working/);
    await page.getByLabel('New password', { exact: true }).fill('FixturePass123!');
    await page.getByLabel('Confirm password', { exact: true }).fill('FixturePass123!');
    await dialog.getByRole('button', { name: 'Reset password' }).click();
    await dialog.waitFor({ state: 'detached' });
  });

  for (const page of pages) await page.close();
  assert.deepEqual(pageErrors, []);
});
