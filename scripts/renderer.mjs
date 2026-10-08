import {
  MODULE_ID, QUALITY_FACTORS, SETTLE_DELAY, TILE_SIZE, VIEW_MARGIN_TILES,
  LEVEL_BIAS, FRAME_BUDGET, HARD_TEXTURE_CAP
} from "./constants.mjs";
import { isSvgSource, loadSvg, clearSvgCache, createCanvas, drawRegion } from "./svg-rasterizer.mjs";

/**
 * @typedef {{u0:number, v0:number, du:number, dv:number}} Region
 *   Zone de l'image en coordonnées normalisées (0 à 1).
 *
 * @typedef {object} Patch
 * @property {PIXI.DisplayObject} mesh   Objet ajouté au canvas, posé par-dessus la cible
 * @property {PIXI.Texture} texture       Texture affichée (celle de la vue)
 * @property {Region} region              Zone de l'image couverte
 * @property {number} width               Taille en px de la texture
 * @property {number} height
 * @property {boolean} shown              Le patch est utile à ce niveau de zoom
 *
 * @typedef {object} TargetState
 * @property {string} src
 * @property {PIXI.Texture} original      Texture de Foundry (jamais détruite par Vellum)
 * @property {{texture:PIXI.Texture, width:number, height:number}|null} base
 * @property {Patch|null} patch
 * @property {object|null} view            Vue courante : niveau, tuiles couvertes, texture assemblée
 * @property {Map<string, {rt:PIXI.RenderTexture, used:number}>} tiles  Cache des tuiles
 * @property {boolean} baseTried          Le fond de base a déjà été tenté
 * @property {number} token               Compteur pour abandonner les rendus obsolètes
 */

/**
 * Vellum — rendu en deux couches :
 *
 * 1. **Le fond de base** : l'image entière, rendue une seule fois à une
 *    résolution moyenne (4096 px par défaut), à la place de la texture native
 *    de Foundry. Il sert de filet de sécurité pendant les déplacements.
 * 2. **Le patch** : la zone visible, assemblée à partir de tuiles de 512 px
 *    rendues à des niveaux de zoom fixes (×2, ×4…) et gardées en cache sur le
 *    GPU. Seules les tuiles manquantes sont dessinées, une par image.
 *
 * Le patch est un objet du même type que la cible, inséré juste au-dessus d'elle
 * dans le même conteneur : il reçoit donc l'éclairage, le brouillard et la vision.
 */
export class VellumRenderer {
  /** @type {Map<PIXI.DisplayObject, TargetState>} */
  #states = new Map();
  /** Fonds de base partagés, par SVG et par taille. */
  #bases = new Map();
  #scratchCanvas = null;
  #blit = null;
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
        state = { src, original: target.texture, base: null, patch: null, view: null, tiles: new Map(), baseTried: false, token: 0 };
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
  /*  Couche 2 : zone visible, rendue par tuiles  */
  /* -------------------------------------------- */

  /*
   * La carte est découpée en tuiles de TILE_SIZE px, à des niveaux de zoom fixes :
   * au niveau L, l'image entière fait (largeur du fond de base × 2^L) px. Les tuiles
   * sont gardées en cache sur la carte graphique. Les tuiles de la vue sont
   * assemblées sur le GPU dans une seule texture (la « vue »), affichée par le
   * patch. Seules les tuiles manquantes sont dessinées, une par image, en
   * commençant par le centre de l'écran.
   */

  async #updatePatch(target, state, source) {
    const full = this.#neededFullSize(target, state);
    if (!full) return;

    // La couche de base suffit à ce niveau de zoom.
    const baseWidth = state.base?.width ?? this.#nativeSize(state).width;
    const ratio = full.width / baseWidth;
    if (ratio <= 2 ** LEVEL_BIAS) {
      this.#showPatch(state, false);
      return;
    }

    const visible = this.#visibleRegion(target);
    if (!visible) {
      this.#showPatch(state, false);
      return;
    }

    // Niveau de zoom : le plus petit qui atteint (presque) la résolution voulue.
    let level = Math.max(1, Math.ceil(Math.log2(ratio) - LEVEL_BIAS));
    let layout;
    while (level >= 1) {
      layout = this.#viewLayout(state, baseWidth, level, visible);
      if (layout.fits) break;
      level--; // budget ou GPU dépassé : on accepte un peu moins de finesse
    }
    if (level < 1) {
      this.#showPatch(state, false);
      return;
    }

    // Même vue qu'avant : rien à recomposer, on finit juste les tuiles manquantes.
    const view = state.view;
    if (view && view.key === layout.key && !view.rt.destroyed) {
      this.#showPatch(state, true);
      if (view.queue.length && !view.pumping) this.#pump(target, state, source, view);
      return;
    }

