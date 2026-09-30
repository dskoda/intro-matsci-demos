/**
 * Hard-sphere lattice geometry for SC, BCC, FCC and HCP.
 *
 * All lengths are in units of the atomic radius R = 1, so touching spheres
 * are exactly 2 apart. The vertical (three.js "up") axis is +y; stacking
 * layers are built along +y, and the in-plane coordinates are (x, z).
 */

export type Structure = 'sc' | 'bcc' | 'fcc' | 'hcp';
export type LayerLabel = 'A' | 'B' | 'C';
export type Site = 'corner' | 'face' | 'body';
export type Vec3 = [number, number, number];

export interface Atom {
  pos: Vec3;
  layerLabel: LayerLabel;
  site: Site;
}

export interface CellBuild {
  atoms: Atom[];
  /** Cell edges as pairs of endpoints */
  edges: [Vec3, Vec3][];
}

export const R = 1;
export const CONTACT = 2 * R;
const EPS = 1e-6;

export interface StructureInfo {
  name: string;
  /** Lattice parameter a (and c for HCP), in units of R */
  a: number;
  c?: number;
  apf: number;
  cn: number;
  /** How the layers-mode planes are chosen */
  layerPlane: string;
  /** Stacking period used in layers mode */
  stacking: LayerLabel[];
}

export const STRUCTURES: Record<Structure, StructureInfo> = {
  sc: {
    name: 'Simple cubic (SC)',
    a: 2 * R,
    apf: Math.PI / 6,
    cn: 6,
    layerPlane: '(001) square layers',
    stacking: ['A'],
  },
  bcc: {
    name: 'Body-centered cubic (BCC)',
    a: (4 * R) / Math.sqrt(3),
    apf: (Math.PI * Math.sqrt(3)) / 8,
    cn: 8,
    layerPlane: '(001) square layers',
    stacking: ['A', 'B'],
  },
  fcc: {
    name: 'Face-centered cubic (FCC)',
    a: 2 * Math.SQRT2 * R,
    apf: Math.PI / (3 * Math.SQRT2),
    cn: 12,
    layerPlane: '(111) close-packed layers',
    stacking: ['A', 'B', 'C'],
  },
  hcp: {
    name: 'Hexagonal close-packed (HCP)',
    a: 2 * R,
    c: 2 * R * Math.sqrt(8 / 3),
    apf: Math.PI / (3 * Math.SQRT2),
    cn: 12,
    layerPlane: '(0001) close-packed layers',
    stacking: ['A', 'B'],
  },
};

export function stackingLabel(structure: Structure, layerIndex: number): LayerLabel {
  const seq = STRUCTURES[structure].stacking;
  return seq[layerIndex % seq.length]!;
}

/** Interlayer spacing along the stacking axis in layers mode. */
function layerSpacing(structure: Structure): number {
  switch (structure) {
    case 'sc':
      return 2 * R;
    case 'bcc':
      return STRUCTURES.bcc.a / 2;
    case 'fcc':
    case 'hcp':
      return 2 * R * Math.sqrt(2 / 3);
  }
}

/** In-plane (x, z) offset of a stacking position. */
function layerOffset(structure: Structure, label: LayerLabel): [number, number] {
  const k = label === 'A' ? 0 : label === 'B' ? 1 : 2;
  if (structure === 'fcc' || structure === 'hcp') {
    // Centroids of the triangular hollows of the A layer
    return [k * R, (k * R) / Math.sqrt(3)];
  }
  const a = STRUCTURES[structure].a;
  return [(k * a) / 2, (k * a) / 2];
}

/**
 * Build `nLayers` stacked layers. `extent` controls the lateral size:
 * hexagonal patches with `extent` rings for close-packed planes, and
 * square patches of half-width `extent` lattice spacings otherwise.
 */
export function buildLayers(structure: Structure, nLayers: number, extent: number): Atom[] {
  const atoms: Atom[] = [];
  const d = layerSpacing(structure);
  const closePacked = structure === 'fcc' || structure === 'hcp';
  const N = extent + 3;

  // Hexagon normals perpendicular to the three close-packed row directions
  const normals: [number, number][] = [30, 90, 150].map((deg) => {
    const t = (deg * Math.PI) / 180;
    return [Math.cos(t), Math.sin(t)];
  });
  const apothem = extent * Math.sqrt(3) * R + EPS;

  for (let layer = 0; layer < nLayers; layer++) {
    const label = stackingLabel(structure, layer);
    const [ox, oz] = layerOffset(structure, label);
    const y = layer * d;

    for (let m = -N; m <= N; m++) {
      for (let n = -N; n <= N; n++) {
        let x: number;
        let z: number;
        if (closePacked) {
          x = m * 2 * R + n * R + ox;
          z = n * Math.sqrt(3) * R + oz;
          const inside = normals.every(([nx, nz]) => Math.abs(x * nx + z * nz) <= apothem);
          if (!inside) continue;
        } else {
          const a = STRUCTURES[structure].a;
          x = m * a + ox;
          z = n * a + oz;
          const half = extent * a + EPS;
          if (Math.abs(x) > half || Math.abs(z) > half) continue;
        }
        atoms.push({ pos: [x, y, z], layerLabel: label, site: 'corner' });
      }
    }
  }
  return atoms;
}

