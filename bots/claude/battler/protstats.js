const fs = require('fs'), path = require('path');
const PROT = new Set(['Protect','Detect','Spiky Shield',"King's Shield",'Baneful Bunker','Silk Trap','Burning Bulwark','Obstruct']);
function analyze(lines, me) {
  const op = me === 'p1' ? 'p2' : 'p1';
  const out = [];
  let turn = 0; const sw = {}, last = {}, hp = {}, used = {}; let ours = 0, blocked = 0, pendingOur = null;
  const pre = [];
  for (const l of lines) { const p = l.split('|'); if (p[1] === 'move' && p[2].startsWith(op) && PROT.has(p[3])) used[p[2].slice(0,2)+p[2].slice(3)] = 1; }
  for (const l of lines) {
    const p = l.split('|');
    if (p[1] === 'turn') { turn = +p[2]; continue; }
    if (p[1] === 'switch' || p[1] === 'drag') { const id = p[2].slice(0,2)+p[2].slice(3); sw[id] = turn; last[id] = ''; const c = (p[4]||'').split(' ')[0].split('/'); hp[id] = c[1] ? 100*c[0]/c[1] : 100; continue; }
    if (p[1] === '-damage' || p[1] === '-heal') { const id = p[2].slice(0,2)+p[2].slice(3); const c = (p[3]||'').split(' ')[0].split('/'); hp[id] = c[0] === '0' ? 0 : c[1] ? 100*c[0]/c[1] : hp[id]; continue; }
    if (p[1] === '-activate' && p[3] === 'move: Protect' && p[2].startsWith(op) && pendingOur) { blocked++; pendingOur = null; continue; }
    if (p[1] === 'move') {
      const id = p[2].slice(0,2)+p[2].slice(3);
      if (p[2].startsWith(me)) { if (p[4] && p[4].startsWith(op) && !PROT.has(p[3]) && !l.includes('[still]')) { ours++; pendingOur = 1; } else pendingOur = null; continue; }
      pendingOur = null;
      if (l.includes('[from]')) continue;
      out.push({ has: !!used[id], first: sw[id] === turn - 1, protLast: PROT.has(last[id] || ''), low: (hp[id] ?? 100) < 50, turn, prot: PROT.has(p[3]) });
      last[id] = p[3];
    }
  }
  return { out, ours, blocked };
}
module.exports = { analyze };
if (require.main === module) {
  const root = process.argv[2];
  const rows = []; let ours = 0, blocked = 0, games = 0;
  for (const d of fs.readdirSync(root)) {
    const dir = path.join(root, d); if (!fs.statSync(dir).isDirectory()) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    if (!files.length) continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, files[files.length-1]), 'utf8')); } catch { continue; }
    const s = JSON.stringify(j);
    let lines = null;
    (function find(o) { if (lines || !o || typeof o !== 'object') return; for (const k in o) { if (k === 'protocol_log' && Array.isArray(o[k])) { lines = o[k]; return; } find(o[k]); } })(j);
    if (!lines) continue;
    lines = lines.flatMap(x => String(x).split('\n'));
    const m = /"team":\{"(p[12]):/.exec(s); if (!m) continue;
    const r = analyze(lines, m[1]); rows.push(...r.out); ours += r.ours; blocked += r.blocked; games++;
  }
  const rate = (f) => { const a = rows.filter(f); return `${a.filter(x => x.prot).length}/${a.length}=${(a.filter(x=>x.prot).length/Math.max(1,a.length)).toFixed(3)}`; };
  console.log('games', games, 'our attacks', ours, 'blocked', blocked, (blocked/ours).toFixed(3));
  console.log('all', rate(x => true), '| has', rate(x => x.has));
  console.log('has&first', rate(x => x.has && x.first), 'has&!first', rate(x => x.has && !x.first));
  console.log('has&protLast', rate(x => x.has && x.protLast), 'has&!protLast', rate(x => x.has && !x.protLast));
  console.log('has&!protLast&low', rate(x => x.has && !x.protLast && x.low), 'has&!protLast&high', rate(x => x.has && !x.protLast && !x.low));
  console.log('has&!protLast&turn1', rate(x => x.has && !x.protLast && x.turn === 1), 'has&!protLast&turn>1&!first', rate(x => x.has && !x.protLast && x.turn > 1 && !x.first));
}
