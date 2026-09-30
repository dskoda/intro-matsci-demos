/**
 * Miller Indices (cubic cells)
 *
 * Shows crystallographic directions [uvw] and planes (hkl) inside a cubic
 * unit cell (SC, BCC, FCC). Extra cells can be added around the central cell
 * to follow fractional coordinates and negative indices into the neighbors,
 * and the atoms can be hidden to leave only the cell edges.
 *
 * Geometry is built in fractional crystal coordinates (central cell = [0,1]³)
 * and drawn with the textbook axes: z up, y to the right, x toward the viewer.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
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
import { STRUCTURES, buildCells, R, type Atom, type Vec3 } from '../crystal-structures/lattice';
import {
  CORNERS,
  cornerVec,
  autoOrigin,
  fitDirection,
  familyDirections,
  cubeGridEdges,
  planeBoxPolygon,
  distanceToSegment,
  dot,
  add,
  cross,
  gcd3,
  formatFraction,
  formatCoord,
  formatIndices,
  type CornerKey,
} from './miller';

type CubicStructure = 'sc' | 'bcc' | 'fcc';
type Corner = 'auto' | CornerKey;
type DirLength = 'fit' | 'full';
type ColorBy = 'site' | 'uniform';

interface DemoParams {
  structure: CubicStructure;
  /** Extra unit cells on each side of the central cell */
  extra: number;
  atoms: boolean;
  radius: number;
  colorBy: ColorBy;
  /** Highlight atoms whose centers lie on the direction / plane */
  highlight: boolean;
  dir: boolean;
  uvw: Vec3;
  tail: Corner;
  dirLength: DirLength;
  components: boolean;
  family: boolean;
  plane: boolean;
  hkl: Vec3;
  origin: Corner;
  intercepts: boolean;
  parallel: boolean;
}

const defaultParams: DemoParams = {
  structure: 'sc',
  extra: 0,
  atoms: true,
  radius: 0.35,
  colorBy: 'site',
  highlight: false,
  dir: true,
  uvw: [1, 1, 1],
  tail: 'auto',
  dirLength: 'fit',
  components: true,
  family: false,
  plane: false,
  hkl: [1, 1, 1],
  origin: 'auto',
  intercepts: true,
  parallel: false,
};

const MAX_EXTRA = 2;
const MAX_INDEX = 3;
const AXIS_NAMES = ['x', 'y', 'z'] as const;
const AXIS_COLORS = ['#ff5a5a', '#5ad16a', '#5a8cff'];
const SITE_COLORS = { corner: '#9fb4c8', face: '#c77dff', body: '#e0d070' };
const UNIFORM_COLOR = '#9fb4c8';
const DIR_COLOR = '#ff8c2e';
const PLANE_COLOR = '#2ec4b6';
const HIGHLIGHT_COLOR = '#ff5ad1';
const LABEL_FONT = '-apple-system,BlinkMacSystemFont,sans-serif';

const STRUCTURE_KEYS: CubicStructure[] = ['sc', 'bcc', 'fcc'];

function isCorner(v: string): v is Corner {
  return v === 'auto' || (CORNERS as readonly string[]).includes(v);
}

function parseIndices(src: Record<string, string>, keys: string[], fallback: Vec3): Vec3 {
  if (keys.every((k) => src[k] === undefined)) return fallback;
  const v = keys.map((k, i) => {
    const s = src[k];
    return s === undefined ? fallback[i]! : clamp(parseInt(s, 10) || 0, -MAX_INDEX, MAX_INDEX);
  }) as Vec3;
  return v.every((x) => x === 0) ? fallback : v;
}

