/* Meadowstead — StarHermit platform adapter over the shared SDK
   (window.StarHermit from starhermit-sdk.js). The SDK owns the launch token,
   renewal, profile lookup, the game:<slug> cloud-save slot, the settings KV,
   key bindings, friends and invite links; this adapter keeps the game's API.
   Hosted mode = signed in: a finished ranked run is also posted to the
   StarHermit high-score board (StarHermit.submitScores, score-script.js).
   Without a token nothing here makes any network request: local clock,
   local boards, local achievements, no telemetry.
   Cloud saves are conditional (the SDK sends the version it last read): when
   another device saved first the SDK emits 'saveconflict'; the adapter reloads
   the cloud document, hands it to applyDoc to merge, and saves the merge. */

const SETTINGS_DEBOUNCE_MS = 1500;
const N = (key) => key; // marks a key for the game's T()
const SYNC_TEXT = { synced: N('☁ synced'), saving: N('☁ saving…'), offline: N('☁ offline') };

/* Merge another device's progress with this one: the further journey stage and
   larger counters win, achievements / dailies / friends are united, and the
   local board keeps the best 50 runs from both. Nothing either side earned is lost. */
export function mergeProgress(local, remote) {
  const a = local || {}, b = remote || {};
  const num = (x) => (Number.isFinite(x) ? x : 0);
  const out = Object.assign({}, b, a);
  out.journeyStage = Math.max(num(a.journeyStage) || 1, num(b.journeyStage) || 1);
  out.masteryXp = Math.max(num(a.masteryXp), num(b.masteryXp));
  out.lifetimeCoins = Math.max(num(a.lifetimeCoins), num(b.lifetimeCoins));
  out.craftTotal = Math.max(num(a.craftTotal), num(b.craftTotal));
  out.tutorialDone = !!(a.tutorialDone || b.tutorialDone);
  out.achievements = Object.assign({}, b.achievements || {}, a.achievements || {});
  for (const [k, t] of Object.entries(b.achievements || {})) if (out.achievements[k] > t) out.achievements[k] = t; // earliest unlock
  out.completedDailies = Object.assign({}, b.completedDailies || {});
  for (const [d, sc] of Object.entries(a.completedDailies || {})) out.completedDailies[d] = Math.max(num(sc), num(out.completedDailies[d]));
  // The streak belongs to whichever side played the latest daily.
  const newer = String(b.lastDailyDate || '') > String(a.lastDailyDate || '') ? b : a;
  out.lastDailyDate = newer.lastDailyDate || null;
  out.dailyStreak = a.lastDailyDate === b.lastDailyDate ? Math.max(num(a.dailyStreak), num(b.dailyStreak)) : num(newer.dailyStreak);
  out.friends = [...new Set([...(b.friends || []), ...(a.friends || [])])];
  const seen = new Set();
  out.localBoard = [...(a.localBoard || []), ...(b.localBoard || [])].filter((row) => {
    const id = [row.name, row.score, row.mode, row.seed, row.when].join('|');
    if (seen.has(id)) return false;
    seen.add(id); return true;
  }).sort((x, y) => y.score - x.score).slice(0, 50);
  return out;
}
/**
 * deps: { sh, store, buildDoc(), applyDoc(doc, { newer }), onIdentity(), onAuth(a), onMerged(), syncEl(), T(key, vars) }
 * store is the game's {get,set} localStorage wrapper.
 */