    this.#composeView(target, state, layout);
    this.#pump(target, state, source, state.view);
  }

  /**
   * Calcule les tuiles nécessaires pour couvrir la zone visible (plus une tuile
   * de marge de chaque côté) à un niveau donné.
   */
  #viewLayout(state, baseWidth, level, visible) {
    const native = this.#nativeSize(state);
    const levelW = Math.round(baseWidth * 2 ** level);
    const levelH = Math.max(1, Math.round(levelW * native.height / native.width));
    const T = TILE_SIZE;
    const cols = Math.ceil(levelW / T), rows = Math.ceil(levelH / T);
    const i0 = Math.max(0, Math.floor(visible.u0 * levelW / T) - VIEW_MARGIN_TILES);
    const j0 = Math.max(0, Math.floor(visible.v0 * levelH / T) - VIEW_MARGIN_TILES);
    const i1 = Math.min(cols, Math.ceil((visible.u0 + visible.du) * levelW / T) + VIEW_MARGIN_TILES);
    const j1 = Math.min(rows, Math.ceil((visible.v0 + visible.dv) * levelH / T) + VIEW_MARGIN_TILES);
    const width = Math.min(i1 * T, levelW) - i0 * T;
    const height = Math.min(j1 * T, levelH) - j0 * T;

    const budget = (this.#setting("maxMegapixels") ?? 32) * 1_000_000;
    const maxSide = this.#gpuMaxSide();
    const fits = width * height <= budget && width <= maxSide && height <= maxSide;

    // Centre de l'écran, en coordonnées de tuiles : les tuiles proches passent en premier.
    const cx = (visible.u0 + visible.du / 2) * levelW / T;
    const cy = (visible.v0 + visible.dv / 2) * levelH / T;

    return {
      level, levelW, levelH, i0, j0, i1, j1, width, height, fits, cx, cy,
      key: `${level}:${i0}:${j0}:${i1}:${j1}`,
      region: { u0: i0 * T / levelW, v0: j0 * T / levelH, du: width / levelW, dv: height / levelH }
    };
  }

  /**
   * Crée la texture de la vue et y assemble ce qui est déjà disponible : l'ancienne
   * vue mise à l'échelle (en attendant mieux), puis les tuiles en cache.
   */
  #composeView(target, state, layout) {
    const renderer = canvas.app.renderer;
    const rt = PIXI.RenderTexture.create({ width: layout.width, height: layout.height, resolution: 1 });
    if (PIXI.MIPMAP_MODES) rt.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;

    const old = state.view;
    const sprite = this.#blitSprite();
    let first = true;
    const blit = (texture, x, y, sx = 1, sy = 1) => {
      sprite.texture = texture;
      sprite.position.set(x, y);
      sprite.scale.set(sx, sy);
      renderer.render(sprite, { renderTexture: rt, clear: first });
      first = false;
    };

    // Ancienne vue en guise d'aperçu (même si elle est d'un autre niveau de zoom).
    if (old && !old.rt.destroyed) {
      const { u0, v0, du, dv } = old.region;
      blit(old.rt,
        u0 * layout.levelW - layout.i0 * TILE_SIZE,
        v0 * layout.levelH - layout.j0 * TILE_SIZE,
        du * layout.levelW / old.width,
        dv * layout.levelH / old.height);
    }
    if (first) renderer.render(new PIXI.Container(), { renderTexture: rt, clear: true });

    // Tuiles déjà en cache, puis file d'attente des manquantes, du centre vers les bords.
    const queue = [];
    const now = performance.now();
    for (let j = layout.j0; j < layout.j1; j++) {
      for (let i = layout.i0; i < layout.i1; i++) {
        const tile = state.tiles.get(`${layout.level}:${i}:${j}`);
        if (tile && !tile.rt.destroyed) {
          tile.used = now;
          blit(tile.rt, (i - layout.i0) * TILE_SIZE, (j - layout.j0) * TILE_SIZE);
        } else {
          queue.push({ i, j, d: Math.hypot(i + 0.5 - layout.cx, j + 0.5 - layout.cy) });
        }
      }
    }
    queue.sort((a, b) => a.d - b.d);

    state.view = { ...layout, rt, queue, pumping: false, rendered: 0, t0: performance.now() };
    this.#attachView(target, state);
    if (old) old.rt.destroy(true);
  }

  /** Affiche la vue courante dans le patch (créé au besoin). */
  #attachView(target, state) {
    const view = state.view;
    let patch = state.patch;
    if (!patch || patch.mesh.destroyed) {
      const mesh = this.#createPatchMesh(target, view.rt);
      if (!mesh) return;
      patch = state.patch = { mesh, shown: false };
    } else {
      patch.mesh.texture = view.rt;
    }
    Object.assign(patch, { texture: view.rt, region: view.region, width: view.width, height: view.height });
    this.#showPatch(state, true);
    this.#syncPatch(target, state);
  }

  /**
   * Dessine les tuiles manquantes de la vue, une par une, en rendant la main au
   * navigateur dès que le budget de l'image est consommé.
   */
  async #pump(target, state, source, view) {
    view.pumping = true;
    const renderer = canvas.app.renderer;
    const T = TILE_SIZE;
    let sliceStart = performance.now();
    try {
      while (view.queue.length) {
        if (this.#states.get(target) !== state || state.view !== view || target.destroyed || view.rt.destroyed) return;

        const { i, j } = view.queue.shift();
        const key = `${view.level}:${i}:${j}`;
        let tile = state.tiles.get(key);
        if (!tile || tile.rt.destroyed) {
          tile = this.#renderTile(source, view, i, j);
          state.tiles.set(key, tile);
          view.rendered++;
        }
        tile.used = performance.now();

        const sprite = this.#blitSprite();
        sprite.texture = tile.rt;
        sprite.position.set((i - view.i0) * T, (j - view.j0) * T);
        sprite.scale.set(1, 1);
        renderer.render(sprite, { renderTexture: view.rt, clear: false });

        if (performance.now() - sliceStart > FRAME_BUDGET) {
          await new Promise(resolve => requestAnimationFrame(() => resolve()));
          sliceStart = performance.now();
        }
      }
      if (view.rendered) {
        this.#log(`Zone ${view.width}×${view.height} (niveau ×${2 ** view.level}) : ${view.rendered} tuile(s) en ${Math.round(performance.now() - view.t0)} ms`, state.src);
      }
      this.#evictTiles(state);
    } finally {
      view.pumping = false;
    }
  }

  /** Dessine une tuile du SVG et la range dans une texture GPU. */
  #renderTile(source, view, i, j) {
    const T = TILE_SIZE;
    const w = Math.min(T, view.levelW - i * T);
    const h = Math.min(T, view.levelH - j * T);
    const scratch = this.#scratch();
    const { ctx } = scratch;
    ctx.clearRect(0, 0, T, T);
    const kx = source.width / view.levelW, ky = source.height / view.levelH;
    ctx.drawImage(source.img, i * T * kx, j * T * ky, w * kx, h * ky, 0, 0, w, h);
    scratch.texture.baseTexture.update();

    const rt = PIXI.RenderTexture.create({ width: w, height: h, resolution: 1 });
    if (PIXI.MIPMAP_MODES) rt.baseTexture.mipmap = PIXI.MIPMAP_MODES.OFF;
    const sprite = this.#blitSprite();
    sprite.texture = new PIXI.Texture(scratch.texture.baseTexture, new PIXI.Rectangle(0, 0, w, h));
    sprite.position.set(0, 0);
    sprite.scale.set(1, 1);
    canvas.app.renderer.render(sprite, { renderTexture: rt, clear: true });
    sprite.texture.destroy(false);
    return { rt, used: performance.now() };
  }

  /** Libère les tuiles les moins récemment utilisées au-delà du budget mémoire. */
  #evictTiles(state) {
    const budget = (this.#setting("maxMegapixels") ?? 32) * 1_000_000;
    const maxTiles = Math.max(32, Math.floor(budget / (TILE_SIZE * TILE_SIZE)));
    if (state.tiles.size <= maxTiles) return;
    const entries = Array.from(state.tiles.entries()).sort((a, b) => a[1].used - b[1].used);
    for (const [key, tile] of entries.slice(0, state.tiles.size - maxTiles)) {
      tile.rt.destroy(true);
      state.tiles.delete(key);
    }
  }

  /** Canvas de travail réutilisé pour dessiner les tuiles. */
  #scratch() {
    if (!this.#scratchCanvas || this.#scratchCanvas.texture.baseTexture.destroyed) {
      const { canvas: el, ctx } = createCanvas(TILE_SIZE, TILE_SIZE);
      this.#scratchCanvas = { canvas: el, ctx, texture: PIXI.Texture.from(el, this.#textureOptions()) };
    }
    return this.#scratchCanvas;
  }

  /** Sprite réutilisé pour les copies entre textures sur le GPU. */
  #blitSprite() {
    if (!this.#blit || this.#blit.destroyed) this.#blit = new PIXI.Sprite();
    return this.#blit;
  }

  /** Libère la vue et toutes les tuiles d'un objet. */
  #releaseTiles(state) {
    if (state.view) {
      state.view.queue.length = 0;
      if (!state.view.rt.destroyed) state.view.rt.destroy(true);
      state.view = null;
    }
    for (const tile of state.tiles?.values() ?? []) {
      if (!tile.rt.destroyed) tile.rt.destroy(true);
    }
    state.tiles?.clear();
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
      state.patch = null;
    }
    this.#releaseTiles(state);
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
        zone: p?.region && p.shown && s.view
          ? `${p.width}×${p.height} ×${2 ** s.view.level} (${pct(p.region.du)}×${pct(p.region.dv)})`
          : "—",
        tuiles: s.tiles.size ? `${s.tiles.size} en cache${s.view?.queue.length ? `, ${s.view.queue.length} en attente` : ""}` : "—",
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
