/**
 * Optical band gap (Lecture 16): pure physics, no DOM.
 *
 * Energies in eV, wavelengths in nm (λ = 1240 / E). The visible range is 380 to 750 nm,
 * i.e. 1.65 to 3.26 eV. Below it is infrared, above it ultraviolet.
 */

export const E_IR_MAX = 1240 / 750; // 1.653 eV
export const E_UV_MIN = 1240 / 380; // 3.263 eV
export const E_MIN = 0.5;
export const E_MAX = 4.5;

export type Region = 'Infrared' | 'Visible' | 'Ultraviolet';

export function wavelength(eV: number): number {
  return eV > 0 ? 1240 / eV : Infinity;
}

export function region(eV: number): Region {
  if (eV < E_IR_MAX) return 'Infrared';
  if (eV > E_UV_MIN) return 'Ultraviolet';
  return 'Visible';
}

/** Dan Bruton wavelength to RGB (0..255), with gamma. Only meaningful for 380..750 nm. */
function bruton(l: number): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  if (l < 440) {
    r = -(l - 440) / 60;
    b = 1;
  } else if (l < 490) {
    g = (l - 440) / 50;
    b = 1;
  } else if (l < 510) {
    g = 1;
    b = -(l - 510) / 20;
  } else if (l < 580) {
    r = (l - 510) / 70;
    g = 1;
  } else if (l < 645) {
    r = 1;
    g = -(l - 645) / 65;
  } else {
    r = 1;
  }
  let f = 1;
  if (l < 420) f = 0.35 + (0.65 * (l - 380)) / 40;
  else if (l > 700) f = 0.35 + (0.65 * (750 - l)) / 50;
  const c = (v: number): number => Math.round(255 * Math.pow(Math.max(0, v * f), 0.8));
  return [c(r), c(g), c(b)];
}

/** Colour of a photon: rainbow when visible, a dim red-grey in the IR and violet-grey in the UV. */
export function photonRGB(eV: number): [number, number, number] {
  const r = region(eV);
  if (r === 'Infrared') {
    const t = Math.max(0, (eV - E_MIN) / (E_IR_MAX - E_MIN));
    return [Math.round(120 + 30 * t), 80, 80];
  }
  if (r === 'Ultraviolet') return [150, 120, 215];
  return bruton(wavelength(eV));
}

export function photonColor(eV: number, alpha = 1): string {
  const [r, g, b] = photonRGB(eV);
  return `rgba(${r},${g},${b},${alpha})`;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Absorption coefficient (arbitrary units): zero below the gap, α0 above it, with a soft edge. */
export const ALPHA0 = 7;
export const EDGE_WIDTH = 0.06;
export function absorption(eph: number, eg: number): number {
  return ALPHA0 * smoothstep(eg - EDGE_WIDTH, eg + EDGE_WIDTH, eph);
}

/**
 * Colour of the material in white light. Photons with E < Eg are transmitted, those above are
 * absorbed, so the body colour is the mix of the visible photons below the gap.
 * Returns the colour, the transmitted fraction of the visible band (0 black, 1 clear),
 * and a short name.
 */
export function bodyColor(eg: number): { rgb: [number, number, number]; clear: number; name: string } {
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  let nAll = 0;
  const steps = 60;
  for (let i = 0; i < steps; i++) {
    const e = E_IR_MAX + ((i + 0.5) / steps) * (E_UV_MIN - E_IR_MAX);
    nAll++;
    if (e < eg) {
      const [r, g, b] = photonRGB(e);
      sr += r;
      sg += g;
      sb += b;
      n++;
    }
  }
  const clear = n / nAll;
  if (n === 0) return { rgb: [20, 20, 24], clear: 0, name: 'black (absorbs all visible light)' };
  let r = sr / n;
  let g = sg / n;
  let b = sb / n;
  const m = Math.max(r, g, b, 1);
  r = (r / m) * 255;
  g = (g / m) * 255;
  b = (b / m) * 255;
  if (clear > 0.97) return { rgb: [235, 240, 250], clear: 1, name: 'transparent (colourless)' };
  return { rgb: [Math.round(r), Math.round(g), Math.round(b)], clear, name: colorName(r, g, b) };
}

function colorName(r: number, g: number, b: number): string {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx - mn < 40) return 'whitish';
  const d = mx - mn;
  let h: number;
  if (mx === r) h = (((g - b) / d) % 6) * 60;
  else if (mx === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  if (h < 0) h += 360;
  if (h < 20 || h >= 340) return 'red';
  if (h < 45) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 160) return 'green';
  if (h < 200) return 'cyan';
  if (h < 260) return 'blue';
  return 'violet';
}

/* ---- pores ---------------------------------------------------------------------------- */

export const MAX_PORES = 500;
export const PORE_R = 4;

export interface Pore {
  /** Fractional position inside the slab, 0..1. */
  u: number;
  v: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Evenly spread pore positions (best candidate), fixed so the slider adds or removes pores. */
export function makePores(n = MAX_PORES, seed = 7): Pore[] {
  const rnd = mulberry32(seed);
  const pores: Pore[] = [];
  for (let i = 0; i < n; i++) {
    let best: Pore | null = null;
    let bestD = -1;
    for (let k = 0; k < 8; k++) {
      const c = { u: 0.02 + 0.96 * rnd(), v: 0.02 + 0.96 * rnd() };
      let d = Infinity;
      for (const p of pores) d = Math.min(d, (p.u - c.u) ** 2 + (p.v - c.v) ** 2);
      if (d > bestD) {
        bestD = d;
        best = c;
      }
    }
    pores.push(best!);
  }
  return pores;
}

/** Number of pores that give a porosity (area fraction) in a slab of the given pixel area. */
export function poreCount(porosity: number, area: number): number {
  return Math.min(MAX_PORES, Math.round((porosity * area) / (Math.PI * PORE_R * PORE_R)));
}
