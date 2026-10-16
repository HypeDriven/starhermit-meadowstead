// Localization coverage: every English key the markup and code use is
// translated in every locale (en-GB → en-US, es-ES → es-419, fr-CA → fr-FR
// inherit), placeholders survive, the language follows sh-language.js and
// switches live, and the Graphics and StarHermit strings cover the nine locales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTables, codeKeys, htmlKeys, audit, bootI18n, LOCALES } from './i18n-common.mjs';
import { SH_STRINGS } from '../js/sh-strings.js';
import { gfxText } from '../js/gfx-strings.js';

const ROOT = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

function usedKeys() {
  const keys = new Set(htmlKeys(read('index.html')));
  for (const f of ['js/main.js', 'js/platform.js', 'js/audio.js']) codeKeys(read(f)).forEach((k) => keys.add(k));
  return [...keys].sort();
}

test('every used key is translated in every locale; placeholders intact', () => {
  const used = usedKeys();
  assert.ok(used.length > 200, 'keys found: ' + used.length);
  assert.deepEqual(audit(loadTables(ROOT, 'js/strings.js', 'MS_STRINGS'), used), []);
});

test('no player-facing literal bypasses T() in the HUD code paths', () => {
  const src = read('js/main.js');
  // Old hard-coded English that must now go through T().
  for (const s of ["'Fulfill'", "'Score '", "'Stage '", "'Empty plot '", "'Hint: '", "'Loading…'", "'Start'"]) {
    assert.ok(!new RegExp(`(textContent|innerHTML) = ${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(src), s);
  }
});

test('the locale follows sh-language and switches live', () => {
  const { I18N, events, doc } = bootI18n(ROOT, { strings: 'js/strings.js', i18n: 'js/i18n.js', global: 'MSI18N', languages: ['de-DE'] });
  assert.equal(I18N.lang, 'de-DE');
  assert.equal(doc.documentElement.lang, 'de-DE');
  assert.equal(I18N.T('Orders'), 'Aufträge');
  I18N.language.setChoice('fr-CA');
  assert.equal(I18N.lang, 'fr-CA');
  assert.equal(events.at(-1), 'fr-CA');
  assert.equal(I18N.T('Score {n}', { n: 12 }), 'Pointage 12');
  assert.equal(I18N.T('Orders'), 'Commandes');
  I18N.language.setChoice('en-GB');
  assert.equal(I18N.T('Fulfill'), 'Fulfil');
  I18N.language.setChoice('es-ES');
  assert.equal(I18N.T('Settings'), 'Ajustes');
  assert.equal(I18N.T('Turnip'), 'Nabo');
});

test('Graphics and StarHermit strings cover all nine locales', () => {
  const shKeys = Object.keys(SH_STRINGS['en-US']);
  for (const l of LOCALES) {
    assert.ok(SH_STRINGS[l], l);
    for (const k of shKeys) assert.ok(SH_STRINGS[l][k], `${l} ${k}`);
    assert.ok(gfxText(l, 'quality'), `${l} gfx quality`);
  }
  assert.equal(gfxText('de-DE', 'section'), 'Grafik');
});
