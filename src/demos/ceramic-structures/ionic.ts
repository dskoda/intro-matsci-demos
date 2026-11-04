/**
 * Hard-sphere geometry of simple ionic (ceramic) crystals: zinc blende (ZnS),
 * rock salt (NaCl), CsCl, fluorite (CaF2) and perovskite (SrTiO3).
 *
 * Every structure is a cubic cell given by fractional basis sites. All lengths
 * are in units of the ANION radius (r- = 1); the cation radius is the radius
 * ratio r+/r- times that. The lattice constant `a` follows from the contact
 * condition: ions are hard spheres, so `a` is the smallest value for which no
 * two spheres overlap. For a small cation the anions touch each other and the
 * cation rattles in its hole; for a large cation the cations and anions touch
 * and the anions are pushed apart.
 *
 * The vertical (three.js "up") axis is +y.
 */

export type IonicStructure = 'zns' | 'nacl' | 'cscl' | 'fluorite' | 'perovskite';
export type Vec3 = [number, number, number];
export type IonKind = 'anion' | 'cation' | 'cationA';
export type Site = 'corner' | 'edge' | 'face' | 'interior';

export interface SpeciesInfo {
  /** Ion symbol with charge, e.g. "Na⁺" */
  symbol: string;
  /** Optional role in the structure, e.g. "A-site" */
  role?: string;
  /**
   * `anion`: radius 1. `cation`: radius from the ratio slider.
   * `cationA`: the large A-site cation of the perovskite (own slider).
   */
  kind: IonKind;
  color: string;
}

export interface BasisSite {
  species: number;
  /** Fractional coordinates in the conventional cubic cell */
  f: Vec3;
}

export interface IonicInfo {
  name: string;
  formula: string;
  species: SpeciesInfo[];
  basis: BasisSite[];
  /** Real compound used as the example, with Shannon radii (Å) per species */
  example: string;
  exampleRadii: number[];
  /** Formula units per cell */
  z: number;
}

export interface Atom {
  pos: Vec3;
  species: number;
  site: Site;
}

export interface CellBuild {
  atoms: Atom[];
  edges: [Vec3, Vec3][];
}

const EPS = 1e-6;
const ANION = '#4a9eff';
const CATION = '#ff9f4a';
const CATION_A = '#c77dff';

const FCC: Vec3[] = [
  [0, 0, 0],
  [0.5, 0.5, 0],
  [0.5, 0, 0.5],
  [0, 0.5, 0.5],
];

const wrap = (v: number): number => ((v % 1) + 1) % 1;

function shifted(sites: Vec3[], s: Vec3, species: number): BasisSite[] {
  return sites.map((p) => ({
    species,
    f: [wrap(p[0] + s[0]), wrap(p[1] + s[1]), wrap(p[2] + s[2])] as Vec3,
  }));
}

const FLUORITE_ANIONS: Vec3[] = [];
for (const x of [0.25, 0.75]) {
  for (const y of [0.25, 0.75]) {
    for (const z of [0.25, 0.75]) FLUORITE_ANIONS.push([x, y, z]);
  }
}

