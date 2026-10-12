import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Frozen APITable v1.13.0-beta.1 PcHome source, matching the deployed build input.
// Keep the original source so this test executes the same branding patch as Docker.
const upstreamPcHome = [
  "/**",
  " * APITable <https://github.com/apitable/apitable>",
  " * Copyright (C) 2022 APITable Ltd. <https://apitable.com>",
  " *",
  " * This program is free software: you can redistribute it and/or modify",
  " * it under the terms of the GNU Affero General Public License as published by",
  " * the Free Software Foundation, either version 3 of the License, or",
  " * (at your option) any later version.",
  " *",
  " * This program is distributed in the hope that it will be useful,",
  " * but WITHOUT ANY WARRANTY; without even the implied warranty of",
  " * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the",
  " * GNU Affero General Public License for more details.",
  " *",
  " * You should have received a copy of the GNU Affero General Public License",
  " * along with this program.  If not, see <http://www.gnu.org/licenses/>.",
  " */",
  "",
  "import { useMount } from 'ahooks';",
  "import { useRouter } from 'next/router';",
  "import { useState } from 'react';",
  "import { IReduxState, Strings, t } from '@apitable/core';",
  "import { ActiveAppSumo } from 'pc/components/home/components/active_app_sumo';",
  "import { useAppSelector } from 'pc/store/react-redux';",
  "import { ForgetPassword } from './components/forget_password';",
  "import { Login } from './components/login';",
  "import { SignUp } from './components/sign_up';",
  "import { HomeWrapper } from './home_wrapper';",
  "import styles from './style.module.less';",
  "",
  "export enum ActionType {",
  "  SignIn = 'SignIn',",
  "  SignUp = 'SignUp',",
  "  ForgetPassword = 'ForgetPassword',",
  "  BindAppSumo = 'BindAppSumo',",
  "}",
  "",
  "export const PcHome: React.FC<React.PropsWithChildren<unknown>> = () => {",
  "  const inviteLinkInfo = useAppSelector((state: IReduxState) => state.invite.inviteLinkInfo);",
  "  const inviteEmailInfo = useAppSelector((state: IReduxState) => state.invite.inviteEmailInfo);",
  "  const [action, setAction] = useState<ActionType>(ActionType.SignUp);",
  "  const [email, setEmail] = useState<string>('');",
  "  const router = useRouter();",
  "",
  "  const switchActionType = (actionType: ActionType) => {",
  "    setAction(actionType);",
  "  };",
  "  const loginAction = localStorage.getItem('loginAction');",
  "  useMount(() => {",
  "    if (router.asPath.includes('sumo')) {",
  "      setAction(ActionType.BindAppSumo);",
  "      return;",
  "    }",
  "    if (loginAction === ActionType.SignIn) {",
  "      setAction(ActionType.SignIn);",
  "      localStorage.removeItem('loginAction');",
  "    }",
  "  });",
  "",
  "  const homeModal = (action: ActionType) => {",
  "    switch (action) {",
  "      case ActionType.SignIn:",
  "        return <Login switchClick={switchActionType} email={email} setEmail={setEmail} />;",
  "      case ActionType.BindAppSumo:",
  "        return <ActiveAppSumo />;",
  "      case ActionType.SignUp:",
  "        return <SignUp switchClick={switchActionType} />;",
  "      case ActionType.ForgetPassword:",
  "        return <ForgetPassword switchClick={switchActionType} email={email} setEmail={setEmail} />;",
  "    }",
  "  };",
  "",
  "  const getTitle = (action: ActionType) => {",
  "    switch (action) {",
  "      case ActionType.SignIn:",
  "        return 'Sign In';",
  "      case ActionType.SignUp:",
  "        return 'Sign Up';",
  "      case ActionType.ForgetPassword:",
  "        return 'Reset Password';",
  "      case ActionType.BindAppSumo:",
  "        return 'Welcome Sumo-ling!';",
  "    }",
  "  };",
  "",
  "  return (",
  "    <HomeWrapper action={action}>",
  "      <div className={styles.loginBox}>",
  "        {inviteLinkInfo || inviteEmailInfo ? (",
  "          <div className={styles.invite}>",
  "            <h4>",
  "              {inviteLinkInfo?.data.memberName || inviteEmailInfo?.data.inviter} {t(Strings.invite_your_join)}",
  "            </h4>",
  "            <p>{`\"${inviteLinkInfo?.data.spaceName || inviteEmailInfo?.data.spaceName}\"`}</p>",
  "          </div>",
  "        ) : (",
  "          <h3 className={styles.title}>{getTitle(action)}</h3>",
  "        )}",
  "        <div className={styles.bgBox1} />",
  "        <div className={styles.bgBox2} />",
  "        <div className={styles.bgBox3} />",
  "        {homeModal(action)}",
  "      </div>",
  "    </HomeWrapper>",
  "  );",
  "};"
].join("\n");

