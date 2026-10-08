import {
  MODULE_ID, QUALITY_FACTORS, SETTLE_DELAY, UPSCALE_THRESHOLD,
  DOWNSCALE_THRESHOLD, MIN_RENDER_SIZE, HARD_TEXTURE_CAP
} from "./constants.mjs";
import { isSvgSource, loadSvgText, rasterizeSvg, clearSvgCache } from "./svg-rasterizer.mjs";

/**
 * @typedef {object} MeshState
 * @property {string} src              URL du SVG d'origine
 * @property {PIXI.Texture} original   Texture chargée par Foundry (jamais détruite par Vellum)
 * @property {PIXI.Texture|null} texture  Texture générée par Vellum, si active
 * @property {number} width            Largeur en px de la texture Vellum
 * @property {number} height           Hauteur en px de la texture Vellum
 * @property {number} token            Compteur pour ignorer les rendus devenus obsolètes
 */

/**
 * Surveille les objets du canvas qui affichent un SVG et remplace leur texture
 * par une version rasterisée à la résolution réellement affichée à l'écran.
 *
 * Approche volontairement générique : au lieu de dépendre du schéma interne des
 * scènes ou des niveaux (qui évolue entre versions de Foundry), on parcourt le
 * groupe primaire du canvas et on repère toute texture dont la source est un SVG.
 * Fonds de scène et tuiles sont donc gérés de la même façon.
 */
export class VellumRenderer {
  /** @type {Map<PIXI.DisplayObject, MeshState>} */
  #states = new Map();
  #timer = null;
  #firstRequest = null;
  #running = false;
  #pending = false;
  #warned = new Set();

  /* -------------------------------------------- */
  /*  Planification                               */
  /* -------------------------------------------- */

