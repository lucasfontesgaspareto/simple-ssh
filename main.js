const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Client } = require('ssh2');
const moba = require('./mobaimport');
const { KNOWN_HOSTS, checkHostKey, describeKey } = require('./knownhosts');

const DB = path.join(app.getPath('userData'), 'connections.json');
// O projeto se chamava sshforge: traz as conexões antigas na primeira execução.
const OLD_DB = path.join(app.getPath('appData'), 'sshforge', 'connections.json');
if (!fs.existsSync(DB) && fs.existsSync(OLD_DB)) { fs.mkdirSync(path.dirname(DB), { recursive: true }); fs.copyFileSync(OLD_DB, DB); }
const sessions = new Map(); // tabId -> { conn, stream, sftp }
let win;

const load = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return []; } };
const save = (list) => fs.writeFileSync(DB, JSON.stringify(list, null, 2));
const emit = (...a) => win && !win.isDestroyed() && win.webContents.send(...a);
const expand = (p) => p.replace(/%USERPROFILE%/gi, os.homedir());

async function verifyHost(c, key) {
  const { host, type, b64, fp } = describeKey(c, key);
  const state = checkHostKey(host, type, b64);
  if (state === 'ok') return true;
  if (state === 'changed') {
    dialog.showMessageBox(win, { type: 'error', title: 'Host key mudou', message: `A chave de ${host} mudou!`, detail: `${type} ${fp}\n\nPode ser man-in-the-middle. Se a mudança é legítima, remova a linha antiga de ${KNOWN_HOSTS}.` });
    return false;
  }
  const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: ['Confiar', 'Cancelar'], defaultId: 1, cancelId: 1, title: 'Host desconhecido', message: `Primeira conexão com ${host}`, detail: `${type} ${fp}` });
  if (response !== 0) return false;
  fs.mkdirSync(path.dirname(KNOWN_HOSTS), { recursive: true });
  fs.appendFileSync(KNOWN_HOSTS, `${host} ${type} ${b64}\n`);
  return true;
}

// ---------- SSH / SFTP ----------

ipcMain.handle('ssh:open', (_, tabId, c, cols, rows) => new Promise((resolve, reject) => {
  let privateKey;
  try { privateKey = c.keyPath ? fs.readFileSync(expand(c.keyPath)) : undefined; }
  catch (e) { return reject(new Error(`Chave não encontrada: ${expand(c.keyPath)}`)); }
  const conn = new Client();
  conn.on('ready', () => conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
    if (err) return reject(err);
    sessions.set(tabId, { conn, stream });
    stream.on('data', (d) => emit('ssh:data', tabId, d));
    stream.stderr.on('data', (d) => emit('ssh:data', tabId, d));
    stream.on('close', () => conn.end());
    resolve();
  }));
  conn.on('error', (e) => { reject(e); emit('ssh:close', tabId, e.message); });
  conn.on('close', () => { sessions.delete(tabId); emit('ssh:close', tabId); });
  conn.connect({
    host: c.host, port: c.port, username: c.user, privateKey,
    readyTimeout: 15000, keepaliveInterval: 30000,
    hostVerifier: (key, cb) => { verifyHost(c, key).then(cb, () => cb(false)); },
  });
}));

ipcMain.on('ssh:write', (_, tabId, data) => sessions.get(tabId)?.stream.write(data));
ipcMain.on('ssh:resize', (_, tabId, cols, rows) => sessions.get(tabId)?.stream.setWindow(rows, cols, 0, 0));
ipcMain.on('ssh:close', (_, tabId) => sessions.get(tabId)?.conn.end());

function sftp(tabId) {
  const s = sessions.get(tabId);
  if (!s) return Promise.reject(new Error('Sessão fechada'));
  if (!s.sftp) s.sftp = new Promise((res, rej) => s.conn.sftp((e, sf) => (e ? rej(e) : res(sf))));
  return s.sftp;
}
const call = (sf, method, ...args) => new Promise((res, rej) => sf[method](...args, (e, v) => (e ? rej(e) : res(v))));

