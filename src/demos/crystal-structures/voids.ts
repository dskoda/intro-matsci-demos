/**
 * Empty-space (void) surface for a hard-sphere packing.
 *
 * The void is the part of a region not covered by spheres of the full
 * radius R. It is the set where g(p) = min(dist to nearest atom − R,
 * inside-distance to the region) > 0; its boundary g = 0 is extracted with
 * marching tetrahedra on a regular grid.
 */

import { R, insideDistance, type HalfSpace, type Region, type Vec3 } from './lattice';

export interface VoidSurface {
  positions: Float32Array;
  normals: Float32Array;
  /** Fraction of the region volume that is empty (grid estimate) */
  emptyFraction: number;
}

const MAX_GRID_POINTS = 150_000;
const MIN_SPACING = 0.08;

/** Six tetrahedra sharing the cube diagonal 0–6 */
const CUBE_CORNERS: Vec3[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];
const TETS = [
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
  [0, 5, 1, 6],
];

/** Spatial hash for nearest-atom queries (only exact up to 2R). */
function nearestAtom(centers: Vec3[]): (p: Vec3) => { dist: number; center: Vec3 | null } {
  const size = 2 * R;
  const buckets = new Map<string, Vec3[]>();
  const key = (i: number, j: number, k: number) => `${i},${j},${k}`;
  for (const c of centers) {
    const k = key(Math.floor(c[0] / size), Math.floor(c[1] / size), Math.floor(c[2] / size));
    const list = buckets.get(k);
    if (list) list.push(c);
    else buckets.set(k, [c]);
  }
  return (p) => {
    const bi = Math.floor(p[0] / size);
    const bj = Math.floor(p[1] / size);
    const bk = Math.floor(p[2] / size);
    let best = size * size;
    let center: Vec3 | null = null;
    for (let i = bi - 1; i <= bi + 1; i++) {
      for (let j = bj - 1; j <= bj + 1; j++) {
        for (let k = bk - 1; k <= bk + 1; k++) {
          const list = buckets.get(key(i, j, k));
          if (!list) continue;
          for (const c of list) {
            const dx = p[0] - c[0];
            const dy = p[1] - c[1];
            const dz = p[2] - c[2];
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < best) {
              best = d2;
              center = c;
            }
          }
        }
      }
    }
    return { dist: Math.sqrt(best), center };
  };
}

/** The half-space that determines insideDistance(region, p). */
function activePlane(region: Region, p: Vec3): HalfSpace | null {
  let best = -Infinity;
  let plane: HalfSpace | null = null;
  for (const part of region) {
    let m = Infinity;
    let arg: HalfSpace | null = null;
    for (const hs of part) {
      const v = hs.n[0] * p[0] + hs.n[1] * p[1] + hs.n[2] * p[2] + hs.d;
      if (v < m) {
        m = v;
        arg = hs;
      }
    }
    if (m > best) {
      best = m;
      plane = arg;
    }
  }
  return plane;
}

/**
 * @param centers all atom centers that can reach into the region (include neighbors outside it)
 * @param region  the volume in which empty space is shown
 * @param bounds  axis-aligned box enclosing the region
 */
