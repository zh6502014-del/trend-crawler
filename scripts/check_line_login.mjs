// Checks the live static frontend and exercises the same one-time auth exchange.
// No email is sent. Credentials, token hashes and sessions are never logged.
import { readFile } from 'node:fs/promises';
import { dashboardLoginUrl } from '../supabase/functions/line-webhook/index.ts';
const timeout = () => AbortSignal.timeout(15000);
async function main() {
  const source = await readFile(new URL('../docs/config.js', import.meta.url), 'utf8');
  const base = /SUPABASE_URL:\s*"([^"]+)"/.exec(source)?.[1];
  const anon = /SUPABASE_ANON_KEY:\s*"([^"]+)"/.exec(source)?.[1];
  const key = process.env.SUPABASE_SERVICE_KEY;
  const dash = process.env.DASHBOARD_URL;
  if (!base || !anon || !key || !dash) throw new Error('Missing dashboard login configuration');
  const localHtml = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8');
  const expectedScripts = [...localHtml.matchAll(/src="((?:app|line-auth)\.js\?[^\"]+)"/g)].map((m) => m[1]);
  const dashboard = new URL(dash);
  dashboard.hash = ''; dashboard.search = '';
  if (!dashboard.pathname.endsWith('/')) dashboard.pathname += '/';
  let ready = false;
  for (let n = 0; n < 60; n++) {
    try {
      const cache = '?line-deploy=' + Date.now();
      const [html, helper, app] = await Promise.all(['', 'line-auth.js', 'app.js'].map(async (file) => {
        const res = await fetch(new URL(file + cache, dashboard), { signal: timeout(), headers: {'Cache-Control':'no-cache'} });
        return res.ok ? res.text() : '';
      }));
      if (expectedScripts.length === 2 && expectedScripts.every((src) => html.includes(src)) &&
          helper.includes('token_hash') && app.includes('window.LineAuth.signIn')) { ready = true; break; }
    } catch { /* Pages may still be deploying; never print response data. */ }
    if (n === 0) console.log('Waiting for the dashboard login frontend on GitHub Pages...');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (!ready) throw new Error('Updated dashboard frontend is not live yet; rerun after GitHub Pages completes');
  const admin = {apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'};
  const request = async (path, options) => {
    const res = await fetch(base + '/auth/v1/' + path, {...options, signal:timeout()});
    if (!res.ok) throw new Error('Dashboard auth check failed (HTTP '+res.status+')');
    return res.status === 204 ? null : res.json();
  };
  let owner = process.env.OWNER_UID;
  let user;
  if (owner) { const data = await request('admin/users/'+encodeURIComponent(owner),{headers:admin}); user=data.user || data; }
  else {
    const data=await request('admin/users?per_page=2',{headers:admin});
    if (data.users?.length !== 1) throw new Error('Configure OWNER_UID for a multi-user dashboard');
    user=data.users[0]; owner=user.id;
  }
  if (!user.email) throw new Error('Dashboard owner has no email');
  const generated=await request('admin/generate_link',{method:'POST',headers:admin,
    body:JSON.stringify({type:'magiclink',email:user.email,redirect_to:dashboard.href})});
  const url=dashboardLoginUrl(dashboard.href,generated);
  if (!url) throw new Error('Supabase returned no usable login token');
  const hash=new URLSearchParams(new URL(url).hash.slice(1)).get('line_token');
  const session=await request('verify',{method:'POST',headers:{apikey:anon,'Content-Type':'application/json'},
    body:JSON.stringify({token_hash:hash,type:'email'})});
  if (!session.access_token || session.user?.id !== owner) throw new Error('Dashboard login did not resolve to the expected owner');
  // Only this test session is revoked; existing LINE/browser sessions stay signed in.
  await request('logout?scope=local',{method:'POST',headers:{apikey:anon,Authorization:'Bearer '+session.access_token}});
  console.log('Dashboard one-time sign-in verified; no email sent, test session closed.');
}
main().catch((error)=>{console.error('::error title=Dashboard login check::'+error.message);process.exitCode=1;});
