/* Meadowstead — localization (js/i18n.js).
 *
 * Nine locales: en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT.
 * English source strings are the keys; js/strings.js holds the tables
 * (en-GB, es-ES and fr-CA carry only their differences from en-US, es-419
 * and fr-FR). The engine client (native/i18n.ts) picks the locale from the
 * runtime's interface language and calls setLocale; every string drawn is
 * looked up with T() each frame, so a change shows at once.
 * Classic script (loadClassic natively, vm in the tests): global MSI18N.
 */
(function (root) {
  'use strict';

  var LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  var PARENT = { 'en-GB': 'en-US', 'es-ES': 'es-419', 'fr-CA': 'fr-FR' };
  var lang = 'en-US';
  var hasOwn = Object.prototype.hasOwnProperty;

  function lookup(key) {
    for (var l = lang; l; l = PARENT[l]) {
      var t = (root.MS_STRINGS || {})[l];
      if (t && hasOwn.call(t, key)) return t[key];
    }
    return key;
  }

  /** Translate an English source string; {name} placeholders filled from vars. */
  function T(key, vars) {
    var s = lookup(String(key));
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return hasOwn.call(vars, k) ? String(vars[k]) : m; });
    return s;
  }

  /** The supported locale for a BCP 47 tag: exact, then by language (en-GB/es-ES/fr-CA by region), else en-US. */
  function pickLocale(tag) {
    var t = String(tag || '');
    for (var i = 0; i < LOCALES.length; i++) if (LOCALES[i].toLowerCase() === t.toLowerCase()) return LOCALES[i];
    var l = t.split('-')[0].toLowerCase();
    if (l === 'en') return /-(gb|uk|ie|au|nz)$/i.test(t) ? 'en-GB' : 'en-US';
    if (l === 'es') return /-es$/i.test(t) ? 'es-ES' : 'es-419';
    if (l === 'fr') return /-ca$/i.test(t) ? 'fr-CA' : 'fr-FR';
    return { de: 'de-DE', pt: 'pt-BR', it: 'it-IT' }[l] || 'en-US';
  }

  function setLocale(next) {
    lang = LOCALES.indexOf(next) >= 0 ? next : 'en-US';
    return lang;
  }

  root.MSI18N = {
    T: T,
    setLocale: setLocale,
    pickLocale: pickLocale,
    get lang() { return lang; },
    locales: LOCALES,
    get tables() { return root.MS_STRINGS || {}; }
  };
})(globalThis);
