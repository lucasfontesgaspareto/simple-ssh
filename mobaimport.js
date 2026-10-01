// Parser de sessões do MobaXterm (.mxtsessions exportado e MobaXterm.ini usam o mesmo formato).
// Linha SSH: nome=#109#0%host%porta%usuario%...%chave%...  (chave no campo 14, _ProfileDir_ = %USERPROFILE%)

function parse(text) {
  const out = [];
  let inBookmarks = false;
  let folder = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inBookmarks = /^\[Bookmarks(_\d+)?\]$/.test(line);
      folder = '';
      continue;
    }
    if (!inBookmarks) continue;
    if (line.startsWith('SubRep=')) { folder = line.slice(7); continue; }
    const at = line.indexOf('=#109#');
    if (at < 0) continue; // só SSH; WSL (#105#), RDP etc. ficam de fora
    const f = line.slice(at + 6).split('#')[0].split('%');
    out.push({
      folder,
      name: line.slice(0, at),
      host: f[1],
      port: Number(f[2]) || 22,
      user: f[3] || '',
      keyPath: (f[14] || '').replace(/^_ProfileDir_/, '%USERPROFILE%'),
    });
  }
  return out;
}

// Dedup por pasta + host + usuário: existente é atualizado, novo é adicionado.
function merge(existing, imported, newId) {
  const key = (c) => `${c.folder}|${c.host}|${c.user}`.toLowerCase();
  const byKey = new Map(existing.map((c) => [key(c), c]));
  let added = 0, updated = 0;
  for (const c of imported) {
    const hit = byKey.get(key(c));
    if (hit) { Object.assign(hit, c); updated++; }
    else { const n = { id: newId(), ...c }; existing.push(n); byKey.set(key(n), n); added++; }
  }
  return { added, updated };
}

// Inverso do parse: gera um .mxtsessions que o MobaXterm e o próprio import aceitam.
function serialize(conns) {
  const byFolder = new Map([['', []]]);
  for (const c of conns) byFolder.set(c.folder || '', [...(byFolder.get(c.folder || '') || []), c]);
  const out = [];
  [...byFolder.keys()].sort().forEach((folder, i) => {
    out.push(i ? `[Bookmarks_${i}]` : '[Bookmarks]', `SubRep=${folder}`, 'ImgNum=42');
    for (const c of byFolder.get(folder)) {
      const key = (c.keyPath || '').replace(/^%USERPROFILE%/i, '_ProfileDir_');
      out.push(`${c.name.replace(/[=#%]/g, '_')}=#109#0%${c.host}%${c.port || 22}%${c.user}%%-1%-1%%%%%0%0%0%${key}%%-1%0#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%<none>%xterm%-1%-1%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1#0# #-1`);
    }
    out.push('');
  });
  return out.join('\r\n');
}

module.exports = { parse, merge, serialize };

if (require.main === module) {
  const assert = require('node:assert');
  const sample = [
    '[Bookmarks]', 'SubRep=', 'ImgNum=42',
    'wsl=#105#14%0%%Ubuntu%%%%#MobaFont%10',
    '[Bookmarks_1]', 'SubRep=Jointer\\Dev', 'ImgNum=41',
    'dev - bastion=#109#0%10.0.0.1%2222%opc%%-1%-1%%%%%0%0%0%_ProfileDir_\\keys\\a.key%%-1%0#MobaFont%10',
    'root box=#109#0%10.0.0.2%22%root%%-1%-1%%%%%0%0%0%%%-1%0#MobaFont%10',
    '[Misc]', 'x=#109#0%nope%22%x',
  ].join('\r\n');
  const s = parse(sample);
  assert.strictEqual(s.length, 2);
  assert.deepStrictEqual(s[0], { folder: 'Jointer\\Dev', name: 'dev - bastion', host: '10.0.0.1', port: 2222, user: 'opc', keyPath: '%USERPROFILE%\\keys\\a.key' });
  assert.strictEqual(s[1].keyPath, '');
  let n = 0;
  const list = [];
  assert.deepStrictEqual(merge(list, s, () => ++n), { added: 2, updated: 0 });
  assert.deepStrictEqual(merge(list, s, () => ++n), { added: 0, updated: 2 });
  assert.strictEqual(list.length, 2);
  const byName = (a, b) => a.name.localeCompare(b.name);
  assert.deepStrictEqual(parse(serialize(s)).sort(byName), [...s].sort(byName));

  // node mobaimport.js arquivo1 arquivo2 ... → resumo do que seria importado
  const all = [];
  for (const file of process.argv.slice(2)) {
    const r = merge(all, parse(require('node:fs').readFileSync(file, 'latin1')), () => ++n);
    console.log(`${file}: +${r.added} ~${r.updated}`);
  }
  if (all.length) console.log(`total: ${all.length} conexões em ${new Set(all.map((c) => c.folder)).size} pastas`);
  console.log('ok');
}
