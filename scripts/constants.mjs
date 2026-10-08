export const MODULE_ID = "vellum";

/** Multiplicateurs de qualité, indexés par la clé du réglage. */
export const QUALITY_FACTORS = {
  low: 0.75,
  normal: 1,
  high: 1.5,
  ultra: 2
};

/** Délai (ms) après le dernier zoom/déplacement avant de redessiner. */
export const SETTLE_DELAY = 200;

/** On redessine en plus fin quand la cible dépasse la résolution actuelle de ce facteur. */
export const UPSCALE_THRESHOLD = 1.2;

/** On redessine en plus petit (pour libérer la mémoire) sous ce facteur. */
export const DOWNSCALE_THRESHOLD = 0.5;

/** Taille minimale (côté le plus long, en px) d'un rendu Vellum. */
export const MIN_RENDER_SIZE = 512;

/** Plafond absolu de taille de texture, même si le GPU accepte plus. */
export const HARD_TEXTURE_CAP = 16384;
