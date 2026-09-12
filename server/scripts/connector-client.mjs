import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Use only the credentials of the configured Teamleader MCP connection.
// Tokens remain in memory and are never included in output or copied to this project.
const name = 'teamleader-secure';
const url = 'https://teamleader-chatgpt.mm-979.workers.dev/mcp';
function accessToken() {
  const payload = JSON.stringify({headers:{},type:'http',url});
  const key = `${name}|${createHash('sha256').update(payload).digest('hex').slice(0,16)}`;
  const keychain = spawnSync('/usr/bin/security',['find-generic-password','-s','Codex MCP Credentials','-a',key,'-w'],{encoding:'utf8'});
  let token;
  if (keychain.status === 0) {
    const saved = JSON.parse(keychain.stdout);
    if (saved.server_name === name && saved.url === url) token = saved.token_response?.access_token;
  }
  if (!token) {
    try {
      const entries = JSON.parse(readFileSync(join(process.env.CODEX_HOME || join(homedir(),'.codex'),'.credentials.json'),'utf8'));
      const saved = Object.values(entries).find(entry => entry.server_name === name && entry.server_url === url);
      if (saved?.server_name === name && saved.server_url === url) token = saved.access_token;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!token) throw new Error('Teamleader MCP OAuth login has not completed. Run codex mcp login teamleader-secure --scopes teamleader:read,teamleader:write.');
  return token;
}

export async function connect() {
  const client = new Client({name:'apa-teamleader-verification',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(url),{requestInit:{headers:{Authorization:`Bearer ${accessToken()}`}}}));
  const call = async (name,args={}) => {
    const response = await client.callTool({name,arguments:args});
    if (response.isError) throw new Error(`Connector tool ${name} failed: ${JSON.stringify(response.content)}`);
    const content = response.content?.find(c=>c.type==='text')?.text;
    return content ? JSON.parse(content) : response;
  };
  return {client,call};
}

if (process.argv[1]?.endsWith('/connector-client.mjs')) {
  const {client,call} = await connect();
  try {
    const command = process.argv[2] || 'tools';
    if (command === 'tools') console.log(JSON.stringify(await client.listTools()));
    else console.log(JSON.stringify(await call(command, process.argv[3] ? JSON.parse(readFileSync(process.argv[3],'utf8')) : {})));
  } finally { await client.close(); }
}