export const STRUCTURES: Record<IonicStructure, IonicInfo> = {
  zns: {
    name: 'Zinc blende (ZnS)',
    formula: 'ZnS',
    species: [
      { symbol: 'Zn²⁺', kind: 'cation', color: CATION },
      { symbol: 'S²⁻', kind: 'anion', color: ANION },
    ],
    basis: [...shifted(FCC, [0.25, 0.25, 0.25], 0), ...shifted(FCC, [0, 0, 0], 1)],
    example: 'ZnS',
    exampleRadii: [0.6, 1.84],
    z: 4,
  },
  nacl: {
    name: 'Rock salt (NaCl)',
    formula: 'NaCl',
    species: [
      { symbol: 'Na⁺', kind: 'cation', color: CATION },
      { symbol: 'Cl⁻', kind: 'anion', color: ANION },
    ],
    basis: [...shifted(FCC, [0.5, 0, 0], 0), ...shifted(FCC, [0, 0, 0], 1)],
    example: 'NaCl',
    exampleRadii: [1.02, 1.81],
    z: 4,
  },
  cscl: {
    name: 'Cesium chloride (CsCl)',
    formula: 'CsCl',
    species: [
      { symbol: 'Cs⁺', kind: 'cation', color: CATION },
      { symbol: 'Cl⁻', kind: 'anion', color: ANION },
    ],
    basis: [
      { species: 0, f: [0.5, 0.5, 0.5] },
      { species: 1, f: [0, 0, 0] },
    ],
    example: 'CsCl',
    exampleRadii: [1.74, 1.81],
    z: 1,
  },
  fluorite: {
    name: 'Fluorite (CaF₂)',
    formula: 'CaF₂',
    species: [
      { symbol: 'Ca²⁺', kind: 'cation', color: CATION },
      { symbol: 'F⁻', kind: 'anion', color: ANION },
    ],
    basis: [...shifted(FCC, [0, 0, 0], 0), ...FLUORITE_ANIONS.map((f) => ({ species: 1, f }))],
    example: 'CaF₂',
    exampleRadii: [1.12, 1.31],
    z: 4,
  },
  perovskite: {
    name: 'Perovskite (SrTiO₃)',
    formula: 'SrTiO₃',
    species: [
      { symbol: 'Ti⁴⁺', role: 'B-site', kind: 'cation', color: CATION },
      { symbol: 'O²⁻', kind: 'anion', color: ANION },
      { symbol: 'Sr²⁺', role: 'A-site', kind: 'cationA', color: CATION_A },
    ],
    basis: [
      { species: 2, f: [0, 0, 0] },
      { species: 0, f: [0.5, 0.5, 0.5] },
      { species: 1, f: [0.5, 0.5, 0] },
      { species: 1, f: [0.5, 0, 0.5] },
      { species: 1, f: [0, 0.5, 0.5] },
    ],
    example: 'SrTiO₃',
    exampleRadii: [0.605, 1.4, 1.44],
    z: 1,
  },
};

export const STRUCTURE_IDS = Object.keys(STRUCTURES) as IonicStructure[];

/** Radius of each species relative to the anion radius (r- = 1). */
export function speciesRadii(s: IonicStructure, ratio: number, ratioA: number): number[] {
  return STRUCTURES[s].species.map((sp) =>
    sp.kind === 'anion' ? 1 : sp.kind === 'cation' ? ratio : ratioA
  );
}

/** Radius ratios (cation, A-site cation) of the real example compound. */
export function exampleRatios(s: IonicStructure): { ratio: number; ratioA: number } {
  const info = STRUCTURES[s];
  const anion = info.species.findIndex((sp) => sp.kind === 'anion');
  const rel = (kind: IonKind): number => {
    const i = info.species.findIndex((sp) => sp.kind === kind);
    return i < 0 ? 1 : info.exampleRadii[i]! / info.exampleRadii[anion]!;
  };
  return {
    ratio: rel('cation'),
    ratioA: info.species.some((sp) => sp.kind === 'cationA') ? rel('cationA') : 1,
  };
}

// --- contact geometry ---------------------------------------------------

function distance(p: Vec3, q: Vec3): number {
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/**
 * Nearest distance (in units of a) between each pair of species, i.e. the
 * distance at which that pair first touches. Entry [i][j] is symmetric.
 */
export function pairDistances(s: IonicStructure): number[][] {
  const { basis, species } = STRUCTURES[s];
  const n = species.length;
  const k = Array.from({ length: n }, () => new Array<number>(n).fill(Infinity));
  for (const p of basis) {
    for (const q of basis) {
      for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
          for (let l = -1; l <= 1; l++) {
            const d = distance(p.f, [q.f[0] + i, q.f[1] + j, q.f[2] + l]);
            if (d < EPS) continue;
            k[p.species]![q.species] = Math.min(k[p.species]![q.species]!, d);
          }
        }
      }
    }
  }
  return k;
}

