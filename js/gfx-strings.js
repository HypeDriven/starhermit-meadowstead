/* Meadowstead — strings for the Settings → Graphics section in every shipped locale.
   Pure data plus a locale picker (navigator.languages → shipped set, with region fallback). */

const EN = {
  section: 'Graphics',
  quality: 'Quality',
  auto: 'Auto (detected: {tier})',
  p_low: 'Low', p_balanced: 'Balanced', p_high: 'High', p_ultra: 'Ultra',
  renderScale: 'Render scale',
  fromPreset: 'From preset ({tier})',
  c_shadows: 'Shadows', c_ao: 'Ambient occlusion', c_bloom: 'Bloom', c_grade: 'Color grade',
  c_antialias: 'Anti-aliasing', c_reflections: 'Reflections', c_water: 'Pond water', c_wind: 'Wind sway',
  c_particles: 'Particles', c_detail: 'Scenery detail',
  t_off: 'Off', t_on: 'On', t_low: 'Low', t_medium: 'Medium', t_high: 'High',
  t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Still', t_animated: 'Animated',
  t_plain: 'Plain', t_detailed: 'Detailed',
  adaptive: 'Adaptive resolution',
  showFps: 'Show frame rate',
  postFailed: 'Post-processing is unavailable on this device, so the game renders without it.',
  unknownGpu: 'unknown GPU',
  w_noShadows: 'no shadows', w_shadows: 'shadows', w_aoFull: 'full ambient occlusion', w_ao: 'ambient occlusion',
  w_bloom: 'bloom', w_reflections: 'reflections', w_noAA: 'no anti-aliasing',
};

const ES = {
  section: 'Gráficos',
  quality: 'Calidad',
  auto: 'Automática (detectada: {tier})',
  p_low: 'Baja', p_balanced: 'Equilibrada', p_high: 'Alta', p_ultra: 'Ultra',
  renderScale: 'Escala de renderizado',
  fromPreset: 'Según el ajuste ({tier})',
  c_shadows: 'Sombras', c_ao: 'Oclusión ambiental', c_bloom: 'Resplandor', c_grade: 'Corrección de color',
  c_antialias: 'Suavizado de bordes', c_reflections: 'Reflejos', c_water: 'Agua del estanque', c_wind: 'Balanceo por viento',
  c_particles: 'Partículas', c_detail: 'Detalle del paisaje',
  t_off: 'No', t_on: 'Sí', t_low: 'Bajo', t_medium: 'Medio', t_high: 'Alto',
  t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Quieta', t_animated: 'Animada',
  t_plain: 'Simple', t_detailed: 'Detallado',
  adaptive: 'Resolución adaptativa',
  showFps: 'Mostrar fotogramas por segundo',
  postFailed: 'El posprocesado no está disponible en este dispositivo; el juego se muestra sin él.',
  unknownGpu: 'GPU desconocida',
  w_noShadows: 'sin sombras', w_shadows: 'sombras', w_aoFull: 'oclusión ambiental completa', w_ao: 'oclusión ambiental',
  w_bloom: 'resplandor', w_reflections: 'reflejos', w_noAA: 'sin suavizado',
};