/**
 * Build nx × ny × nz conventional unit cells (ny is the vertical count).
 * `pad` extends the atoms (not the edges) by that many cells on every side,
 * which is needed wherever spheres from neighboring cells poke into the cell.
 */
export function buildCells(
  structure: Structure,
  nx: number,
  ny: number,
  nz: number,
  pad = 0
): CellBuild {
  return structure === 'hcp'
    ? buildHcpCells(nx, ny, nz, pad)
    : buildCubicCells(structure, nx, ny, nz, pad);
}

function buildCubicCells(
  structure: Structure,
  nx: number,
  ny: number,
  nz: number,
  pad: number
): CellBuild {
  const a = STRUCTURES[structure].a;
  const basis: { f: Vec3; site: Site }[] = [{ f: [0, 0, 0], site: 'corner' }];
  if (structure === 'bcc') basis.push({ f: [0.5, 0.5, 0.5], site: 'body' });
  if (structure === 'fcc') {
    basis.push({ f: [0.5, 0.5, 0], site: 'face' });
    basis.push({ f: [0.5, 0, 0.5], site: 'face' });
    basis.push({ f: [0, 0.5, 0.5], site: 'face' });
  }

  const atoms: Atom[] = [];
  for (let i = -pad; i <= nx + pad; i++) {
    for (let j = -pad; j <= ny + pad; j++) {
      for (let k = -pad; k <= nz + pad; k++) {
        for (const b of basis) {
          const fx = i + b.f[0];
          const fy = j + b.f[1];
          const fz = k + b.f[2];
          if (fx > nx + pad + EPS || fy > ny + pad + EPS || fz > nz + pad + EPS) continue;
          atoms.push({
            pos: [fx * a, fy * a, fz * a],
            layerLabel: cubicLayerLabel(structure, fx, fy, fz),
            site: b.site,
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

/**
 * Stacking labels inside the cubic cells: FCC is ABC along the body
 * diagonal [111]; BCC is AB along the vertical [001]; SC is all A.
 */
function cubicLayerLabel(structure: Structure, fx: number, fy: number, fz: number): LayerLabel {
  const labels: LayerLabel[] = ['A', 'B', 'C'];
  if (structure === 'fcc') {
    const plane = Math.round(fx + fy + fz); // FCC sites have integer (x+y+z) in units of a
    return labels[((plane % 3) + 3) % 3]!;
  }
  if (structure === 'bcc') return Math.round(fy * 2) % 2 === 0 ? 'A' : 'B';
  return 'A';
}

/** Hexagon (side a, vertex along +x) centers for the HCP prism arrangement. */
export function hcpPrismCenters(nx: number, nz: number, pad = 0): [number, number][] {
  const a = STRUCTURES.hcp.a;
  const t1: [number, number] = [1.5 * a, (Math.sqrt(3) / 2) * a];
  const t2: [number, number] = [0, Math.sqrt(3) * a];
  const centers: [number, number][] = [];
  for (let i = -pad; i < nx + pad; i++) {
    for (let k = -pad; k < nz + pad; k++) {
      centers.push([i * t1[0] + k * t2[0], i * t1[1] + k * t2[1]]);
    }
  }
  return centers;
}

function insideHexagon(x: number, z: number, cx: number, cz: number, a: number): boolean {
  const apothem = (Math.sqrt(3) / 2) * a + 1e-4;
  for (const deg of [30, 90, 150]) {
    const t = (deg * Math.PI) / 180;
    if (Math.abs((x - cx) * Math.cos(t) + (z - cz) * Math.sin(t)) > apothem) return false;
  }
  return true;
}

function buildHcpCells(nx: number, ny: number, nz: number, pad: number): CellBuild {
  const a = STRUCTURES.hcp.a;
  const c = STRUCTURES.hcp.c!;
  const centers = hcpPrismCenters(nx, nz);
  const atomCenters = hcpPrismCenters(nx, nz, pad);

  const atoms: Atom[] = [];
  const seen = new Set<string>();
  const N = 2 * (nx + nz + 2 * pad) + 4;
  const bOffset: [number, number] = [a / 2, a / (2 * Math.sqrt(3))];

  for (let layer = -2 * pad; layer <= 2 * (ny + pad); layer++) {
    const isB = Math.abs(layer) % 2 === 1;
    const y = (layer * c) / 2;
    for (let m = -N; m <= N; m++) {
      for (let n = -N; n <= N; n++) {
        const x = m * a + n * (a / 2) + (isB ? bOffset[0] : 0);
        const z = n * (Math.sqrt(3) / 2) * a + (isB ? bOffset[1] : 0);
        const owner = atomCenters.find(([cx, cz]) => insideHexagon(x, z, cx, cz, a));
        if (!owner) continue;
        const key = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        let site: Site = 'body';
        if (!isB) {
          const atCenter = atomCenters.some(([cx, cz]) => Math.hypot(x - cx, z - cz) < 1e-4);
          site = atCenter ? 'face' : 'corner';
        }
        atoms.push({ pos: [x, y, z], layerLabel: isB ? 'B' : 'A', site });
      }
    }
  }

  const edges: [Vec3, Vec3][] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (p: Vec3, q: Vec3): void => {
    const kp = p.map((v) => v.toFixed(3)).join(',');
    const kq = q.map((v) => v.toFixed(3)).join(',');
    const key = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push([p, q]);
  };
  for (const [cx, cz] of centers) {
    const verts: [number, number][] = [];
    for (let v = 0; v < 6; v++) {
      const t = (v * Math.PI) / 3;
      verts.push([cx + a * Math.cos(t), cz + a * Math.sin(t)]);
    }
    for (let j = 0; j <= ny; j++) {
      const y = j * c;
      for (let v = 0; v < 6; v++) {
        const p = verts[v]!;
        const q = verts[(v + 1) % 6]!;
        addEdge([p[0], y, p[1]], [q[0], y, q[1]]);
      }
    }
    for (const [vx, vz] of verts) {
      for (let j = 0; j < ny; j++) addEdge([vx, j * c, vz], [vx, (j + 1) * c, vz]);
    }
  }
  return { atoms, edges };
}

/**
 * A region is a union of convex parts; each part is a list of half-spaces
 * n·p + d >= 0 (n is the inward unit normal).
 */
export interface HalfSpace {
  n: Vec3;
  d: number;
}
export type Region = HalfSpace[][];

/** Signed distance-like measure: > 0 inside the region, < 0 outside. */
export function insideDistance(region: Region, p: Vec3): number {
  let best = -Infinity;
  for (const part of region) {
    let m = Infinity;
    for (const { n, d } of part) m = Math.min(m, n[0] * p[0] + n[1] * p[1] + n[2] * p[2] + d);
    best = Math.max(best, m);
  }
  return best;
}

function hexPrism(cx: number, cz: number, apothem: number, y0: number, y1: number): HalfSpace[] {
  const part: HalfSpace[] = [
    { n: [0, 1, 0], d: -y0 },
    { n: [0, -1, 0], d: y1 },
  ];
  for (const deg of [30, 90, 150, 210, 270, 330]) {
    const t = (deg * Math.PI) / 180;
    const ux = Math.cos(t);
    const uz = Math.sin(t);
    part.push({ n: [-ux, 0, -uz], d: apothem + ux * cx + uz * cz });
  }
  return part;
}

function box(x1: number, y1: number, z1: number, x0 = 0, y0 = 0, z0 = 0): HalfSpace[] {
  return [
    { n: [1, 0, 0], d: -x0 },
    { n: [-1, 0, 0], d: x1 },
    { n: [0, 1, 0], d: -y0 },
    { n: [0, -1, 0], d: y1 },
    { n: [0, 0, 1], d: -z0 },
    { n: [0, 0, -1], d: z1 },
  ];
}

/** The volume of the nx × ny × nz unit cells (ny vertical). */
export function cellRegion(structure: Structure, nx: number, ny: number, nz: number): Region {
  if (structure === 'hcp') {
    const { a, c } = STRUCTURES.hcp;
    const apothem = (Math.sqrt(3) / 2) * a;
    return hcpPrismCenters(nx, nz).map(([cx, cz]) => hexPrism(cx, cz, apothem, 0, ny * c!));
  }
  const a = STRUCTURES[structure].a;
  return [box(nx * a, ny * a, nz * a)];
}

/**
 * The volume of a layers-mode stack: between the bottom and top layer
 * planes, laterally bounded by the outermost row of A-layer atom centers.
 */
export function layerRegion(structure: Structure, nLayers: number, extent: number): Region {
  const yTop = (nLayers - 1) * layerSpacing(structure);
  if (structure === 'fcc' || structure === 'hcp') {
    return [hexPrism(0, 0, extent * Math.sqrt(3) * R, 0, yTop)];
  }
  const h = extent * STRUCTURES[structure].a;
  return [box(h, yTop, h, -h, 0, -h)];
}

/** All pairs of touching spheres (center distance = 2R). */
export function findContacts(atoms: Atom[]): [number, number][] {
  const pairs: [number, number][] = [];
  const target = CONTACT * CONTACT;
  const tol = 1e-3 * target;
  for (let i = 0; i < atoms.length; i++) {
    const p = atoms[i]!.pos;
    for (let j = i + 1; j < atoms.length; j++) {
      const q = atoms[j]!.pos;
      const dx = p[0] - q[0];
      const dy = p[1] - q[1];
      const dz = p[2] - q[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (Math.abs(d2 - target) < tol) pairs.push([i, j]);
    }
  }
  return pairs;
}