export interface PairContact {
  i: number;
  j: number;
  /** Lattice constant needed for this pair to touch */
  needed: number;
  /** True if this pair sets the lattice constant */
  binding: boolean;
}

export interface Lattice {
  a: number;
  radii: number[];
  pairs: PairContact[];
}

/** Smallest lattice constant with no overlapping spheres. */
export function solveLattice(s: IonicStructure, radii: number[]): Lattice {
  const k = pairDistances(s);
  const pairs: PairContact[] = [];
  let a = 0;
  for (let i = 0; i < radii.length; i++) {
    for (let j = i; j < radii.length; j++) {
      const needed = (radii[i]! + radii[j]!) / k[i]![j]!;
      pairs.push({ i, j, needed, binding: false });
      a = Math.max(a, needed);
    }
  }
  for (const p of pairs) p.binding = p.needed > a * (1 - 1e-6);
  return { a, radii, pairs };
}

/**
 * Radius ratio r+/r- below which the anions touch each other (the cation
 * starts to rattle): the cation–anion and anion–anion contacts coincide.
 */
export function criticalRatio(s: IonicStructure, cation = 0): number {
  const info = STRUCTURES[s];
  const anion = info.species.findIndex((sp) => sp.kind === 'anion');
  const k = pairDistances(s);
  return (2 * k[cation]![anion]!) / k[anion]![anion]! - 1;
}

/** Textbook radius-ratio boundaries and the coordination number above each. */
export const RATIO_RULE: { from: number; cn: number }[] = [
  { from: 0, cn: 2 },
  { from: 0.155, cn: 3 },
  { from: 0.225, cn: 4 },
  { from: 0.414, cn: 6 },
  { from: 0.732, cn: 8 },
  { from: 1.0, cn: 12 },
];

export function predictedCN(ratio: number): number {
  let cn = RATIO_RULE[0]!.cn;
  for (const r of RATIO_RULE) if (ratio >= r.from - 1e-9) cn = r.cn;
  return cn;
}

// --- neighbours ---------------------------------------------------------

export interface Shell {
  species: number;
  /** Distance to this shell (in the same units as `a`) */
  distance: number;
  positions: Vec3[];
}

/**
 * First shell of each oppositely charged species around an ion (periodic
 * crystal, not limited to the displayed cells). `pos` is in the same units
 * as `a`. For the A-site of a perovskite this is 12 anions, for Ti 6, and for
 * O two shells: 2 Ti and 4 Sr.
 */
export function neighborShells(s: IonicStructure, a: number, pos: Vec3, species: number): Shell[] {
  const info = STRUCTURES[s];
  const isAnion = info.species[species]!.kind === 'anion';
  const cell: Vec3 = [Math.floor(pos[0] / a), Math.floor(pos[1] / a), Math.floor(pos[2] / a)];
  const found = new Map<number, { distance: number; positions: Vec3[] }>();

  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      for (let l = -2; l <= 2; l++) {
        for (const b of info.basis) {
          if ((info.species[b.species]!.kind === 'anion') === isAnion) continue;
          const q: Vec3 = [
            (cell[0] + i + b.f[0]) * a,
            (cell[1] + j + b.f[1]) * a,
            (cell[2] + l + b.f[2]) * a,
          ];
          const d = distance(pos, q);
          const cur = found.get(b.species);
          if (!cur || d < cur.distance - 1e-4 * a) {
            found.set(b.species, { distance: d, positions: [q] });
          } else if (Math.abs(d - cur.distance) <= 1e-4 * a) {
            cur.positions.push(q);
          }
        }
      }
    }
  }
  return [...found.entries()].map(([sp, v]) => ({ species: sp, ...v }));
}

