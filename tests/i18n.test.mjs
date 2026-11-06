// Localization coverage: every English key the engine client (native/*.ts)
// shows is translated in every locale (en-GB → en-US, es-ES → es-419,
// fr-CA → fr-FR inherit), placeholders and markup survive, no table keeps a
// key nothing shows (assets/strings.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { codeKeys, audit } from './i18n-common.mjs';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const TABLES = JSON.parse(read('assets/strings.json'));

export function usedKeys() {
  const keys = new Set();
  for (const f of readdirSync(new URL('native/', ROOT)).filter((n) => n.endsWith('.ts'))) codeKeys(read('native/' + f)).forEach((k) => keys.add(k));
  // Caption keys (native/audio.ts CAPTIONS, shown with T()).
  const audio = read('native/audio.ts');
  const caps = audio.slice(audio.indexOf('const CAPTIONS'), audio.indexOf('};', audio.indexOf('const CAPTIONS')));
  for (const m of caps.matchAll(/:\s*"([^"]+)"/g)) keys.add(m[1]);
  return [...keys].filter((k) => /[A-Za-z]/.test(k)).sort();
}

test('every used key is translated in every locale; placeholders intact; nothing unused', () => {
  const used = usedKeys();
  assert.ok(used.length > 200, 'keys found: ' + used.length);
  assert.deepEqual(audit(TABLES, used), []);
});

test('regional variants inherit through the engine chain; the generated tables hold what they did', () => {
  assert.equal(TABLES['de-DE'].Orders, 'Aufträge');
  assert.equal(TABLES['fr-CA']['Score {n}'], 'Pointage {n}');
  assert.equal(TABLES['en-GB'].Fulfill, 'Fulfil');
  assert.equal(TABLES['es-ES'].Settings, 'Ajustes');
  assert.equal(TABLES['en-US'].Orders, 'Orders');
});
