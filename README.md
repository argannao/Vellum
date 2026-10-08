# Vellum

**Des fonds de scène et des tuiles en SVG, nets à tous les niveaux de zoom, dans Foundry VTT.**

Le vélin était la surface lisse et sans grain des manuscrits enluminés. Vellum apporte la même chose à vos cartes : plus de pixels qui apparaissent quand vous zoomez sur un détail.

> ⚠️ **Version 0.1 en développement.** Le module n'a pas encore été testé en conditions réelles. Retours et rapports de bugs bienvenus dans les [issues](https://github.com/argannao/Vellum/issues).

---

## Le problème

Foundry accepte déjà les fichiers `.svg` comme fond de scène ou comme tuile. Mais il les convertit **une seule fois** en image, à leur taille native, au chargement de la scène. Dès que vous zoomez au-delà de cette taille, le rendu devient flou, exactement comme avec un PNG.

## Ce que fait Vellum

Vellum redessine vos SVG **à la résolution réellement affichée à l'écran** :

- Quand vous zoomez, il attend que le mouvement s'arrête (environ 0,2 s), puis redessine le SVG à la nouvelle résolution.
- Quand vous dézoomez, il réduit la taille de l'image en mémoire, et revient à l'image native de Foundry quand celle-ci suffit.
- L'image reste dans le moteur de rendu de Foundry : **éclairage, brouillard de guerre, vision et murs fonctionnent normalement.**
- Chaque joueur calcule son propre rendu selon son écran et ses réglages. Rien n'est synchronisé, rien n'est stocké dans le monde.

Fonds de scène et tuiles sont gérés de la même façon, sans configuration : il suffit d'utiliser un fichier `.svg`.

## Installation

### Par URL de manifeste (recommandé)

Dans Foundry : **Modules complémentaires → Installer un module**, puis collez dans le champ « URL du manifeste » :

```
https://github.com/argannao/Vellum/releases/latest/download/module.json
```

> Disponible dès la publication de la première release.

### Manuellement

1. Téléchargez `module.zip` depuis la [dernière release](https://github.com/argannao/Vellum/releases/latest).
2. Décompressez-le dans `Data/modules/vellum/` de votre installation Foundry.
3. Redémarrez Foundry et activez **Vellum** dans votre monde.

## Utilisation

1. Activez le module dans votre monde.
2. Choisissez un fichier `.svg` comme fond de scène (configuration de la scène) ou comme tuile.
3. Zoomez : c'est net.

### Réglages

Dans **Paramètres → Configurer les paramètres → Vellum**. Ce sont des réglages **client** : chaque joueur règle Vellum selon sa machine.

| Réglage | Par défaut | Rôle |
|---|---|---|
| Activer le rendu vectoriel | Oui | Désactivé, Foundry affiche les SVG comme d'habitude. |
| Qualité | Écran (×1) | Résolution de rendu par rapport à l'écran. ×1,5 ou ×2 pour un rendu encore plus fin, au prix de plus de mémoire. |
| Budget mémoire par image | 64 Mpx | Taille maximale d'une image rendue (64 Mpx ≈ 256 Mo de mémoire vidéo). À baisser sur les petites configurations. |
| Mode débogage | Non | Affiche le détail de chaque rendu dans la console. |

## Préparer ses SVG

Pour un résultat optimal :

- **Convertissez les textes en tracés** (dans Inkscape : *Chemin → Objet en chemin*). Un SVG affiché comme image ne peut pas charger de polices externes.
- **Intégrez les images** plutôt que de les lier. Les images bitmap contenues dans le SVG restent, elles, limitées à leur propre résolution.
- **Donnez une taille au document** (`width`, `height` ou `viewBox`). C'est cette taille que Foundry utilise pour dimensionner la scène.
- **Évitez les filtres lourds** (flous, ombres portées en grand nombre) : ils ralentissent chaque nouveau rendu.

## Limites connues

- **Plafond de résolution.** Sur une très grande carte très zoomée, la résolution est plafonnée par le budget mémoire et par la taille maximale de texture du GPU (souvent 16 384 px). Le rendu reste bien meilleur que l'image native, mais peut ne plus être parfaitement net au zoom maximal. La version 0.2 lèvera cette limite (voir feuille de route).
- **Court délai au zoom.** Pendant le mouvement, c'est la version précédente qui est affichée, étirée ; la version nette apparaît dès l'arrêt.
- **SVG très complexes.** Le rendu se fait dans le navigateur et peut prendre quelques centaines de millisecondes pour des fichiers très chargés.
- **Fichiers hébergés ailleurs** (S3, autre domaine) : le serveur doit autoriser les requêtes CORS, sinon le SVG reste en résolution native.

## Diagnostic

Ouvrez la console (F12) et tapez :

```js
game.modules.get("vellum").api.inspect()
```

Vous obtenez la liste des SVG détectés, leur taille native et la résolution actuellement rendue par Vellum. Autres commandes :

```js
game.modules.get("vellum").api.refresh() // force un nouveau rendu
game.modules.get("vellum").api.reset()   // revient aux images natives puis recalcule
```

En cas de bug, joignez le résultat de `inspect()` et les messages d'erreur de la console à votre issue.

## Feuille de route

- [x] **0.1** — Rendu adaptatif au zoom des fonds de scène et tuiles SVG.
- [ ] **0.2** — Rendu par zone visible : une version basse résolution de toute la carte, plus un rendu pleine résolution limité à la portion affichée. Net à tous les zooms, quelle que soit la taille de la carte.
- [ ] **0.3** — Rendu en arrière-plan (sans bloquer l'interface) et cache partagé quand un même SVG est utilisé plusieurs fois.
- [ ] Pistes : réglages par scène, aperçu dans la configuration de la scène, prise en charge d'autres formats vectoriels.

## Fonctionnement technique

Le canvas de Foundry tourne en WebGL (via PIXI), qui ne sait afficher que des textures en pixels. Vellum parcourt le groupe primaire du canvas, repère les objets dont la texture provient d'un fichier SVG, puis :

1. calcule la taille à laquelle l'objet est réellement affiché à l'écran (zoom × densité de pixels × qualité) ;
2. si l'image actuelle est trop petite (ou inutilement grande), il récupère le code source du SVG, fixe sa taille à la résolution voulue et le fait dessiner par le navigateur dans un `<canvas>` ;
3. remplace la texture de l'objet par ce nouveau rendu, sans changer sa taille dans la scène.

La texture d'origine chargée par Foundry n'est jamais modifiée : désactiver Vellum la rétablit immédiatement.

### Structure du dépôt

```
module.json              Manifeste du module
scripts/
  vellum.mjs             Point d'entrée : réglages, hooks, API
  renderer.mjs           Détection des SVG et gestion des textures
  svg-rasterizer.mjs     Chargement et rasterisation des SVG
  constants.mjs          Seuils et paramètres internes
lang/                    Traductions (français, anglais)
.github/workflows/       Publication automatique des releases
```

### Publier une nouvelle version

1. Mettez à jour `CHANGELOG.md`.
2. Sur GitHub, créez une release avec un tag au format `vX.Y.Z` (par exemple `v0.1.0`).
3. Le workflow met à jour `module.json` avec la version et les bonnes URLs, puis joint `module.json` et `module.zip` à la release. Foundry détecte la mise à jour automatiquement.

## Compatibilité

- Foundry VTT **v14**
- Indépendant du système de jeu (D&D, Cyberpunk RED, Warhammer 40K, homebrew…)

## Licence

[MIT](LICENSE) — © 2026 Argan
