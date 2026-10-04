/**
 * Crystal defects on a simple (square / simple cubic) lattice
 *
 * Pure geometry, shared by the 2D and 3D defect demos: builds a perfect crystal
 * and then introduces a vacancy, a self-interstitial, an edge or screw
 * dislocation (isotropic Volterra displacement field), or a tilt grain
 * boundary. Atoms are classified as "core" (coordination changed or very close
 * to the defect), "shell" (within a chosen radius of the defect) or "bulk".
 *
 * Lengths are in units of the lattice constant a = 1.
 */

import type { Vec3 } from '../crystal-structures/lattice';

export type DefectType =
  | 'perfect'
  | 'vacancy'
  | 'interstitial'
  | 'edge'
  | 'screw'
  | 'grain-boundary';

export type Role = 'bulk' | 'shell' | 'core' | 'extra';

export interface DefectAtom {
  pos: Vec3;
  role: Role;
  /** Number of neighbours within BOND_CUTOFF */
  cn: number;
}

export interface DefectOptions {
  dim: 2 | 3;
  /** Number of atoms along each edge (adjusted so the defect sits symmetrically) */
  size: number;
  /** Atoms closer than this to the defect are highlighted as "shell" */
  shellRadius: number;
  /** Total misorientation of the grain boundary (degrees) */
  tilt: number;
}

export interface DefectStructure {
  type: DefectType;
  atoms: DefectAtom[];
  bonds: [number, number][];
  /** Empty lattice sites (vacancy) */
  ghosts: Vec3[];
  /** Largest coordinate of the (undistorted) crystal along each axis */
  half: number;
  /** Half-height of the crystal along z (0 in 2D) */
  halfZ: number;
  /** Burgers vector of a dislocation */
  burgers: Vec3 | null;
  /** Actual edge length used */
  n: number;
}

export const BOND_CUTOFF = 1.3;
const CORE_RADIUS = 1.0;
const POISSON = 0.3;

export const DEFECT_INFO: Record<DefectType, { label: string; description: string }> = {
  perfect: {
    label: 'Perfect crystal',
    description: 'Every atom sits on a lattice site and has the full set of neighbours.',
  },
  vacancy: {
    label: 'Vacancy',
    description:
      'A missing atom (point defect). The neighbours have one fewer bond and relax slightly toward the hole.',
  },
  interstitial: {
    label: 'Self-interstitial',
    description:
      'An extra atom of the same element squeezed between lattice sites. It pushes its neighbours away and strains the surrounding lattice.',
  },
  edge: {
    label: 'Edge dislocation',
    description:
      'An extra half-plane of atoms ends inside the crystal. The dislocation line runs along the end of the half-plane; the Burgers vector b is perpendicular to it.',
  },
  screw: {
    label: 'Screw dislocation',
    description:
      'Atomic planes spiral around the dislocation line like a parking-garage ramp. The Burgers vector b is parallel to the line.',
  },
  'grain-boundary': {
    label: 'Grain boundary',
    description:
      'Two crystals with the same structure but different orientations meet at an interface. Atoms along the boundary have irregular bonding.',
  },
};

export const ROLE_COLORS: Record<Role, string> = {
  bulk: '#4a9eff',
  shell: '#ff9f4a',
  core: '#ff4d6d',
  extra: '#7CFF9F',
};

export const ROLE_LABELS: Record<Role, string> = {
  bulk: 'Bulk atoms',
  shell: 'Nearby (strained) atoms',
  core: 'Defect core (changed bonding)',
  extra: 'Extra atom',
};

export function defectTypes(dim: 2 | 3): DefectType[] {
  return dim === 2
    ? ['perfect', 'vacancy', 'interstitial', 'edge']
    : ['perfect', 'vacancy', 'interstitial', 'edge', 'screw', 'grain-boundary'];
}

/** Vacancies need an atom at the origin (odd n); everything else is centred on a cell. */
export function fitSize(type: DefectType, size: number): number {
  const odd = type === 'vacancy';
  return size % 2 === (odd ? 1 : 0) ? size : size + 1;
}

function distToDefect(type: DefectType, p: Vec3): number {
  switch (type) {
    case 'vacancy':
    case 'interstitial':
      return Math.hypot(p[0], p[1], p[2]);
    case 'edge':
    case 'screw':
      return Math.hypot(p[0], p[1]);
    case 'grain-boundary':
      return Math.abs(p[0]);
    default:
      return Infinity;
  }
}

