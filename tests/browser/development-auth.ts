import { existsSync,readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { test,type Page } from '@playwright/test';

const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function requireValue(value:unknown,code:string):asserts value {if(!value)throw new Error(code);}

/** Explicit opt-in. A fresh, short-lived session uses the already authorized local principal. */
async function withDevelopmentSession(page:Page,use:(principal:string)=>Promise<void>) {
  requireValue(process.env.ATLAS_BROWSER_TEST_SESSION==='true','DEVELOPMENT_BROWSER_SESSION_OPT_IN_REQUIRED');
  const root=new URL('../../',import.meta.url);const envPath=new URL('.env.local',root);
  const env={...(existsSync(envPath)?parseEnv(readFileSync(envPath,'utf8')):{}),...process.env};
  requireValue(env.CLERK_SECRET_KEY?.startsWith('sk_test_')&&env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith('pk_test_'),'DEVELOPMENT_CLERK_REQUIRED');
  const identity=record(JSON.parse(readFileSync(new URL('.atlas/live-principal.json',root),'utf8')) as unknown);
  requireValue(typeof identity.principalId==='string'&&/^user_[A-Za-z0-9]+$/.test(identity.principalId),'AUTHORIZED_LOCAL_PRINCIPAL_REQUIRED');
  const principal=identity.principalId;
  async function clerk(path:string,method='GET',body?:unknown) {
    const response=await fetch(`https://api.clerk.com/v1${path}`,{method,headers:{Authorization:`Bearer ${env.CLERK_SECRET_KEY}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(20_000)});
    return {ok:response.ok,data:await response.json().catch(()=>null) as unknown};
  }
  const instance=await clerk('/instance');requireValue(instance.ok&&record(instance.data).environment_type==='development','DEVELOPMENT_INSTANCE_REQUIRED');
  const sessions=await clerk(`/sessions?user_id=${encodeURIComponent(principal)}`);requireValue(sessions.ok&&Array.isArray(sessions.data),'EXISTING_SESSIONS_REQUIRED');
  const original=new Set((sessions.data as unknown[]).map(record).filter(row=>row.user_id===principal&&typeof row.id==='string').map(row=>row.id as string));
  let ticketId:string|undefined;let sessionId:string|undefined;let consumed=false;
  try {
    await page.goto('/sign-in');
    await page.waitForFunction(()=>!!(window as unknown as {Clerk?:{loaded?:boolean}}).Clerk?.loaded);
    const issued=await clerk('/sign_in_tokens','POST',{user_id:principal,expires_in_seconds:120});const ticket=record(issued.data);
    if(issued.ok&&typeof ticket.id==='string'&&/^sit_[A-Za-z0-9]+$/.test(ticket.id))ticketId=ticket.id;
    requireValue(issued.ok&&ticketId&&typeof ticket.token==='string'&&ticket.user_id===principal,'DEVELOPMENT_TICKET_REQUIRED');
    const signed=await page.evaluate(async ticket=>{
      const clerk=(window as unknown as {Clerk:{client:{signIn:{create:(input:{strategy:'ticket';ticket:string})=>Promise<{status:string;createdSessionId:string|null}>}}}}).Clerk;
      const result=await clerk.client.signIn.create({strategy:'ticket',ticket});return {status:result.status,id:result.createdSessionId};
    },ticket.token);
    requireValue(signed.status==='complete'&&typeof signed.id==='string'&&/^sess_[A-Za-z0-9]+$/.test(signed.id)&&!original.has(signed.id),'NEW_DEVELOPMENT_SESSION_REQUIRED');
    consumed=true;sessionId=signed.id;
    await page.evaluate(async session=>{await (window as unknown as {Clerk:{setActive:(input:{session:string})=>Promise<void>}}).Clerk.setActive({session});},sessionId);
    await page.waitForFunction(principal=>(window as unknown as {Clerk?:{user?:{id?:string}}}).Clerk?.user?.id===principal,principal);
    const account=await page.evaluate(async()=>{const response=await fetch('/api/account',{cache:'no-store',credentials:'same-origin'});return {status:response.status,data:await response.json() as unknown};});
    requireValue(account.status===200&&record(account.data).authenticated===true&&record(account.data).principalId===principal,'REAL_ACCOUNT_AUTHENTICATION_REQUIRED');
    await use(principal);
  }finally {
    if(!sessionId){const candidate=await page.evaluate(()=>{const clerk=(window as unknown as {Clerk?:{session?:{id?:string};user?:{id?:string}}}).Clerk;return {id:clerk?.session?.id,principal:clerk?.user?.id};}).catch(()=>null);
      if(candidate?.principal===principal&&candidate.id&&!original.has(candidate.id))sessionId=candidate.id;}
    if(sessionId){requireValue(!original.has(sessionId)&&/^sess_[A-Za-z0-9]+$/.test(sessionId),'SESSION_CLEANUP_OWNERSHIP_REQUIRED');
      const owned=await clerk(`/sessions/${encodeURIComponent(sessionId)}`);requireValue(owned.ok&&record(owned.data).user_id===principal&&record(owned.data).id===sessionId,'SESSION_CLEANUP_PRINCIPAL_REQUIRED');
      const revoked=await clerk(`/sessions/${encodeURIComponent(sessionId)}/revoke`,'POST',{});requireValue(revoked.ok&&record(revoked.data).status==='revoked','NEW_TEST_SESSION_CLEANUP_FAILED');}
    if(ticketId&&!consumed){const revoked=await clerk(`/sign_in_tokens/${encodeURIComponent(ticketId)}/revoke`,'POST',{});requireValue(revoked.ok&&record(revoked.data).status==='revoked','UNUSED_TEST_TICKET_CLEANUP_FAILED');}
  }
}

export const developmentTest=test.extend<{developmentPrincipal:string}>({
  developmentPrincipal:async({page},use)=>{await withDevelopmentSession(page,use);},
});
