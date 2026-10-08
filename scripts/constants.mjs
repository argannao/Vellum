export const MODULE_ID = "vellum";

/** Multiplicateurs de qualité, indexés par la clé du réglage. */
export const QUALITY_FACTORS = {
  low: 0.75,
  normal: 1,
  high: 1.5,
  ultra: 2
};

/** Résolutions possibles du fond de base (côté le plus long, en px). */
export const BASE_RESOLUTIONS = [2048, 4096, 8192];

/** Délai (ms) après le dernier zoom/déplacement avant de redessiner la zone visible. */
export const SETTLE_DELAY = 150;

/**
 * Marge rendue autour de la zone visible, en fraction de sa taille.
 * Permet de se déplacer un peu sans déclencher de nouveau rendu.
 */
export const PATCH_MARGIN = 0.25;

/** On redessine la zone quand le zoom a changé au-delà de ces rapports. */
export const ZOOM_IN_THRESHOLD = 1.15;
export const ZOOM_OUT_THRESHOLD = 0.6;

/** Taille des morceaux pour les rendus découpés (px). */
export const TILE_SIZE = 1024;

/** Temps maximum (ms) de dessin d'affilée avant de rendre la main au navigateur. */
export const FRAME_BUDGET = 12;

/** Plafond absolu de taille de texture, même si le GPU accepte plus. */
export const HARD_TEXTURE_CAP = 16384;
