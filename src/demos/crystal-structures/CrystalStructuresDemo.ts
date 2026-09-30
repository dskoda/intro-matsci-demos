/**
 * Crystal Structures (hard-sphere model)
 *
 * Builds SC, BCC, FCC and HCP out of hard spheres in 3D so students can see
 * which atoms touch, how much empty space remains, and how the structures
 * stack. The structure can be grown one layer at a time (stacking view) or
 * one unit cell at a time. Drag to rotate, scroll to zoom, right-drag to pan.
 *
 * Lengths are in units of the atomic radius R; touching spheres are 2R apart.
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
  buildLayers,
  buildCells,
  findContacts,
  stackingLabel,
  cellRegion,
  layerRegion,
  insideDistance,
  R,
  type Atom,
  type Structure,
  type Vec3,
} from './lattice';
import { computeVoidSurface } from './voids';

type Mode = 'layers' | 'cells';
type ColorBy = 'layer' | 'site' | 'uniform';

interface DemoParams {
  structure: Structure;
  mode: Mode;
  layers: number;
  extent: number;
  /** Unit cells along a, b (in-plane) and c (vertical) */
  na: number;
  nb: number;
  nc: number;
  radius: number;
  contacts: boolean;
  edges: boolean;
  clip: boolean;
  /** Show the empty space left by spheres of the full radius R */
  voids: boolean;
  hideAtoms: boolean;
  colorBy: ColorBy;
}

const defaultParams: DemoParams = {
  structure: 'fcc',
  mode: 'layers',
  layers: 1,
  extent: 3,
  na: 1,
  nb: 1,
  nc: 1,
  radius: 1.0,
  contacts: false,
  edges: true,
  clip: false,
  voids: false,
  hideAtoms: false,
  colorBy: 'layer',
};

const MAX_LAYERS = 8;
const MAX_CELLS = 4;
const DROP_TIME = 0.45; // seconds for newly added atoms to fall into place
const DROP_HEIGHT = 6;

const LAYER_COLORS = { A: '#4a9eff', B: '#ff9f4a', C: '#7CFF9F' };
const SITE_COLORS = { corner: '#4a9eff', face: '#c77dff', body: '#ff6b6b' };
const UNIFORM_COLOR = '#9fb4c8';
const PICK_COLOR = '#ffd84a';
const NEIGHBOR_COLOR = '#ff5ad1';
const VOID_COLOR = '#2ec4b6';

