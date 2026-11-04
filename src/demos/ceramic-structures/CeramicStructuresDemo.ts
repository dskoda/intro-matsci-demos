/**
 * Ceramic Structures (ionic hard-sphere model)
 *
 * Builds the zinc blende (ZnS), rock salt (NaCl), CsCl, fluorite (CaF2) and
 * perovskite (SrTiO3) structures from hard-sphere cations and anions. The
 * radius ratio r+/r- is a slider: the lattice constant follows from the
 * touching condition, so students see the anions touch (cation rattles) below
 * the critical ratio and the cations and anions touch above it. Click an ion
 * to see its nearest oppositely charged neighbours and the coordination
 * polyhedron. Drag to rotate, scroll to zoom, right-drag to pan.
 *
 * Lengths are in units of the anion radius r-.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import {
  createSlider,
  createSelect,
  createCheckbox,
  createButton,
  type Disposable,
  type SliderControl,
  type SelectControl,
  type CheckboxControl,
} from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import {
  STRUCTURES,
  STRUCTURE_IDS,
  RATIO_RULE,
  speciesRadii,
  exampleRatios,
  solveLattice,
  criticalRatio,
  predictedCN,
  coordination,
  neighborShells,
  buildCells,
  boxDistance,
  findContacts,
  packingFraction,
  type Atom,
  type IonicStructure,
  type Vec3,
} from './ionic';

type ColorBy = 'species' | 'site';

interface DemoParams {
  structure: IonicStructure;
  /** Cation radius / anion radius (the B-site cation for perovskite) */
  ratio: number;
  /** A-site cation radius / anion radius (perovskite only) */
  ratioA: number;
  /** Unit cells along a, b (in-plane) and c (vertical) */
  na: number;
  nb: number;
  nc: number;
  scale: number;
  contacts: boolean;
  edges: boolean;
  clip: boolean;
  polyhedron: boolean;
  colorBy: ColorBy;
}

const defaultStructure: IonicStructure = 'nacl';

const defaultParams: DemoParams = {
  structure: defaultStructure,
  ...exampleRatios(defaultStructure),
  na: 1,
  nb: 1,
  nc: 1,
  scale: 1.0,
  contacts: false,
  edges: true,
  clip: false,
  polyhedron: true,
  colorBy: 'species',
};

const MAX_CELLS = 3;
const RATIO_MIN = 0.1;
const RATIO_MAX = 1.0;
const RATIO_A_MIN = 0.6;
const RATIO_A_MAX = 1.3;
const DROP_TIME = 0.45; // seconds for newly added ions to fall into place
const DROP_HEIGHT = 8;

const SITE_COLORS = { corner: '#4a9eff', edge: '#7CFF9F', face: '#c77dff', interior: '#ff6b6b' };
const SITE_SHARE = { corner: '1/8', edge: '1/4', face: '1/2', interior: '1' };
const PICK_COLOR = '#ffd84a';
const NEIGHBOR_COLOR = '#ff5ad1';

function parseParams(src: Record<string, string>, params: DemoParams): void {
  const int = (v: string, lo: number, hi: number) => clamp(parseInt(v, 10) || lo, lo, hi);
  if (src.structure && src.structure in STRUCTURES) {
    params.structure = src.structure as IonicStructure;
    // Start from the real compound unless the URL gives the ratios
    Object.assign(params, exampleRatios(params.structure));
  }
  if (src.ratio) params.ratio = clamp(parseFloat(src.ratio) || 0.5, RATIO_MIN, RATIO_MAX);
  if (src.ratioA) params.ratioA = clamp(parseFloat(src.ratioA) || 1, RATIO_A_MIN, RATIO_A_MAX);
  params.ratio = clamp(params.ratio, RATIO_MIN, RATIO_MAX);
  params.ratioA = clamp(params.ratioA, RATIO_A_MIN, RATIO_A_MAX);
  if (src.na) params.na = int(src.na, 1, MAX_CELLS);
  if (src.nb) params.nb = int(src.nb, 1, MAX_CELLS);
  if (src.nc) params.nc = int(src.nc, 1, MAX_CELLS);
  if (src.scale) params.scale = clamp(parseFloat(src.scale) || 1, 0.15, 1);
  if (src.contacts !== undefined) params.contacts = src.contacts === 'true';
  if (src.edges !== undefined) params.edges = src.edges === 'true';
  if (src.clip !== undefined) params.clip = src.clip === 'true';
  if (src.polyhedron !== undefined) params.polyhedron = src.polyhedron === 'true';
  if (src.colorBy === 'species' || src.colorBy === 'site') params.colorBy = src.colorBy;
}

