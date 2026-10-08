# Changelog

## 0.1.1

- Correction : points et petits traits colorés parasites sur certaines cartes graphiques. Le SVG est désormais rasterisé en mémoire CPU avant d'être envoyé au GPU, et les mipmaps sont désactivées pour les textures Vellum.

## 0.1.0

- Première version.
- Détection automatique des fonds de scène et tuiles au format SVG.
- Re-rasterisation adaptative au zoom (rendu net à la résolution de l'écran).
- Réglages client : activation, qualité, budget mémoire, mode débogage.
- API console `game.modules.get("vellum").api` pour le diagnostic.