function parseParams(src: Record<string, string>, params: DemoParams): void {
  const int = (v: string, lo: number, hi: number) => clamp(parseInt(v, 10) || lo, lo, hi);
  if (src.structure && src.structure in STRUCTURES) params.structure = src.structure as Structure;
  if (src.mode === 'layers' || src.mode === 'cells') params.mode = src.mode;
  if (src.layers) params.layers = int(src.layers, 1, MAX_LAYERS);
  if (src.extent) params.extent = int(src.extent, 1, 5);
  if (src.na) params.na = int(src.na, 1, MAX_CELLS);
  if (src.nb) params.nb = int(src.nb, 1, MAX_CELLS);
  if (src.nc) params.nc = int(src.nc, 1, MAX_CELLS);
  if (src.radius) params.radius = clamp(parseFloat(src.radius) || 1, 0.15, 1);
  if (src.contacts !== undefined) params.contacts = src.contacts === 'true';
  if (src.edges !== undefined) params.edges = src.edges === 'true';
  if (src.clip !== undefined) params.clip = src.clip === 'true';
  if (src.voids !== undefined) params.voids = src.voids === 'true';
  if (src.hideAtoms !== undefined) params.hideAtoms = src.hideAtoms === 'true';
  if (src.colorBy === 'layer' || src.colorBy === 'site' || src.colorBy === 'uniform') {
    params.colorBy = src.colorBy;
  }
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
  const bondGeometry = new THREE.CylinderGeometry(0.1, 0.1, 1, 12, 1);
  const capGeometry = new THREE.CircleGeometry(1, 48);
  const atomMaterial = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 });
  // Flat faces where a clipping plane cuts a sphere, so clipped atoms read as solid
  const capMaterial = new THREE.MeshStandardMaterial({ roughness: 0.8, side: THREE.DoubleSide });
  const bondMaterial = new THREE.MeshStandardMaterial({ color: '#e8e8e8', roughness: 0.5 });
  const voidMaterial = new THREE.MeshStandardMaterial({
    color: VOID_COLOR,
    roughness: 0.6,
    side: THREE.DoubleSide,
    // Where the void surface coincides with a sphere surface, the sphere wins
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });
  const edgeMaterial = new THREE.LineBasicMaterial({ color: '#dddddd' });

  let atomMesh: THREE.InstancedMesh | null = null;
  let bondMesh: THREE.InstancedMesh | null = null;
  let capMesh: THREE.InstancedMesh | null = null;
  let capAtom: number[] = [];
  let voidMesh: THREE.Mesh | null = null;
  let voidFraction: number | null = null;
  let edgeLines: THREE.LineSegments | null = null;

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
    'Drag to rotate · scroll to zoom · right-drag to pan · click an atom to show the atoms it touches';
  container.appendChild(hint);

  // --- structure state --------------------------------------------------
  let atoms: Atom[] = [];
  let contacts: [number, number][] = [];
  let neighbors: number[][] = [];
  let birth: number[] = []; // time (s) each atom was added, for the drop-in animation
  let clock = 0;
  let animatingAtoms = false;
  let picked: number | null = null;
  let stackingAxis = new THREE.Vector3(0, 1, 0);
  const center = new THREE.Vector3();
  let boundRadius = 5;
  const dummy = new THREE.Object3D();

  function clipAllowed(): boolean {
    return params.structure !== 'hcp' || (params.na === 1 && params.nb === 1);
  }

  function currentRegion() {
    return params.mode === 'cells'
      ? cellRegion(params.structure, params.na, params.nc, params.nb)
      : layerRegion(params.structure, params.layers, params.extent);
  }

  function clipActive(): boolean {
    return params.mode === 'cells' && params.clip && clipAllowed();
  }

  /** Clipping planes (cell faces pushed out by a hair so the caps sit just inside). */
  function computeClipPlanes(): THREE.Plane[] {
    if (!clipActive()) return [];
    const part = currentRegion()[0]!;
    return part.map(({ n, d }) => new THREE.Plane(new THREE.Vector3(...n), d + 1e-3));
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
    disposeVoid();
  }

  function disposeCaps(): void {
    if (!capMesh) return;
    scene.remove(capMesh);
    capMesh.dispose();
    capMesh = null;
    capAtom = [];
  }

  function disposeVoid(): void {
    if (!voidMesh) return;
    scene.remove(voidMesh);
    voidMesh.geometry.dispose();
    voidMesh = null;
  }

  /** Rebuild all geometry. New atoms (not present before) drop in from above. */
  function rebuild(resetView: boolean): void {
    const previous = new Set(atoms.map((at) => posKey(at.pos)));
    const animate = !resetView && previous.size > 0;

    let edges: [Vec3, Vec3][] = [];
    if (params.mode === 'layers') {
      atoms = buildLayers(params.structure, params.layers, params.extent);
      stackingAxis = new THREE.Vector3(0, 1, 0);
    } else {
      const build = buildCells(params.structure, params.na, params.nc, params.nb);
      atoms = build.atoms;
      edges = build.edges;
      if (clipActive()) {
        // Neighbor-cell spheres that poke into the cell (e.g. HCP) are part of its contents
        const region = currentRegion();
        const known = new Set(atoms.map((at) => posKey(at.pos)));
        const padded = buildCells(params.structure, params.na, params.nc, params.nb, 1).atoms;
        for (const at of padded) {
          if (!known.has(posKey(at.pos)) && insideDistance(region, at.pos) > -R + 1e-6) {
            atoms.push(at);
          }
        }
      }
      stackingAxis =
        params.structure === 'fcc'
          ? new THREE.Vector3(1, 1, 1).normalize()
          : new THREE.Vector3(0, 1, 0);
    }
    birth = atoms.map((at) => (animate && !previous.has(posKey(at.pos)) ? clock : -Infinity));

    contacts = findContacts(atoms);
    neighbors = atoms.map(() => []);
    for (const [i, j] of contacts) {
      neighbors[i]!.push(j);
      neighbors[j]!.push(i);
    }
    picked = null;

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
      const mid = p.clone().add(q).multiplyScalar(0.5);
      const dir = q.clone().sub(p);
      dummy.position.copy(mid);
      dummy.quaternion.setFromUnitVectors(up, dir.clone().normalize());
      dummy.scale.set(1, dir.length(), 1);
      dummy.updateMatrix();
      bondMesh!.setMatrixAt(k, dummy.matrix);
    });
    scene.add(bondMesh);

    if (edges.length > 0) {
      const pts = new Float32Array(edges.length * 6);
      edges.forEach(([p, q], k) => pts.set([...p, ...q], k * 6));
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(pts, 3));
      edgeLines = new THREE.LineSegments(geom, edgeMaterial);
      scene.add(edgeLines);
    }

    // Bounding sphere for camera framing
    const box = new THREE.Box3();
    atoms.forEach((at) => box.expandByPoint(new THREE.Vector3(...at.pos)));
    const prevCenter = center.clone();
    box.getCenter(center);
    boundRadius = Math.max(box.getSize(new THREE.Vector3()).length() / 2 + 1, 3);

    if (resetView) {
      setView('reset');
    } else {
      // Keep the current viewing direction, follow the growing structure
      const shift = center.clone().sub(prevCenter);
      camera.position.add(shift);
      controls.target.copy(center);
    }

    updateVoid();
    applyDisplay();
    animatingAtoms = updateInstances();
    updateOverlay();
  }

  /** (Re)compute the empty-space surface for the current build, if enabled. */
  function updateVoid(): void {
    disposeVoid();
    voidFraction = null;
    if (!params.voids) return;
    if (params.mode === 'layers' && params.layers < 2) return;

    const region = currentRegion();
    const real =
      params.mode === 'cells'
        ? buildCells(params.structure, params.na, params.nc, params.nb).atoms
        : atoms;
    // Include neighbors just outside the region so their spheres are accounted for
    const centers = (
      params.mode === 'cells'
        ? buildCells(params.structure, params.na, params.nc, params.nb, 1).atoms
        : buildLayers(params.structure, params.layers, params.extent + 1)
    ).map((at) => at.pos);
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const at of real) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, at.pos[k]!);
        max[k] = Math.max(max[k]!, at.pos[k]!);
      }
    }

    const surface = computeVoidSurface(centers, region, { min, max });
    voidFraction = surface.emptyFraction;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(surface.normals, 3));
    voidMesh = new THREE.Mesh(geom, voidMaterial);
    scene.add(voidMesh);
  }

  /** Flat caps on every sphere face cut by a clipping plane. */
  function updateCaps(): void {
    disposeCaps();
    if (!clipActive()) return;
    const part = currentRegion()[0]!;
    const r = params.radius * R;
    const entries: {
      atom: number;
      center: THREE.Vector3;
      normal: THREE.Vector3;
      radius: number;
    }[] = [];
    atoms.forEach((at, i) => {
      for (const { n, d } of part) {
        const dist = n[0] * at.pos[0] + n[1] * at.pos[1] + n[2] * at.pos[2] + d;
        if (Math.abs(dist) >= r) continue;
        const normal = new THREE.Vector3(...n);
        const center = new THREE.Vector3(...at.pos).addScaledVector(normal, -dist);
        entries.push({ atom: i, center, normal, radius: Math.sqrt(r * r - dist * dist) });
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
      if (neighbors[picked]!.includes(i)) return NEIGHBOR_COLOR;
    }
    const colorBy =
      params.colorBy === 'site' && params.mode === 'layers' ? 'layer' : params.colorBy;
    if (colorBy === 'layer') return LAYER_COLORS[at.layerLabel];
    if (colorBy === 'site') return SITE_COLORS[at.site];
    return UNIFORM_COLOR;
  }

  const dimmed = new THREE.Color('#2a2a2a');

  function displayColor(i: number, out: THREE.Color): THREE.Color {
    out.set(atomColor(i));
    const isHighlighted = picked === null || i === picked || neighbors[picked]!.includes(i);
    if (!isHighlighted) out.lerp(dimmed, 0.7);
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
    applyColors();
  }

  /** Update sphere scales and drop-in offsets. Returns true while animating. */
  function updateInstances(): boolean {
    if (!atomMesh) return false;
    let animating = false;
    const s = params.radius;
    for (let i = 0; i < atoms.length; i++) {
      const [x, y, z] = atoms[i]!.pos;
      const t = clamp((clock - birth[i]!) / DROP_TIME, 0, 1);
      if (t < 1) animating = true;
      const ease = 1 - (1 - t) * (1 - t) * (1 - t);
      dummy.position.set(x, y + DROP_HEIGHT * (1 - ease), z);
      dummy.quaternion.identity();
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      atomMesh.setMatrixAt(i, dummy.matrix);
    }
    atomMesh.instanceMatrix.needsUpdate = true;
    atomMesh.computeBoundingSphere();
    // Contacts, caps and empty space appear once atoms have fallen into place
    const atomsVisible = !(params.voids && params.hideAtoms);
    atomMesh.visible = atomsVisible;
    if (bondMesh) bondMesh.visible = params.contacts && !animating;
    if (voidMesh) voidMesh.visible = !animating;
    if (animating) disposeCaps();
    else updateCaps();
    if (capMesh) capMesh.visible = atomsVisible;
    return animating;
  }

  function setView(kind: 'reset' | 'top' | 'side'): void {
    const fov = (camera.fov * Math.PI) / 180;
    const dist = (boundRadius / Math.sin(fov / 2)) * 1.05;
    let dir: THREE.Vector3;
    if (kind === 'top') {
      dir = stackingAxis.clone();
      if (Math.abs(dir.y) > 0.999) dir.add(new THREE.Vector3(0, 0, 1e-3)).normalize();
    } else if (kind === 'side') {
      // Look along a close-packed row (x) so the layer offsets are visible
      dir =
        params.mode === 'cells' && params.structure === 'fcc'
          ? new THREE.Vector3(1, -1, 0).normalize()
          : new THREE.Vector3(0, 0, 1);
    } else {
      dir = new THREE.Vector3(1.1, 0.8, 1.5).normalize();
    }
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.lookAt(center);
    controls.update();
  }

  function stackingText(): string {
    const info = STRUCTURES[params.structure];
    if (params.mode === 'layers') {
      const seq = Array.from({ length: params.layers }, (_, k) =>
        stackingLabel(params.structure, k)
      );
      return `${info.layerPlane}: <b>${seq.join(' ')}</b> (bottom → top)`;
    }
    switch (params.structure) {
      case 'fcc':
        return 'ABC stacking of (111) planes along the body diagonal [111]';
      case 'hcp':
        return 'AB stacking of (0001) planes along c';
      case 'bcc':
        return 'AB stacking of (001) planes (corners / body centers)';
      case 'sc':
        return 'AA stacking of (001) planes';
    }
  }

  function updateOverlay(): void {
    const info = STRUCTURES[params.structure];
    const eff = info.apf * params.radius ** 3;
    const lines = [
      `<b style="font-size:14px">${info.name}</b>`,
      stackingText(),
      `atoms shown: ${atoms.length} · touching pairs: ${contacts.length}`,
      `coordination number: ${info.cn} · ideal APF: ${info.apf.toFixed(3)}`,
      `sphere radius r/R = ${params.radius.toFixed(2)} → filled fraction ${eff.toFixed(3)} ` +
        `(empty ${(1 - eff).toFixed(3)})`,
    ];
    if (params.voids) {
      lines.push(
        voidFraction === null
          ? `<span style="color:${VOID_COLOR}">empty space</span>: add a second layer to see the gaps between layers`
          : `<span style="color:${VOID_COLOR}">empty space</span> (spheres of full radius R): ` +
              `${(voidFraction * 100).toFixed(1)}% of the ${params.mode === 'cells' ? 'cell volume' : 'stack volume'} ` +
              `(ideal 1 − APF = ${((1 - info.apf) * 100).toFixed(1)}%)`
      );
    }
    if (picked !== null) {
      lines.push(
        `<span style="color:${PICK_COLOR}">selected atom</span> touches ` +
          `<span style="color:${NEIGHBOR_COLOR}"><b>${neighbors[picked]!.length}</b> atoms</span>`
      );
    }
    const colorBy =
      params.colorBy === 'site' && params.mode === 'layers' ? 'layer' : params.colorBy;
    const swatch = (c: string, t: string) => `<span style="color:${c}">●</span> ${t}`;
    if (colorBy === 'layer') {
      const used = new Set(atoms.map((at) => at.layerLabel));
      lines.push(
        (['A', 'B', 'C'] as const)
          .filter((l) => used.has(l))
          .map((l) => swatch(LAYER_COLORS[l], `layer ${l}`))
          .join('&nbsp;&nbsp;')
      );
    } else if (colorBy === 'site') {
      const used = new Set(atoms.map((at) => at.site));
      const names = { corner: 'corner', face: 'face', body: 'interior' };
      lines.push(
        (['corner', 'face', 'body'] as const)
          .filter((s) => used.has(s))
          .map((s) => swatch(SITE_COLORS[s], names[s]))
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
    applyColors();
    updateOverlay();
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);

  // --- controls panel ---------------------------------------------------
  const disposables: Disposable[] = [];
  let structureSelect: SelectControl | null = null;
  let modeSelect: SelectControl | null = null;
  let extentSlider: SliderControl | null = null;
  let naSlider: SliderControl | null = null;
  let nbSlider: SliderControl | null = null;
  let ncSlider: SliderControl | null = null;
  let radiusSlider: SliderControl | null = null;
  let contactsCheckbox: CheckboxControl | null = null;
  let edgesCheckbox: CheckboxControl | null = null;
  let clipCheckbox: CheckboxControl | null = null;
  let voidsCheckbox: CheckboxControl | null = null;
  let hideAtomsCheckbox: CheckboxControl | null = null;
  let colorSelect: SelectControl | null = null;
  let layerSectionEl: HTMLElement | null = null;
  let cellSectionEl: HTMLElement | null = null;
  let layerCountText: HTMLElement | null = null;
  let clipNote: HTMLElement | null = null;

  function syncControls(): void {
    structureSelect?.setValue(params.structure);
    modeSelect?.setValue(params.mode);
    extentSlider?.setValue(params.extent);
    naSlider?.setValue(params.na);
    nbSlider?.setValue(params.nb);
    ncSlider?.setValue(params.nc);
    radiusSlider?.setValue(params.radius);
    contactsCheckbox?.setChecked(params.contacts);
    edgesCheckbox?.setChecked(params.edges);
    clipCheckbox?.setChecked(params.clip);
    voidsCheckbox?.setChecked(params.voids);
    hideAtomsCheckbox?.setChecked(params.hideAtoms);
    if (hideAtomsCheckbox) hideAtomsCheckbox.element.style.display = params.voids ? '' : 'none';
    colorSelect?.setValue(params.colorBy);
    if (layerSectionEl) layerSectionEl.style.display = params.mode === 'layers' ? '' : 'none';
    if (cellSectionEl) cellSectionEl.style.display = params.mode === 'cells' ? '' : 'none';
    if (layerCountText) layerCountText.textContent = `Layers: ${params.layers} / ${MAX_LAYERS}`;
    if (clipNote) clipNote.style.display = clipAllowed() ? 'none' : '';
  }

  function onChange(rebuildNeeded: boolean, resetView = false): void {
    if (rebuildNeeded) rebuild(resetView);
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
      options: [
        { value: 'sc', label: 'Simple cubic (SC)' },
        { value: 'bcc', label: 'Body-centered cubic (BCC)' },
        { value: 'fcc', label: 'Face-centered cubic (FCC)' },
        { value: 'hcp', label: 'Hexagonal close-packed (HCP)' },
      ],
      value: params.structure,
      onChange: (v) => {
        params.structure = v as Structure;
        onChange(true, true);
      },
    });
    disposables.push(structureSelect);
    structSection.content.appendChild(structureSelect.element);

    modeSelect = createSelect({
      label: 'Build by',
      options: [
        { value: 'layers', label: 'Stacking layers' },
        { value: 'cells', label: 'Unit cells' },
      ],
      value: params.mode,
      onChange: (v) => {
        params.mode = v as Mode;
        onChange(true, true);
      },
    });
    disposables.push(modeSelect);
    structSection.content.appendChild(modeSelect.element);
    controlsPanel.appendChild(structSection.element);

    // Layers mode
    const layerSection = createSection({ title: 'Stacking Layers' });
    disposables.push(layerSection);
    layerSectionEl = layerSection.element;

    layerCountText = document.createElement('div');
    layerCountText.className = 'control-label';
    layerSection.content.appendChild(layerCountText);

    const addLayer = createButton({
      label: '+ Add layer',
      onClick: () => {
        if (params.layers >= MAX_LAYERS) return;
        params.layers += 1;
        onChange(true);
      },
    });
    const removeLayer = createButton({
      label: '− Remove layer',
      variant: 'secondary',
      onClick: () => {
        if (params.layers <= 1) return;
        params.layers -= 1;
        onChange(true);
      },
    });
    disposables.push(addLayer, removeLayer);
    layerSection.content.appendChild(buttonRow(addLayer.element, removeLayer.element));

    extentSlider = createSlider({
      label: 'Layer size',
      min: 1,
      max: 5,
      step: 1,
      value: params.extent,
      format: (v) => v.toFixed(0),
      onChange: (v) => {
        params.extent = Math.round(v);
        onChange(true);
      },
    });
    disposables.push(extentSlider);
    layerSection.content.appendChild(extentSlider.element);
    layerSection.content.appendChild(
      createHelperText(
        'FCC and HCP stack identical close-packed layers; only the position of the third layer ' +
          'differs (C for FCC, back over A for HCP). BCC atoms within a (001) layer do not touch — ' +
          'each touches four atoms above and four below.'
      )
    );
    controlsPanel.appendChild(layerSection.element);

    // Unit cell mode
    const cellSection = createSection({ title: 'Unit Cells' });
    disposables.push(cellSection);
    cellSectionEl = cellSection.element;

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
          onChange(true);
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
        onChange(true);
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
      label: 'Clip spheres to the cell',
      checked: params.clip,
      onChange: (c) => {
        params.clip = c;
        onChange(true);
      },
    });
    disposables.push(edgesCheckbox, clipCheckbox);
    cellSection.content.appendChild(edgesCheckbox.element);
    cellSection.content.appendChild(clipCheckbox.element);
    clipNote = createHelperText('Clipping for HCP works with a single cell along a and b.');
    cellSection.content.appendChild(clipNote);
    controlsPanel.appendChild(cellSection.element);

    // Spheres & display
    const displaySection = createSection({ title: 'Spheres & Display' });
    disposables.push(displaySection);

    radiusSlider = createSlider({
      label: 'Sphere radius (r / R)',
      min: 0.15,
      max: 1,
      step: 0.01,
      value: params.radius,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        params.radius = v;
        onChange(false);
      },
    });
    disposables.push(radiusSlider);
    displaySection.content.appendChild(radiusSlider.element);
    displaySection.content.appendChild(
      createHelperText(
        'At r/R = 1 the spheres are hard spheres that just touch their nearest neighbors. ' +
          'Shrink them to see the lattice and the empty space.'
      )
    );

    contactsCheckbox = createCheckbox({
      label: 'Show contacts (touching pairs)',
      checked: params.contacts,
      onChange: (c) => {
        params.contacts = c;
        onChange(false);
      },
    });
    disposables.push(contactsCheckbox);
    displaySection.content.appendChild(contactsCheckbox.element);

    voidsCheckbox = createCheckbox({
      label: 'Show empty space',
      checked: params.voids,
      onChange: (c) => {
        params.voids = c;
        updateVoid();
        onChange(false);
      },
    });
    hideAtomsCheckbox = createCheckbox({
      label: 'Hide atoms (empty space only)',
      checked: params.hideAtoms,
      onChange: (c) => {
        params.hideAtoms = c;
        onChange(false);
      },
    });
    disposables.push(voidsCheckbox, hideAtomsCheckbox);
    displaySection.content.appendChild(voidsCheckbox.element);
    displaySection.content.appendChild(hideAtomsCheckbox.element);
    displaySection.content.appendChild(
      createHelperText(
        'Empty space is always computed for spheres of the full radius R, independent of the ' +
          'radius slider. In unit-cell mode, combine it with "Clip spheres to the cell" to see ' +
          'occupied and empty area on every cell face.'
      )
    );

    colorSelect = createSelect({
      label: 'Color atoms by',
      options: [
        { value: 'layer', label: 'Stacking layer (A/B/C)' },
        { value: 'site', label: 'Cell site (corner/face/interior)' },
        { value: 'uniform', label: 'Uniform' },
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
    const topBtn = createButton({
      label: 'Top',
      variant: 'secondary',
      onClick: () => setView('top'),
    });
    const sideBtn = createButton({
      label: 'Side',
      variant: 'secondary',
      onClick: () => setView('side'),
    });
    disposables.push(resetBtn, topBtn, sideBtn);
    viewSection.content.appendChild(buttonRow(resetBtn.element, topBtn.element, sideBtn.element));
    viewSection.content.appendChild(
      createHelperText('Top looks down the stacking direction ([111] for FCC unit cells).')
    );
    controlsPanel.appendChild(viewSection.element);
  }

  function updateUrlParams(): void {
    options.setParams(getParamRecord());
  }

  function getParamRecord(): Record<string, string> {
    return {
      structure: params.structure,
      mode: params.mode,
      layers: String(params.layers),
      extent: String(params.extent),
      na: String(params.na),
      nb: String(params.nb),
      nc: String(params.nc),
      radius: params.radius.toFixed(2),
      contacts: String(params.contacts),
      edges: String(params.edges),
      clip: String(params.clip),
      voids: String(params.voids),
      hideAtoms: String(params.hideAtoms),
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
      voidMaterial.dispose();
      edgeMaterial.dispose();
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

export const crystalStructuresDemo: DemoDefinition = {
  id: 'crystal-structures',
  title: 'Crystal Structures (Hard Spheres)',
  description:
    'Build SC, BCC, FCC and HCP from hard spheres in 3D, layer by layer or cell by cell, to see stacking order, which atoms touch, and how much space is empty.',
  category: 'Crystallography',
  tags: ['crystal structure', 'fcc', 'bcc', 'hcp', 'stacking', 'packing fraction', '3d'],
  create,
};

export default crystalStructuresDemo;
