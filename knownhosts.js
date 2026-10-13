// known_hosts no formato OpenSSH, com suporte a entradas hasheadas |1|salt|hash. Usado pelo app e pelo mcp.js.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const KNOWN_HOSTS = path.join(os.homedir(), '.ssh', 'known_hosts');

function hostMatches(pattern, host) {
  if (pattern.startsWith('|1|')) {
    const [, , salt, hash] = pattern.split('|');
    return crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(host).digest('base64') === hash;
  }
  return pattern.split(',').includes(host);
}

// 'ok' | 'unknown' | 'changed' — só compara chaves do mesmo tipo, igual ao OpenSSH
function checkHostKey(host, type, b64) {
  let lines = [];
  try { lines = fs.readFileSync(KNOWN_HOSTS, 'utf8').split(/\r?\n/); } catch {}
  let changed = false;
  for (const l of lines) {
    const [hosts, t, k] = l.trim().split(/\s+/);
    if (!k || hosts.startsWith('#') || t !== type || !hostMatches(hosts, host)) continue;
    if (k === b64) return 'ok';
    changed = true;
  }
  return changed ? 'changed' : 'unknown';
}

// Dados da chave recebida no hostVerifier do ssh2, no formato do known_hosts.
function describeKey(c, key) {
  return {
    host: c.port === 22 ? c.host : `[${c.host}]:${c.port}`,
    type: key.subarray(4, 4 + key.readUInt32BE(0)).toString(),
    b64: key.toString('base64'),
    fp: 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, ''),
  };
}

module.exports = { KNOWN_HOSTS, checkHostKey, describeKey };
