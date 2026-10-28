/**
 * Microstructure picture for the TTT demo: a periodic G×G map of prior-austenite grains,
 * pearlite colonies and martensite plates. Each pixel carries a phase label; `sync` relabels
 * pixels so that the area of each phase equals its fraction. Diffusional products nucleate at
 * the austenite grain boundaries and grow inward, martensite fills plate by plate, and
 * spheroidite replaces pearlite/bainite colony by colony.
 */

import { mulberry32 } from '../strengthening/strengthening';
import { PHASES, type Fractions, type Phase } from './ttt';

export const G = 256;
const N = G * G;

const IDX: Record<Phase, number> = { A: 0, Pc: 1, Pf: 2, B: 3, M: 4, S: 5 };

function wrap(d: number): number {
  const a = Math.abs(d);
  return a > G / 2 ? G - a : a;
}

function swrap(d: number): number {
  return d > G / 2 ? d - G : d < -G / 2 ? d + G : d;
}

function hash(i: number, j: number, s: number): number {
  let h =
    Math.imul(i + 374761393, 668265263) ^
    Math.imul(j + 1274126177, 2246822519) ^
    Math.imul(s + 1, 3266489917);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function argsort(key: Float32Array): Uint32Array {
  const idx = Array.from({ length: key.length }, (_, i) => i);
  idx.sort((a, b) => key[a]! - key[b]!);
  return Uint32Array.from(idx);
}

export class SteelPicture {
  readonly label = new Uint8Array(N);
  private counts = [N, 0, 0, 0, 0, 0];
  private pO = 0;
  private pM = 0;
  private grain = new Int32Array(N);
  private colony = new Int32Array(N);
  private plate = new Int32Array(N);
  private boundary = new Uint8Array(N);
  private orderP: Uint32Array;
  private orderM: Uint32Array;
  private orderS: Uint32Array;
  private tex: Uint8ClampedArray[] = [];

  constructor(seed: number) {
    const rng = mulberry32(seed);

    // prior-austenite grains: jittered grid of seeds, distance to the boundary from d2 − d1
    const NG = 6;
    const gx: number[] = [];
    const gy: number[] = [];
    for (let j = 0; j < NG; j++)
      for (let i = 0; i < NG; i++) {
        gx.push(((i + 0.15 + 0.7 * rng()) * G) / NG);
        gy.push(((j + 0.15 + 0.7 * rng()) * G) / NG);
      }
    const gAngle = gx.map(() => rng() * Math.PI);
    const bd = new Float32Array(N);
    for (let y = 0; y < G; y++)
      for (let x = 0; x < G; x++) {
        let d1 = Infinity;
        let d2 = Infinity;
        let b = 0;
        for (let k = 0; k < gx.length; k++) {
          const dx = wrap(x - gx[k]!);
          const dy = wrap(y - gy[k]!);
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < d1) {
            d2 = d1;
            d1 = d;
            b = k;
          } else if (d < d2) d2 = d;
        }
        const i = y * G + x;
        this.grain[i] = b;
        bd[i] = (d2 - d1) / 2;
      }
    for (let y = 0; y < G; y++)
      for (let x = 0; x < G; x++) {
        const i = y * G + x;
        const r = this.grain[y * G + ((x + 1) % G)]!;
        const d = this.grain[((y + 1) % G) * G + x]!;
        this.boundary[i] = r !== this.grain[i] || d !== this.grain[i] ? 1 : 0;
      }

    // pearlite / bainite colonies
    const NC = 15;
    const cx: number[] = [];
    const cy: number[] = [];
    for (let j = 0; j < NC; j++)
      for (let i = 0; i < NC; i++) {
        cx.push(((i + 0.1 + 0.8 * rng()) * G) / NC);
        cy.push(((j + 0.1 + 0.8 * rng()) * G) / NC);
      }
    const cAngle = cx.map(() => rng() * Math.PI);
    for (let y = 0; y < G; y++)
      for (let x = 0; x < G; x++) {
        let best = Infinity;
        let b = 0;
        for (let k = 0; k < cx.length; k++) {
          const dx = wrap(x - cx[k]!);
          const dy = wrap(y - cy[k]!);
          const d = dx * dx + dy * dy;
          if (d < best) {
            best = d;
            b = k;
          }
        }
        this.colony[y * G + x] = b;
      }

    // martensite plates: elongated cells, oriented ±~55° from a per-grain axis
    const NP = 420;
    const px: number[] = [];
    const py: number[] = [];
    const pAng: number[] = [];
    for (let k = 0; k < NP; k++) {
      const x = rng() * G;
      const y = rng() * G;
      let gi = 0;
      let bestd = Infinity;
      for (let q = 0; q < gx.length; q++) {
        const dx = wrap(x - gx[q]!);
        const dy = wrap(y - gy[q]!);
        const d = dx * dx + dy * dy;
        if (d < bestd) {
          bestd = d;
          gi = q;
        }
      }
      px.push(x);
      py.push(y);
      pAng.push(gAngle[gi]! + (rng() < 0.5 ? 1 : -1) * (0.9 + 0.25 * (rng() - 0.5)));
    }
    const cosA = pAng.map(Math.cos);
    const sinA = pAng.map(Math.sin);
    for (let y = 0; y < G; y++)
      for (let x = 0; x < G; x++) {
        let best = Infinity;
        let b = 0;
        for (let k = 0; k < NP; k++) {
          const dx = swrap(x - px[k]!);
          const dy = swrap(y - py[k]!);
          const u = dx * cosA[k]! + dy * sinA[k]!;
          const v = -dx * sinA[k]! + dy * cosA[k]!;
          const d = (u * u) / 9 + v * v * 4;
          if (d < best) {
            best = d;
            b = k;
          }
        }
        this.plate[y * G + x] = b;
      }

    // orders in which pixels are consumed
    const noise = valueNoise(rng, 12);
    const keyP = new Float32Array(N);
    for (let i = 0; i < N; i++) keyP[i] = bd[i]! + 14 * (noise[i]! - 0.5) + 0.5 * rng();
    this.orderP = argsort(keyP);
    const plateRank = Array.from({ length: NP }, () => rng());
    const keyM = new Float32Array(N);
    for (let i = 0; i < N; i++) keyM[i] = plateRank[this.plate[i]!]! + 1e-4 * rng();
    this.orderM = argsort(keyM);
    const colRank = Array.from({ length: NC * NC }, () => rng());
    const keyS = new Float32Array(N);
    for (let i = 0; i < N; i++) keyS[i] = colRank[this.colony[i]!]! + 1e-4 * rng();
    this.orderS = argsort(keyS);

    this.buildTextures(seed, gAngle, cAngle, pAng);
  }

  private buildTextures(seed: number, gAngle: number[], cAngle: number[], pAng: number[]) {
    const mk = () => new Uint8ClampedArray(N * 4);
    const T = PHASES.map(mk);
    const set = (a: Uint8ClampedArray, i: number, r: number, g: number, b: number) => {
      a[4 * i] = r;
      a[4 * i + 1] = g;
      a[4 * i + 2] = b;
      a[4 * i + 3] = 255;
    };
    const rng = mulberry32(seed + 17);
    const colShade = Array.from({ length: 256 }, () => rng());
    const grainShade = Array.from({ length: 64 }, () => rng());
    const SP = 8; // spheroidite cell size
    const dots: number[] = [];
    for (let k = 0; k < (G / SP) * (G / SP); k++) dots.push(rng(), rng(), 1.2 + rng() * 1.0);
    for (let y = 0; y < G; y++)
      for (let x = 0; x < G; x++) {
        const i = y * G + x;
        const col = this.colony[i]!;
        const ca = cAngle[col]!;
        const u = x * Math.cos(ca) + y * Math.sin(ca);
        const sh = colShade[col % 256]!;

        // austenite: light grains
        const gs = grainShade[this.grain[i]! % 64]!;
        const a = 178 + 22 * gs;
        set(T[0]!, i, a, a + 4, a + 14);

        // coarse pearlite: wide lamellae
        const pc = (((u / 9) % 1) + 1) % 1 < 0.18;
        set(T[1]!, i, pc ? 112 : 244 - 14 * sh, pc ? 68 : 214 - 14 * sh, pc ? 38 : 168 - 14 * sh);

        // fine pearlite: narrow lamellae
        const pf = (((u / 3.6) % 1) + 1) % 1 < 0.32;
        set(T[2]!, i, pf ? 125 : 238 - 12 * sh, pf ? 38 : 168 - 12 * sh, pf ? 46 : 160 - 12 * sh);

        // bainite: sheaves of fine plates with scattered carbides
        const ba = ca * 0.5 + gAngle[this.grain[i]!]! * 0.5;
        const ub = x * Math.cos(ba) + y * Math.sin(ba);
        const vb = -x * Math.sin(ba) + y * Math.cos(ba);
        const stripe = (((ub / 4.2) % 1) + 1) % 1;
        const carbide =
          stripe < 0.35 && hash(Math.floor(vb / 3), Math.floor(ub / 4.2), seed) < 0.75;
        set(
          T[3]!,
          i,
          carbide ? 38 : 150 - 14 * sh,
          carbide ? 88 : 208 - 14 * sh,
          carbide ? 58 : 164 - 14 * sh
        );

        // martensite: plates with darker edges
        const pl = this.plate[i]!;
        const ps = hash(pl, 3, seed);
        const right = this.plate[y * G + ((x + 1) % G)]!;
        const down = this.plate[((y + 1) % G) * G + x]!;
        const edge = right !== pl || down !== pl;
        const midrib = Math.abs(-x * Math.sin(pAng[pl]!) + y * Math.cos(pAng[pl]!)) % 6 < 0.7;
        if (edge) set(T[4]!, i, 30, 52, 100);
        else set(T[4]!, i, (midrib ? 130 : 160) + 25 * ps, (midrib ? 170 : 200) + 20 * ps, 245);

        // spheroidite: carbide spheres in a ferrite matrix
        let inDot = false;
        const cxm = Math.floor(x / SP);
        const cym = Math.floor(y / SP);
        for (let dy = -1; dy <= 1 && !inDot; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const ix = (cxm + dx + G / SP) % (G / SP);
            const iy = (cym + dy + G / SP) % (G / SP);
            const k = (iy * (G / SP) + ix) * 3;
            const dxp = (cxm + dx) * SP + 1.5 + dots[k]! * (SP - 3) - x;
            const dyp = (cym + dy) * SP + 1.5 + dots[k + 1]! * (SP - 3) - y;
            const r = dots[k + 2]!;
            if (dxp * dxp + dyp * dyp < r * r) {
              inDot = true;
              break;
            }
          }
        set(T[5]!, i, inDot ? 82 : 226, inDot ? 46 : 208, inDot ? 112 : 238);
      }
    this.tex = T;
  }

  reset() {
    this.label.fill(0);
    this.counts = [N, 0, 0, 0, 0, 0];
    this.pO = 0;
    this.pM = 0;
  }

  /** Relabel pixels so that the area of each phase matches the fractions */
  sync(f: Fractions) {
    const target = PHASES.map((p) => Math.round(f[p] * N));
    const count = this.counts;
    // spheroidite replaces pearlite/bainite colony by colony
    let needS = target[5]! - count[5]!;
    if (needS > 0) {
      for (const L of [1, 2, 3]) {
        let e = Math.min(needS, count[L]! - target[L]!);
        if (e <= 0) continue;
        for (let k = 0; k < N && e > 0; k++) {
          const i = this.orderS[k]!;
          if (this.label[i] === L) {
            this.label[i] = 5;
            count[L]!--;
            count[5]!++;
            e--;
            needS--;
          }
        }
      }
    }
    // martensite from the remaining austenite, plate by plate
    let needM = target[4]! - count[4]!;
    while (needM > 0 && this.pM < N) {
      const i = this.orderM[this.pM++]!;
      if (this.label[i] === 0) {
        this.label[i] = 4;
        count[0]!--;
        count[4]!++;
        needM--;
      }
    }
    // diffusional products nucleate at grain boundaries and grow inward
    for (const L of [1, 2, 3]) {
      let need = target[L]! - count[L]!;
      while (need > 0 && this.pO < N) {
        const i = this.orderP[this.pO++]!;
        if (this.label[i] === 0) {
          this.label[i] = L;
          count[0]!--;
          count[L]!++;
          need--;
        }
      }
    }
  }

  paint(out: Uint8ClampedArray) {
    for (let i = 0; i < N; i++) {
      const t = this.tex[this.label[i]!]!;
      let r = t[4 * i]!;
      let g = t[4 * i + 1]!;
      let b = t[4 * i + 2]!;
      if (this.boundary[i]) {
        r = r * 0.35;
        g = g * 0.35;
        b = b * 0.35;
      }
      out[4 * i] = r;
      out[4 * i + 1] = g;
      out[4 * i + 2] = b;
      out[4 * i + 3] = 255;
    }
  }
}

/** Smooth periodic value noise in [0, 1) on the G×G grid */
function valueNoise(rng: () => number, cells: number): Float32Array {
  const v = Array.from({ length: cells * cells }, () => rng());
  const out = new Float32Array(N);
  const s = G / cells;
  for (let y = 0; y < G; y++)
    for (let x = 0; x < G; x++) {
      const fx = x / s;
      const fy = y / s;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const a = v[(y0 % cells) * cells + (x0 % cells)]!;
      const b = v[(y0 % cells) * cells + ((x0 + 1) % cells)]!;
      const c = v[((y0 + 1) % cells) * cells + (x0 % cells)]!;
      const d = v[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)]!;
      out[y * G + x] =
        a * (1 - sx) * (1 - sy) + b * sx * (1 - sy) + c * (1 - sx) * sy + d * sx * sy;
    }
  return out;
}

export { IDX as PHASE_INDEX };