const fixture = `
import React, { useEffect } from 'react';
const params = new URLSearchParams(location.search);
const invitation = { data: { memberName: 'Inviter', inviter: 'Inviter', spaceName: 'Fixture' } };
const state = { invite: {
  inviteLinkInfo: params.get('fixtureInvite') === 'link' ? invitation : null,
  inviteEmailInfo: params.get('fixtureInvite') === 'email' ? invitation : null,
} };
export const useMount = callback => useEffect(() => { callback(); }, []);
export const useRouter = () => ({ pathname: location.pathname, asPath: location.pathname + location.search, query: Object.fromEntries(params) });
export const useAppSelector = selector => selector(state);
export const getLanguage = () => 'zh-CN';
export const Strings = new Proxy({}, { get: (_, key) => key });
export const t = key => key === 'login' ? '登录' : key === 'share_form_edit_tip' ? '当前神奇表单需要登录填写 ' : String(key);
export const AutoTestID = { GO_LOGIN_BTN: 'go-login' };
export const Navigation = { LOGIN: 'login' };
export const Router = { redirect(route, { query }) {
  if (route !== Navigation.LOGIN) throw new Error('Unexpected login destination');
  const search = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => { if (value != null) search.set(key, value); });
  location.assign('/login?' + search.toString());
} };
export const Login = ({ switchClick }) => <section data-testid="login-form"><label>邮箱<input type="email" /></label><label>密码<input type="password" /></label><button onClick={() => switchClick('SignUp')}>去注册</button></section>;
export const SignUp = ({ switchClick }) => <section data-testid="signup-form"><button onClick={() => switchClick('SignIn')}>去登录</button></section>;
export const ActiveAppSumo = () => <div data-testid="sumo-form">Sumo</div>;
export const ForgetPassword = () => <div data-testid="forgot-password-form">Forgot password</div>;
export const HomeWrapper = ({ children }) => <main>{children}</main>;
export const Space = ({ children }) => <div>{children}</div>;
export const useTheme = () => ({ palette: { type: 'light' } });
export const Logo = () => <span>Fixture</span>;
export const GithubButton = () => null;
export const NavBar = () => null;
`;

