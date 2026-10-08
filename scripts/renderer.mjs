import {
  MODULE_ID, QUALITY_FACTORS, SETTLE_DELAY, PATCH_MARGIN,
  ZOOM_IN_THRESHOLD, ZOOM_OUT_THRESHOLD, HARD_TEXTURE_CAP
} from "./constants.mjs";
import { isSvgSource, loadSvg, clearSvgCache, createCanvas, drawRegion } from "./svg-rasterizer.mjs";

/**
 * @typedef {{u0:number, v0:number, du:number, dv:number}} Region
 *   Zone de l'image en coordonnées normalisées (0 à 1).
 *
 * @typedef {object} Patch
 * @property {PIXI.DisplayObject} mesh   Objet ajouté au canvas, posé par-dessus la cible
 * @property {PIXI.Texture} texture       Rendu actuellement affiché
 * @property {boolean} shown              Le patch est utile à ce niveau de zoom
 * @property {Region|null} region         Zone actuellement affichée
 * @property {number} width               Taille en px du dernier rendu
 * @property {number} height
 * @property {number} fullWidth           Largeur équivalente de l'image entière à cette résolution
 *
 * @typedef {object} TargetState
 * @property {string} src
 * @property {PIXI.Texture} original      Texture de Foundry (jamais détruite par Vellum)
 * @property {{texture:PIXI.Texture, width:number, height:number}|null} base
 * @property {Patch|null} patch
 * @property {boolean} baseTried          Le fond de base a déjà été tenté
 * @property {number} token               Compteur pour abandonner les rendus obsolètes
 */

/**
 * Vellum 0.2 — rendu en deux couches :
 *
 * 1. **Le fond de base** : l'image entière, rendue une seule fois à une
 *    résolution moyenne (4096 px par défaut), à la place de la texture native
 *    de Foundry. Il sert de filet de sécurité pendant les déplacements.
 * 2. **Le patch** : uniquement la zone visible (plus une marge), rendue à la
 *    résolution exacte de l'écran, et posée par-dessus. Il est redessiné après
 *    un zoom ou quand on sort de la marge.
 *
 * Le patch est un objet du même type que la cible, inséré juste au-dessus d'elle
 * dans le même conteneur : il reçoit donc l'éclairage, le brouillard et la vision.
 */
export class VellumRenderer {
  /** @type {Map<PIXI.DisplayObject, TargetState>} */
  #states = new Map();
  /** Fonds de base partagés, par SVG et par taille. */
  #bases = new Map();
  #timer = null;
  #firstRequest = null;
  #running = false;
  #pending = false;
  #warned = new Set();
  #tickerBound = false;

  /* -------------------------------------------- */
  /*  Planification                               */
  /* -------------------------------------------- */