function posKey(p: Vec3): string {
  return `${p[0].toFixed(3)},${p[1].toFixed(3)},${p[2].toFixed(3)}`;
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  const params: DemoParams = { ...defaultParams };
  parseParams(options.getParams(), params);

  // --- three.js setup ---------------------------------------------------
  container.style.position = 'relative';
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setClearColor('#0a0a0a');
  renderer.localClippingEnabled = true;
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
  scene.add(camera);
  scene.add(new THREE.HemisphereLight('#ffffff', '#303040', 1.1));
  const keyLight = new THREE.DirectionalLight('#ffffff', 1.8);
  keyLight.position.set(3, 5, 4);
  camera.add(keyLight); // light follows the viewer so the front is always lit

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;

  const sphereGeometry = new THREE.SphereGeometry(1, 32, 24);
  const bondGeometry = new THREE.CylinderGeometry(0.08, 0.08, 1, 12, 1);
  const capGeometry = new THREE.CircleGeometry(1, 48);
  const atomMaterial = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 });
  // Flat faces where a clipping plane cuts a sphere, so clipped ions read as solid
  const capMaterial = new THREE.MeshStandardMaterial({ roughness: 0.8, side: THREE.DoubleSide });
  const bondMaterial = new THREE.MeshStandardMaterial({ color: '#e8e8e8', roughness: 0.5 });
  const edgeMaterial = new THREE.LineBasicMaterial({ color: '#dddddd' });
  // Drawn through the spheres so the polyhedron around an interior ion stays visible
  const polyMaterial = new THREE.LineBasicMaterial({
    color: PICK_COLOR,
    depthTest: false,
    transparent: true,
  });

  let atomMesh: THREE.InstancedMesh | null = null;
  let bondMesh: THREE.InstancedMesh | null = null;
  let capMesh: THREE.InstancedMesh | null = null;
  let capAtom: number[] = [];
  let edgeLines: THREE.LineSegments | null = null;
  let polyLines: THREE.LineSegments | null = null;

  // Readout overlay
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:absolute;top:8px;left:10px;color:#ddd;font:13px -apple-system,BlinkMacSystemFont,sans-serif;' +
    'line-height:1.45;pointer-events:none;text-shadow:0 1px 2px #000;';
  container.appendChild(overlay);
  const hint = document.createElement('div');
  hint.style.cssText =
    'position:absolute;bottom:8px;left:10px;color:#888;font:12px -apple-system,BlinkMacSystemFont,sans-serif;' +
    'pointer-events:none;';
  hint.textContent =
    'Drag to rotate · scroll to zoom · right-drag to pan · click an ion to show its nearest neighbors';
  container.appendChild(hint);

  // --- structure state --------------------------------------------------
  let atoms: Atom[] = [];
  let radii: number[] = [];
  let lattice = solveLattice(params.structure, speciesRadii(params.structure, 1, 1));
  let contacts: [number, number][] = [];
  let birth: number[] = []; // time (s) each ion was added, for the drop-in animation
  let clock = 0;
  let animatingAtoms = false;
  let picked: number | null = null;
  let shellKeys = new Set<string>();
  const center = new THREE.Vector3();
  let boundRadius = 5;
  const dummy = new THREE.Object3D();

  function cellSize(): Vec3 {
    const a = lattice.a;
    return [params.na * a, params.nc * a, params.nb * a];
  }

  function clipActive(): boolean {
    return params.clip;
  }

  /** Clipping planes (cell faces pushed out by a hair so the caps sit just inside). */
  function computeClipPlanes(): THREE.Plane[] {
    if (!clipActive()) return [];
    const [X, Y, Z] = cellSize();
    const d = 1e-3;
    return [
      new THREE.Plane(new THREE.Vector3(1, 0, 0), d),
      new THREE.Plane(new THREE.Vector3(-1, 0, 0), X + d),
      new THREE.Plane(new THREE.Vector3(0, 1, 0), d),
      new THREE.Plane(new THREE.Vector3(0, -1, 0), Y + d),
      new THREE.Plane(new THREE.Vector3(0, 0, 1), d),
      new THREE.Plane(new THREE.Vector3(0, 0, -1), Z + d),
    ];
  }

  function disposeMeshes(): void {
    for (const obj of [atomMesh, bondMesh, edgeLines]) {
      if (!obj) continue;
      scene.remove(obj);
      if (obj instanceof THREE.InstancedMesh) obj.dispose();
    }
    edgeLines?.geometry.dispose();
    atomMesh = bondMesh = edgeLines = null;
    disposeCaps();
    disposePoly();
  }

  function disposeCaps(): void {
    if (!capMesh) return;
    scene.remove(capMesh);
    capMesh.dispose();
    capMesh = null;
    capAtom = [];
  }

  function disposePoly(): void {
    if (!polyLines) return;
    scene.remove(polyLines);
    polyLines.geometry.dispose();
    polyLines = null;
  }

  /**
   * Rebuild all geometry. With `animate`, ions not present before (a new cell)
   * drop in from above; otherwise (e.g. a radius change) they just move.
   */
  function rebuild(resetView: boolean, animate = false): void {
    const prevCenter = center.clone();
    const prevBound = boundRadius;
    const previous = new Set(atoms.map((at) => posKey(at.pos)));
    const dropIn = animate && !resetView && previous.size > 0;

    radii = speciesRadii(params.structure, params.ratio, params.ratioA);
    lattice = solveLattice(params.structure, radii);
    const a = lattice.a;

    const build = buildCells(params.structure, a, params.na, params.nc, params.nb);
    atoms = build.atoms;
    if (clipActive()) {
      // Ions centered outside the cell whose spheres poke into it are part of its contents
      const known = new Set(atoms.map((at) => posKey(at.pos)));
      const size = cellSize();
      for (const at of buildCells(params.structure, a, params.na, params.nc, params.nb, 1).atoms) {
        if (!known.has(posKey(at.pos)) && boxDistance(at.pos, size) > -radii[at.species]! + 1e-6) {
          atoms.push(at);
        }
      }
    }
    birth = atoms.map((at) => (dropIn && !previous.has(posKey(at.pos)) ? clock : -Infinity));
    contacts = findContacts(atoms, radii);
    picked = null;
    shellKeys = new Set();

    disposeMeshes();

    atomMesh = new THREE.InstancedMesh(sphereGeometry, atomMaterial, Math.max(atoms.length, 1));
    atomMesh.count = atoms.length;
    scene.add(atomMesh);

    bondMesh = new THREE.InstancedMesh(bondGeometry, bondMaterial, Math.max(contacts.length, 1));
    bondMesh.count = contacts.length;
    const up = new THREE.Vector3(0, 1, 0);
    contacts.forEach(([i, j], k) => {
      const p = new THREE.Vector3(...atoms[i]!.pos);
      const q = new THREE.Vector3(...atoms[j]!.pos);
      const dir = q.clone().sub(p);
      dummy.position.copy(p).add(q).multiplyScalar(0.5);
      dummy.quaternion.setFromUnitVectors(up, dir.clone().normalize());
      dummy.scale.set(1, dir.length(), 1);
      dummy.updateMatrix();
      bondMesh!.setMatrixAt(k, dummy.matrix);
    });
    scene.add(bondMesh);

    const pts = new Float32Array(build.edges.length * 6);
    build.edges.forEach(([p, q], k) => pts.set([...p, ...q], k * 6));
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    edgeLines = new THREE.LineSegments(geom, edgeMaterial);
    scene.add(edgeLines);

    // Bounding sphere for camera framing (the cell, plus the ions that stick out of it)
    const box = new THREE.Box3();
    const size = cellSize();
    box.expandByPoint(new THREE.Vector3(0, 0, 0));
    box.expandByPoint(new THREE.Vector3(...size));
    if (!clipActive()) {
      const rMax = Math.max(...radii);
      box.expandByScalar(rMax);
    }
    box.getCenter(center);
    boundRadius = Math.max(box.getSize(new THREE.Vector3()).length() / 2 + 0.5, 3);

    if (resetView) {
      setView('reset');
    } else {
      // Keep the viewing direction and framing while the cell grows or shrinks
      const offset = camera.position
        .clone()
        .sub(prevCenter)
        .multiplyScalar(boundRadius / prevBound);
      camera.position.copy(center).add(offset);
      controls.target.copy(center);
    }

    applyDisplay();
    animatingAtoms = updateInstances();
    updateOverlay();
  }

  /** Flat caps on every sphere face cut by a clipping plane. */
  function updateCaps(): void {
    disposeCaps();
    if (!clipActive()) return;
    const size = cellSize();
    const entries: {
      atom: number;
      center: THREE.Vector3;
      normal: THREE.Vector3;
      radius: number;
    }[] = [];
    atoms.forEach((at, i) => {
      const r = params.scale * radii[at.species]!;
      for (let k = 0; k < 3; k++) {
        for (const side of [0, 1]) {
          // Distance of the center inside the face (>0 inside), and the inward normal
          const dist = side === 0 ? at.pos[k]! : size[k]! - at.pos[k]!;
          if (Math.abs(dist) >= r) continue;
          const normal = new THREE.Vector3();
          normal.setComponent(k, side === 0 ? 1 : -1);
          const c = new THREE.Vector3(...at.pos).addScaledVector(normal, -dist);
          entries.push({ atom: i, center: c, normal, radius: Math.sqrt(r * r - dist * dist) });
        }
      }
    });
    if (entries.length === 0) return;

    capMesh = new THREE.InstancedMesh(capGeometry, capMaterial, entries.length);
    const zAxis = new THREE.Vector3(0, 0, 1);
    entries.forEach((e, k) => {
      dummy.position.copy(e.center);
      dummy.quaternion.setFromUnitVectors(zAxis, e.normal);
      dummy.scale.setScalar(e.radius);
      dummy.updateMatrix();
      capMesh!.setMatrixAt(k, dummy.matrix);
    });
    capAtom = entries.map((e) => e.atom);
    scene.add(capMesh);
    applyColors();
  }

  function atomColor(i: number): string {
    const at = atoms[i]!;
    if (picked !== null) {
      if (i === picked) return PICK_COLOR;
      if (shellKeys.has(posKey(at.pos))) return NEIGHBOR_COLOR;
    }
    return params.colorBy === 'site'
      ? SITE_COLORS[at.site]
      : STRUCTURES[params.structure].species[at.species]!.color;
  }

  const dimmed = new THREE.Color('#2a2a2a');

  function displayColor(i: number, out: THREE.Color): THREE.Color {
    out.set(atomColor(i));
    const lit = picked === null || i === picked || shellKeys.has(posKey(atoms[i]!.pos));
    if (!lit) out.lerp(dimmed, 0.7);
    return out;
  }

  function applyColors(): void {
    if (!atomMesh) return;
    const col = new THREE.Color();
    for (let i = 0; i < atoms.length; i++) atomMesh.setColorAt(i, displayColor(i, col));
    if (atomMesh.instanceColor) atomMesh.instanceColor.needsUpdate = true;
    if (capMesh) {
      // Cut faces slightly darker than the sphere surface
      capAtom.forEach((i, k) => capMesh!.setColorAt(k, displayColor(i, col).multiplyScalar(0.8)));
      if (capMesh.instanceColor) capMesh.instanceColor.needsUpdate = true;
    }
  }

  function applyDisplay(): void {
    const planes = computeClipPlanes();
    atomMaterial.clippingPlanes = planes;
    capMaterial.clippingPlanes = planes;
    bondMaterial.clippingPlanes = planes;
    atomMaterial.needsUpdate = capMaterial.needsUpdate = bondMaterial.needsUpdate = true;
    if (bondMesh) bondMesh.visible = params.contacts;
    if (edgeLines) edgeLines.visible = params.edges;
    updatePolyhedron();
    applyColors();
  }

  /** Update sphere scales and drop-in offsets. Returns true while animating. */
  function updateInstances(): boolean {
    if (!atomMesh) return false;
    let animating = false;
    for (let i = 0; i < atoms.length; i++) {
      const [x, y, z] = atoms[i]!.pos;
      const t = clamp((clock - birth[i]!) / DROP_TIME, 0, 1);
      if (t < 1) animating = true;
      const ease = 1 - (1 - t) * (1 - t) * (1 - t);
      dummy.position.set(x, y + DROP_HEIGHT * (1 - ease), z);
      dummy.quaternion.identity();
      dummy.scale.setScalar(params.scale * radii[atoms[i]!.species]!);
      dummy.updateMatrix();
      atomMesh.setMatrixAt(i, dummy.matrix);
    }
    atomMesh.instanceMatrix.needsUpdate = true;
    atomMesh.computeBoundingSphere();
    // Contacts and caps appear once ions have fallen into place
    if (bondMesh) bondMesh.visible = params.contacts && !animating;
    if (animating) disposeCaps();
    else updateCaps();
    return animating;
  }

  /** Outline of the polyhedron of nearest oppositely charged ions around the picked ion. */
  function updatePolyhedron(): void {
    disposePoly();
    shellKeys = new Set();
    if (picked === null) return;
    const at = atoms[picked]!;
    const shells = neighborShells(params.structure, lattice.a, at.pos, at.species);
    const segs: number[] = [];
    for (const shell of shells) {
      for (const p of shell.positions) shellKeys.add(posKey(p));
      // Polyhedron edges join the closest pairs of neighbors
      const pts = shell.positions;
      let dMin = Infinity;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          dMin = Math.min(dMin, Math.hypot(...(pts[i]!.map((v, k) => v - pts[j]![k]!) as Vec3)));
        }
      }
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const d = Math.hypot(...(pts[i]!.map((v, k) => v - pts[j]![k]!) as Vec3));
          if (d < dMin * (1 + 1e-3)) segs.push(...pts[i]!, ...pts[j]!);
        }
      }
    }
    if (!params.polyhedron || segs.length === 0) return;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs), 3));
    polyLines = new THREE.LineSegments(geom, polyMaterial);
    polyLines.renderOrder = 10;
    scene.add(polyLines);
  }

  function setView(kind: 'reset' | 'cube' | 'diagonal'): void {
    const fov = (camera.fov * Math.PI) / 180;
    const dist = (boundRadius / Math.sin(fov / 2)) * 1.05;
    let dir: THREE.Vector3;
    if (kind === 'cube') {
      dir = new THREE.Vector3(0, 1e-3, 1).normalize(); // down the [001] axis (a square lattice)
    } else if (kind === 'diagonal') {
      dir = new THREE.Vector3(1, 1, 1).normalize();
    } else {
      dir = new THREE.Vector3(1.1, 0.8, 1.5).normalize();
    }
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.lookAt(center);
    controls.update();
  }

  // --- readout ----------------------------------------------------------
  const sym = (i: number): string => STRUCTURES[params.structure].species[i]!.symbol;
  const swatch = (c: string, t: string) => `<span style="color:${c}">●</span> ${t}`;

  /** Bar of the textbook coordination ranges with a marker at the current ratio. */
  function ratioBar(ratio: number): string {
    const W = 260;
    const xOf = (r: number) => (clamp(r, 0, 1) / 1) * W;
    const colors = ['#2a3a4a', '#2f4a63', '#35618a', '#3b78b0', '#4a9eff'];
    const segs = RATIO_RULE.slice(0, 5)
      .map((r, k) => {
        const lo = r.from;
        const hi = RATIO_RULE[k + 1]!.from;
        const w = xOf(hi) - xOf(lo);
        const label = w > 22 ? `${r.cn}` : '';
        return (
          `<div style="width:${w}px;background:${colors[k]};text-align:center;color:#fff;` +
          `font-size:11px;line-height:16px">${label}</div>`
        );
      })
      .join('');
    return (
      `<div style="position:relative;width:${W}px;margin-top:3px">` +
      `<div style="display:flex">${segs}</div>` +
      `<div style="position:absolute;top:-3px;left:${xOf(ratio) - 1}px;width:2px;height:22px;background:${PICK_COLOR}"></div>` +
      `<div style="display:flex;justify-content:space-between;font-size:10px;color:#999"><span>0</span><span>r⁺/r⁻</span><span>1</span></div>` +
      `</div>`
    );
  }

  function formatCoordination(species: number): string {
    return coordination(params.structure, species)
      .map((c) => `${c.count} ${sym(c.species)}`)
      .join(' + ');
  }

  function updateOverlay(): void {
    const info = STRUCTURES[params.structure];
    const lines: string[] = [`<b style="font-size:14px">${info.name}</b>`];

    // Radii and cell
    const radiiText = info.species
      .map((sp, k) => `r(${sp.symbol}) = ${radii[k]!.toFixed(2)}`)
      .join(' · ');
    lines.push(`${radiiText} <span style="color:#999">(in units of the anion radius)</span>`);
    const perCell = info.species
      .map((sp, k) => {
        const n = info.basis.filter((b) => b.species === k).length;
        return n === 1 ? sp.symbol : `${n} ${sp.symbol}`;
      })
      .join(' + ');
    lines.push(`per unit cell: ${perCell} (Z = ${info.z} ${info.formula})`);
    lines.push(
      `lattice constant a = ${lattice.a.toFixed(2)} · filled fraction ${(
        packingFraction(params.structure, lattice) *
        params.scale ** 3
      ).toFixed(3)}`
    );

    // Coordination and the radius-ratio rule
    const parts = info.species.map((sp, k) => ({ sp, k }));
    lines.push(
      'coordination: ' +
        parts
          .map(
            ({ sp, k }) =>
              `${sp.symbol}${sp.role ? ` (${sp.role})` : ''} → ${formatCoordination(k)}`
          )
          .join(' · ')
    );
    const crit = criticalRatio(params.structure);
    const upper = RATIO_RULE.find((r) => r.from > crit + 1e-3)?.from ?? 1;
    const cationCheck = parts
      .filter(({ sp }) => sp.kind !== 'anion')
      .map(({ sp, k }) => {
        const ratio = radii[k]!;
        const rule = predictedCN(ratio);
        const actual = coordination(params.structure, k).reduce((s, c) => s + c.count, 0);
        const ok = rule === actual;
        return (
          `${sp.symbol}: ratio ${ratio.toFixed(2)} → rule CN ${rule}, ` +
          `structure CN ${actual} <span style="color:${ok ? '#7CFF9F' : '#ff6b6b'}">${ok ? '✓' : '✗'}</span>`
        );
      });
    lines.push(`radius-ratio rule: ${cationCheck.join(' · ')}`);
    lines.push(
      `stable for ${crit.toFixed(3)} ≤ r⁺/r⁻ < ${upper.toFixed(3)} ` +
        `<span style="color:#999">(below ${crit.toFixed(3)} the anions touch)</span>`
    );

    // Which ions touch
    const kind = (k: number) => info.species[k]!.kind === 'anion';
    const binding = lattice.pairs.filter((p) => p.binding);
    // Within 1% of touching counts as touching (real SrTiO3 has t = 1.002)
    const nearBinding = lattice.pairs.filter((p) => p.needed > lattice.a * 0.99);
    const touchesAnion = (k: number) =>
      nearBinding.some((p) => (p.i === k && kind(p.j)) || (p.j === k && kind(p.i)));
    const loose = parts.filter(({ sp, k }) => sp.kind !== 'anion' && !touchesAnion(k));
    if (binding.some((p) => kind(p.i) && kind(p.j))) {
      lines.push(`<span style="color:#ff9f4a">anions touch each other</span>`);
    }
    if (binding.some((p) => !kind(p.i) && !kind(p.j))) {
      lines.push(`<span style="color:#ff9f4a">cations touch each other</span>`);
    }
    if (loose.length > 0) {
      const names = loose.map(({ sp }) => sp.symbol).join(', ');
      const verb = loose.length === 1 ? 'rattles' : 'rattle';
      const tail = params.structure === 'perovskite' ? '' : ': unstable at this ratio';
      lines.push(`<span style="color:#ff6b6b">${names} ${verb} in its hole${tail}</span>`);
    } else {
      lines.push(`<span style="color:#7CFF9F">every cation touches its anion neighbors</span>`);
    }
    if (params.structure === 'perovskite') {
      const t = (radii[2]! + 1) / (Math.SQRT2 * (radii[0]! + 1));
      const verdict =
        t > 1.01
          ? 'above 1: A-site ion large, B-site cation rattles'
          : t >= 0.995
            ? 'ideal cubic perovskite'
            : t >= 0.9
              ? 'cubic to slightly tilted'
              : 'below 0.9: octahedra tilt';
      lines.push(
        `tolerance factor t = (r<sub>A</sub>+r<sub>O</sub>) / √2(r<sub>B</sub>+r<sub>O</sub>) = <b>${t.toFixed(3)}</b> (${verdict})`
      );
    }

    lines.push(ratioBar(radii[0]!));
    lines.push(
      `<span style="color:#999;font-size:11px">coordination number predicted from r⁺/r⁻</span>`
    );

    if (picked !== null) {
      const at = atoms[picked]!;
      const shells = neighborShells(params.structure, lattice.a, at.pos, at.species);
      const text = shells.map((s) => `${s.positions.length} ${sym(s.species)}`).join(' + ');
      lines.push(
        `<span style="color:${PICK_COLOR}">selected ${sym(at.species)}</span> has ` +
          `<span style="color:${NEIGHBOR_COLOR}"><b>${text}</b></span> as nearest neighbors`
      );
    }

    if (params.colorBy === 'species') {
      lines.push(
        info.species
          .map((sp) => swatch(sp.color, sp.symbol + (sp.role ? ` (${sp.role})` : '')))
          .join('&nbsp;&nbsp;')
      );
    } else {
      const used = new Set(atoms.map((at) => at.site));
      lines.push(
        (['corner', 'edge', 'face', 'interior'] as const)
          .filter((s) => used.has(s))
          .map((s) => swatch(SITE_COLORS[s], `${s} (${SITE_SHARE[s]} in the block)`))
          .join('&nbsp;&nbsp;')
      );
    }
    overlay.innerHTML = lines.join('<br>');
  }

  // --- picking ----------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downX = 0;
  let downY = 0;

  function onPointerDown(e: PointerEvent): void {
    downX = e.clientX;
    downY = e.clientY;
  }

  function onPointerUp(e: PointerEvent): void {
    if (e.button !== 0 || Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return;
    if (!atomMesh || !atomMesh.visible) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(atomMesh)[0];
    const id = hit?.instanceId ?? null;
    picked = id === picked ? null : id;
    updatePolyhedron();
    applyColors();
    updateOverlay();
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);

  // --- controls panel ---------------------------------------------------
  const disposables: Disposable[] = [];
  let structureSelect: SelectControl | null = null;
  let ratioSlider: SliderControl | null = null;
  let ratioASlider: SliderControl | null = null;
  let naSlider: SliderControl | null = null;
  let nbSlider: SliderControl | null = null;
  let ncSlider: SliderControl | null = null;
  let scaleSlider: SliderControl | null = null;
  let contactsCheckbox: CheckboxControl | null = null;
  let edgesCheckbox: CheckboxControl | null = null;
  let clipCheckbox: CheckboxControl | null = null;
  let polyCheckbox: CheckboxControl | null = null;
  let colorSelect: SelectControl | null = null;
  let ratioLabel: HTMLElement | null = null;
  let exampleButton: { element: HTMLElement } | null = null;

  function syncControls(): void {
    structureSelect?.setValue(params.structure);
    ratioSlider?.setValue(params.ratio);
    ratioASlider?.setValue(params.ratioA);
    if (ratioASlider) {
      ratioASlider.element.style.display = params.structure === 'perovskite' ? '' : 'none';
    }
    if (ratioLabel) {
      ratioLabel.textContent =
        params.structure === 'perovskite'
          ? 'B-site cation radius / anion radius (r_Ti / r_O)'
          : 'Cation radius / anion radius (r⁺ / r⁻)';
    }
    if (exampleButton) {
      const el = exampleButton.element as HTMLButtonElement;
      el.textContent = `Set to real ${STRUCTURES[params.structure].example}`;
    }
    naSlider?.setValue(params.na);
    nbSlider?.setValue(params.nb);
    ncSlider?.setValue(params.nc);
    scaleSlider?.setValue(params.scale);
    contactsCheckbox?.setChecked(params.contacts);
    edgesCheckbox?.setChecked(params.edges);
    clipCheckbox?.setChecked(params.clip);
    polyCheckbox?.setChecked(params.polyhedron);
    colorSelect?.setValue(params.colorBy);
  }

  function onChange(rebuildNeeded: boolean, resetView = false, animate = false): void {
    if (rebuildNeeded) rebuild(resetView, animate);
    else {
      applyDisplay();
      updateInstances();
      updateOverlay();
    }
    syncControls();
    updateUrlParams();
  }

  function buttonRow(...els: HTMLElement[]): HTMLElement {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    els.forEach((el) => {
      el.style.flex = '1';
      row.appendChild(el);
    });
    return row;
  }

  if (controlsPanel) {
    const structSection = createSection({ title: 'Structure' });
    disposables.push(structSection);

    structureSelect = createSelect({
      label: 'Crystal structure',
      options: STRUCTURE_IDS.map((id) => ({ value: id, label: STRUCTURES[id].name })),
      value: params.structure,
      onChange: (v) => {
        params.structure = v as IonicStructure;
        Object.assign(params, exampleRatios(params.structure));
        onChange(true, true);
      },
    });
    disposables.push(structureSelect);
    structSection.content.appendChild(structureSelect.element);
    controlsPanel.appendChild(structSection.element);

    // Ion sizes
    const ionSection = createSection({ title: 'Ion Sizes' });
    disposables.push(ionSection);

    ratioLabel = document.createElement('div');
    ratioLabel.className = 'control-label';
    ionSection.content.appendChild(ratioLabel);
    ratioSlider = createSlider({
      label: 'Radius ratio',
      min: RATIO_MIN,
      max: RATIO_MAX,
      step: 0.005,
      value: params.ratio,
      format: (v) => v.toFixed(3),
      onChange: (v) => {
        params.ratio = v;
        onChange(true);
      },
    });
    ratioASlider = createSlider({
      label: 'A-site radius ratio (r_Sr / r_O)',
      min: RATIO_A_MIN,
      max: RATIO_A_MAX,
      step: 0.005,
      value: params.ratioA,
      format: (v) => v.toFixed(3),
      onChange: (v) => {
        params.ratioA = v;
        onChange(true);
      },
    });
    disposables.push(ratioSlider, ratioASlider);
    ionSection.content.appendChild(ratioSlider.element);
    ionSection.content.appendChild(ratioASlider.element);

    const exampleBtn = createButton({
      label: 'Set to real compound',
      variant: 'secondary',
      onClick: () => {
        Object.assign(params, exampleRatios(params.structure));
        onChange(true);
      },
    });
    exampleButton = exampleBtn;
    disposables.push(exampleBtn);
    ionSection.content.appendChild(exampleBtn.element);
    ionSection.content.appendChild(
      createHelperText(
        'The anion has radius 1 and the lattice constant is set by contact: ions are hard spheres. ' +
          'Shrink the cation until the anions touch (the cation rattles), or grow it until the ' +
          'structure no longer suits it. Turn on "Show contacts" to see which ions touch. ' +
          'The real compound uses Shannon ionic radii.'
      )
    );
    controlsPanel.appendChild(ionSection.element);

    // Unit cells
    const cellSection = createSection({ title: 'Unit Cells' });
    disposables.push(cellSection);

    const cellSlider = (label: string, key: 'na' | 'nb' | 'nc'): SliderControl => {
      const s = createSlider({
        label,
        min: 1,
        max: MAX_CELLS,
        step: 1,
        value: params[key],
        format: (v) => v.toFixed(0),
        onChange: (v) => {
          params[key] = Math.round(v);
          onChange(true, false, true);
        },
      });
      disposables.push(s);
      cellSection.content.appendChild(s.element);
      return s;
    };
    naSlider = cellSlider('Cells along a', 'na');
    nbSlider = cellSlider('Cells along b', 'nb');
    ncSlider = cellSlider('Cells along c (vertical)', 'nc');

    const addCell = createButton({
      label: '+ Add cell',
      onClick: () => {
        const keys = ['na', 'nb', 'nc'] as const;
        const max = Math.max(params.na, params.nb, params.nc);
        const next = keys.find((k) => params[k] < max) ?? (max < MAX_CELLS ? 'na' : null);
        if (!next) return;
        params[next] += 1;
        onChange(true, false, true);
      },
    });
    const resetCells = createButton({
      label: 'Single cell',
      variant: 'secondary',
      onClick: () => {
        params.na = params.nb = params.nc = 1;
        onChange(true);
      },
    });
    disposables.push(addCell, resetCells);
    cellSection.content.appendChild(buttonRow(addCell.element, resetCells.element));

    edgesCheckbox = createCheckbox({
      label: 'Show unit cell edges',
      checked: params.edges,
      onChange: (c) => {
        params.edges = c;
        onChange(false);
      },
    });
    clipCheckbox = createCheckbox({
      label: 'Clip ions to the cell',
      checked: params.clip,
      onChange: (c) => {
        params.clip = c;
        onChange(true);
      },
    });
    disposables.push(edgesCheckbox, clipCheckbox);
    cellSection.content.appendChild(edgesCheckbox.element);
    cellSection.content.appendChild(clipCheckbox.element);
    cellSection.content.appendChild(
      createHelperText(
        'Clipping keeps only the part of each ion inside the cell, so you can count how many ' +
          'ions belong to one cell. Color by "cell site" shows each ion’s share.'
      )
    );
    controlsPanel.appendChild(cellSection.element);

    // Display
    const displaySection = createSection({ title: 'Ions & Display' });
    disposables.push(displaySection);

    scaleSlider = createSlider({
      label: 'Ion size (fraction of true size)',
      min: 0.15,
      max: 1,
      step: 0.01,
      value: params.scale,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        params.scale = v;
        onChange(false);
      },
    });
    disposables.push(scaleSlider);
    displaySection.content.appendChild(scaleSlider.element);

    contactsCheckbox = createCheckbox({
      label: 'Show contacts (touching pairs)',
      checked: params.contacts,
      onChange: (c) => {
        params.contacts = c;
        onChange(false);
      },
    });
    polyCheckbox = createCheckbox({
      label: 'Show coordination polyhedron of the selected ion',
      checked: params.polyhedron,
      onChange: (c) => {
        params.polyhedron = c;
        onChange(false);
      },
    });
    disposables.push(contactsCheckbox, polyCheckbox);
    displaySection.content.appendChild(contactsCheckbox.element);
    displaySection.content.appendChild(polyCheckbox.element);

    colorSelect = createSelect({
      label: 'Color ions by',
      options: [
        { value: 'species', label: 'Ion type (cation / anion)' },
        { value: 'site', label: 'Cell site (corner/edge/face/interior)' },
      ],
      value: params.colorBy,
      onChange: (v) => {
        params.colorBy = v as ColorBy;
        onChange(false);
      },
    });
    disposables.push(colorSelect);
    displaySection.content.appendChild(colorSelect.element);
    controlsPanel.appendChild(displaySection.element);

    // View
    const viewSection = createSection({ title: 'View' });
    disposables.push(viewSection);
    const resetBtn = createButton({ label: 'Reset view', onClick: () => setView('reset') });
    const cubeBtn = createButton({
      label: '[001]',
      variant: 'secondary',
      onClick: () => setView('cube'),
    });
    const diagBtn = createButton({
      label: '[111]',
      variant: 'secondary',
      onClick: () => setView('diagonal'),
    });
    disposables.push(resetBtn, cubeBtn, diagBtn);
    viewSection.content.appendChild(buttonRow(resetBtn.element, cubeBtn.element, diagBtn.element));
    controlsPanel.appendChild(viewSection.element);
  }

  function updateUrlParams(): void {
    options.setParams(getParamRecord());
  }

  function getParamRecord(): Record<string, string> {
    return {
      structure: params.structure,
      ratio: params.ratio.toFixed(3),
      ratioA: params.ratioA.toFixed(3),
      na: String(params.na),
      nb: String(params.nb),
      nc: String(params.nc),
      scale: params.scale.toFixed(2),
      contacts: String(params.contacts),
      edges: String(params.edges),
      clip: String(params.clip),
      polyhedron: String(params.polyhedron),
      colorBy: params.colorBy,
    };
  }

  // --- render loop & resize ---------------------------------------------
  function handleResize(): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    // Shift the picture right and down so the structure clears the text readout
    camera.setViewOffset(w, h, -0.12 * w, -0.1 * h, w, h);
    camera.updateProjectionMatrix();
  }

  const resizeObserver = new ResizeObserver(handleResize);
  resizeObserver.observe(container);
  handleResize();

  rebuild(true);
  syncControls();

  const loop = new AnimationLoop((dt) => {
    clock += dt;
    if (animatingAtoms) animatingAtoms = updateInstances();
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    start() {
      loop.start();
    },
    stop() {
      loop.stop();
    },
    resize() {
      handleResize();
    },
    dispose() {
      loop.dispose();
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      controls.dispose();
      disposeMeshes();
      sphereGeometry.dispose();
      bondGeometry.dispose();
      capGeometry.dispose();
      atomMaterial.dispose();
      capMaterial.dispose();
      bondMaterial.dispose();
      edgeMaterial.dispose();
      polyMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      overlay.remove();
      hint.remove();
      disposables.forEach((d) => d.dispose());
    },
    getParams() {
      return getParamRecord();
    },
    setParams(newParams: Record<string, string>) {
      parseParams(newParams, params);
      rebuild(true);
      syncControls();
    },
  };
}

export const ceramicStructuresDemo: DemoDefinition = {
  id: 'ceramic-structures',
  title: 'Ceramic Structures (Ionic Crystals)',
  description:
    'Build ZnS, NaCl, CsCl, fluorite and perovskite from hard-sphere cations and anions. Change the cation/anion radius ratio to see which ions touch, how the coordination number follows the radius-ratio rule, and what the coordination polyhedra look like.',
  category: 'Crystallography',
  tags: [
    'ceramics',
    'ionic',
    'radius ratio',
    'nacl',
    'zns',
    'cscl',
    'fluorite',
    'perovskite',
    '3d',
  ],
  create,
};

export default ceramicStructuresDemo;
