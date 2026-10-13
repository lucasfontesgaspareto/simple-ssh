// Servidor MCP (stdio) que dá à IA (Claude Code, Codex) acesso às conexões do Simple SSH.
// Protocolo: JSON-RPC 2.0, uma mensagem por linha no stdin/stdout. Nada além disso pode ir para o stdout.
//   claude mcp add simple-ssh -- node C:\caminho\sshforge\mcp.js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { Client } = require('ssh2');
const { KNOWN_HOSTS, checkHostKey, describeKey } = require('./knownhosts');

const DB = process.env.SIMPLE_SSH_DB || path.join(process.env.APPDATA || os.homedir(), 'Simple SSH', 'connections.json');
const MAX_OUT = 50_000; // caracteres por stream, para não estourar o contexto da IA
const load = () => JSON.parse(fs.readFileSync(DB, 'utf8'));
const expand = (p) => p.replace(/%USERPROFILE%/gi, os.homedir());

// Conexões ficam abertas entre chamadas: id -> Promise<Client>
const pool = new Map();

function connect(c) {
  if (pool.has(c.id)) return pool.get(c.id);
  const p = new Promise((resolve, reject) => {
    const conn = new Client();
    let hostErr;
    conn.on('ready', () => resolve(conn));
    conn.on('error', (e) => { pool.delete(c.id); reject(hostErr || e); });
    conn.on('close', () => pool.delete(c.id));
    conn.connect({
      host: c.host, port: c.port || 22, username: c.user,
      privateKey: c.keyPath ? fs.readFileSync(expand(c.keyPath)) : undefined,
      readyTimeout: 15000, keepaliveInterval: 30000,
      // Sem janela para perguntar: só aceita host que já está no known_hosts.
      hostVerifier: (key) => {
        const { host, type, b64, fp } = describeKey(c, key);
        const state = checkHostKey(host, type, b64);
        if (state === 'unknown') hostErr = new Error(`Host ${host} (${type} ${fp}) não está no ${KNOWN_HOSTS}. Conecte uma vez pelo Simple SSH para confiar nele.`);
        if (state === 'changed') hostErr = new Error(`A chave de ${host} MUDOU (${type} ${fp}). Pode ser man-in-the-middle; conexão recusada.`);
        return state === 'ok';
      },
    });
  });
  pool.set(c.id, p);
  return p;
}

async function run({ id, command, stdin, timeout = 120 }) {
  const c = load().find((x) => x.id === id);
  if (!c) throw new Error(`Conexão ${id} não existe. Use list_connections.`);
  const conn = await connect(c);
  return new Promise((resolve, reject) => conn.exec(command, (err, stream) => {
    if (err) return reject(err);
    let out = '', errOut = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stream.close(); }, timeout * 1000);
    stream.on('data', (d) => { if (out.length < MAX_OUT) out += d; });
    stream.stderr.on('data', (d) => { if (errOut.length < MAX_OUT) errOut += d; });
    stream.on('close', (code, signal) => {
      clearTimeout(timer);
      const cut = (s) => (s.length >= MAX_OUT ? s.slice(0, MAX_OUT) + '\n[... saída cortada]' : s);
      const status = timedOut ? `timeout após ${timeout}s` : `exit ${code ?? signal}`;
      resolve([`[${c.user}@${c.host}] ${status}`, cut(out), errOut && `--- stderr ---\n${cut(errOut)}`].filter(Boolean).join('\n'));
    });
    stream.end(stdin ?? undefined);
  }));
}

const tools = {
  list_connections: {
    description: 'Lista as conexões SSH salvas no Simple SSH (id, pasta, nome, usuário@host). Use o id nas outras ferramentas.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => load().map((c) => `${c.id}\t${c.folder ? c.folder + '\\' : ''}${c.name}\t${c.user}@${c.host}:${c.port || 22}`).join('\n') || 'Nenhuma conexão salva.',
  },
  run: {
    description: 'Executa um comando shell no servidor remoto e devolve stdout, stderr e exit code. Para escrever arquivo, use command "cat > /caminho" com o conteúdo em stdin. Não é interativo (sem TTY).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'id da conexão (list_connections)' },
        command: { type: 'string' },
        stdin: { type: 'string', description: 'texto enviado ao stdin do comando' },
        timeout: { type: 'number', description: 'segundos, padrão 120' },
      },
      required: ['id', 'command'],
    },
    handler: run,
  },
};

async function handle(msg) {
  const { method, params } = msg;
  if (method === 'initialize') return { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'simple-ssh', version: '0.1.0' } };
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) };
  if (method === 'tools/call') {
    const t = tools[params.name];
    if (!t) throw Object.assign(new Error(`Ferramenta desconhecida: ${params.name}`), { code: -32602 });
    try { return { content: [{ type: 'text', text: await t.handler(params.arguments || {}) }] }; }
    catch (e) { return { content: [{ type: 'text', text: e.message }], isError: true }; }
  }
  throw Object.assign(new Error(`Método não suportado: ${method}`), { code: -32601 });
}

const reply = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return reply({ id: null, error: { code: -32700, message: 'JSON inválido' } }); }
  if (msg.id === undefined) return; // notificação (ex.: notifications/initialized)
  try { reply({ id: msg.id, result: await handle(msg) }); }
  catch (e) { reply({ id: msg.id, error: { code: e.code || -32603, message: e.message } }); }
}).on('close', () => { for (const p of pool.values()) p.then((c) => c.end(), () => {}); });
