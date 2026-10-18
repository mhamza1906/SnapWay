#!/usr/bin/env node
// Temporary public phone access through the existing installed ngrok agent.
// Leaves unrelated tunnels alone. No credentials are read or printed here.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const api = 'http://127.0.0.1:4040/api/tunnels';
const name = 'snapway-phone';
const command = process.argv[2] || 'info';
if (!['start','info','stop'].includes(command)) throw new Error('Use start, info or stop.');
let response;
try { response = await fetch(api); }
catch { throw new Error('Start your configured ngrok agent first, then run this command again.'); }
if (!response.ok) throw new Error('The ngrok agent API is unavailable.');
const tunnels = (await response.json()).tunnels;
let tunnel = tunnels.find(tunnel => tunnel.name === name);
if (command === 'stop') {
  if (tunnel) {
    const stopped = await fetch(`${api}/${name}`, {method:'DELETE'});
    if (!stopped.ok) throw new Error('Could not stop the phone preview.');
  }
  console.log('Phone preview stopped; other ngrok tunnels are unchanged.');
} else {
  if (!tunnel && command === 'start') {
    response = await fetch(api, {method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({name,addr:'http://127.0.0.1:4200',proto:'http',host_header:'preserve',inspect:false})});
    if (!response.ok) throw new Error('Could not create the phone tunnel; inspect your ngrok account limits.');
    tunnel = await response.json();
  }
  if (!tunnel) throw new Error('No phone preview is running. Use start.');
  const origin = new URL(tunnel.public_url);
  if (origin.protocol !== 'https:') throw new Error('Phone preview requires HTTPS.');
  const local = fileURLToPath(new URL('../local/',import.meta.url));
  await mkdir(local,{recursive:true});
  await writeFile(`${local}phone-preview.json`,JSON.stringify({origin:origin.origin,tunnelName:name},null,2));
  console.log(`Phone: ${origin.origin}/graph-editor?mode=photos`);
  console.log(`Google authorized redirect URI: ${origin.origin}/accounts/google/login/callback/`);
  console.log(`Frontend: __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${origin.hostname} node node_modules/@angular/cli/bin/ng.js serve --host 127.0.0.1 --port 4200 --proxy-config ../../local/proxy-8001.json (from apps/web)`);
  console.log(`API: DEV_EXTRA_ORIGINS=${origin.origin} DJANGO_TRUST_PROXY=true DJANGO_SETTINGS_MODULE=config.settings.development .venv/bin/python apps/api/manage.py runserver 127.0.0.1:8001 (from repository root)`);
}