  /** Demande un rafraîchissement après stabilisation du zoom/déplacement. */
  schedule(delay = SETTLE_DELAY) {
    // Si des événements arrivent en continu, on force un passage au bout
    // d'une seconde plutôt que de repousser indéfiniment.
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
      this.#bindTicker();
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

  /**
   * Libère tout avant que Foundry ne démonte le canvas. Les textures d'origine
   * sont remises en place, au cas où Foundry lirait encore la scène pendant
   * son démontage.
   */
  tearDown() {
    clearTimeout(this.#timer);
    for (const [target, state] of this.#states) this.#release(target, state, { restore: !target.destroyed });
    this.#states.clear();
  }

  /** Rétablit toutes les textures d'origine et vide les caches. */
  reset() {
    for (const [target, state] of this.#states) this.#release(target, state, { restore: true });
    this.#states.clear();
    clearSvgCache();
    this.#warned.clear();
  }

  /* -------------------------------------------- */
  /*  Boucle principale                           */
  /* -------------------------------------------- */

  async #refresh() {
    if (!canvas?.ready || !canvas.primary) return;

    const targets = this.#collectTargets();

    // Objets disparus ou recréés par Foundry : on oublie leur état.
    for (const [target, state] of this.#states) {
      if (target.destroyed || !targets.has(target)) this.#release(target, state, { restore: !target.destroyed });
    }

    if (!this.#setting("enabled")) {
      for (const [target, state] of this.#states) this.#release(target, state, { restore: true });
      return;
    }

    for (const [target, src] of targets) {
      let state = this.#states.get(target);

      // Foundry a remplacé la texture (tuile modifiée, nouveau fond…) : on repart de zéro.
      if (state && target.texture !== (state.base?.texture ?? state.original)) {
        this.#release(target, state, { restore: false });
        state = null;
      }
      if (!state) {
        state = { src, original: target.texture, base: null, patch: null, baseTried: false, token: 0 };
        this.#states.set(target, state);
      }

      if (!target.worldVisible) continue; // tuile cachée, autre niveau affiché…

      let source;
      try {
        source = await loadSvg(state.src, this.#nativeSize(state), { log: (...a) => this.#log(...a) });
        if (!state.announced) {
          state.announced = true;
          this.#log(`SVG prêt en ${Math.round(source.prepTime)} ms (${source.flattened} calque(s) flouté(s) pré-rendu(s))`, state.src);
        }
      } catch (error) {
        this.#warnOnce(state.src, error);
        continue;
      }
      if (this.#states.get(target) !== state || target.destroyed) continue;

      if (!state.baseTried) await this.#renderBase(target, state, source);
      if (this.#states.get(target) !== state || target.destroyed) continue;

      await this.#updatePatch(target, state, source);
    }
  }

  /* -------------------------------------------- */
  /*  Détection                                   */
  /* -------------------------------------------- */

  /**
   * Parcourt le groupe primaire et renvoie les objets affichant un SVG.
   * @returns {Map<PIXI.DisplayObject, string>}
   */
  #collectTargets() {
    const found = new Map();
    const visit = obj => {
      if (!obj || obj.destroyed || obj._vellumPatch) return;
      if (obj.texture) {
        const state = this.#states.get(obj);
        const src = (state && obj.texture === state.base?.texture) ? state.src : this.#sourceOf(obj);
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
  /*  Couche 1 : fond de base                     */
  /* -------------------------------------------- */

  /**
   * Rend l'image entière une fois, à la résolution de base, à la place de la
   * texture native. Le rendu est partagé entre tous les objets qui affichent le
   * même SVG (un fond et des tuiles identiques, par exemple).
   */
  async #renderBase(target, state, source) {
    state.baseTried = true;
    const native = this.#nativeSize(state);
    const longest = this.#setting("baseResolution") ?? 4096;
    const maxSide = Math.min(longest, this.#gpuMaxSide());
    const k = maxSide / Math.max(native.width, native.height);
    if (k <= 1.05) return; // la texture de Foundry est déjà assez grande

    const width = Math.round(native.width * k);
    const height = Math.round(native.height * k);
    const key = `${state.src}|${width}x${height}`;

    let entry = this.#bases.get(key);
    if (!entry) {
      const t0 = performance.now();
      entry = { refs: 0, texture: null, promise: null };
      entry.promise = (async () => {
        const { canvas: el, ctx } = createCanvas(width, height);
        const done = await drawRegion(source, ctx, { u0: 0, v0: 0, du: 1, dv: 1 }, width, height,
          () => entry.refs === 0 && entry.started);
        if (!done) {
          el.width = el.height = 0;
          return null;
        }
        this.#log(`Fond de base ${width}×${height} en ${Math.round(performance.now() - t0)} ms`, state.src);
        return (entry.texture = PIXI.Texture.from(el, this.#textureOptions()));
      })();
      this.#bases.set(key, entry);
    }

    entry.refs++;
    entry.started = true;
    state.baseKey = key;
    const texture = await entry.promise;

    if (!texture || this.#states.get(target) !== state || target.destroyed || target.texture !== state.original) {
      this.#releaseBase(state);
      return;
    }
    this.#swapTexture(target, texture);
    state.base = { texture, width, height };
  }

  /** Libère la part de fond de base d'un objet ; détruit la texture quand plus personne ne l'utilise. */
  #releaseBase(state) {
    const key = state.baseKey;
    state.baseKey = null;
    const entry = key && this.#bases.get(key);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.#bases.delete(key);
    if (entry.texture) this.#destroyTexture(entry.texture);
  }

  /* -------------------------------------------- */
  /*  Couche 2 : patch de la zone visible         */
  /* -------------------------------------------- */

  async #updatePatch(target, state, source) {
    const full = this.#neededFullSize(target, state);
    if (!full) return;

    // La couche de base suffit à ce niveau de zoom : pas besoin de patch.
    const baseWidth = state.base?.width ?? this.#nativeSize(state).width;
    if (full.width <= baseWidth * 1.05) {
      this.#showPatch(state, false);
      return;
    }

    const visible = this.#visibleRegion(target);
    if (!visible) {
      this.#showPatch(state, false);
      return;
    }

    // Le patch actuel couvre encore la vue à une résolution convenable ? Rien à faire.
    const patch = state.patch;
    if (patch?.region && !patch.mesh.destroyed && patch.width > 0) {
      const ratio = full.width / patch.fullWidth;
      const fresh = ratio < ZOOM_IN_THRESHOLD && ratio > ZOOM_OUT_THRESHOLD;
      if (fresh && this.#contains(patch.region, visible)) {
        this.#showPatch(state, true);
        return;
      }
    }

    const region = this.#expand(visible, PATCH_MARGIN);
    let width = region.du * full.width;
    let height = region.dv * full.height;

    // Budget mémoire et plafond GPU.
    const budget = (this.#setting("maxMegapixels") ?? 32) * 1_000_000;
    let k = Math.min(1, Math.sqrt(budget / (width * height)));
    k = Math.min(k, this.#gpuMaxSide() / Math.max(width, height));
    width = Math.max(1, Math.round(width * k));
    height = Math.max(1, Math.round(height * k));
    const fullWidth = full.width * k;

    // Le budget empêche de faire mieux que le fond de base : inutile de dessiner.
    if (fullWidth <= baseWidth * 1.05) {
      this.#showPatch(state, false);
      return;
    }

    await this.#renderPatch(target, state, source, region, width, height, fullWidth);
  }

  async #renderPatch(target, state, source, region, width, height, fullWidth) {
    const token = ++state.token;
    const t0 = performance.now();

    // On dessine dans un canvas à part : le patch affiché reste intact pendant le rendu.
    const { canvas: el, ctx } = createCanvas(width, height);
    const done = await drawRegion(source, ctx, region, width, height,
      () => token !== state.token || target.destroyed);
    if (!done || this.#states.get(target) !== state) {
      el.width = el.height = 0;
      return;
    }

    const texture = PIXI.Texture.from(el, this.#textureOptions());
    let patch = state.patch;
    if (!patch || patch.mesh.destroyed) {
      const mesh = this.#createPatchMesh(target, texture);
      if (!mesh) {
        this.#destroyTexture(texture);
        return;
      }
      patch = state.patch = { mesh, texture: null, shown: false };
    } else {
      patch.mesh.texture = texture;
    }

    const previous = patch.texture;
    Object.assign(patch, { texture, region, width, height, fullWidth });
    this.#destroyTexture(previous);

    this.#showPatch(state, true);
    this.#syncPatch(target, state);
    this.#log(`Zone ${width}×${height} en ${Math.round(performance.now() - t0)} ms`, state.src);
  }

  /**
   * Crée l'objet du patch avec la même classe que la cible (PrimarySpriteMesh
   * en général), pour qu'il soit trié, éclairé et masqué comme elle.
   */
  #createPatchMesh(target, texture) {
    const parent = target.parent;
    if (!parent) return null;
    let mesh;
    try {
      mesh = new target.constructor(texture);
    } catch (error) {
      this.#log("Classe de la cible inutilisable, repli sur PIXI.Sprite", error);
      mesh = new PIXI.Sprite(texture);
    }
    mesh.name = "vellum-patch";
    mesh._vellumPatch = true;
    mesh.eventMode = "none";
    parent.addChildAt(mesh, parent.getChildIndex(target) + 1);
    return mesh;
  }

  /**
   * Aligne le patch sur la cible : même position, rotation et tri, avec une
   * échelle et une ancre calculées pour qu'il recouvre exactement sa zone.
   * Appelé à chaque image par le ticker, pour suivre les tuiles qui bougent.
   */
  #syncPatch(target, state) {
    const patch = state.patch;
    if (!patch?.region || patch.mesh.destroyed) return;
    const mesh = patch.mesh;
    const { u0, v0, du, dv } = patch.region;
    const tex = target.texture?.orig ?? target.texture;
    if (!tex?.width) return;

    const ax = target.anchor?.x ?? 0;
    const ay = target.anchor?.y ?? 0;
    mesh.anchor?.set((ax - u0) / du, (ay - v0) / dv);

    const sx = target.scale.x * tex.width * du / patch.width;
    const sy = target.scale.y * tex.height * dv / patch.height;
    mesh.scale.set(sx, sy);
    mesh.position.copyFrom(target.position);
    mesh.rotation = target.rotation;
    mesh.skew?.copyFrom(target.skew);
    mesh.pivot.set(
      sx ? target.pivot.x * target.scale.x / sx : 0,
      sy ? target.pivot.y * target.scale.y / sy : 0
    );
    mesh.alpha = target.alpha;

    // Tri dans le groupe primaire : juste au-dessus de la cible.
    for (const key of ["elevation", "sortLayer", "zIndex"]) {
      try {
        if (key in target && mesh[key] !== target[key]) mesh[key] = target[key];
      } catch { /* propriété en lecture seule */ }
    }
    try {
      if ("sort" in target && mesh.sort !== target.sort + 0.001) mesh.sort = target.sort + 0.001;
    } catch { /* idem */ }

    mesh.visible = patch.shown && target.visible && target.renderable !== false;
  }

  /** Affiche ou masque le patch (la visibilité finale suit aussi celle de la cible). */
  #showPatch(state, shown) {
    if (!state.patch) return;
    state.patch.shown = shown;
    if (!shown && !state.patch.mesh.destroyed) state.patch.mesh.visible = false;
  }

  /** Synchronise tous les patchs à chaque image. */
  #tick = () => {
    for (const [target, state] of this.#states) {
      if (state.patch && !target.destroyed) this.#syncPatch(target, state);
    }
  };

  #bindTicker() {
    if (this.#tickerBound || !canvas?.app?.ticker) return;
    canvas.app.ticker.add(this.#tick);
    this.#tickerBound = true;
  }

  /* -------------------------------------------- */
  /*  Géométrie                                   */
  /* -------------------------------------------- */

  /** Taille de la texture d'origine de Foundry. */
  #nativeSize(state) {
    const o = state.original.orig ?? state.original;
    return { width: o.width, height: o.height };
  }

  /** Taille qu'aurait l'image entière si on la rendait à la résolution de l'écran. */
  #neededFullSize(target, state) {
    const tex = target.texture?.orig ?? target.texture;
    const wt = target.worldTransform;
    if (!tex?.width || !wt) return null;
    const resolution = canvas.app?.renderer?.resolution ?? window.devicePixelRatio ?? 1;
    const quality = QUALITY_FACTORS[this.#setting("quality")] ?? 1;
    const width = Math.hypot(wt.a, wt.b) * tex.width * resolution * quality;
    const native = this.#nativeSize(state);
    return { width, height: width * native.height / native.width };
  }

  /**
   * Zone de la cible visible à l'écran, en coordonnées normalisées.
   * @returns {Region|null}
   */
  #visibleRegion(target) {
    const screen = canvas.app?.renderer?.screen;
    const tex = target.texture?.orig ?? target.texture;
    if (!screen || !tex?.width) return null;
    const ax = target.anchor?.x ?? 0;
    const ay = target.anchor?.y ?? 0;
    const corners = [[0, 0], [screen.width, 0], [0, screen.height], [screen.width, screen.height]];
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    const p = new PIXI.Point();
    for (const [x, y] of corners) {
      target.worldTransform.applyInverse({ x, y }, p);
      const u = p.x / tex.width + ax;
      const v = p.y / tex.height + ay;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const u0 = Math.max(0, minU), v0 = Math.max(0, minV);
    const u1 = Math.min(1, maxU), v1 = Math.min(1, maxV);
    if (u1 <= u0 || v1 <= v0) return null;
    return { u0, v0, du: u1 - u0, dv: v1 - v0 };
  }

  /** Agrandit une zone d'une marge relative, sans sortir de l'image. */
  #expand(r, margin) {
    const mu = r.du * margin, mv = r.dv * margin;
    const u0 = Math.max(0, r.u0 - mu), v0 = Math.max(0, r.v0 - mv);
    const u1 = Math.min(1, r.u0 + r.du + mu), v1 = Math.min(1, r.v0 + r.dv + mv);
    return { u0, v0, du: u1 - u0, dv: v1 - v0 };
  }

  /** Teste si la zone a contient entièrement la zone b. */
  #contains(a, b) {
    const eps = 1e-6;
    return b.u0 >= a.u0 - eps && b.v0 >= a.v0 - eps
      && b.u0 + b.du <= a.u0 + a.du + eps && b.v0 + b.dv <= a.v0 + a.dv + eps;
  }

  #gpuMaxSide() {
    const gl = canvas.app?.renderer?.gl;
    const gpuMax = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 8192;
    return Math.min(gpuMax, HARD_TEXTURE_CAP);
  }

  /* -------------------------------------------- */
  /*  Textures                                    */
  /* -------------------------------------------- */

  /** Pas de mipmaps : chaque texture est rendue à la taille où elle est affichée. */
  #textureOptions() {
    const options = {};
    if (PIXI.MIPMAP_MODES) options.mipmap = PIXI.MIPMAP_MODES.OFF;
    if (PIXI.SCALE_MODES) options.scaleMode = PIXI.SCALE_MODES.LINEAR;
    return options;
  }

  /** Change la texture d'un objet sans modifier sa taille dans la scène. */
  #swapTexture(mesh, texture) {
    const width = mesh.width;
    const height = mesh.height;
    mesh.texture = texture;
    mesh.width = width;
    mesh.height = height;
    // Recalcule la transformation tout de suite : sinon les calculs de zone qui
    // suivent utiliseraient l'ancienne échelle jusqu'à la prochaine image.
    try {
      if (mesh.parent) mesh.updateTransform();
    } catch { /* recalculée à la prochaine image */ }
  }

  #release(target, state, { restore }) {
    state.token++;
    if (state.patch) {
      const mesh = state.patch.mesh;
      if (!mesh.destroyed) {
        mesh.parent?.removeChild(mesh);
        mesh.destroy({ children: true, texture: false });
      }
      this.#destroyTexture(state.patch.texture);
      state.patch = null;
    }
    if (state.base && restore && !target.destroyed && target.texture === state.base.texture && !state.original.destroyed) {
      this.#swapTexture(target, state.original);
    }
    state.base = null;
    this.#releaseBase(state);
    this.#states.delete(target);
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
    const pct = n => `${Math.round(n * 100)}%`;
    return Array.from(this.#states.entries()).map(([target, s]) => {
      const native = this.#nativeSize(s);
      const p = s.patch;
      return {
        src: s.src,
        objet: target.constructor?.name,
        natif: `${native.width}×${native.height}`,
        base: s.base ? `${s.base.width}×${s.base.height}` : "—",
        zone: p?.region && p.shown ? `${p.width}×${p.height} (${pct(p.region.du)}×${pct(p.region.dv)})` : "—",
        visible: target.worldVisible
      };
    });
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
    console.warn(`${MODULE_ID} | Échec du chargement de ${src}`, error);
    if (this.#warned.has(src)) return;
    this.#warned.add(src);
    ui.notifications?.warn(game.i18n.format("VELLUM.Notifications.LoadFailed", { src }));
  }
}
