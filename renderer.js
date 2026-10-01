const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const msg = (e) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const join = (d, n) => (d === '/' ? '/' : d + '/') + n;
const parent = (d) => d.replace(/\/[^/]*$/, '') || '/';
const fmt = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(1)} GB`);

let conns = [];
const tabs = []; // { id, conn, term, fit, el, tabEl, alive, cwd }
let activeId = null;
const active = () => tabs.find((t) => t.id === activeId);
const closedFolders = new Set();

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('on'), 3500);
}
api.onToast(toast);

// Arrastar arquivo fora do explorer não deve navegar a janela
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// ---------- painel lateral ----------

document.querySelectorAll('.side-tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.side-tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('#conns').hidden = b.dataset.pane !== 'conns';
  $('#files').hidden = b.dataset.pane !== 'files';
  if (b.dataset.pane === 'files') refreshFiles();
});
const filesVisible = () => !$('#files').hidden;

// ---------- conexões ----------

function renderTree() {
  const q = $('#search').value.toLowerCase();
  const root = { kids: {}, items: [] };
  for (const c of conns) {
    if (q && !`${c.name} ${c.host} ${c.user} ${c.folder}`.toLowerCase().includes(q)) continue;
    let n = root;
    for (const part of (c.folder || '').split('\\').filter(Boolean)) n = n.kids[part] ??= { kids: {}, items: [] };
    n.items.push(c);
  }
  $('#tree').replaceChildren(...nodeEls(root, ''));
  if (!conns.length) $('#tree').append(el('div', { className: 'hint', textContent: 'Nenhuma conexão. Crie uma ou importe do MobaXterm.' }));
  $('#folders').replaceChildren(...[...new Set(conns.map((c) => c.folder).filter(Boolean))].sort().map((f) => el('option', { value: f })));
}

function nodeEls(node, path) {
  const out = [];
  for (const [name, kid] of Object.entries(node.kids).sort(([a], [b]) => a.localeCompare(b))) {
    const p = path + '\\' + name;
    const d = el('details', { open: !closedFolders.has(p) }, el('summary', { textContent: name }), ...nodeEls(kid, p));
    d.ontoggle = () => (d.open ? closedFolders.delete(p) : closedFolders.add(p));
    out.push(d);
  }
  for (const c of node.items.sort((a, b) => a.name.localeCompare(b.name))) {
    const r = el('div', { className: 'row', textContent: c.name, title: `${c.user}@${c.host}:${c.port}` });
    r.ondblclick = () => openTab(c);
    r.oncontextmenu = async () => {
      const pick = await api.menu([{ id: 'open', label: 'Conectar' }, { id: 'edit', label: 'Editar' }, { id: 'dup', label: 'Duplicar' }, '-', { id: 'del', label: 'Excluir' }]);
      if (pick === 'open') openTab(c);
      if (pick === 'edit') editConn(c);
      if (pick === 'dup') editConn({ ...c, id: '', name: c.name + ' (cópia)' });
      if (pick === 'del' && confirm(`Excluir "${c.name}"?`)) { conns = await api.deleteConn(c.id); renderTree(); }
    };
    out.push(r);
  }
  return out;
}

const form = $('#form form');
function editConn(c = { id: '', name: '', folder: '', host: '', port: 22, user: '', keyPath: '' }) {
  for (const [k, v] of Object.entries(c)) if (form.elements[k]) form.elements[k].value = v;
  $('#f-delete').hidden = !c.id;
  $('#form').returnValue = '';
  $('#form').showModal();
}
$('#form').onclose = async () => {
  if ($('#form').returnValue !== 'save') return;
  const c = Object.fromEntries(new FormData(form));
  c.port = Number(c.port) || 22;
  c.folder = c.folder.replace(/^\\+|\\+$/g, '');
  conns = await api.saveConn(c);
  renderTree();
};
$('#f-delete').onclick = async () => {
  if (!confirm('Excluir esta conexão?')) return;
  conns = await api.deleteConn(form.elements.id.value);
  $('#form').close();
  renderTree();
};
$('#pick-key').onclick = async () => { const p = await api.pickKey(); if (p) form.elements.keyPath.value = p; };
$('#new').onclick = () => editConn();
$('#search').oninput = renderTree;
$('#import').onclick = async () => {
  try {
    const r = await api.importMoba();
    if (!r) return;
    conns = r.list;
    renderTree();
    toast(`Importado: ${r.added} novas, ${r.updated} atualizadas`);
  } catch (e) { toast(msg(e)); }
};

$('#export').onclick = async () => {
  try { const n = await api.exportMoba(); if (n != null) toast(`Exportado: ${n} conexões`); } catch (e) { toast(msg(e)); }
};

// ---------- abas / terminal ----------

function openTab(c) {
  const id = crypto.randomUUID();
  const term = new Terminal({ fontFamily: '"Cascadia Mono", Consolas, monospace', fontSize: 14, cursorBlink: true, scrollback: 10000, theme: { background: '#1e1f22' } });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const box = el('div', { className: 'term' });
  $('#terms').append(box);
  term.open(box);

  const tabEl = el('div', { className: 'tab', title: `${c.user}@${c.host}` }, el('span', { textContent: c.name }), el('button', { className: 'x', textContent: '×', title: 'Fechar' }));
  tabEl.onclick = (e) => (e.target.classList.contains('x') ? closeTab(t) : activate(t));
  $('#tabs').append(tabEl);

  const t = { id, conn: c, term, fit, el: box, tabEl, alive: false, cwd: null };
  tabs.push(t);

  // Estilo MobaXterm: selecionar copia, botão direito cola. Ctrl+Shift+C/V também.
  term.onSelectionChange(() => { const s = term.getSelection(); if (s) navigator.clipboard.writeText(s); });
  box.addEventListener('contextmenu', async (e) => { e.preventDefault(); if (t.alive) api.write(id, await navigator.clipboard.readText()); });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
    if (e.code === 'KeyC') { navigator.clipboard.writeText(term.getSelection()); return false; }
    if (e.code === 'KeyV') { navigator.clipboard.readText().then((s) => t.alive && api.write(id, s)); return false; }
    return true;
  });
  term.onData((d) => {
    if (t.alive) api.write(id, d);
    else if (d.toLowerCase() === 'r') connect(t);
  });
  term.onResize(({ cols, rows }) => t.alive && api.resize(id, cols, rows));

  activate(t);
  connect(t);
}

async function connect(t) {
  const c = t.conn;
  t.cwd = null;
  t.tabEl.classList.remove('dead');
  t.term.write(`\x1b[90mConectando em ${c.user}@${c.host}:${c.port}...\x1b[0m\r\n`);
  try {
    await api.open(t.id, c, t.term.cols, t.term.rows);
    t.alive = true;
    if (t.id === activeId && filesVisible()) refreshFiles();
  } catch (e) {
    t.term.write(`\x1b[31m${msg(e)}\x1b[0m\r\n\x1b[90m[R] reconectar\x1b[0m\r\n`);
    t.tabEl.classList.add('dead');
  }
}

api.onData((id, data) => tabs.find((t) => t.id === id)?.term.write(data));
api.onClose((id, reason) => {
  const t = tabs.find((x) => x.id === id);
  if (!t?.alive) return;
  t.alive = false;
  t.tabEl.classList.add('dead');
  t.term.write(`\r\n\x1b[90m[conexão encerrada${reason ? ': ' + reason : ''}] [R] reconectar\x1b[0m\r\n`);
  if (t.id === activeId && filesVisible()) refreshFiles();
});

function activate(t) {
  activeId = t.id;
  for (const x of tabs) { x.el.classList.toggle('on', x === t); x.tabEl.classList.toggle('on', x === t); }
  $('#empty').hidden = true;
  t.fit.fit();
  t.term.focus();
  if (filesVisible()) refreshFiles();
}

function closeTab(t) {
  api.close(t.id);
  t.term.dispose();
  t.el.remove();
  t.tabEl.remove();
  tabs.splice(tabs.indexOf(t), 1);
  if (activeId === t.id) {
    activeId = null;
    if (tabs.length) activate(tabs.at(-1));
    else { $('#empty').hidden = false; refreshFiles(); }
  }
}

new ResizeObserver(() => active()?.fit.fit()).observe($('#terms'));

// ---------- explorer SFTP ----------

const fileList = $('#filelist');
const svg = (d) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 16 16'); s.innerHTML = d; s.classList.add('ico'); return s; };
const ICON = {
  dir: '<path fill="currentColor" d="M1.5 3h4.2l1.5 1.5h7.3v8.5h-13z"/>',
  file: '<path fill="none" stroke="currentColor" d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3"/>',
  up: '<path fill="none" stroke="currentColor" stroke-width="1.5" d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/>',
};
const base = (p) => p.split('/').pop();

// Cada aba guarda seu histórico: back/fwd são pilhas de caminhos. select = nome a destacar depois de listar.
function cd(t, dir, { push = true, select } = {}) {
  if (push && t.cwd && dir !== t.cwd) { (t.back ??= []).push(t.cwd); t.fwd = []; }
  t.cwd = dir;
  t.sel = select;
  refreshFiles();
}
function go(t, from, to) {
  if (!t?.alive || !t[from]?.length) return;
  (t[to] ??= []).push(t.cwd);
  cd(t, t[from].pop(), { push: false });
}
const goUp = (t) => t?.alive && t.cwd !== '/' && cd(t, parent(t.cwd), { select: base(t.cwd) });

function crumbs(t) {
  const parts = t.cwd.split('/').filter(Boolean);
  const out = [el('button', { className: 'crumb', textContent: '/', onclick: () => cd(t, '/') })];
  parts.forEach((p, i) => out.push(
    el('span', { className: 'sep', textContent: '›' }),
    el('button', { className: 'crumb', textContent: p, onclick: () => cd(t, '/' + parts.slice(0, i + 1).join('/')) })));
  $('#crumbs').replaceChildren(...out);
  $('#crumbs').scrollLeft = 1e9;
}

async function refreshFiles() {
  const t = active();
  $('#back').disabled = !t?.back?.length;
  $('#fwd').disabled = !t?.fwd?.length;
  if (!t?.alive) {
    $('#cwd').value = '';
    $('#crumbs').replaceChildren();
    fileList.replaceChildren(el('div', { className: 'hint', textContent: t ? 'Sessão desconectada' : 'Nenhuma sessão ativa' }));
    return;
  }
  fileList.classList.add('loading');
  try {
    t.cwd ??= await api.home(t.id);
    const items = await api.list(t.id, t.cwd);
    if (t !== active()) return;
    $('#cwd').value = t.cwd;
    crumbs(t);
    const rows = t.cwd === '/' ? [] : [fileRow(t, { name: '..', dir: true, up: true })];
    fileList.replaceChildren(...rows, ...items.map((i) => fileRow(t, i)));
    if (!items.length) fileList.append(el('div', { className: 'hint', textContent: 'Pasta vazia' }));
    const keep = [...fileList.querySelectorAll('.row')].find((x) => x.dataset.name === t.sel);
    if (keep) select(keep); else fileList.scrollTop = 0;
  } catch (e) { toast(msg(e)); }
  finally { fileList.classList.remove('loading'); }
}

function select(row) {
  fileList.querySelector('.row.sel')?.classList.remove('sel');
  if (!row) return;
  row.classList.add('sel');
  row.scrollIntoView({ block: 'nearest' });
  const t = active();
  if (t) t.sel = row.dataset.name;
}

function fileRow(t, f) {
  const p = f.up ? parent(t.cwd) : join(t.cwd, f.name);
  const r = el('div', { className: 'row file' + (f.dir ? ' is-dir' : ''), title: f.up ? 'Pasta acima' : `${f.name}\n${new Date(f.mtime).toLocaleString()}` },
    svg(ICON[f.up ? 'up' : f.dir ? 'dir' : 'file']),
    el('span', { className: 'name', textContent: f.name }),
    el('span', { className: 'size', textContent: f.dir ? '' : fmt(f.size) }));
  r.dataset.name = f.name;
  r.open = () => (f.up ? goUp(t) : f.dir ? cd(t, p) : run(api.edit(t.id, p), `Abrindo ${f.name} no VS Code`));
  r.onclick = () => { select(r); fileList.focus(); };
  r.ondblclick = r.open;
  if (f.up) return r;
  r.rename = async () => {
    const name = await ask('Novo nome', f.name);
    if (name && name !== f.name) { t.sel = name; run(api.rename(t.id, p, join(t.cwd, name)).then(refreshFiles)); }
  };
  r.remove = () => confirm(`Excluir ${p}?${f.dir ? '\n(só funciona com a pasta vazia)' : ''}`) && run(api.del(t.id, p, f.dir).then(refreshFiles), 'Excluído');
  r.oncontextmenu = async (e) => {
    e.stopPropagation();
    select(r);
    const items = f.dir ? [{ id: 'open', label: 'Abrir' }] : [{ id: 'open', label: 'Editar no VS Code' }, { id: 'down', label: 'Download...' }];
    const pick = await api.menu([...items, { id: 'copy', label: 'Copiar caminho' }, { id: 'ren', label: 'Renomear (F2)' }, '-', { id: 'del', label: 'Excluir (Del)' }]);
    if (pick === 'open') r.open();
    if (pick === 'down') run(api.download(t.id, p), 'Download concluído');
    if (pick === 'copy') run(navigator.clipboard.writeText(p), 'Caminho copiado');
    if (pick === 'ren') r.rename();
    if (pick === 'del') r.remove();
  };
  return r;
}

const run = (promise, ok) => promise.then(() => ok && toast(ok), (e) => toast(msg(e)));

// Teclado: setas/Home/End/PgUp/PgDn, Enter abre, Backspace sobe, F2, Del, F5, Alt+←/→, e digitar pula pro nome.
let typed = '', typedAt = 0;
fileList.onkeydown = (e) => {
  const t = active();
  if (!t?.alive) return;
  const rows = [...fileList.querySelectorAll('.row')];
  const cur = fileList.querySelector('.row.sel');
  const i = rows.indexOf(cur);
  const page = Math.max(1, Math.floor(fileList.clientHeight / (rows[0]?.offsetHeight || 24)) - 1);
  const move = e.altKey ? undefined : { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: rows.length - 1, PageDown: i + page, PageUp: i - page }[e.key];
  if (move !== undefined) select(rows[Math.max(0, Math.min(rows.length - 1, move))]);
  else if (e.key === 'Enter') cur?.open();
  else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) goUp(t);
  else if (e.altKey && e.key === 'ArrowLeft') go(t, 'back', 'fwd');
  else if (e.altKey && e.key === 'ArrowRight') go(t, 'fwd', 'back');
  else if (e.key === 'F2') cur?.rename?.();
  else if (e.key === 'Delete') cur?.remove?.();
  else if (e.key === 'F5') refreshFiles();
  else if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
    typed = (Date.now() - typedAt > 800 ? '' : typed) + e.key.toLowerCase();
    typedAt = Date.now();
    select(rows.find((x) => x.dataset.name.toLowerCase().startsWith(typed)) || cur);
  } else return;
  e.preventDefault();
};
// Botões laterais do mouse
$('#files').onmouseup = (e) => { if (e.button === 3) go(active(), 'back', 'fwd'); if (e.button === 4) go(active(), 'fwd', 'back'); };

fileList.oncontextmenu = async () => {
  const t = active();
  if (!t?.alive) return;
  select(null);
  const pick = await api.menu([{ id: 'mkdir', label: 'Nova pasta' }, { id: 'up', label: 'Upload...' }, { id: 'copy', label: 'Copiar caminho' }, { id: 'ref', label: 'Atualizar (F5)' }]);
  if (pick === 'mkdir') { const n = await ask('Nome da pasta'); if (n) { t.sel = n; run(api.mkdir(t.id, join(t.cwd, n)).then(refreshFiles)); } }
  if (pick === 'up') $('#picker').click();
  if (pick === 'copy') run(navigator.clipboard.writeText(t.cwd), 'Caminho copiado');
  if (pick === 'ref') refreshFiles();
};

async function upload(files) {
  const t = active();
  if (!t?.alive || !files.length) return;
  toast(`Enviando ${files.length} arquivo(s)...`);
  await run(api.upload(t.id, [...files].map(api.filePath), t.cwd).then(refreshFiles), 'Upload concluído');
}
$('#picker').onchange = (e) => { upload(e.target.files); e.target.value = ''; };
fileList.ondragover = (e) => { e.preventDefault(); fileList.classList.add('drop'); };
fileList.ondragleave = () => fileList.classList.remove('drop');
fileList.ondrop = (e) => { e.preventDefault(); fileList.classList.remove('drop'); upload(e.dataTransfer.files); };

$('#up').onclick = () => goUp(active());
$('#back').onclick = () => go(active(), 'back', 'fwd');
$('#fwd').onclick = () => go(active(), 'fwd', 'back');
$('#refresh').onclick = refreshFiles;

// Clicar no fundo do breadcrumb (ou Ctrl+L) vira campo de texto pra digitar o caminho.
const editPath = () => { $('#crumbs').hidden = true; $('#cwd').hidden = false; $('#cwd').select(); };
const showCrumbs = () => { $('#cwd').hidden = true; $('#crumbs').hidden = false; };
$('#crumbs').onclick = (e) => e.target === e.currentTarget && active()?.alive && editPath();
$('#files').addEventListener('keydown', (e) => { if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); editPath(); } });
$('#cwd').onblur = showCrumbs;
$('#cwd').onkeydown = (e) => {
  const t = active();
  if (e.key === 'Escape') fileList.focus();
  if (e.key === 'Enter' && t?.alive) { cd(t, e.target.value.trim() || '/'); fileList.focus(); }
};

// prompt() não existe no Electron; diálogo próprio
function ask(label, value = '') {
  $('#ask-label').textContent = label;
  $('#ask-input').value = value;
  $('#ask').returnValue = '';
  $('#ask').showModal();
  $('#ask-input').select();
  return new Promise((res) => ($('#ask').onclose = () => res($('#ask').returnValue === 'ok' ? $('#ask-input').value.trim() : null)));
}

api.conns().then((list) => { conns = list; renderTree(); });