test('APITable form login routing and initial login screen', { timeout: 60000 }, async (t) => {
  const pcPath = path.join(root, 'packages/datasheet/src/pc/components/home/pc_home.tsx');
  const signUpPath = path.join(root, 'packages/datasheet/src/pc/components/home/components/sign_up/sign_up_base.tsx');
  const memory = new Map([[pcPath, upstreamPcHome], [signUpPath, '              placeholder="Please enter your email address"']]);
  const patch = fs.readFileSync(path.join(root, 'deploy/apitable-community-web/scripts/apply-branding.mjs'), 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInNewContext(patch, { path: { ...path, resolve: (...parts) => path.resolve(root, ...parts) }, fs: {
    existsSync: () => false,
    readFileSync: name => { assert(memory.has(name), `Unexpected branding input ${name}`); return memory.get(name); },
    writeFileSync: (name, content) => memory.set(name, content),
  } });
  const formSource = fs.readFileSync(path.join(root, 'deploy/apitable-community-web/src/form_container.tsx'), 'utf8');
  const promptStart = formSource.indexOf('  const msgContent = (');
  assert(promptStart >= 0, 'The actual form login prompt must exist');
  const promptEnd = formSource.indexOf('\n  );', promptStart);
  assert(promptEnd > promptStart);
  const prompt = formSource.slice(promptStart + '  const msgContent = '.length, promptEnd + '\n  )'.length);
  const bundle = await build({
    stdin: {
      contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
        import { PcHome } from 'actual-pc-home';
        import { MobileHome } from './deploy/apitable-community-web/src/mobile_home.tsx';
        import { FormLoginPrompt } from 'actual-form-login-prompt';
        const panel = new URLSearchParams(location.search).get('panel');
        createRoot(document.getElementById('root')).render(panel === 'form' ? <FormLoginPrompt /> : panel === 'mobile' ? <MobileHome /> : <PcHome />);`,
      loader: 'tsx', resolveDir: root,
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    plugins: [{ name: 'upstream-login-fixture', setup(builder) {
      builder.onResolve({ filter: /^(actual-pc-home|\.\/pc_home)$/ }, () => ({ path: 'pc-home', namespace: 'pc-home' }));
      builder.onLoad({ filter: /.*/, namespace: 'pc-home' }, () => ({ contents: memory.get(pcPath), loader: 'tsx', resolveDir: root }));
      builder.onResolve({ filter: /^actual-form-login-prompt$/ }, () => ({ path: 'prompt', namespace: 'prompt' }));
      builder.onLoad({ filter: /.*/, namespace: 'prompt' }, () => ({ contents: `import React from 'react';
        import { Strings, t, AutoTestID, Router, Navigation } from 'login-fixture';
        const styles = {}; const shareInfo = { spaceId: 'space-fixture' };
        export const FormLoginPrompt = () => ${prompt};`, loader: 'tsx', resolveDir: root }));
      builder.onResolve({ filter: /^(login-fixture|ahooks|next\/router|@apitable\/components|@apitable\/core|pc\/store\/react-redux|pc\/components\/common|pc\/components\/home\/components\/active_app_sumo|\.\/components\/.*|\.\/home_wrapper)$/ }, () => ({ path: 'fixture', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: fixture, loader: 'tsx', resolveDir: root }));
      builder.onResolve({ filter: /\.less$/ }, () => ({ path: 'styles', namespace: 'styles' }));
      builder.onLoad({ filter: /.*/, namespace: 'styles' }, () => ({ contents: 'export default {};' }));
    } }],
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
  const errors = [];
  const open = async (route, options = {}) => {
    const page = await browser.newPage({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 } });
    t.after(() => page.close());
    page.on('pageerror', error => errors.push(error.message));
    if (options.blockStorage) await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage unavailable'); } }));
    if (options.signInIntent) await page.addInitScript(() => localStorage.setItem('loginAction', 'SignIn'));
    await page.goto(origin + route);
    return page;
  };

  for (const panel of ['pc', 'mobile']) {
    await t.test(`${panel}: /login displays sign-in and the registration action still works`, async () => {
      const page = await open(`/login?panel=${panel}&reference=${encodeURIComponent(origin + '/workbench/fomExample')}`, { mobile: panel === 'mobile' });
      await page.getByTestId('login-form').waitFor();
      assert.equal(await page.getByRole('heading', { name: '登录', exact: true }).count(), 1);
      assert.equal(await page.getByTestId('signup-form').count(), 0);
      await page.getByRole('button', { name: '去注册' }).click();
      await page.getByTestId('signup-form').waitFor();
      await page.getByRole('button', { name: '去登录' }).click();
      await page.getByTestId('login-form').waitFor();
    });

    await t.test(`${panel}: homepage and invitation entry keep registration as the default`, async () => {
      for (const route of [`/?panel=${panel}`, `/login?panel=${panel}&inviteLinkToken=fixture`, `/login?panel=${panel}&inviteMailToken=fixture`, `/login?panel=${panel}&fixtureInvite=link`, `/login?panel=${panel}&fixtureInvite=email`]) {
        const page = await open(route, { mobile: panel === 'mobile' });
        await page.getByTestId('signup-form').waitFor();
        assert.equal(await page.getByTestId('login-form').count(), 0);
      }
    });

    await t.test(`${panel}: storage failures do not block login and explicit legacy sign-in remains supported`, async () => {
      const blocked = await open(`/login?panel=${panel}`, { blockStorage: true, mobile: panel === 'mobile' });
      await blocked.getByTestId('login-form').waitFor();
      const legacy = await open(`/?panel=${panel}`, { signInIntent: true, mobile: panel === 'mobile' });
      await legacy.getByTestId('login-form').waitFor();
      const sumo = await open(`/sumo?panel=${panel}`, { mobile: panel === 'mobile' });
      await sumo.getByTestId('sumo-form').waitFor();
    });
  }

  for (const blocked of [false, true]) {
    await t.test(`form login encodes the complete return URL${blocked ? ' with browser storage disabled' : ''}`, async () => {
      const page = await open('/share/shrFixture?panel=form&prefill=hello%20world&field=one%26two#field-three', { blockStorage: blocked });
      const reference = page.url();
      await page.locator('#go-login').waitFor();
      await Promise.all([
        page.waitForURL(url => url.pathname === '/login'),
        page.locator('#go-login').click(),
      ]);
      const destination = new URL(page.url());
      assert.equal(destination.origin, origin);
      assert.equal(destination.searchParams.get('reference'), reference);
      assert.equal(destination.searchParams.get('spaceId'), 'space-fixture');
      assert.equal(destination.searchParams.has('field'), false);
      assert.equal(destination.hash, '');
      await page.getByTestId('login-form').waitFor();
    });
  }

  assert.deepEqual(errors, []);
});