/** Isotropic-elasticity displacement of an edge dislocation with b = x̂, line along z. */
function edgeDisplacement(x: number, y: number): [number, number] {
  const r2 = x * x + y * y;
  const theta = Math.atan2(y, x);
  const k = 1 / (2 * Math.PI);
  const c = 4 * (1 - POISSON);
  const ux = k * (theta + (x * y) / (2 * (1 - POISSON) * r2));
  const uy = -k * (((1 - 2 * POISSON) / c) * Math.log(r2) * 0.5 + (x * x - y * y) / (c * r2));
  return [ux, uy];
}

interface RawAtom {
  pos: Vec3;
  extra: boolean;
  /** Well inside the crystal, so missing neighbours are not a surface effect */
  interior: boolean;
}

/**
 * 2D edge dislocation built the textbook way: the upper half has one more
 * column than the lower half, so an extra half-plane ends at the origin.
 * Both halves span the same width, so the upper columns are compressed
 * (spacing < 1) and the lower columns stretched (spacing > 1).
 */
function buildEdgeHalfPlane(n: number): RawAtom[] {
  const half = (n - 1) / 2;
  const width = n - 0.5;
  const upperSpacing = width / n;
  const lowerSpacing = width / (n - 1);
  const atoms: RawAtom[] = [];
  for (let j = 0; j < n; j++) {
    const y = j - half;
    const inRows = Math.abs(y) <= half - 0.99;
    if (y > 0) {
      for (let k = 0; k <= n; k++) {
        atoms.push({
          pos: [(k - n / 2) * upperSpacing, y, 0],
          extra: k === n / 2,
          interior: inRows && k >= 1 && k <= n - 1,
        });
      }
    } else {
      for (let i = 0; i < n; i++) {
        atoms.push({
          pos: [(i - half) * lowerSpacing, y, 0],
          extra: false,
          interior: inRows && i >= 1 && i <= n - 2,
        });
      }
    }
  }
  return atoms;
}

