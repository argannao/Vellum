/**
 * Vellum — fonds de scène et tuiles SVG nets à tous les niveaux de zoom.
 * Point d'entrée du module : réglages, hooks et API publique.
 */
import { MODULE_ID, QUALITY_FACTORS, BASE_RESOLUTIONS } from "./constants.mjs";
import { VellumRenderer } from "./renderer.mjs";

const renderer = new VellumRenderer();

/* -------------------------------------------- */
/*  Réglages                                    */
/* -------------------------------------------- */

function registerSettings() {
  const onChange = () => renderer.schedule(0);

  game.settings.register(MODULE_ID, "enabled", {
    name: "VELLUM.Settings.Enabled.Name",
    hint: "VELLUM.Settings.Enabled.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange
  });

  game.settings.register(MODULE_ID, "quality", {
    name: "VELLUM.Settings.Quality.Name",
    hint: "VELLUM.Settings.Quality.Hint",
    scope: "client",
    config: true,
    type: String,
    choices: Object.fromEntries(
      Object.keys(QUALITY_FACTORS).map(k => [k, `VELLUM.Settings.Quality.Choices.${k}`])
    ),
    default: "normal",
    onChange
  });

  game.settings.register(MODULE_ID, "baseResolution", {
    name: "VELLUM.Settings.BaseResolution.Name",
    hint: "VELLUM.Settings.BaseResolution.Hint",
    scope: "client",
    config: true,
    type: Number,
    choices: Object.fromEntries(BASE_RESOLUTIONS.map(r => [r, `${r} px`])),
    default: 4096,
    onChange: () => {
      // Le fond de base n'est rendu qu'une fois : il faut tout recalculer.
      renderer.reset();
      renderer.schedule(0);
    }
  });

  game.settings.register(MODULE_ID, "maxMegapixels", {
    name: "VELLUM.Settings.MaxMegapixels.Name",
    hint: "VELLUM.Settings.MaxMegapixels.Hint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 8, max: 128, step: 8 },
    default: 32,
    onChange
  });

  game.settings.register(MODULE_ID, "debug", {
    name: "VELLUM.Settings.Debug.Name",
    hint: "VELLUM.Settings.Debug.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  registerSettings();

  const module = game.modules.get(MODULE_ID);
  module.api = {
    /** Force un nouveau rendu de tous les SVG. */
    refresh: () => renderer.refresh(),
    /** Rétablit les textures natives et vide les caches. */
    reset: () => {
      renderer.reset();
      renderer.schedule(0);
    },
    /** Affiche dans la console la liste des SVG détectés et leur résolution. */
    inspect: () => {
      const rows = renderer.inspect();
      console.table(rows);
      return rows;
    }
  };
});

// Scène affichée : premier passage.
Hooks.on("canvasReady", () => renderer.schedule(0));

// Zoom ou déplacement : on attend que le mouvement s'arrête.
Hooks.on("canvasPan", () => renderer.schedule());

// Fond, tuiles ou niveaux modifiés : nouvelle détection.
for (const hook of ["drawTile", "refreshTile", "updateScene", "createTile", "updateTile", "deleteTile"]) {
  Hooks.on(hook, () => renderer.schedule());
}

// Changement de scène : on libère les textures avant que Foundry ne démonte le canvas.
Hooks.on("canvasInit", () => renderer.tearDown());
Hooks.on("canvasTearDown", () => renderer.tearDown());

// Redimensionnement de la fenêtre ou changement d'écran (la résolution affichée change).
window.addEventListener("resize", () => renderer.schedule());
