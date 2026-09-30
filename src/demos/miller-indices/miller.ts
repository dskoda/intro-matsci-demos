/**
 * Geometry and formatting helpers for Miller indices in cubic cells.
 *
 * Everything is in fractional crystal coordinates (x, y, z): the central
 * unit cell is [0, 1]³ and lattice points have integer coordinates.
 */

import type { Vec3 } from '../crystal-structures/lattice';

const EPS = 1e-6;

/** The 8 corners of the central cell, keyed by their coordinates ("101" → (1, 0, 1)). */
export const CORNERS = ['000', '100', '010', '001', '110', '101', '011', '111'] as const;
export type CornerKey = (typeof CORNERS)[number];

export function cornerVec(key: CornerKey): Vec3 {
  return [Number(key[0]), Number(key[1]), Number(key[2])];
}

/**
 * Textbook origin choice: shift the origin to the far side of the cell along
 * every axis with a negative index, so the direction / intercepts stay inside.
 */
export function autoOrigin(indices: Vec3): Vec3 {
  return indices.map((i) => (i < 0 ? 1 : 0)) as Vec3;
}

/** Direction scaled so its largest component is ±1 (it just fits in the cell). */
export function fitDirection(uvw: Vec3): Vec3 {
  const m = Math.max(...uvw.map(Math.abs));
  return uvw.map((c) => c / m) as Vec3;
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

export function gcd3(v: Vec3): number {
  return gcd(gcd(v[0], v[1]), v[2]);
}

/** All distinct directions in the family ⟨uvw⟩ (signed permutations). */
export function familyDirections(uvw: Vec3): Vec3[] {
  const [a, b, c] = uvw.map(Math.abs) as Vec3;
  const perms: Vec3[] = [
    [a, b, c],
    [a, c, b],
    [b, a, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ];
  const seen = new Map<string, Vec3>();
  for (const p of perms) {
    for (let s = 0; s < 8; s++) {
      const d: Vec3 = [s & 1 ? -p[0] : p[0], s & 2 ? -p[1] : p[1], s & 4 ? -p[2] : p[2]];
      seen.set(d.map((x) => x + 0).join(','), d.map((x) => x + 0) as Vec3); // +0 folds −0
    }
  }
  return [...seen.values()];
}

/** Unit-length grid segments of the integer lattice inside [lo, hi]³. */
export function cubeGridEdges(lo: number, hi: number): [Vec3, Vec3][] {
  const edges: [Vec3, Vec3][] = [];
  for (let i = lo; i <= hi; i++) {
    for (let j = lo; j <= hi; j++) {
      for (let k = lo; k < hi; k++) {
        edges.push([
          [k, i, j],
          [k + 1, i, j],
        ]);
        edges.push([
          [i, k, j],
          [i, k + 1, j],
        ]);
        edges.push([
          [i, j, k],
          [i, j, k + 1],
        ]);
      }
    }
  }
  return edges;
}

/**
 * Polygon where the plane n·p = c cuts the box [lo, hi], with vertices in
 * order around the polygon. Empty if the plane misses the box (or only
 * touches an edge or corner).
 */
export function planeBoxPolygon(n: Vec3, c: number, lo: Vec3, hi: Vec3): Vec3[] {
  const corner = (m: number): Vec3 => [
    m & 1 ? hi[0] : lo[0],
    m & 2 ? hi[1] : lo[1],
    m & 4 ? hi[2] : lo[2],
  ];
  const pts: Vec3[] = [];
  const push = (p: Vec3): void => {
    if (!pts.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-7)) pts.push(p);
  };
  // The 12 box edges join corners that differ in exactly one bit
  for (let m = 0; m < 8; m++) {
    for (const bit of [1, 2, 4]) {
      if (m & bit) continue;
      const p = corner(m);
      const q = corner(m | bit);
      const fp = dot(n, p) - c;
      const fq = dot(n, q) - c;
      if (Math.abs(fp) < EPS) push(p);
      if (Math.abs(fq) < EPS) push(q);
      if (fp * fq < 0) {
        const t = fp / (fp - fq);
        push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])]);
      }
    }
  }
  if (pts.length < 3) return [];

  // Sort by angle around the centroid, within the plane
  const cen = pts.reduce<Vec3>((s, p) => add(s, p), [0, 0, 0]).map((v) => v / pts.length) as Vec3;
  const len = Math.hypot(...n);
  const nn = n.map((v) => v / len) as Vec3;
  const helper: Vec3 = Math.abs(nn[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = cross(nn, helper);
  const w = cross(nn, u);
  const angle = (p: Vec3): number => {
    const d: Vec3 = [p[0] - cen[0], p[1] - cen[1], p[2] - cen[2]];
    return Math.atan2(dot(d, w), dot(d, u));
  };
  return pts.sort((a, b) => angle(a) - angle(b));
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function distanceToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const t = Math.max(0, Math.min(1, dot(ap, ab) / dot(ab, ab)));
  return Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]);
}

const MINUS = '−';

/** 0.5 → "1/2", −1/3 → "−1/3", 2 → "2", Infinity → "∞". */
export function formatFraction(x: number): string {
  if (!Number.isFinite(x)) return '∞';
  const sign = x < -EPS ? MINUS : '';
  const ax = Math.abs(x);
  for (let d = 1; d <= 6; d++) {
    const num = Math.round(ax * d);
    if (Math.abs(ax * d - num) < 1e-6) return d === 1 ? `${sign}${num}` : `${sign}${num}/${d}`;
  }
  return `${sign}${ax.toFixed(2)}`;
}

export function formatCoord(p: Vec3): string {
  return `(${p.map(formatFraction).join(', ')})`;
}

/** HTML for Miller indices, negatives with an overbar: [1 1̄ 0], (1̄ 1 1). */
export function formatIndices(v: Vec3, open: string, close: string): string {
  const parts = v.map((i) =>
    i < 0 ? `<span style="text-decoration:overline">${-i}</span>` : `${i}`
  );
  return `${open}${parts.join('&thinsp;')}${close}`;
}
