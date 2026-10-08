/**
 * Chargement et dessin de fichiers SVG.
 *
 * Le SVG est décodé une seule fois en <img>, à sa taille d'origine. Chrome
 * conserve sa version vectorielle : quand on dessine une portion de l'image
 * agrandie dans un <canvas>, il retrace les formes à la taille demandée au lieu
 * d'étirer des pixels. Dessiner uniquement la zone visible est donc rapide, sans
 * avoir à relire le fichier à chaque fois.
 */
import { TILE_SIZE, FRAME_BUDGET } from "./constants.mjs";
import { flattenBlurLayers } from "./svg-optimizer.mjs";

/** @type {Map<string, Promise<SvgSource>>} */
const sources = new Map();

/**
 * @typedef {object} SvgSource
 * @property {HTMLImageElement} img
 * @property {number} width    Largeur d'origine (unités du SVG)
 * @property {number} height   Hauteur d'origine
 * @property {string} url      URL blob à libérer
 * @property {number} flattened  Nombre de calques floutés pré-rendus
 * @property {number} prepTime   Temps de préparation (ms)
 */

/**
 * Teste si une URL (ou data URI) désigne un SVG.
 * @param {string} src
 * @returns {boolean}
 */
export function isSvgSource(src) {
  if (typeof src !== "string" || !src) return false;
  if (src.startsWith("data:image/svg+xml")) return true;
  const clean = src.split(/[?#]/)[0].toLowerCase();
  return clean.endsWith(".svg");
}

/**
 * Lit une longueur SVG en pixels. Renvoie null pour les unités non gérées (%, em…).
 * @param {string|null} value
 * @returns {number|null}
 */
function parseLength(value) {
  if (!value) return null;
  const match = /^\s*([\d.]+)\s*(px)?\s*$/i.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Lit un SVG et le normalise : taille explicite et viewBox présente, pour qu'il
 * se mette à l'échelle proprement quelle que soit la façon dont il a été exporté.
 * @param {string} svgText
 * @param {{width:number, height:number}} fallbackSize  Taille utilisée par Foundry
 * @returns {{doc:XMLDocument, width:number, height:number}}
 */
export function parseSvg(svgText, fallbackSize) {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = doc.documentElement;
  if (doc.querySelector("parsererror") || root?.localName?.toLowerCase() !== "svg") {
    throw new Error("Fichier SVG invalide");
  }

  let width = parseLength(root.getAttribute("width"));
  let height = parseLength(root.getAttribute("height"));
  const viewBox = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  const hasViewBox = viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0;

  // Taille manquante : on reprend celle que Foundry a utilisée, pour que la
  // correspondance avec sa texture reste exacte.
  if (!width || !height) {
    width = fallbackSize.width || (hasViewBox ? viewBox[2] : 1000);
    height = fallbackSize.height || (hasViewBox ? viewBox[3] : 1000);
  }

  // Sans viewBox, changer la taille recadrerait le dessin au lieu de le mettre à l'échelle.
  if (!hasViewBox) root.setAttribute("viewBox", `0 0 ${width} ${height}`);
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));

  return { doc, width, height };
}

/**
 * Charge et décode un SVG, une seule fois par URL.
 * @param {string} src
 * @param {{width:number, height:number}} fallbackSize
 * @returns {Promise<SvgSource>}
 */
export function loadSvg(src, fallbackSize, { log } = {}) {
  if (!sources.has(src)) {
    const promise = (async () => {
      const t0 = performance.now();
      const response = await fetch(src);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { doc, width, height } = parseSvg(await response.text(), fallbackSize);
      const flattened = await flattenBlurLayers(doc, { log });
      const text = new XMLSerializer().serializeToString(doc.documentElement);
      const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      try {
        await img.decode();
      } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
      }
      return { img, width, height, url, flattened, prepTime: performance.now() - t0 };
    })();
    promise.catch(() => sources.delete(src)); // nouvelle tentative possible plus tard
    sources.set(src, promise);
  }
  return sources.get(src);
}

/** Libère tous les SVG chargés. */
export function clearSvgCache() {
  for (const promise of sources.values()) {
    promise.then(s => URL.revokeObjectURL(s.url)).catch(() => {});
  }
  sources.clear();
}

/**
 * Crée un canvas en mémoire CPU.
 *
 * willReadFrequently force un canvas logiciel : sans ça, Chrome dessine les grands
 * canvas sur le GPU, et leur copie vers une texture WebGL peut produire des
 * pixels parasites sur certaines cartes graphiques.
 * @param {number} width
 * @param {number} height
 */
export function createCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { canvas, ctx };
}

const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

/**
 * Dessine une portion du SVG dans un canvas, par morceaux, en rendant la main au
 * navigateur entre deux morceaux si le dessin prend trop de temps. L'interface
 * reste ainsi fluide même pour les gros rendus.
 *
 * @param {SvgSource} source
 * @param {CanvasRenderingContext2D} ctx
 * @param {{u0:number, v0:number, du:number, dv:number}} region  Zone normalisée (0 à 1)
 * @param {number} width   Taille du rendu en px
 * @param {number} height
 * @param {() => boolean} isStale  Renvoie true si le rendu est devenu inutile
 * @returns {Promise<boolean>}  false si le rendu a été abandonné
 */
export async function drawRegion(source, ctx, region, width, height, isStale) {
  const { img } = source;
  const sx0 = region.u0 * source.width;
  const sy0 = region.v0 * source.height;
  const kx = (region.du * source.width) / width;   // unités SVG par pixel
  const ky = (region.dv * source.height) / height;

  ctx.clearRect(0, 0, width, height);
  let sliceStart = performance.now();

  for (let y = 0; y < height; y += TILE_SIZE) {
    for (let x = 0; x < width; x += TILE_SIZE) {
      const w = Math.min(TILE_SIZE, width - x);
      const h = Math.min(TILE_SIZE, height - y);
      ctx.drawImage(img, sx0 + x * kx, sy0 + y * ky, w * kx, h * ky, x, y, w, h);

      if (performance.now() - sliceStart > FRAME_BUDGET) {
        await nextFrame();
        if (isStale()) return false;
        sliceStart = performance.now();
      }
    }
  }
  return !isStale();
}
