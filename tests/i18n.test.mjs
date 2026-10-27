// Localization coverage: every English key the engine client (native/*.ts)
// shows is translated in every locale (en-GB → en-US, es-ES → es-419,
// fr-CA → fr-FR inherit), placeholders and markup survive, no table keeps a
// key nothing shows, the classic js/i18n.js switches locale as native/i18n.ts
// drives it, and the StarHermit account strings cover the nine locales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { loadTables, codeKeys, audit, LOCALES } from './i18n-common.mjs';
import { SH_STRINGS } from '../js/sh-strings.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

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
  assert.deepEqual(audit(loadTables(ROOT, 'js/strings.js', 'MS_STRINGS'), used), []);
});

test('js/i18n.js picks and switches the locale', () => {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('js/strings.js'), sandbox);
  vm.runInContext(read('js/i18n.js'), sandbox);
  const I = sandbox.MSI18N;
  assert.equal(I.pickLocale('de-AT'), 'de-DE');
  assert.equal(I.pickLocale('en-AU'), 'en-GB');
  assert.equal(I.pickLocale('es-MX'), 'es-419');
  assert.equal(I.pickLocale('fr-CA'), 'fr-CA');
  assert.equal(I.pickLocale('ja-JP'), 'en-US');
  I.setLocale('de-DE');
  assert.equal(I.T('Orders'), 'Aufträge');
  I.setLocale('fr-CA');
  assert.equal(I.T('Score {n}', { n: 12 }), 'Pointage 12');
  assert.equal(I.T('Orders'), 'Commandes');
  I.setLocale('en-GB');
  assert.equal(I.T('Fulfill'), 'Fulfil');
  I.setLocale('es-ES');
  assert.equal(I.T('Settings'), 'Ajustes');
  assert.equal(I.T('Turnip'), 'Nabo');
});

test('StarHermit account strings cover all nine locales', () => {
  const shKeys = Object.keys(SH_STRINGS['en-US']);
  for (const l of LOCALES) {
    assert.ok(SH_STRINGS[l], l);
    for (const k of shKeys) assert.ok(SH_STRINGS[l][k], `${l} ${k}`);
  }
});