ipcMain.handle('sftp:home', async (_, tabId) => call(await sftp(tabId), 'realpath', '.'));
ipcMain.handle('sftp:list', async (_, tabId, dir) => {
  const items = await call(await sftp(tabId), 'readdir', dir);
  return items
    .map((i) => ({ name: i.filename, dir: i.attrs.isDirectory(), size: i.attrs.size, mtime: i.attrs.mtime * 1000 }))
    .sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name));
});
ipcMain.handle('sftp:mkdir', async (_, tabId, p) => call(await sftp(tabId), 'mkdir', p));
ipcMain.handle('sftp:rename', async (_, tabId, from, to) => call(await sftp(tabId), 'rename', from, to));
// ponytail: rmdir só apaga pasta vazia; recursivo quando fizer falta
ipcMain.handle('sftp:delete', async (_, tabId, p, isDir) => call(await sftp(tabId), isDir ? 'rmdir' : 'unlink', p));
ipcMain.handle('sftp:upload', async (_, tabId, localPaths, dir) => {
  const sf = await sftp(tabId);
  // ponytail: só arquivos; pastas arrastadas são ignoradas
  for (const lp of localPaths) if (fs.statSync(lp).isFile()) await call(sf, 'fastPut', lp, path.posix.join(dir, path.basename(lp)));
});
ipcMain.handle('sftp:download', async (_, tabId, remote) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: path.join(os.homedir(), 'Downloads', path.posix.basename(remote)) });
  if (!canceled) await call(await sftp(tabId), 'fastGet', remote, filePath);
});

// Edição remota: baixa num temp, abre no VS Code e sobe de novo a cada save.
ipcMain.handle('sftp:edit', async (_, tabId, remote) => {
  const sf = await sftp(tabId);
  const local = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'simple-ssh-')), path.posix.basename(remote));
  await call(sf, 'fastGet', remote, local);
  let timer;
  const watcher = fs.watch(local, () => {
    clearTimeout(timer);
    timer = setTimeout(() => call(sf, 'fastPut', local, remote)
      .then(() => emit('toast', `Enviado: ${remote}`))
      .catch((e) => emit('toast', `Falha ao enviar ${remote}: ${e.message}`)), 300);
  });
  spawn('code', ['--wait', local], { shell: true }).on('exit', () => watcher.close());
});

// ---------- conexões ----------

ipcMain.handle('conn:list', () => load());
ipcMain.handle('conn:save', (_, c) => {
  const list = load();
  const i = list.findIndex((x) => x.id === c.id);
  if (i >= 0) list[i] = c; else list.push({ ...c, id: crypto.randomUUID() });
  save(list);
  return list;
});
ipcMain.handle('conn:delete', (_, id) => { const list = load().filter((c) => c.id !== id); save(list); return list; });
ipcMain.handle('conn:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'MobaXterm', extensions: ['mxtsessions', 'ini'] }],
  });
  if (canceled) return null;
  const list = load();
  const r = { added: 0, updated: 0 };
  for (const f of filePaths) {
    const x = moba.merge(list, moba.parse(fs.readFileSync(f, 'latin1')), crypto.randomUUID);
    r.added += x.added; r.updated += x.updated;
  }
  save(list);
  return { list, ...r };
});
ipcMain.handle('conn:export', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(os.homedir(), 'Downloads', 'simple-ssh.mxtsessions'),
    filters: [{ name: 'MobaXterm', extensions: ['mxtsessions'] }],
  });
  if (canceled) return null;
  const list = load();
  fs.writeFileSync(filePath, moba.serialize(list), 'latin1');
  return list.length;
});
ipcMain.handle('pick:key', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { defaultPath: path.join(os.homedir(), '.ssh'), properties: ['openFile'] });
  return canceled ? null : filePaths[0].replace(os.homedir(), '%USERPROFILE%');
});

// Menu de contexto nativo: recebe [{id,label}|'-'] e devolve o id escolhido (ou null).
ipcMain.handle('menu', (_, items) => new Promise((resolve) => {
  let picked = null;
  Menu.buildFromTemplate(items.map((i) => (i === '-' ? { type: 'separator' } : { label: i.label, click: () => (picked = i.id) })))
    .popup({ window: win, callback: () => resolve(picked) });
}));

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1300, height: 800, backgroundColor: '#1e1f22', title: 'Simple SSH',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  if (process.argv.includes('--dev')) win.webContents.openDevTools();
});
app.on('window-all-closed', () => app.quit());
