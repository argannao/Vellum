/**
 * Optimisation des SVG avant rendu.
 *
 * Les filtres de flou (feGaussianBlur) sont de loin l'opération la plus coûteuse
 * pour le navigateur : à fort zoom, il doit recalculer le flou sur une surface
 * énorme à chaque rendu. Or un contenu flou n'a, par nature, aucun détail fin :
 * le transformer en image bitmap ne change rien visuellement.
 *
 * Chaque groupe flouté est donc rendu une seule fois en image, puis remplacé
 * par une balise <image> à la même place dans le document. L'ordre d'affichage,
 * les transformations et les modes de fusion (mix-blend-mode) sont conservés.
 */

/** Taille maximale (côté le plus long) d'un calque flouté pré-rendu. */
const BLUR_MAX_SIDE = 2048;

/** En dessous de cette taille de flou (en px du calque), on garde le vectoriel. */
const MIN_BLUR_PIXELS = 1.5;

/** Au-delà de ce nombre de groupes floutés (ombres d'objets…), on n'optimise pas. */
const MAX_LAYERS = 8;

const SVG_NS = "http://www.w3.org/2000/svg";
const DEF_TAGS = "filter, linearGradient, radialGradient, pattern, clipPath, mask, symbol, marker, style";
const NON_RENDERED = "defs, clipPath, mask, pattern, symbol, marker";

/**
 * Remplace les groupes floutés d'un document SVG par des images pré-rendues.
 * Le document est modifié sur place.
 *
 * @param {XMLDocument} doc   Document normalisé (taille et viewBox explicites)
 * @param {{log?:Function}} [options]
 * @returns {Promise<number>}  Nombre de calques remplacés
 */
export async function flattenBlurLayers(doc, { log } = {}) {
  const root = doc.documentElement;
  const blurFilters = new Map();
  for (const filter of root.querySelectorAll("filter")) {
    if (!filter.id) continue;
    const sigma = Math.max(0, ...Array.from(filter.querySelectorAll("feGaussianBlur"))
      .flatMap(b => (b.getAttribute("stdDeviation") ?? "0").trim().split(/[\s,]+/).map(Number))
      .filter(Number.isFinite));
    if (sigma > 0) blurFilters.set(filter.id, sigma);
  }
  if (!blurFilters.size) return 0;

  const targets = Array.from(root.querySelectorAll("[filter]"))
    .map(el => ({ el, sigma: blurFilters.get(filterId(el)) }))
    .filter(t => t.sigma && !t.el.closest(NON_RENDERED) && !t.el.parentElement?.closest("[filter]"));
  if (!targets.length) return 0;
  if (targets.length > MAX_LAYERS) {
    log?.(`${targets.length} groupes floutés : trop nombreux, conservés en vectoriel`);
    return 0;
  }

  // Définitions réutilisables : dans <defs>, mais aussi déclarées ailleurs
  // (certains exports placent les filtres et dégradés directement dans le document).
  const defs = [
    ...root.querySelectorAll("defs"),
    ...Array.from(root.querySelectorAll(DEF_TAGS)).filter(el => !el.parentElement?.closest("defs, " + DEF_TAGS))
  ].filter(el => !el.parentElement?.closest("defs"));

  const viewBox = root.getAttribute("viewBox").trim().split(/[\s,]+/).map(Number);
  let count = 0;
  for (const { el, sigma } of targets) {
    try {
      if (await flattenOne(doc, el, sigma, defs, viewBox, log)) count++;
    } catch (error) {
      log?.("Calque flouté conservé tel quel", error);
    }
  }
  return count;
}

/**
 * Pré-rend un groupe flouté et le remplace par une image.
 * @returns {Promise<boolean>}
 */
