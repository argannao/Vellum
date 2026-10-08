/**
 * Chargement et rasterisation de fichiers SVG.
 *
 * Le navigateur sait dessiner un SVG à n'importe quelle taille sans perte :
 * on modifie les attributs width/height de la racine à la taille voulue,
 * puis on le dessine dans un <canvas> que PIXI transforme en texture.
 */

const svgCache = new Map();

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
 * Charge le texte d'un SVG, avec cache par URL.
 * @param {string} src
 * @returns {Promise<string>}
 */
export function loadSvgText(src) {
  if (!svgCache.has(src)) {
    const promise = fetch(src)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .catch(error => {
        svgCache.delete(src); // permet une nouvelle tentative plus tard
        throw error;
      });
    svgCache.set(src, promise);
  }
  return svgCache.get(src);
}

/** Vide le cache des SVG chargés. */
export function clearSvgCache() {
  svgCache.clear();
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
 * Prépare le SVG pour un rendu à la taille demandée.
 * @param {string} svgText            Code source du SVG
 * @param {number} width              Largeur cible en pixels
 * @param {number} height             Hauteur cible en pixels
 * @param {{width:number, height:number}} fallbackSize  Taille d'origine si le SVG n'en déclare pas
 * @returns {string}
 */
export function resizeSvg(svgText, width, height, fallbackSize) {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = doc.documentElement;
  if (doc.querySelector("parsererror") || root?.localName?.toLowerCase() !== "svg") {
    throw new Error("Fichier SVG invalide");
  }

  // Sans viewBox, changer width/height recadrerait le dessin au lieu de le mettre à l'échelle.
  if (!root.hasAttribute("viewBox")) {
    const w = parseLength(root.getAttribute("width")) ?? fallbackSize.width;
    const h = parseLength(root.getAttribute("height")) ?? fallbackSize.height;
    if (w && h) root.setAttribute("viewBox", `0 0 ${w} ${h}`);
  }

  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  return new XMLSerializer().serializeToString(root);
}

/**
 * Rasterise un SVG dans un canvas à la taille demandée.
 * @param {string} svgText
 * @param {number} width
 * @param {number} height
 * @param {{width:number, height:number}} fallbackSize
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function rasterizeSvg(svgText, width, height, fallbackSize) {
  const resized = resizeSvg(svgText, width, height, fallbackSize);
  const blob = new Blob([resized], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    // willReadFrequently force un canvas en mémoire CPU. Sans ça, Chrome dessine
    // les très grands canvas sur le GPU, et la copie vers la texture WebGL peut
    // produire des pixels parasites (points et traits colorés) sur certaines cartes.
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, width, height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}