function buildGrainBoundary(n: number, dim: 2 | 3, tiltDeg: number): RawAtom[] {
  const h = (n - 1) / 2 + 0.05;
  const m = Math.ceil(n * 0.9) + 2;
  const kRange = dim === 3 ? m : 0;
  const grains: Vec3[][] = [[], []];
  for (let g = 0; g < 2; g++) {
    const phi = ((g === 0 ? 1 : -1) * tiltDeg * Math.PI) / 360;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    for (let i = -m; i <= m; i++) {
      for (let j = -m; j <= m; j++) {
        for (let k = -kRange; k <= kRange; k++) {
          const x = i * c + k * s;
          const z = -i * s + k * c;
          if (Math.abs(x) > h || Math.abs(j) > h || Math.abs(z) > (dim === 3 ? h : 0.01)) continue;
          if (g === 0 ? x >= 0 : x < 0) continue;
          grains[g]!.push([x, j, z]);
        }
      }
    }
  }
  // Remove atoms of grain B that overlap grain A across the boundary
  const minDist2 = 0.8 * 0.8;
  const keep = grains[1]!.filter((p) =>
    grains[0]!.every((q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2 > minDist2)
  );
  const inner = h - 1.2;
  return [...grains[0]!, ...keep].map((pos) => ({
    pos,
    extra: false,
    interior:
      Math.abs(pos[0]) <= inner &&
      Math.abs(pos[1]) <= inner &&
      (dim === 2 || Math.abs(pos[2]) <= inner),
  }));
}

export function buildDefect(type: DefectType, options: DefectOptions): DefectStructure {
  const { dim } = options;
  if (!defectTypes(dim).includes(type)) type = 'perfect';
  const n = fitSize(type, Math.round(options.size));
  const nz = dim === 3 ? n : 1;
  const half = (n - 1) / 2;
  const halfZ = (nz - 1) / 2;
  const ideal = 2 * dim;

  let raw: RawAtom[] = [];
  const ghosts: Vec3[] = [];
  let burgers: Vec3 | null = null;

  if (type === 'grain-boundary') {
    raw = buildGrainBoundary(n, dim, options.tilt);
  } else if (type === 'edge' && dim === 2) {
    raw = buildEdgeHalfPlane(n);
    burgers = [1, 0, 0];
  } else {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        for (let k = 0; k < nz; k++) {
          const ref: Vec3 = [i - half, j - half, k - halfZ];
          const interior =
            Math.abs(ref[0]) <= half - 0.99 &&
            Math.abs(ref[1]) <= half - 0.99 &&
            (dim === 2 || Math.abs(ref[2]) <= halfZ - 0.99);
          const r2 = ref[0] ** 2 + ref[1] ** 2 + ref[2] ** 2;
          let pos: Vec3 = ref;
          if (type === 'vacancy') {
            if (r2 < 1e-9) {
              ghosts.push(ref);
              continue;
            }
            const f = -0.06 / r2;
            pos = [ref[0] + f * ref[0], ref[1] + f * ref[1], ref[2] + f * ref[2]];
          } else if (type === 'interstitial') {
            const f = 0.1 / r2;
            pos = [ref[0] + f * ref[0], ref[1] + f * ref[1], ref[2] + f * ref[2]];
          } else if (type === 'edge') {
            const [ux, uy] = edgeDisplacement(ref[0], ref[1]);
            pos = [ref[0] + ux, ref[1] + uy, ref[2]];
          } else if (type === 'screw') {
            pos = [ref[0], ref[1], ref[2] + Math.atan2(ref[1], ref[0]) / (2 * Math.PI)];
          }
          raw.push({ pos, extra: false, interior });
        }
      }
    }
    if (type === 'interstitial') raw.push({ pos: [0, 0, 0], extra: true, interior: true });
    if (type === 'edge') burgers = [1, 0, 0];
    if (type === 'screw') burgers = [0, 0, 1];
  }

  // Bonds and coordination numbers
  const bonds: [number, number][] = [];
  const cn = new Array<number>(raw.length).fill(0);
  const cut2 = BOND_CUTOFF * BOND_CUTOFF;
  const stagger = type === 'edge' && dim === 2;
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i]!.pos;
    for (let j = i + 1; j < raw.length; j++) {
      const q = raw[j]!.pos;
      const dx = p[0] - q[0];
      if (dx * dx > cut2) continue;
      const d2 = dx * dx + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      // Across the slip plane of the 2D half-plane model, bond only to atoms roughly below
      if (d2 <= cut2 && !(stagger && p[1] * q[1] < 0 && Math.abs(dx) > 0.55)) {
        bonds.push([i, j]);
        cn[i]!++;
        cn[j]!++;
      }
    }
  }

  const atoms: DefectAtom[] = raw.map((a, i) => {
    const d = distToDefect(type, a.pos);
    let role: Role = 'bulk';
    if (a.extra) role = 'extra';
    else if (type !== 'perfect') {
      // Grain boundary: colour purely by distance to the boundary plane
      const byBonding = type !== 'grain-boundary' && a.interior && cn[i] !== ideal;
      if (d < CORE_RADIUS || byBonding) role = 'core';
      else if (d < options.shellRadius) role = 'shell';
    }
    return { pos: a.pos, role, cn: cn[i]! };
  });

  return { type, atoms, bonds, ghosts, half, halfZ, burgers, n };
}

export interface BurgersCircuit {
  path: Vec3[];
  /** Closure failure: the circuit ends at `end` instead of returning to `start` */
  start: Vec3;
  end: Vec3;
}

/**
 * Walk k lattice steps right, up, left and down around the dislocation core,
 * always hopping to the real atom nearest the ideal next site. In a perfect
 * crystal this closes; around a dislocation it does not, and the closure
 * failure is the Burgers vector.
 */
export function burgersCircuit(structure: DefectStructure, k: number): BurgersCircuit | null {
  const atoms = structure.atoms;
  const nearest = (target: Vec3, tol: number): Vec3 | null => {
    let best: Vec3 | null = null;
    let bestD = tol * tol;
    for (const a of atoms) {
      const d = (a.pos[0] - target[0]) ** 2 + (a.pos[1] - target[1]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = a.pos;
      }
    }
    return best;
  };

  const start = nearest([-k + 0.5, -k + 0.5, 0], 0.7);
  if (!start) return null;
  const path: Vec3[] = [start];
  const dirs: Vec3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [-1, 0, 0],
    [0, -1, 0],
  ];
  let cur = start;
  for (const dir of dirs) {
    for (let s = 0; s < 2 * k; s++) {
      const next = nearest([cur[0] + dir[0], cur[1] + dir[1], 0], 0.6);
      if (!next) return null;
      path.push(next);
      cur = next;
    }
  }
  return { path, start, end: cur };
}