function parseParams(src: Record<string, string>, params: DemoParams): void {
  const bool = (v: string | undefined, cur: boolean) => (v === undefined ? cur : v === 'true');
  if (src.structure && (STRUCTURE_KEYS as string[]).includes(src.structure)) {
    params.structure = src.structure as CubicStructure;
  }
  if (src.extra) params.extra = clamp(parseInt(src.extra, 10) || 0, 0, MAX_EXTRA);
  params.atoms = bool(src.atoms, params.atoms);
  if (src.radius) params.radius = clamp(parseFloat(src.radius) || 0.35, 0.1, 1);
  if (src.colorBy === 'site' || src.colorBy === 'uniform') params.colorBy = src.colorBy;
  params.highlight = bool(src.highlight, params.highlight);
  params.dir = bool(src.dir, params.dir);
  params.uvw = parseIndices(src, ['u', 'v', 'w'], params.uvw);
  if (src.tail && isCorner(src.tail)) params.tail = src.tail;
  if (src.dirLength === 'fit' || src.dirLength === 'full') params.dirLength = src.dirLength;
  params.components = bool(src.components, params.components);
  params.family = bool(src.family, params.family);
  params.plane = bool(src.plane, params.plane);
  params.hkl = parseIndices(src, ['h', 'k', 'l'], params.hkl);
  if (src.origin && isCorner(src.origin)) params.origin = src.origin;
  params.intercepts = bool(src.intercepts, params.intercepts);
  params.parallel = bool(src.parallel, params.parallel);
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  const params: DemoParams = {
    ...defaultParams,
    uvw: [...defaultParams.uvw],
    hkl: [...defaultParams.hkl],
  };
  parseParams(options.getParams(), params);

  // --- three.js setup ---------------------------------------------------
  container.style.position = 'relative';
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setClearColor('#0a0a0a');
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  scene.add(camera);
  scene.add(new THREE.HemisphereLight('#ffffff', '#303040', 1.1));
  const keyLight = new THREE.DirectionalLight('#ffffff', 1.8);
  keyLight.position.set(3, 5, 4);
  camera.add(keyLight); // light follows the viewer so the front is always lit

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;

  // Crystal frame: x → toward the viewer (+Z), y → right (+X), z → up (+Y)
  const crystal = new THREE.Group();
  crystal.quaternion.setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 1, 0)
    )
  );
  scene.add(crystal);
  const latticeGroup = new THREE.Group(); // atoms, cell edges, axes
  const indexGroup = new THREE.Group(); // direction and plane
  crystal.add(latticeGroup, indexGroup);

  const sphereGeometry = new THREE.SphereGeometry(1, 32, 24);
  const shaftGeometry = new THREE.CylinderGeometry(1, 1, 1, 16, 1);
  const headGeometry = new THREE.ConeGeometry(1, 1, 24, 1);
  const atomMaterial = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 });
  const centralEdgeMaterial = new THREE.LineBasicMaterial({ color: '#e8e8e8' });
  const outerEdgeMaterial = new THREE.LineBasicMaterial({ color: '#4a4a4a' });
  const axisMaterials = AXIS_COLORS.map(
    (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.5 })
  );
  const componentMaterials = AXIS_COLORS.map(
    (color) => new THREE.LineDashedMaterial({ color, dashSize: 0.05, gapSize: 0.035 })
  );
  const dirMaterial = new THREE.MeshStandardMaterial({ color: DIR_COLOR, roughness: 0.4 });
  const familyMaterial = new THREE.MeshStandardMaterial({
    color: DIR_COLOR,
    roughness: 0.4,
    transparent: true,
    opacity: 0.4,
  });
  const planeMaterial = new THREE.MeshBasicMaterial({
    color: PLANE_COLOR,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const parallelMaterial = new THREE.MeshBasicMaterial({
    color: PLANE_COLOR,
    transparent: true,
    opacity: 0.14,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const planeEdgeMaterial = new THREE.LineBasicMaterial({ color: PLANE_COLOR });
  const parallelEdgeMaterial = new THREE.LineBasicMaterial({
    color: PLANE_COLOR,
    transparent: true,
    opacity: 0.45,
  });
  const interceptAxisMaterial = new THREE.LineDashedMaterial({
    color: '#888888',
    dashSize: 0.04,
    gapSize: 0.04,
  });
  const markerMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.5 });
  const interceptMaterial = new THREE.MeshStandardMaterial({ color: PLANE_COLOR, roughness: 0.4 });
  const sharedGeometries: THREE.BufferGeometry[] = [sphereGeometry, shaftGeometry, headGeometry];
  const sharedMaterials: THREE.Material[] = [
    atomMaterial,
    centralEdgeMaterial,
    outerEdgeMaterial,
    ...axisMaterials,
    ...componentMaterials,
    dirMaterial,
    familyMaterial,
    planeMaterial,
    parallelMaterial,
    planeEdgeMaterial,
    parallelEdgeMaterial,
    interceptAxisMaterial,
    markerMaterial,
    interceptMaterial,
  ];

  // Readout overlay
  const overlay = document.createElement('div');
  overlay.style.cssText =
    `position:absolute;top:8px;left:10px;color:#ddd;font:13px ${LABEL_FONT};` +
    'line-height:1.45;pointer-events:none;text-shadow:0 1px 2px #000;';
  container.appendChild(overlay);
  const hint = document.createElement('div');
  hint.style.cssText =
    `position:absolute;bottom:8px;left:10px;color:#888;font:12px ${LABEL_FONT};` +
    'pointer-events:none;';
  hint.textContent = 'Drag to rotate · scroll to zoom · right-drag to pan';
  container.appendChild(hint);

  // --- state ------------------------------------------------------------
  let atoms: Atom[] = [];
  let atomMesh: THREE.InstancedMesh | null = null;
  const onDirection = new Set<number>();
  const onPlane = new Set<number>();
  /** Whether the main plane cuts the central cell (otherwise it is drawn in the neighbors) */
  let planeInCell = true;
  let planeVisible = true;
  const center = new THREE.Vector3(0.5, 0.5, 0.5).applyQuaternion(crystal.quaternion);
  let boundRadius = 1;
  const dummy = new THREE.Object3D();
  const UP = new THREE.Vector3(0, 1, 0);

  const latticeA = () => STRUCTURES[params.structure].a;
  const blockLo = (): Vec3 => [-params.extra, -params.extra, -params.extra];
  const blockHi = (): Vec3 => [1 + params.extra, 1 + params.extra, 1 + params.extra];
  const unitVec = (i: number): Vec3 => [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0];

  function directionTail(): Vec3 {
    return params.tail === 'auto' ? autoOrigin(params.uvw) : cornerVec(params.tail);
  }

  function directionVector(): Vec3 {
    return params.dirLength === 'fit' ? fitDirection(params.uvw) : [...params.uvw];
  }

  function planeOrigin(): Vec3 {
    return params.origin === 'auto' ? autoOrigin(params.hkl) : cornerVec(params.origin);
  }

  // --- drawing helpers --------------------------------------------------
  /** Remove and free everything in a group (shared geometries/materials are kept). */
  function clearGroup(group: THREE.Group): void {
    group.traverse((obj) => {
      if (obj === atomMesh) return;
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        const geom = obj.geometry as THREE.BufferGeometry;
        if (!sharedGeometries.includes(geom)) geom.dispose();
      }
    });
    group.clear(); // also detaches CSS2D label elements
  }

  function addLabel(
    parent: THREE.Object3D,
    html: string,
    pos: Vec3,
    color: string,
    anchor: [number, number] = [-0.1, 1.1]
  ): void {
    const el = document.createElement('div');
    el.innerHTML = html;
    el.style.cssText =
      `color:${color};font:600 13px ${LABEL_FONT};white-space:nowrap;pointer-events:none;` +
      'text-shadow:0 0 3px #000,0 0 3px #000,0 0 2px #000;';
    const label = new CSS2DObject(el);
    label.position.set(...pos);
    label.center.set(anchor[0], anchor[1]);
    parent.add(label);
  }

  function addArrow(
    parent: THREE.Object3D,
    from: Vec3,
    to: Vec3,
    radius: number,
    material: THREE.Material
  ): void {
    const a = new THREE.Vector3(...from);
    const dir = new THREE.Vector3(...to).sub(a);
    const len = dir.length();
    if (len < 1e-9) return;
    dir.divideScalar(len);
    const headLen = Math.min(radius * 6, len * 0.4);
    const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
    const shaft = new THREE.Mesh(shaftGeometry, material);
    shaft.position.copy(a).addScaledVector(dir, (len - headLen) / 2);
    shaft.quaternion.copy(q);
    shaft.scale.set(radius, len - headLen, radius);
    const head = new THREE.Mesh(headGeometry, material);
    head.position.copy(a).addScaledVector(dir, len - headLen / 2);
    head.quaternion.copy(q);
    head.scale.set(radius * 2.5, headLen, radius * 2.5);
    parent.add(shaft, head);
  }

  function addSegments(
    parent: THREE.Object3D,
    segments: [Vec3, Vec3][],
    material: THREE.LineBasicMaterial | THREE.LineDashedMaterial
  ): void {
    if (segments.length === 0) return;
    const pts = new Float32Array(segments.length * 6);
    segments.forEach(([p, q], k) => pts.set([...p, ...q], k * 6));
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    const lines = new THREE.LineSegments(geom, material);
    if (material instanceof THREE.LineDashedMaterial) lines.computeLineDistances();
    parent.add(lines);
  }

  function addMarker(parent: THREE.Object3D, pos: Vec3, radius: number, material: THREE.Material) {
    const m = new THREE.Mesh(sphereGeometry, material);
    m.position.set(...pos);
    m.scale.setScalar(radius);
    parent.add(m);
  }

  function addPolygon(
    parent: THREE.Object3D,
    poly: Vec3[],
    fill: THREE.Material,
    edge: THREE.LineBasicMaterial
  ): void {
    if (poly.length < 3) return;
    const tris: number[] = [];
    for (let i = 1; i < poly.length - 1; i++) tris.push(...poly[0]!, ...poly[i]!, ...poly[i + 1]!);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(tris, 3));
    parent.add(new THREE.Mesh(geom, fill));
    const outline = new THREE.BufferGeometry();
    outline.setAttribute('position', new THREE.Float32BufferAttribute(poly.flat(), 3));
    parent.add(new THREE.LineLoop(outline, edge));
  }

  // --- lattice ----------------------------------------------------------
  function rebuildLattice(): void {
    clearGroup(latticeGroup);
    atomMesh?.dispose();

    const e = params.extra;
    const n = 2 * e + 1;
    const a = latticeA();
    const snap = (v: number) => Math.round(v * 1e6) / 1e6;
    atoms = buildCells(params.structure, n, n, n).atoms.map((at) => ({
      ...at,
      pos: at.pos.map((v) => snap(v / a - e)) as Vec3,
    }));
    atomMesh = new THREE.InstancedMesh(sphereGeometry, atomMaterial, Math.max(atoms.length, 1));
    atomMesh.count = atoms.length;
    latticeGroup.add(atomMesh);

    // Central cell bright; neighbor cells dim (skip segments on the central cell)
    const isCentral = ([p, q]: [Vec3, Vec3]) => [...p, ...q].every((v) => v === 0 || v === 1);
    const all = cubeGridEdges(-e, 1 + e);
    addSegments(latticeGroup, all.filter(isCentral), centralEdgeMaterial);
    addSegments(
      latticeGroup,
      all.filter((s) => !isCentral(s)),
      outerEdgeMaterial
    );

    // Crystal axes from the lattice origin
    const axisLen = 1 + e + 0.35;
    for (let i = 0; i < 3; i++) {
      const tip = unitVec(i).map((v) => v * axisLen) as Vec3;
      addArrow(latticeGroup, [0, 0, 0], tip, 0.008, axisMaterials[i]!);
      addLabel(latticeGroup, AXIS_NAMES[i]!, tip, AXIS_COLORS[i]!, [0.5, 1.2]);
    }

    boundRadius = ((1 + 2 * e) * Math.sqrt(3)) / 2 + 0.3;
    updateAtomInstances();
    rebuildIndices();
  }

  function updateAtomInstances(): void {
    if (!atomMesh) return;
    const r = (params.radius * R) / latticeA();
    atoms.forEach((at, i) => {
      dummy.position.set(...at.pos);
      dummy.scale.setScalar(r);
      dummy.updateMatrix();
      atomMesh!.setMatrixAt(i, dummy.matrix);
    });
    atomMesh.instanceMatrix.needsUpdate = true;
    atomMesh.computeBoundingSphere();
    atomMesh.visible = params.atoms;
  }

  const dimmed = new THREE.Color('#2a2a2a');

  function applyColors(): void {
    if (!atomMesh) return;
    const active = params.highlight && onDirection.size + onPlane.size > 0;
    const col = new THREE.Color();
    atoms.forEach((at, i) => {
      col.set(params.colorBy === 'site' ? SITE_COLORS[at.site] : UNIFORM_COLOR);
      if (active) {
        if (onDirection.has(i) || onPlane.has(i)) col.set(HIGHLIGHT_COLOR);
        else col.lerp(dimmed, 0.7);
      }
      atomMesh!.setColorAt(i, col);
    });
    if (atomMesh.instanceColor) atomMesh.instanceColor.needsUpdate = true;
  }

  // --- direction and plane ----------------------------------------------
  function rebuildIndices(): void {
    clearGroup(indexGroup);
    onDirection.clear();
    onPlane.clear();
    if (params.dir) buildDirection();
    if (params.plane) buildPlane();
    applyColors();
    updateOverlay();
  }

  function buildDirection(): void {
    const tail = directionTail();
    const vec = directionVector();
    const head = add(tail, vec);
    addArrow(indexGroup, tail, head, 0.016, dirMaterial);
    addMarker(indexGroup, tail, 0.025, dirMaterial);
    addLabel(indexGroup, `tail ${formatCoord(tail)}`, tail, DIR_COLOR, [1.1, -0.1]);
    addLabel(indexGroup, `head ${formatCoord(head)}`, head, DIR_COLOR);

    if (params.components) {
      let p = tail;
      for (let i = 0; i < 3; i++) {
        if (vec[i] === 0) continue;
        const q = add(p, unitVec(i).map((v) => v * vec[i]!) as Vec3);
        addSegments(indexGroup, [[p, q]], componentMaterials[i]!);
        const mid = p.map((v, k) => (v + q[k]!) / 2) as Vec3;
        addLabel(indexGroup, formatFraction(vec[i]!), mid, AXIS_COLORS[i]!, [0.5, 0.5]);
        p = q;
      }
    }

    if (params.family) {
      const c: Vec3 = [0.5, 0.5, 0.5];
      for (const d of familyDirections(params.uvw)) {
        const f = fitDirection(d).map((v) => v * 0.5) as Vec3;
        addArrow(indexGroup, c, add(c, f), 0.008, familyMaterial);
      }
    }

    atoms.forEach((at, i) => {
      if (distanceToSegment(at.pos, tail, head) < 1e-5) onDirection.add(i);
    });
  }

  function buildPlane(): void {
    const n = params.hkl;
    const O = planeOrigin();
    const c = dot(n, O) + 1; // h(x−Ox) + k(y−Oy) + l(z−Oz) = 1
    const lo = blockLo();
    const hi = blockHi();

    let poly = planeBoxPolygon(n, c, [0, 0, 0], [1, 1, 1]);
    planeInCell = poly.length >= 3;
    let regionLo: Vec3 = [0, 0, 0];
    let regionHi: Vec3 = [1, 1, 1];
    if (!planeInCell) {
      poly = planeBoxPolygon(n, c, lo, hi);
      regionLo = lo;
      regionHi = hi;
    }
    planeVisible = poly.length >= 3;
    addPolygon(indexGroup, poly, planeMaterial, planeEdgeMaterial);

    if (params.parallel) {
      const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((m) =>
        dot(n, [m & 1 ? hi[0] : lo[0], m & 2 ? hi[1] : lo[1], m & 4 ? hi[2] : lo[2]])
      );
      const min = Math.ceil(Math.min(...corners) - 1e-6);
      const max = Math.floor(Math.max(...corners) + 1e-6);
      for (let m = min; m <= max; m++) {
        addPolygon(
          indexGroup,
          planeBoxPolygon(n, m, lo, hi),
          parallelMaterial,
          parallelEdgeMaterial
        );
      }
    }

    if (params.intercepts) {
      addMarker(indexGroup, O, 0.03, markerMaterial);
      addLabel(indexGroup, 'O', O, '#ffffff', [1.3, -0.1]);
      for (let i = 0; i < 3; i++) {
        // Axis through O along which the intercept is measured
        const from = [...O] as Vec3;
        const to = [...O] as Vec3;
        from[i] = lo[i]!;
        to[i] = hi[i]!;
        addSegments(indexGroup, [[from, to]], interceptAxisMaterial);
        if (n[i] !== 0) {
          const p = add(O, unitVec(i).map((v) => v / n[i]!) as Vec3);
          addMarker(indexGroup, p, 0.028, interceptMaterial);
          addLabel(
            indexGroup,
            `${AXIS_NAMES[i]} = ${formatFraction(1 / n[i]!)}`,
            p,
            AXIS_COLORS[i]!
          );
        } else {
          // Parallel to this axis: label the inward half of the axis line
          const p = [...O] as Vec3;
          p[i] = O[i] === 0 ? 0.6 : 0.4;
          addLabel(indexGroup, `${AXIS_NAMES[i]} = ∞`, p, AXIS_COLORS[i]!);
        }
      }
    }

    const tol = 1e-6;
    atoms.forEach((at, i) => {
      const inside = at.pos.every((v, k) => v >= regionLo[k]! - tol && v <= regionHi[k]! + tol);
      if (inside && Math.abs(dot(n, at.pos) - c) < tol) onPlane.add(i);
    });
  }

  // --- readout ------------------------------------------------------------
  function updateOverlay(): void {
    const info = STRUCTURES[params.structure];
    const a = info.a;
    const n = 2 * params.extra + 1;
    const lines = [
      `<b style="font-size:14px">${info.name}</b>`,
      `a = ${a.toFixed(3)} R` +
        (params.extra > 0 ? ` · ${n}×${n}×${n} cells (central cell in white)` : ''),
    ];

    const uvw = params.uvw;
    const hkl = params.hkl;
    const dirText = formatIndices(uvw, '[', ']');
    const planeText = formatIndices(hkl, '(', ')');

    if (params.dir) {
      const tail = directionTail();
      const vec = directionVector();
      const m = Math.max(...uvw.map(Math.abs));
      const s = dot(uvw, uvw);
      lines.push('');
      lines.push(`<b style="color:${DIR_COLOR}">Direction ${dirText}</b>`);
      lines.push(`tail ${formatCoord(tail)} → head ${formatCoord(add(tail, vec))}`);
      let steps = `head − tail = ${formatCoord(vec)}`;
      if (params.dirLength === 'fit' && m > 1) steps += ` → × ${m} clears the fractions`;
      lines.push(`${steps} → ${dirText}`);
      const g = gcd3(uvw);
      if (g > 1) {
        const red = uvw.map((v) => v / g) as Vec3;
        lines.push(`same direction as ${formatIndices(red, '[', ']')} (lowest integers)`);
      }
      lines.push(`lattice vector length √${s}·a = ${(Math.sqrt(s) * a).toFixed(2)} R`);
      if (params.highlight && params.atoms) {
        lines.push(
          `<span style="color:${HIGHLIGHT_COLOR}">${onDirection.size} atom centers</span> on the arrow`
        );
      }
    }

    if (params.plane) {
      const O = planeOrigin();
      const s = dot(hkl, hkl);
      lines.push('');
      lines.push(`<b style="color:${PLANE_COLOR}">Plane ${planeText}</b>`);
      const shifted = O.some((v) => v !== 0);
      lines.push(
        `origin O = ${formatCoord(O)}` +
          (params.origin === 'auto' && shifted ? ' (moved for the negative indices)' : '')
      );
      const intercepts = hkl.map((h, i) => `${AXIS_NAMES[i]} = ${formatFraction(1 / h)}`);
      lines.push(`intercepts from O: ${intercepts.join(', ')}`);
      lines.push(`take reciprocals (1/∞ = 0) → ${planeText}`);
      const g = gcd3(hkl);
      if (g > 1) {
        const red = hkl.map((v) => v / g) as Vec3;
        lines.push(`parallel to ${formatIndices(red, '(', ')')}, with 1/${g} of its spacing`);
      }
      lines.push(
        `interplanar spacing d = a/√${s} = ${(1 / Math.sqrt(s)).toFixed(3)} a = ` +
          `${(a / Math.sqrt(s)).toFixed(2)} R`
      );
      if (!planeVisible) {
        lines.push('⚠ with this origin the plane lies outside the cells shown');
      } else if (!planeInCell) {
        lines.push('⚠ with this origin the plane misses the central cell (drawn in the neighbors)');
      }
      if (params.highlight && params.atoms) {
        lines.push(
          `<span style="color:${HIGHLIGHT_COLOR}">${onPlane.size} atom centers</span> on the plane` +
            (planeInCell ? ' in the central cell' : '')
        );
      }
    }

    if (params.dir && params.plane) {
      const d = dot(uvw, hkl);
      const c = cross(uvw, hkl);
      let rel: string;
      if (c.every((v) => v === 0)) {
        rel = `${dirText} is normal to ${planeText} (true in cubic crystals)`;
      } else if (d === 0) {
        rel = `${dirText} lies in (is parallel to) ${planeText}`;
      } else {
        const cos = d / Math.sqrt(dot(uvw, uvw) * dot(hkl, hkl));
        const angle = (Math.acos(clamp(cos, -1, 1)) * 180) / Math.PI;
        rel = `angle between ${dirText} and the ${planeText} normal: ${angle.toFixed(1)}°`;
      }
      lines.push('', rel);
    }

    overlay.innerHTML = lines.join('<br>');
  }

  // --- view ---------------------------------------------------------------
  function setView(kind: 'reset' | 'front' | 'dir' | 'normal'): void {
    const fov = (camera.fov * Math.PI) / 180;
    const dist = (boundRadius / Math.sin(fov / 2)) * 1.05;
    const crystalDir =
      kind === 'dir'
        ? new THREE.Vector3(...params.uvw)
        : kind === 'normal'
          ? new THREE.Vector3(...params.hkl)
          : kind === 'front'
            ? new THREE.Vector3(1, 0, 0)
            : new THREE.Vector3(2.2, 0.9, 1.0);
    const dir = crystalDir.normalize().applyQuaternion(crystal.quaternion);
    if (Math.abs(dir.y) > 0.999) dir.add(new THREE.Vector3(0, 0, 1e-3)).normalize();
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.lookAt(center);
    controls.update();
  }

  // --- controls panel ---------------------------------------------------
  const disposables: Disposable[] = [];
  let structureSelect: SelectControl | null = null;
  let extraSlider: SliderControl | null = null;
  let atomsCheckbox: CheckboxControl | null = null;
  let radiusSlider: SliderControl | null = null;
  let colorSelect: SelectControl | null = null;
  let highlightCheckbox: CheckboxControl | null = null;
  let dirCheckbox: CheckboxControl | null = null;
  let tailSelect: SelectControl | null = null;
  let lengthSelect: SelectControl | null = null;
  let componentsCheckbox: CheckboxControl | null = null;
  let familyCheckbox: CheckboxControl | null = null;
  let planeCheckbox: CheckboxControl | null = null;
  let originSelect: SelectControl | null = null;
  let interceptsCheckbox: CheckboxControl | null = null;
  let parallelCheckbox: CheckboxControl | null = null;
  const uvwSliders: SliderControl[] = [];
  const hklSliders: SliderControl[] = [];
  let dirBody: HTMLElement | null = null;
  let planeBody: HTMLElement | null = null;
  let atomBody: HTMLElement | null = null;

  function syncControls(): void {
    structureSelect?.setValue(params.structure);
    extraSlider?.setValue(params.extra);
    atomsCheckbox?.setChecked(params.atoms);
    radiusSlider?.setValue(params.radius);
    colorSelect?.setValue(params.colorBy);
    highlightCheckbox?.setChecked(params.highlight);
    dirCheckbox?.setChecked(params.dir);
    uvwSliders.forEach((s, i) => s.setValue(params.uvw[i]!));
    tailSelect?.setValue(params.tail);
    lengthSelect?.setValue(params.dirLength);
    componentsCheckbox?.setChecked(params.components);
    familyCheckbox?.setChecked(params.family);
    planeCheckbox?.setChecked(params.plane);
    hklSliders.forEach((s, i) => s.setValue(params.hkl[i]!));
    originSelect?.setValue(params.origin);
    interceptsCheckbox?.setChecked(params.intercepts);
    parallelCheckbox?.setChecked(params.parallel);
    if (dirBody) dirBody.style.display = params.dir ? '' : 'none';
    if (planeBody) planeBody.style.display = params.plane ? '' : 'none';
    if (atomBody) atomBody.style.display = params.atoms ? '' : 'none';
  }

  type Update = 'lattice' | 'indices' | 'atoms';

  function onChange(update: Update, resetView = false): void {
    if (update === 'lattice') rebuildLattice();
    else if (update === 'indices') rebuildIndices();
    else {
      updateAtomInstances();
      applyColors();
      updateOverlay();
    }
    if (resetView) setView('reset');
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

  const signed = (v: number) => (v < 0 ? `−${-v}` : String(v));
  const cornerOptions = [
    { value: 'auto', label: 'Auto (shift for negative indices)' },
    ...CORNERS.map((k) => ({ value: k, label: formatCoord(cornerVec(k)) })),
  ];

  if (controlsPanel) {
    const checkbox = (
      parent: HTMLElement,
      label: string,
      key:
        | 'atoms'
        | 'highlight'
        | 'dir'
        | 'components'
        | 'family'
        | 'plane'
        | 'intercepts'
        | 'parallel',
      update: Update
    ): CheckboxControl => {
      const c = createCheckbox({
        label,
        checked: params[key],
        onChange: (v) => {
          params[key] = v;
          onChange(update);
        },
      });
      disposables.push(c);
      parent.appendChild(c.element);
      return c;
    };

    const indexSlider = (parent: HTMLElement, label: string, key: 'uvw' | 'hkl', i: number) => {
      const s: SliderControl = createSlider({
        label,
        min: -MAX_INDEX,
        max: MAX_INDEX,
        step: 1,
        value: params[key][i]!,
        format: signed,
        onChange: (v) => {
          const next = [...params[key]] as Vec3;
          next[i] = Math.round(v);
          if (next.every((x) => x === 0)) {
            s.setValue(params[key][i]!); // indices cannot all be zero
            return;
          }
          params[key] = next;
          onChange('indices');
        },
      });
      disposables.push(s);
      parent.appendChild(s.element);
      return s;
    };

    // Cell
    const cellSection = createSection({ title: 'Unit Cell' });
    disposables.push(cellSection);
    structureSelect = createSelect({
      label: 'Cubic structure',
      options: [
        { value: 'sc', label: 'Simple cubic (SC)' },
        { value: 'bcc', label: 'Body-centered cubic (BCC)' },
        { value: 'fcc', label: 'Face-centered cubic (FCC)' },
      ],
      value: params.structure,
      onChange: (v) => {
        params.structure = v as CubicStructure;
        onChange('lattice');
      },
    });
    extraSlider = createSlider({
      label: 'Extra cells on each side',
      min: 0,
      max: MAX_EXTRA,
      step: 1,
      value: params.extra,
      format: (v) => v.toFixed(0),
      onChange: (v) => {
        params.extra = Math.round(v);
        onChange('lattice', true);
      },
    });
    disposables.push(structureSelect, extraSlider);
    cellSection.content.appendChild(structureSelect.element);
    cellSection.content.appendChild(extraSlider.element);
    cellSection.content.appendChild(
      createHelperText(
        'Neighboring cells help to follow fractional coordinates, negative indices and ' +
          'full-length directions beyond the central cell.'
      )
    );

    atomsCheckbox = checkbox(cellSection.content, 'Show atoms', 'atoms', 'atoms');
    atomBody = document.createElement('div');
    cellSection.content.appendChild(atomBody);
    radiusSlider = createSlider({
      label: 'Sphere radius (r / R)',
      min: 0.1,
      max: 1,
      step: 0.01,
      value: params.radius,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        params.radius = v;
        onChange('atoms');
      },
    });
    colorSelect = createSelect({
      label: 'Color atoms by',
      options: [
        { value: 'site', label: 'Cell site (corner/face/interior)' },
        { value: 'uniform', label: 'Uniform' },
      ],
      value: params.colorBy,
      onChange: (v) => {
        params.colorBy = v as ColorBy;
        onChange('atoms');
      },
    });
    disposables.push(radiusSlider, colorSelect);
    atomBody.appendChild(radiusSlider.element);
    atomBody.appendChild(colorSelect.element);
    highlightCheckbox = checkbox(
      atomBody,
      'Highlight atoms on the direction / plane',
      'highlight',
      'atoms'
    );
    controlsPanel.appendChild(cellSection.element);

    // Direction
    const dirSection = createSection({ title: 'Direction [uvw]' });
    disposables.push(dirSection);
    dirCheckbox = checkbox(dirSection.content, 'Show direction', 'dir', 'indices');
    dirBody = document.createElement('div');
    dirSection.content.appendChild(dirBody);
    ['u', 'v', 'w'].forEach((name, i) => uvwSliders.push(indexSlider(dirBody!, name, 'uvw', i)));
    tailSelect = createSelect({
      label: 'Tail at',
      options: cornerOptions,
      value: params.tail,
      onChange: (v) => {
        params.tail = v as Corner;
        onChange('indices');
      },
    });
    lengthSelect = createSelect({
      label: 'Arrow length',
      options: [
        { value: 'fit', label: 'Fit in the cell (largest component = 1)' },
        { value: 'full', label: 'Full lattice vector u·a + v·b + w·c' },
      ],
      value: params.dirLength,
      onChange: (v) => {
        params.dirLength = v as DirLength;
        onChange('indices');
      },
    });
    disposables.push(tailSelect, lengthSelect);
    dirBody.appendChild(tailSelect.element);
    dirBody.appendChild(lengthSelect.element);
    componentsCheckbox = checkbox(dirBody, 'Show x, y, z components', 'components', 'indices');
    familyCheckbox = checkbox(dirBody, 'Show family ⟨uvw⟩ (from cell center)', 'family', 'indices');
    dirBody.appendChild(
      createHelperText(
        'Recipe: head − tail, clear fractions by multiplying, reduce to the smallest integers. ' +
          'Negative components are written with a bar. Indices cannot all be zero.'
      )
    );
    controlsPanel.appendChild(dirSection.element);

    // Plane
    const planeSection = createSection({ title: 'Plane (hkl)' });
    disposables.push(planeSection);
    planeCheckbox = checkbox(planeSection.content, 'Show plane', 'plane', 'indices');
    planeBody = document.createElement('div');
    planeSection.content.appendChild(planeBody);
    ['h', 'k', 'l'].forEach((name, i) => hklSliders.push(indexSlider(planeBody!, name, 'hkl', i)));
    originSelect = createSelect({
      label: 'Origin at',
      options: cornerOptions,
      value: params.origin,
      onChange: (v) => {
        params.origin = v as Corner;
        onChange('indices');
      },
    });
    disposables.push(originSelect);
    planeBody.appendChild(originSelect.element);
    interceptsCheckbox = checkbox(planeBody, 'Show origin and intercepts', 'intercepts', 'indices');
    parallelCheckbox = checkbox(
      planeBody,
      'Show parallel planes (through all cells shown)',
      'parallel',
      'indices'
    );
    planeBody.appendChild(
      createHelperText(
        'Recipe: pick an origin the plane does not pass through, read the intercepts in units ' +
          'of a (∞ if parallel), take reciprocals, clear fractions. Index 0 means the plane is ' +
          'parallel to that axis.'
      )
    );
    controlsPanel.appendChild(planeSection.element);

    // View
    const viewSection = createSection({ title: 'View' });
    disposables.push(viewSection);
    const resetBtn = createButton({ label: 'Reset view', onClick: () => setView('reset') });
    const frontBtn = createButton({
      label: 'Down x',
      variant: 'secondary',
      onClick: () => setView('front'),
    });
    const dirBtn = createButton({
      label: 'Along [uvw]',
      variant: 'secondary',
      onClick: () => setView('dir'),
    });
    const normalBtn = createButton({
      label: 'Along (hkl) normal',
      variant: 'secondary',
      onClick: () => setView('normal'),
    });
    disposables.push(resetBtn, frontBtn, dirBtn, normalBtn);
    viewSection.content.appendChild(buttonRow(resetBtn.element, frontBtn.element));
    viewSection.content.appendChild(buttonRow(dirBtn.element, normalBtn.element));
    controlsPanel.appendChild(viewSection.element);
  }

  function updateUrlParams(): void {
    options.setParams(getParamRecord());
  }

  function getParamRecord(): Record<string, string> {
    return {
      structure: params.structure,
      extra: String(params.extra),
      atoms: String(params.atoms),
      radius: params.radius.toFixed(2),
      colorBy: params.colorBy,
      highlight: String(params.highlight),
      dir: String(params.dir),
      u: String(params.uvw[0]),
      v: String(params.uvw[1]),
      w: String(params.uvw[2]),
      tail: params.tail,
      dirLength: params.dirLength,
      components: String(params.components),
      family: String(params.family),
      plane: String(params.plane),
      h: String(params.hkl[0]),
      k: String(params.hkl[1]),
      l: String(params.hkl[2]),
      origin: params.origin,
      intercepts: String(params.intercepts),
      parallel: String(params.parallel),
    };
  }

  // --- render loop & resize ---------------------------------------------
  function handleResize(): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  const resizeObserver = new ResizeObserver(handleResize);
  resizeObserver.observe(container);
  handleResize();

  rebuildLattice();
  setView('reset');
  syncControls();

  const loop = new AnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
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
      controls.dispose();
      clearGroup(latticeGroup);
      clearGroup(indexGroup);
      atomMesh?.dispose();
      sharedGeometries.forEach((g) => g.dispose());
      sharedMaterials.forEach((m) => m.dispose());
      renderer.dispose();
      renderer.domElement.remove();
      labelRenderer.domElement.remove();
      overlay.remove();
      hint.remove();
      disposables.forEach((d) => d.dispose());
    },
    getParams() {
      return getParamRecord();
    },
    setParams(newParams: Record<string, string>) {
      parseParams(newParams, params);
      rebuildLattice();
      setView('reset');
      syncControls();
    },
  };
}

export const millerIndicesDemo: DemoDefinition = {
  id: 'miller-indices',
  title: 'Miller Indices (Cubic)',
  description:
    'Visualize crystallographic directions [uvw] and planes (hkl) in SC, BCC and FCC unit cells, with neighboring cells to follow fractional and negative indices.',
  category: 'Crystallography',
  tags: ['miller indices', 'directions', 'planes', 'unit cell', 'cubic', '3d'],
  create,
};

export default millerIndicesDemo;