export function computeVoidSurface(
  centers: Vec3[],
  region: Region,
  bounds: { min: Vec3; max: Vec3 }
): VoidSurface {
  const nearestFull = nearestAtom(centers);
  const nearest = (p: Vec3) => nearestFull(p).dist;

  const ext = [0, 1, 2].map((i) => bounds.max[i]! - bounds.min[i]!);
  const volume = ext.reduce((acc, e) => acc * Math.max(e, 1e-3), 1);
  const h = Math.max(MIN_SPACING, Math.cbrt(volume / MAX_GRID_POINTS));
  // One extra sample outside the box on each side so the surface closes
  const origin = bounds.min.map((v) => v - h) as Vec3;
  const dims = ext.map((e) => Math.ceil(e / h) + 3);
  const [nx, ny, nz] = dims as [number, number, number];

  const g = new Float32Array(nx * ny * nz);
  const idx = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  let inRegion = 0;
  let empty = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const p: Vec3 = [origin[0] + i * h, origin[1] + j * h, origin[2] + k * h];
        g[idx(i, j, k)] = Math.min(insideDistance(region, p), nearest(p) - R);
      }
    }
  }

  // Volume estimate from voxel midpoints (unbiased at the region faces)
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const p: Vec3 = [
          origin[0] + (i + 0.5) * h,
          origin[1] + (j + 0.5) * h,
          origin[2] + (k + 0.5) * h,
        ];
        if (insideDistance(region, p) <= 0) continue;
        inRegion++;
        if (nearest(p) > R) empty++;
      }
    }
  }

  const pos: number[] = [];
  const nrm: number[] = [];

  interface Corner {
    p: Vec3;
    v: number;
  }
  interface Vertex {
    p: Vec3;
    n: Vec3;
  }
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

  /** Closest point to p on the circle where the sphere at c meets the plane. */
  const onRim = (p: Vec3, c: Vec3, { n, d }: HalfSpace): Vec3 => {
    const h = n[0] * c[0] + n[1] * c[1] + n[2] * c[2] + d;
    if (Math.abs(h) >= R) return p;
    const q0: Vec3 = [c[0] - n[0] * h, c[1] - n[1] * h, c[2] - n[2] * h];
    const pd = n[0] * p[0] + n[1] * p[1] + n[2] * p[2] + d;
    const v = sub([p[0] - n[0] * pd, p[1] - n[1] * pd, p[2] - n[2] * pd], q0);
    const len = Math.hypot(v[0], v[1], v[2]);
    if (len < 1e-9) return p;
    const s = Math.sqrt(R * R - h * h) / len;
    return [q0[0] + v[0] * s, q0[1] + v[1] * s, q0[2] + v[2] * s];
  };

  /**
   * Point where g = 0 on the edge from an inside corner to an outside corner,
   * snapped onto the exact surface (sphere or cell face) with its analytic
   * normal, which points out of the void.
   */
  const cut = (a: Corner, b: Corner): Vertex => {
    const t = a.v / (a.v - b.v);
    const p: Vec3 = [
      a.p[0] + (b.p[0] - a.p[0]) * t,
      a.p[1] + (b.p[1] - a.p[1]) * t,
      a.p[2] + (b.p[2] - a.p[2]) * t,
    ];
    const { dist, center } = nearestFull(p);
    const plane = activePlane(region, p);
    const planeDist = plane ? insideDistance(region, p) : Infinity;
    if (plane && (planeDist < dist - R || !center)) {
      const { n } = plane;
      let q: Vec3 = [p[0] - n[0] * planeDist, p[1] - n[1] * planeDist, p[2] - n[2] * planeDist];
      // Near (or inside) a sphere: move to the rim so the crease is sharp
      const hit = nearestFull(q);
      if (hit.center && hit.dist < R + h) q = onRim(q, hit.center, plane);
      return { p: q, n: [-n[0], -n[1], -n[2]] };
    }
    const c = center!;
    const len = dist || 1;
    const u: Vec3 = [(c[0] - p[0]) / len, (c[1] - p[1]) / len, (c[2] - p[2]) / len];
    let q: Vec3 = [c[0] - u[0] * R, c[1] - u[1] * R, c[2] - u[2] * R];
    // Near (or outside) a face: move to the rim so the crease is sharp
    const face = activePlane(region, q);
    if (face && insideDistance(region, q) < h) q = onRim(q, c, face);
    return { p: q, n: u };
  };

  const emit = (a: Vertex, b: Vertex, c: Vertex): void => {
    const face = cross(sub(b.p, a.p), sub(c.p, a.p));
    const avg = [a.n[0] + b.n[0] + c.n[0], a.n[1] + b.n[1] + c.n[1], a.n[2] + b.n[2] + c.n[2]];
    const tri =
      face[0] * avg[0]! + face[1] * avg[1]! + face[2] * avg[2]! >= 0 ? [a, b, c] : [a, c, b];
    for (const v of tri) {
      pos.push(...v.p);
      nrm.push(...v.n);
    }
  };

  const corners = new Array<Corner>(8);
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let nPos = 0;
        for (const [di, dj, dk] of CUBE_CORNERS) {
          if (g[idx(i + di, j + dj, k + dk)]! > 0) nPos++;
        }
        if (nPos === 0 || nPos === 8) continue;
        for (let c = 0; c < 8; c++) {
          const [di, dj, dk] = CUBE_CORNERS[c]!;
          corners[c] = {
            p: [origin[0] + (i + di) * h, origin[1] + (j + dj) * h, origin[2] + (k + dk) * h],
            v: g[idx(i + di, j + dj, k + dk)]!,
          };
        }

        for (const tet of TETS) {
          const vs = tet.map((c) => corners[c]!);
          const inside = vs.filter((c) => c.v > 0);
          const outside = vs.filter((c) => c.v <= 0);
          if (inside.length === 0 || inside.length === 4) continue;
          if (inside.length === 1) {
            const p = inside[0]!;
            emit(cut(p, outside[0]!), cut(p, outside[1]!), cut(p, outside[2]!));
          } else if (inside.length === 3) {
            const q = outside[0]!;
            emit(cut(inside[0]!, q), cut(inside[1]!, q), cut(inside[2]!, q));
          } else {
            const [p0, p1] = inside as [Corner, Corner];
            const [q0, q1] = outside as [Corner, Corner];
            const a = cut(p0, q0);
            const b = cut(p0, q1);
            const c = cut(p1, q1);
            const d = cut(p1, q0);
            emit(a, b, c);
            emit(a, c, d);
          }
        }
      }
    }
  }

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    emptyFraction: inRegion > 0 ? empty / inRegion : 0,
  };
}