async function flattenOne(doc, el, sigma, defs, viewBox, log) {
  // Repère local du groupe : produit des transformations des ancêtres et de la sienne.
  const ctm = new DOMMatrix();
  const chain = [];
  for (let node = el; node && node !== doc.documentElement; node = node.parentElement) chain.unshift(node);
  for (const node of chain) ctm.multiplySelf(parseTransform(node.getAttribute("transform")));
  if (!ctm.is2D || Math.abs(ctm.a * ctm.d - ctm.b * ctm.c) < 1e-12) return false;

  // Zone de la carte (viewBox) exprimée dans ce repère local.
  const inv = ctm.inverse();
  const [vx, vy, vw, vh] = viewBox;
  const corners = [[vx, vy], [vx + vw, vy], [vx, vy + vh], [vx + vw, vy + vh]].map(([x, y]) => inv.transformPoint({ x, y }));
  const pad = 3 * sigma;
  const x = Math.min(...corners.map(p => p.x)) - pad;
  const y = Math.min(...corners.map(p => p.y)) - pad;
  const w = Math.max(...corners.map(p => p.x)) + pad - x;
  const h = Math.max(...corners.map(p => p.y)) + pad - y;

  const k = BLUR_MAX_SIDE / Math.max(w, h);
  const pxW = Math.max(1, Math.round(w * k));
  const pxH = Math.max(1, Math.round(h * k));
  if (sigma * k < MIN_BLUR_PIXELS) {
    log?.("Flou trop fin pour être pré-rendu, conservé en vectoriel");
    return false;
  }

  // SVG isolé : uniquement ce groupe, dans son repère local, sans fusion ni opacité.
  const isolated = doc.implementation.createDocument(SVG_NS, "svg", null);
  const svg = isolated.documentElement;
  for (const attr of doc.documentElement.attributes) {
    if (!["width", "height", "viewBox", "preserveAspectRatio"].includes(attr.name)) svg.setAttribute(attr.name, attr.value);
  }
  svg.setAttribute("width", String(pxW));
  svg.setAttribute("height", String(pxH));
  svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "none");
  for (const d of defs) svg.appendChild(isolated.importNode(d, true));

  // Attributs de présentation hérités des ancêtres (fill, stroke…).
  const wrapper = isolated.createElementNS(SVG_NS, "g");
  for (const name of INHERITED) {
    const value = inheritedValue(el, name);
    if (value != null) wrapper.setAttribute(name, value);
  }
  const copy = isolated.importNode(el, true);
  copy.removeAttribute("transform");
  copy.removeAttribute("opacity");
  stripBlend(copy);
  wrapper.appendChild(copy);
  svg.appendChild(wrapper);

  const dataUrl = await rasterizeToDataUrl(new XMLSerializer().serializeToString(svg), pxW, pxH);

  // Remplacement à la même place : transformations, fusion et opacité conservées.
  const image = doc.createElementNS(SVG_NS, "image");
  image.setAttribute("x", String(x));
  image.setAttribute("y", String(y));
  image.setAttribute("width", String(w));
  image.setAttribute("height", String(h));
  image.setAttribute("preserveAspectRatio", "none");
  image.setAttribute("href", dataUrl);
  for (const name of ["transform", "opacity", "style", "clip-path", "mask"]) {
    const value = el.getAttribute(name);
    if (value) image.setAttribute(name, value);
  }
  el.replaceWith(image);
  return true;
}

/* -------------------------------------------- */
/*  Utilitaires                                 */
/* -------------------------------------------- */

function filterId(el) {
  return /url\(\s*['"]?#([^'")\s]+)/.exec(el.getAttribute("filter") ?? "")?.[1];
}

/** Attributs de présentation hérités qu'il faut reporter sur le groupe isolé. */
const INHERITED = ["fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity",
  "stroke-linejoin", "stroke-linecap", "stroke-dasharray", "color"];

function inheritedValue(el, name) {
  for (let node = el.parentElement; node && node !== el.ownerDocument.documentElement; node = node.parentElement) {
    const value = node.getAttribute(name);
    if (value != null) return value;
  }
  return null;
}

/** Retire le mode de fusion et l'opacité du groupe isolé (l'image les appliquera). */
function stripBlend(el) {
  const style = el.getAttribute("style");
  if (!style) return;
  const cleaned = style.replace(/(mix-blend-mode|opacity)\s*:\s*[^;]+;?/g, "").trim();
  if (cleaned) el.setAttribute("style", cleaned);
  else el.removeAttribute("style");
}

/**
 * Lit un attribut transform SVG (matrix, translate, scale, rotate, skewX, skewY).
 * @param {string|null} value
 * @returns {DOMMatrix}
 */
export function parseTransform(value) {
  const m = new DOMMatrix();
  if (!value) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(value))) {
    const a = match[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    switch (match[1]) {
      case "matrix": m.multiplySelf(new DOMMatrix(a.slice(0, 6))); break;
      case "translate": m.translateSelf(a[0] ?? 0, a[1] ?? 0); break;
      case "scale": m.scaleSelf(a[0] ?? 1, a[1] ?? a[0] ?? 1); break;
      case "rotate":
        if (a.length >= 3) m.translateSelf(a[1], a[2]).rotateSelf(a[0]).translateSelf(-a[1], -a[2]);
        else m.rotateSelf(a[0] ?? 0);
        break;
      case "skewX": m.skewXSelf(a[0] ?? 0); break;
      case "skewY": m.skewYSelf(a[0] ?? 0); break;
    }
  }
  return m;
}

/** Rend un SVG dans un canvas et l'encode en PNG (data URL, seule forme qu'un SVG-image peut charger). */
async function rasterizeToDataUrl(svgText, width, height) {
  const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d", { willReadFrequently: true }).drawImage(img, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Encodage PNG impossible"))), "image/png"));
    canvas.width = canvas.height = 0;
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