export function createPlatform(deps) {
  const sh = deps.sh || globalThis.StarHermit;
  const store = deps.store;
  const T = deps.T || ((key, vars) => String(key).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m)));
  let lastSettings = null;
  let pendingPatch = null;
  let settingsTimer = null;

  const platform = {
    get hosted() { return !!sh.signedIn; },
    get userId() { return sh.userId; },
    get gameSlug() { return sh.slug || 'meadowstead'; },
    _name: null,
    sync: 'offline', // synced | saving | offline — shown in the sync chip

    async init() {
      sh.init();
      sh.on('saved', (ok) => this.setSync(ok ? 'synced' : 'offline'));
      sh.on('saveconflict', () => this.resolveConflict());
      sh.on('auth', (a) => {
        if (!a.signedIn) { this._name = null; this.setSync('offline'); }
        if (deps.onAuth) deps.onAuth(a);
      });
      if (this.hosted) {
        // the device clock is used everywhere (no time probe)
        this.fetchProfile(); // not awaited: the name chip fills in when it resolves
        this.setSync('saving');
        await this.cloudLoad(); // remote-preferred; localStorage stays the offline cache
      }
    },
    now() { return Date.now(); },
    utcDate() { return new Date(this.now()).toISOString().slice(0, 10); },

    async fetchProfile() {
      const p = this.hosted ? await sh.profile() : null;
      this._name = p ? p.nickname : null; // nickname only — never the username
      if (deps.onIdentity) deps.onIdentity();
    },
    displayName() {
      if (this._name) return this._name;
      if (this.userId) return T('Player {id}', { id: String(this.userId).slice(0, 6) });
      return T('You');
    },

    /* ---- cloud save: the game:<slug> slot; localStorage stays the offline cache ---- */
    async cloudLoad() {
      if (!this.hosted) return;
      const doc = await sh.loadJSON();
      if (doc && typeof doc === 'object') {
        // Progress from both sides is merged (applyDoc); settings only from a newer save.
        const meta = store.get('cloud-meta', null);
        const newer = !meta || !doc.savedAt || doc.savedAt > meta.savedAt;
        deps.applyDoc(doc, { newer });
        if (newer) store.set('cloud-meta', { savedAt: doc.savedAt || Date.now() });
      }
      this.setSync('synced');
    },
    /* Another device saved since our last load: reload, merge, save the merge. */
    async resolveConflict() {
      if (!this.hosted) return;
      const doc = await sh.loadJSON();
      if (doc && typeof doc === 'object') deps.applyDoc(doc, { newer: false });
      if (deps.onMerged) deps.onMerged();
      if (!sh.saveConflicted()) this.cloudSaveSoon();
    },
    cloudSaveSoon() {
      if (!this.hosted) return;
      this.setSync('saving');
      const doc = deps.buildDoc();
      store.set('cloud-meta', { savedAt: doc.savedAt });
      sh.saveJSON(doc, 2000); // debounced
    },
    cloudFlush() {
      if (!this.hosted) return;
      sh.flushSave(true); // pagehide/visibilitychange: keepalive PUT
      this.flushSettings();
    },

    /* ---- settings KV: per-player preferences, changed keys only ---- */
    async loadSettings() { return this.hosted ? (await sh.getSettings()) || {} : {}; },
    primeSettings(obj) { lastSettings = JSON.stringify(obj); },
    pushSettings(obj) {
      if (!this.hosted || lastSettings === null) return;
      const json = JSON.stringify(obj);
      if (json === lastSettings) return;
      const prev = JSON.parse(lastSettings);
      lastSettings = json;
      pendingPatch = pendingPatch || {};
      for (const k of Object.keys(obj)) {
        if (JSON.stringify(obj[k]) !== JSON.stringify(prev[k])) pendingPatch[k] = obj[k];
      }
      clearTimeout(settingsTimer);
      settingsTimer = setTimeout(() => this.flushSettings(), SETTINGS_DEBOUNCE_MS);
    },
    flushSettings() {
      clearTimeout(settingsTimer);
      settingsTimer = null;
      if (!pendingPatch || !this.hosted) return Promise.resolve(null);
      const patch = pendingPatch;
      pendingPatch = null;
      return sh.patchSettings(patch);
    },

    /* ---- controls, sign-in, invite ---- */
    loadBindings(defaults) { return this.hosted ? sh.loadBindings(defaults) : Promise.resolve(defaults); },
    canSignIn() { return sh.canSignIn(); },
    signIn() { return sh.signIn(); },
    inviteLink() { return this.hosted ? sh.inviteLink() : null; },

    /* ---- friends (platform account) with nicknames + online state ---- */
    async friends() {
      if (!this.hosted) return [];
      const list = await sh.friends();
      return Promise.all((list || []).map(async (f) => ({
        userId: f.userId,
        name: await this.nicknameFor(f.userId),
        online: !!f.online,
      })));
    },

    /* ---- platform leaderboard (read-only; ranked boards are server-owned) ---- */
    /* Post a finished ranked run to the leaderboards (score-script.js); resolves
       { posted, rank } — rank on the high-score board, or null. Signed in only. */
    async submitScore(total) {
      if (!this.hosted) return { posted: false, rank: null };
      try {
        const keys = await sh.submitScores({ 'high-score': total });
        if (!(keys || []).includes('high-score')) return { posted: false, rank: null };
        try {
          const r = await sh.leaderboard('high-score', { pageSize: 100 });
          const me = (r.items || []).find((e) => String(e.userId) === String(this.userId));
          return { posted: true, rank: me ? me.rank : null };
        } catch { return { posted: true, rank: null }; }
      } catch { return { posted: false, rank: null }; }
    },
    async leaderboardEntries(friendsOnly) {
      if (!this.hosted) return [];
      const lb = await sh.leaderboard(null, { pageSize: friendsOnly ? 100 : 20 });
      if (!lb || !lb.board) return []; // no platform board for this game: local records only
      let items = lb.items || [];
      if (friendsOnly) {
        // The SDK has no friendsOnly filter: keep the player's own and friends' rows.
        const ids = new Set(((await sh.friends()) || []).map((f) => String(f.userId)));
        ids.add(String(this.userId));
        items = items.filter((e) => ids.has(String(e.userId)));
      }
      const rows = [];
      for (const e of items.slice(0, 20)) {
        const uid = e.userId;
        rows.push({
          userId: uid,
          name: String(uid) === String(this.userId) ? this.displayName() : await this.nicknameFor(uid),
          score: e.score != null ? e.score : (e.bestScore != null ? e.bestScore : 0),
        });
      }
      return rows;
    },
    async nicknameFor(userId) {
      if (userId == null) return T('Player');
      const p = await sh.profile(userId);
      return p ? p.displayName : T('Player {id}', { id: String(userId).slice(0, 6) });
    },

    syncText() { return SYNC_TEXT[this.sync] ? T(SYNC_TEXT[this.sync]) : ('☁ ' + this.sync); },
    setSync(state) {
      this.sync = state;
      const el = deps.syncEl && deps.syncEl();
      if (!el) return;
      el.hidden = !this.hosted;
      el.textContent = this.syncText();
    },
  };
  return platform;
}
