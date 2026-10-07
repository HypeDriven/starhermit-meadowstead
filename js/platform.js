/* Meadowstead — StarHermit platform adapter over the shared SDK
   (window.StarHermit from starhermit-sdk.js). The SDK owns the launch token,
   renewal, profile lookup, the game:<slug> cloud-save slot, the settings KV,
   key bindings, friends and invite links; this adapter keeps the game's API.
   Hosted mode = signed in: a finished ranked run is also posted to the
   StarHermit high-score board (StarHermit.submitScores, score-script.js).
   Without a token nothing here makes any network request: local clock,
   local boards, local achievements, no telemetry. */

const SETTINGS_DEBOUNCE_MS = 1500;
const SYNC_TEXT = { synced: '☁ synced', saving: '☁ saving…', offline: '☁ offline' };

/**
 * deps: { sh, store, buildDoc(), applyDoc(doc), onIdentity(), onAuth(a), syncEl() }
 * store is the game's {get,set} localStorage wrapper.
 */
export function createPlatform(deps) {
  const sh = deps.sh || globalThis.StarHermit;
  const store = deps.store;
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
      if (this.userId) return 'Player ' + String(this.userId).slice(0, 6);
      return 'You';
    },

    /* ---- cloud save: the game:<slug> slot; localStorage stays the offline cache ---- */
    async cloudLoad() {
      if (!this.hosted) return;
      const doc = await sh.loadJSON();
      if (doc && typeof doc === 'object') {
        // on conflict prefer the remote copy
        const meta = store.get('cloud-meta', null);
        if (!meta || !doc.savedAt || doc.savedAt > meta.savedAt) {
          deps.applyDoc(doc);
          store.set('cloud-meta', { savedAt: doc.savedAt || Date.now() });
        }
      }
      this.setSync('synced');
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
      if (userId == null) return 'Player';
      const p = await sh.profile(userId);
      return p ? p.displayName : 'Player ' + String(userId).slice(0, 6);
    },

    setSync(state) {
      this.sync = state;
      const el = deps.syncEl && deps.syncEl();
      if (!el) return;
      el.hidden = !this.hosted;
      el.textContent = SYNC_TEXT[state] || ('☁ ' + state);
    },
  };
  return platform;
}
