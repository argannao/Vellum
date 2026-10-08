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

/** Délai (ms) après le dernier zoom/déplacement avant de mettre à jour la zone visible. */
export const SETTLE_DELAY = 100;

/**
 * Taille des tuiles (px). 512 px : assez petit pour qu'une tuile se dessine et
 * s'envoie au GPU en une image (~16 ms), assez grand pour limiter le surcoût fixe
 * de chaque dessin.
 */
export const TILE_SIZE = 512;

/** Tuiles de marge préparées autour de la zone visible, de chaque côté. */
export const VIEW_MARGIN_TILES = 1;

/**
 * Tolérance (en puissance de 2) avant de passer au niveau de zoom supérieur :
 * 0,4 accepte un agrandissement jusqu'à ×1,32 avant de redessiner plus fin, et
 * limite le surplus de résolution (et donc de calcul) à ×1,5 environ.
 */
export const LEVEL_BIAS = 0.4;

/** Temps maximum (ms) de dessin d'affilée avant de rendre la main au navigateur. */
export const FRAME_BUDGET = 12;

/** Plafond absolu de taille de texture, même si le GPU accepte plus. */
export const HARD_TEXTURE_CAP = 16384;
