// Actual local authentication, invitations and project authorization; no API interception or model calls.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
export async function runStudioLiveAccessScenarios({page,browser,webOrigin,outDir,runId,dbUrl,sql,waitUntil,evidence,step}){
 evidence.scope='Real isolated PostgreSQL/API/Studio registration, invitation authorization, member removal and actor isolation. Verified-email status for permission tests is explicitly seeded locally after testing unverified-email rejection; no email-delivery/verification, generation, retrieval, object-store or export acceptance.';
 evidence.realModelCalls=0;evidence.browserApiInterception=false;
 const password=randomBytes(24).toString('base64url')+'!1aA';
 async function register(p,role){await p.goto(webOrigin+'/register');await waitUntil(async()=>await p.locator('#username').count()===1,'Hydrated registration form',30000);await p.locator('#username').fill(role+'_'+runId);await p.locator('#email').fill(role+'_'+runId+'@example.test');await p.locator('#password').fill(password);await p.getByRole('button',{name:'创建工作台',exact:true}).click();await p.waitForURL(webOrigin+'/',{timeout:60000});}
 const check=async(p,endpoint)=>p.evaluate(async url=>{const r=await fetch('/api/v1'+url);return{status:r.status,body:await r.json()};},endpoint);
 step('Register two real isolated accounts and create the private project');
 await register(page,'owner');await page.getByRole('textbox',{name:'新项目名称'}).fill('真实权限验收 '+runId);await page.getByRole('button',{name:'创建项目 →',exact:true}).click();await page.waitForURL(/\/studio\//);const projectId=new URL(page.url()).pathname.split('/').at(-1);evidence.projectId=projectId;
 const peerContext=await browser.newContext(),peer=await peerContext.newPage();peer.setDefaultTimeout(30000);
 const anonymous=await browser.newContext(),anon=await anonymous.newPage();
 try{
  await register(peer,'member');
  await anon.goto(webOrigin+'/login');
  assert.equal((await check(anon,'/projects/'+projectId+'/bootstrap')).status,401);
  assert.equal((await check(peer,'/projects/'+projectId+'/bootstrap')).status,404);
  evidence.checks.anonymousAndUninvitedRejected=true;
  step('Create and accept a real project invitation through the UI');
  await page.goto(webOrigin+'/studio/'+projectId+'?view=project');await page.getByRole('textbox',{name:'邀请邮箱'}).fill('member_'+runId+'@example.test');await page.getByRole('combobox',{name:'邀请角色'}).selectOption('editor');await page.getByRole('button',{name:'创建邀请',exact:true}).click();
  const invite=page.getByRole('textbox',{name:'邀请链接',exact:true});await invite.waitFor();const href=await invite.inputValue();
  await peer.goto(href);
  await peer.getByText('The signed-in account does not expose an email address',{exact:true}).waitFor();
  assert.equal(await peer.getByRole('button',{name:'接受邀请',exact:true}).isDisabled(),true);
  evidence.checks.unverifiedEmailInvitationRejected=true;
  // Deliberate identity fixture in the owned test DB, not an application bypass
  // and not evidence that the product's email-verification workflow exists.
  const trust=await sql('UPDATE workbench.auth_users SET email_verified=true WHERE email=$1 RETURNING id',['member_'+runId+'@example.test'],dbUrl);assert.equal(trust.rows.length,1);
  evidence.identityVerificationFixture='member email_verified=true in the owned isolated DB; email delivery and verification flow remain untested';
  await peer.reload();await peer.getByRole('button',{name:'接受邀请',exact:true}).click();await peer.getByRole('button',{name:'进入项目',exact:true}).click();await peer.waitForURL(/\/studio\//);
  await peer.getByRole('textbox',{name:'描述需求或修改'}).fill('属于成员账户的未发送草稿 '+runId);
  assert.equal((await check(peer,'/projects/'+projectId+'/bootstrap')).status,200);
  evidence.checks.realInvitationAccepted=true;
  await page.reload();const member=page.getByRole('article',{name:'成员 member_'+runId,exact:true});await member.waitFor();
  step('Remove the active member and observe the actual private workspace invalidation');
  await member.getByText('移除成员',{exact:true}).click();await member.getByRole('button',{name:'确认移除 member_'+runId,exact:true}).click();await page.getByText('成员已移除',{exact:true}).waitFor();
  const denied=await check(peer,'/projects/'+projectId+'/bootstrap');assert.equal(denied.status,404);
  // The mounted app's periodic bootstrap makes its own real request and emits
  // the production denial signal; no synthetic DOM events or intercepted API.
  await peer.getByText('项目访问权限已失效。请重新登录或联系项目所有者。',{exact:true}).waitFor({timeout:45000});
  assert.equal(await peer.getByRole('textbox',{name:'描述需求或修改'}).count(),0);assert.equal(await peer.locator('.visual-paper iframe').count(),0);
  await peer.screenshot({path:path.join(outDir,'member-revoked.png')});
  evidence.checks.actualRevocationUnmountedWorkspace=true;
  step('Reauthorize the same member and recover their isolated unsent draft');
  // Invitation grants project access without broad workspace-directory membership.
  // Reinvite the removed guest through the same authorized product workflow.
  await page.getByRole('textbox',{name:'邀请邮箱'}).fill('member_'+runId+'@example.test');await page.getByRole('button',{name:'创建邀请',exact:true}).click();
  const renewed=page.getByRole('article',{name:'邀请 member_'+runId+'@example.test',exact:true}).filter({hasText:'待接受'}).getByRole('textbox',{name:'邀请链接',exact:true});await renewed.waitFor();
  await peer.goto(await renewed.inputValue());await peer.getByRole('button',{name:'接受邀请',exact:true}).click();await peer.getByRole('button',{name:'进入项目',exact:true}).click();
  await waitUntil(async()=>await peer.getByRole('textbox',{name:'描述需求或修改'}).inputValue()==='属于成员账户的未发送草稿 '+runId,'Real authorized draft recovery');
  evidence.checks.sameActorDraftRecovered=true;
  await peer.goto(webOrigin+'/');await peer.getByRole('button',{name:'退出登录',exact:true}).click();await peer.waitForURL(/\/login/);
  await waitUntil(async()=>await peer.locator('#account').count()===1,'Hydrated login form',30000);
  await peer.locator('#account').fill('owner_'+runId);await peer.locator('#password').fill(password);await peer.getByRole('button',{name:'登录',exact:true}).click();await peer.waitForURL(webOrigin+'/',{timeout:60000});
  await peer.goto(webOrigin+'/studio/'+projectId);await waitUntil(async()=>await peer.getByRole('textbox',{name:'描述需求或修改'}).count()===1,'Other actor workspace loaded',30000);
  assert.equal(await peer.getByRole('textbox',{name:'描述需求或修改'}).inputValue(),'');evidence.checks.crossAccountDraftNotRestored=true;
  const count=await sql('SELECT count(*)::int AS n FROM workbench.runs WHERE project_id=$1',[projectId],dbUrl);assert.equal(count.rows[0].n,0);
  evidence.checks.noRunOrModelCall=true;await writeFile(path.join(outDir,'access-results.json'),JSON.stringify({checks:evidence.checks,projectId,scope:evidence.scope},null,2));
 }catch(error){
  await writeFile(path.join(outDir,'peer-failure-state.json'),JSON.stringify({path:new URL(peer.url()).pathname,text:await peer.locator('body').innerText().catch(()=>''),tokenPresent:await peer.evaluate(()=>!!sessionStorage.getItem('workbench.project-invitation-token.v1')).catch(()=>false)},null,2));
  await peer.screenshot({path:path.join(outDir,'peer-failure.png')}).catch(()=>{});
  throw error;
 }finally{await peerContext.close();await anonymous.close();}
}
