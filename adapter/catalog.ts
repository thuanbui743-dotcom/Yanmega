// Builds data/platform-cards.json (card_id -> full platform card) from captured draft states.
// Usage: npx tsx adapter/catalog.ts <captures dir> [more dirs...]
import * as fs from 'fs';
import * as path from 'path';

const out = path.join(__dirname, '..', 'data', 'platform-cards.json');
const catalog: Record<string, any> = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {};
const before = Object.keys(catalog).length;
const walk = (p: string): string[] => fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap(f => walk(path.join(p, f))) : [p];
for (const dir of process.argv.slice(2)) {
  for (const f of walk(dir).filter(f => f.endsWith('.json'))) {
    try {
      const st = JSON.parse(fs.readFileSync(f, 'utf8')).state;
      for (const c of st?.observation?.available_cards ?? []) if (c?.card_id) catalog[c.card_id] = c;
    } catch { /* skip unreadable files */ }
  }
}
fs.writeFileSync(out, JSON.stringify(catalog, null, 1));
console.log(`catalog: ${Object.keys(catalog).length} cards (+${Object.keys(catalog).length - before})`);