/** Coordination of a species: neighbours per oppositely charged species. */
export function coordination(
  s: IonicStructure,
  species: number
): { species: number; count: number }[] {
  const site = STRUCTURES[s].basis.find((b) => b.species === species)!;
  const shells = neighborShells(s, 1, site.f, species);
  return shells.map((sh) => ({ species: sh.species, count: sh.positions.length }));
}

// --- building cells -----------------------------------------------------

function siteOf(f: Vec3, n: Vec3): Site {
  let onBoundary = 0;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(f[k]!) < EPS || Math.abs(f[k]! - n[k]!) < EPS) onBoundary++;
  }
  return (['interior', 'face', 'edge', 'corner'] as const)[onBoundary]!;
}

/**
 * Build nx × ny × nz conventional cells (ny vertical) of lattice constant `a`.
 * Atoms on the faces, edges and corners are all included. `pad` extends the
 * atoms (not the edges) by that many cells on every side.
 */
export function buildCells(
  s: IonicStructure,
  a: number,
  nx: number,
  ny: number,
  nz: number,
  pad = 0
): CellBuild {
  const basis = STRUCTURES[s].basis;
  const n: Vec3 = [nx, ny, nz];
  const atoms: Atom[] = [];
  for (let i = -pad; i <= nx + pad; i++) {
    for (let j = -pad; j <= ny + pad; j++) {
      for (let k = -pad; k <= nz + pad; k++) {
        for (const b of basis) {
          const f: Vec3 = [i + b.f[0], j + b.f[1], k + b.f[2]];
          if (f[0] > nx + pad + EPS || f[1] > ny + pad + EPS || f[2] > nz + pad + EPS) continue;
          atoms.push({
            pos: [f[0] * a, f[1] * a, f[2] * a],
            species: b.species,
            site: siteOf(f, n),
          });
        }
      }
    }
  }

  const edges: [Vec3, Vec3][] = [];
  const X = nx * a;
  const Y = ny * a;
  const Z = nz * a;
  for (let j = 0; j <= ny; j++) {
    for (let k = 0; k <= nz; k++)
      edges.push([
        [0, j * a, k * a],
        [X, j * a, k * a],
      ]);
  }
  for (let i = 0; i <= nx; i++) {
    for (let k = 0; k <= nz; k++)
      edges.push([
        [i * a, 0, k * a],
        [i * a, Y, k * a],
      ]);
  }
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= ny; j++)
      edges.push([
        [i * a, j * a, 0],
        [i * a, j * a, Z],
      ]);
  }
  return { atoms, edges };
}

/** Signed distance to the nearest face of the box [0,X]×[0,Y]×[0,Z]: > 0 inside. */
export function boxDistance(p: Vec3, size: Vec3): number {
  let m = Infinity;
  for (let k = 0; k < 3; k++) m = Math.min(m, p[k]!, size[k]! - p[k]!);
  return m;
}

/** All pairs of touching spheres (center distance = sum of radii). */
export function findContacts(atoms: Atom[], radii: number[]): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < atoms.length; i++) {
    const p = atoms[i]!;
    for (let j = i + 1; j < atoms.length; j++) {
      const q = atoms[j]!;
      const target = radii[p.species]! + radii[q.species]!;
      const dx = p.pos[0] - q.pos[0];
      if (Math.abs(dx) > target) continue;
      const d = distance(p.pos, q.pos);
      if (Math.abs(d - target) < 1e-3 * target) pairs.push([i, j]);
    }
  }
  return pairs;
}

/** Total sphere volume per cell divided by cell volume. */
export function packingFraction(s: IonicStructure, lattice: Lattice): number {
  let v = 0;
  for (const b of STRUCTURES[s].basis) v += (4 / 3) * Math.PI * lattice.radii[b.species]! ** 3;
  return v / lattice.a ** 3;
}