  /** Demande un rafraîchissement après stabilisation du zoom/déplacement. */
  schedule(delay = SETTLE_DELAY) {
    // Si des événements arrivent en continu (tuile animée, etc.), on force un
    // passage au bout d'une seconde plutôt que de repousser indéfiniment.
    const now = performance.now();
    this.#firstRequest ??= now;
    if (now - this.#firstRequest > 1000) delay = 0;

    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#firstRequest = null;
      this.refresh();
    }, delay);
  }

  /** Lance un rafraîchissement ; si un rendu est en cours, il sera relancé ensuite. */
  async refresh() {
    if (this.#running) {
      this.#pending = true;
      return;
    }
    this.#running = true;
    try {
      await this.#refresh();
    } catch (error) {
      console.error(`${MODULE_ID} | Erreur pendant le rafraîchissement`, error);
    } finally {
      this.#running = false;
      if (this.#pending) {
        this.#pending = false;
        this.schedule(0);
      }
    }
  }

  /** Libère tout avant que Foundry ne démonte le canvas. */
  tearDown() {
    clearTimeout(this.#timer);
    for (const [mesh, state] of this.#states) this.#release(mesh, state, { restore: false });
    this.#states.clear();
  }

  /** Rétablit toutes les textures d'origine et vide les caches. */
  reset() {
    for (const [mesh, state] of this.#states) this.#release(mesh, state, { restore: true });
    this.#states.clear();
    clearSvgCache();
    this.#warned.clear();
  }

  /* -------------------------------------------- */
  /*  Boucle principale                           */
  /* -------------------------------------------- */

  async #refresh() {
    if (!canvas?.ready || !canvas.primary) return;

    const meshes = this.#collectMeshes();

    // Objets disparus ou recréés par Foundry : on oublie leur état.
    for (const [mesh, state] of this.#states) {
      if (mesh.destroyed || !meshes.has(mesh)) this.#release(mesh, state, { restore: !mesh.destroyed });
    }

    if (!this.#setting("enabled")) {
      for (const [mesh, state] of this.#states) this.#release(mesh, state, { restore: true });
      return;
    }

    for (const [mesh, src] of meshes) {
      let state = this.#states.get(mesh);

      // Foundry a remplacé la texture (tuile modifiée, nouveau fond…) : on repart de zéro.
      if (state && mesh.texture !== (state.texture ?? state.original)) {
        this.#release(mesh, state, { restore: false });
        state = null;
      }
      if (!state) {
        state = { src, original: mesh.texture, texture: null, width: 0, height: 0, token: 0 };
        this.#states.set(mesh, state);
      }

      if (!mesh.worldVisible) continue; // ex. tuile cachée ou autre niveau affiché

      const target = this.#targetSize(mesh, state);
      if (!target) continue;

      const originalWidth = state.original.orig?.width ?? state.original.width;

      // Assez zoomé arrière : la texture de Foundry suffit, on libère la mémoire.
      if (target.width <= originalWidth * 1.05) {
        if (state.texture) this.#revert(mesh, state);
        continue;
      }

      if (state.texture) {
        const ratio = target.width / state.width;
        if (ratio < UPSCALE_THRESHOLD && ratio > DOWNSCALE_THRESHOLD) continue;
      }

      await this.#render(mesh, state, target);
    }
  }

  /* -------------------------------------------- */
  /*  Détection                                   */
  /* -------------------------------------------- */

  /**
   * Parcourt le groupe primaire et renvoie les objets affichant un SVG.
   * @returns {Map<PIXI.DisplayObject, string>}
   */
  #collectMeshes() {
    const found = new Map();
    const visit = obj => {
      if (!obj || obj.destroyed) return;
      if (obj.texture) {
        const state = this.#states.get(obj);
        // Si la texture est déjà la nôtre, la source est connue.
        const src = (state && obj.texture === state.texture) ? state.src : this.#sourceOf(obj);
        if (src && isSvgSource(src)) found.set(obj, src);
      }
      for (const child of obj.children ?? []) visit(child);
    };
    visit(canvas.primary);
    return found;
  }

  /**
   * Retrouve l'URL d'origine de la texture d'un objet, quelle que soit la
   * façon dont Foundry/PIXI l'a chargée.
   * @param {PIXI.DisplayObject} obj
   * @returns {string|null}
   */
  #sourceOf(obj) {
    const texture = obj.texture;
    const base = texture?.baseTexture ?? texture?.source;
    if (!base) return null;
    const resource = base.resource;
    const element = resource?.source ?? resource;
    const candidates = [
      resource?.url,
      typeof resource?.src === "string" ? resource.src : null,
      typeof resource?.svg === "string" && !resource.svg.trimStart().startsWith("<") ? resource.svg : null,
      element?.currentSrc,
      typeof element?.src === "string" ? element.src : null,
      base.cacheId,
      ...(base.textureCacheIds ?? []),
      ...(texture.textureCacheIds ?? [])
    ];
    return candidates.find(c => isSvgSource(c)) ?? null;
  }

  /* -------------------------------------------- */
  /*  Calcul de la résolution cible               */
  /* -------------------------------------------- */

  /**
   * Taille en pixels à laquelle le SVG doit être rendu pour être net à l'écran.
   * @returns {{width:number, height:number}|null}
   */
  #targetSize(mesh, state) {
    const texture = mesh.texture;
    const texW = texture.orig?.width ?? texture.width;
    const wt = mesh.worldTransform;
    if (!texW || !wt) return null;

    const renderer = canvas.app?.renderer;
    const resolution = renderer?.resolution ?? window.devicePixelRatio ?? 1;
    const quality = QUALITY_FACTORS[this.#setting("quality")] ?? 1;

    // Largeur du sprite à l'écran (en px physiques), indépendante de la texture actuelle.
    const screenWidth = Math.hypot(wt.a, wt.b) * texW * resolution;

    const orig = state.original.orig ?? state.original;
    const aspect = orig.width / orig.height;
    if (!Number.isFinite(aspect) || aspect <= 0) return null;

    let width = screenWidth * quality;
    let height = width / aspect;

    // Plafond GPU.
    const gl = renderer?.gl;
    const gpuMax = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 8192;
    const maxSide = Math.min(gpuMax, HARD_TEXTURE_CAP);
    const sideScale = Math.min(1, maxSide / Math.max(width, height));
    width *= sideScale;
    height *= sideScale;

    // Budget mémoire.
    const budget = (this.#setting("maxMegapixels") ?? 64) * 1_000_000;
    if (width * height > budget) {
      const k = Math.sqrt(budget / (width * height));
      width *= k;
      height *= k;
    }

    // Plancher.
    const longest = Math.max(width, height);
    if (longest < MIN_RENDER_SIZE) {
      const k = MIN_RENDER_SIZE / longest;
      width *= k;
      height *= k;
    }

    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  }

  /* -------------------------------------------- */
  /*  Rendu et remplacement de texture            */
  /* -------------------------------------------- */

  async #render(mesh, state, target) {
    const token = ++state.token;
    const fallback = {
      width: state.original.orig?.width ?? state.original.width,
      height: state.original.orig?.height ?? state.original.height
    };

    let canvasEl;
    const t0 = performance.now();
    try {
      const text = await loadSvgText(state.src);
      canvasEl = await rasterizeSvg(text, target.width, target.height, fallback);
    } catch (error) {
      this.#warnOnce(state.src, error);
      return;
    }

    // Entre-temps : nouveau zoom, objet détruit ou texture changée par Foundry.
    if (token !== state.token || mesh.destroyed || this.#states.get(mesh) !== state) return;
    if (mesh.texture !== (state.texture ?? state.original)) return;

    const texture = this.#createTexture(canvasEl);
    this.#swapTexture(mesh, texture);

    const previous = state.texture;
    state.texture = texture;
    state.width = target.width;
    state.height = target.height;
    this.#destroyTexture(previous);

    this.#log(`Rendu ${target.width}×${target.height} en ${Math.round(performance.now() - t0)} ms`, state.src);
  }

  #createTexture(canvasEl) {
    // Pas de mipmaps : la texture est déjà rendue à la résolution de l'écran, et
    // leur génération sur une texture géante est une source d'artefacts GPU.
    const options = {};
    if (PIXI.MIPMAP_MODES) options.mipmap = PIXI.MIPMAP_MODES.OFF;
    if (PIXI.SCALE_MODES) options.scaleMode = PIXI.SCALE_MODES.LINEAR;
    return PIXI.Texture.from(canvasEl, options);
  }

  /** Change la texture d'un objet sans modifier sa taille dans la scène. */
  #swapTexture(mesh, texture) {
    const width = mesh.width;
    const height = mesh.height;
    mesh.texture = texture;
    mesh.width = width;
    mesh.height = height;
  }

  /** Remet la texture de Foundry et libère celle de Vellum. */
  #revert(mesh, state) {
    state.token++;
    if (!mesh.destroyed && mesh.texture === state.texture && !state.original.destroyed) {
      this.#swapTexture(mesh, state.original);
    }
    this.#destroyTexture(state.texture);
    state.texture = null;
    state.width = state.height = 0;
    this.#log("Retour à la texture native", state.src);
  }

  #release(mesh, state, { restore }) {
    state.token++;
    if (restore && state.texture) this.#revert(mesh, state);
    else this.#destroyTexture(state.texture);
    this.#states.delete(mesh);
  }

  #destroyTexture(texture) {
    if (!texture || texture.destroyed) return;
    try {
      const source = texture.baseTexture?.resource?.source;
      texture.destroy(true);
      if (source instanceof HTMLCanvasElement) source.width = source.height = 0; // libère la RAM
    } catch (error) {
      this.#log("Destruction de texture ignorée", error);
    }
  }

  /* -------------------------------------------- */
  /*  Diagnostic                                  */
  /* -------------------------------------------- */

  /** Liste les SVG suivis, pour la console. */
  inspect() {
    return Array.from(this.#states.entries()).map(([mesh, s]) => ({
      src: s.src,
      objet: mesh.constructor?.name,
      natif: `${s.original.orig?.width ?? s.original.width}×${s.original.orig?.height ?? s.original.height}`,
      vellum: s.texture ? `${s.width}×${s.height}` : "—",
      visible: mesh.worldVisible
    }));
  }

  /* -------------------------------------------- */
  /*  Utilitaires                                 */
  /* -------------------------------------------- */

  #setting(key) {
    try {
      return game.settings.get(MODULE_ID, key);
    } catch {
      return undefined;
    }
  }

  #log(...args) {
    if (this.#setting("debug")) console.log(`${MODULE_ID} |`, ...args);
  }

  #warnOnce(src, error) {
    console.warn(`${MODULE_ID} | Échec du rendu de ${src}`, error);
    if (this.#warned.has(src)) return;
    this.#warned.add(src);
    ui.notifications?.warn(game.i18n.format("VELLUM.Notifications.LoadFailed", { src }));
  }
}