export const STRINGS = {
  'en-US': EN,
  'en-GB': Object.assign({}, EN, { c_grade: 'Colour grade' }),
  'es-419': ES,
  'es-ES': Object.assign({}, ES, { renderScale: 'Escala de renderizado', showFps: 'Mostrar FPS' }),
  'de-DE': {
    section: 'Grafik',
    quality: 'Qualität',
    auto: 'Automatisch (erkannt: {tier})',
    p_low: 'Niedrig', p_balanced: 'Ausgewogen', p_high: 'Hoch', p_ultra: 'Ultra',
    renderScale: 'Renderskalierung',
    fromPreset: 'Wie Voreinstellung ({tier})',
    c_shadows: 'Schatten', c_ao: 'Umgebungsverdeckung', c_bloom: 'Bloom', c_grade: 'Farbkorrektur',
    c_antialias: 'Kantenglättung', c_reflections: 'Spiegelungen', c_water: 'Teichwasser', c_wind: 'Wind',
    c_particles: 'Partikel', c_detail: 'Landschaftsdetails',
    t_off: 'Aus', t_on: 'An', t_low: 'Niedrig', t_medium: 'Mittel', t_high: 'Hoch',
    t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Ruhig', t_animated: 'Bewegt',
    t_plain: 'Schlicht', t_detailed: 'Detailliert',
    adaptive: 'Adaptive Auflösung',
    showFps: 'Bildrate anzeigen',
    postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; das Spiel wird ohne sie dargestellt.',
    unknownGpu: 'unbekannte GPU',
    w_noShadows: 'keine Schatten', w_shadows: 'Schatten', w_aoFull: 'volle Umgebungsverdeckung', w_ao: 'Umgebungsverdeckung',
    w_bloom: 'Bloom', w_reflections: 'Spiegelungen', w_noAA: 'keine Kantenglättung',
  },
  'fr-FR': {
    section: 'Graphismes',
    quality: 'Qualité',
    auto: 'Auto (détectée : {tier})',
    p_low: 'Basse', p_balanced: 'Équilibrée', p_high: 'Haute', p_ultra: 'Ultra',
    renderScale: 'Échelle de rendu',
    fromPreset: 'Selon le préréglage ({tier})',
    c_shadows: 'Ombres', c_ao: 'Occlusion ambiante', c_bloom: 'Halo lumineux', c_grade: 'Étalonnage des couleurs',
    c_antialias: 'Anticrénelage', c_reflections: 'Reflets', c_water: 'Eau de la mare', c_wind: 'Balancement au vent',
    c_particles: 'Particules', c_detail: 'Détail du décor',
    t_off: 'Désactivé', t_on: 'Activé', t_low: 'Bas', t_medium: 'Moyen', t_high: 'Élevé',
    t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Immobile', t_animated: 'Animée',
    t_plain: 'Simple', t_detailed: 'Détaillé',
    adaptive: 'Résolution adaptative',
    showFps: 'Afficher la fréquence d’images',
    postFailed: 'Le post-traitement n’est pas disponible sur cet appareil ; le jeu s’affiche sans.',
    unknownGpu: 'GPU inconnu',
    w_noShadows: 'sans ombres', w_shadows: 'ombres', w_aoFull: 'occlusion ambiante complète', w_ao: 'occlusion ambiante',
    w_bloom: 'halo', w_reflections: 'reflets', w_noAA: 'sans anticrénelage',
  },
  'pt-BR': {
    section: 'Gráficos',
    quality: 'Qualidade',
    auto: 'Automática (detectada: {tier})',
    p_low: 'Baixa', p_balanced: 'Equilibrada', p_high: 'Alta', p_ultra: 'Ultra',
    renderScale: 'Escala de renderização',
    fromPreset: 'Conforme a predefinição ({tier})',
    c_shadows: 'Sombras', c_ao: 'Oclusão de ambiente', c_bloom: 'Brilho', c_grade: 'Correção de cor',
    c_antialias: 'Suavização de bordas', c_reflections: 'Reflexos', c_water: 'Água do lago', c_wind: 'Balanço do vento',
    c_particles: 'Partículas', c_detail: 'Detalhe do cenário',
    t_off: 'Desligado', t_on: 'Ligado', t_low: 'Baixo', t_medium: 'Médio', t_high: 'Alto',
    t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Parada', t_animated: 'Animada',
    t_plain: 'Simples', t_detailed: 'Detalhado',
    adaptive: 'Resolução adaptativa',
    showFps: 'Mostrar taxa de quadros',
    postFailed: 'O pós-processamento não está disponível neste dispositivo; o jogo é exibido sem ele.',
    unknownGpu: 'GPU desconhecida',
    w_noShadows: 'sem sombras', w_shadows: 'sombras', w_aoFull: 'oclusão de ambiente completa', w_ao: 'oclusão de ambiente',
    w_bloom: 'brilho', w_reflections: 'reflexos', w_noAA: 'sem suavização',
  },
  'it-IT': {
    section: 'Grafica',
    quality: 'Qualità',
    auto: 'Automatica (rilevata: {tier})',
    p_low: 'Bassa', p_balanced: 'Bilanciata', p_high: 'Alta', p_ultra: 'Ultra',
    renderScale: 'Scala di rendering',
    fromPreset: 'Dalla preimpostazione ({tier})',
    c_shadows: 'Ombre', c_ao: 'Occlusione ambientale', c_bloom: 'Bagliore', c_grade: 'Correzione colore',
    c_antialias: 'Antialiasing', c_reflections: 'Riflessi', c_water: 'Acqua dello stagno', c_wind: 'Oscillazione al vento',
    c_particles: 'Particelle', c_detail: 'Dettaglio del paesaggio',
    t_off: 'No', t_on: 'Sì', t_low: 'Basso', t_medium: 'Medio', t_high: 'Alto',
    t_fxaa: 'FXAA', t_smaa: 'SMAA', t_msaa: 'MSAA', t_static: 'Ferma', t_animated: 'Animata',
    t_plain: 'Semplice', t_detailed: 'Dettagliato',
    adaptive: 'Risoluzione adattiva',
    showFps: 'Mostra frame al secondo',
    postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; il gioco viene mostrato senza.',
    unknownGpu: 'GPU sconosciuta',
    w_noShadows: 'senza ombre', w_shadows: 'ombre', w_aoFull: 'occlusione ambientale completa', w_ao: 'occlusione ambientale',
    w_bloom: 'bagliore', w_reflections: 'riflessi', w_noAA: 'senza antialiasing',
  },
};
STRINGS['fr-CA'] = Object.assign({}, STRINGS['fr-FR'], { c_water: 'Eau de l’étang', showFps: 'Afficher le nombre d’images par seconde' });

export const LOCALES = Object.keys(STRINGS);

/** Narrow the browser's language list to a shipped locale (fr-CA → fr-FR → en-US). */
export function pickLocale(langs) {
  const FALLBACK = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };
  for (const raw of langs || []) {
    const l = String(raw || '');
    const exact = LOCALES.find((x) => x.toLowerCase() === l.toLowerCase());
    if (exact) return exact;
    const base = FALLBACK[l.slice(0, 2).toLowerCase()];
    if (base) return base;
  }
  return 'en-US';
}

/** Look up a string with `{name}` substitution. */
export function gfxText(locale, key, vars) {
  const t = (STRINGS[locale] && STRINGS[locale][key]) || EN[key] || key;
  return vars ? t.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : '')) : t;
}
