/**
 * Crystal Defects in 3D (simple cubic)
 *
 * Shows a vacancy, a self-interstitial, an edge dislocation, a screw
 * dislocation and a tilt grain boundary in a simple cubic crystal. Atoms around
 * the defect are coloured by how strongly their bonding is disturbed, and the
 * opacity of each group can be changed to look through the crystal.
 * Drag to rotate, scroll to zoom, right-drag to pan.
 *
 * Lengths are in units of the lattice constant a.
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
  buildDefect,
  defectTypes,
  DEFECT_INFO,
  ROLE_COLORS,
  ROLE_LABELS,
  type DefectStructure,
  type DefectType,
  type Role,
} from './defects';

interface DemoParams {
  defect: DefectType;
  size: number;
  shell: number;
  tilt: number;
  bulkOpacity: number;
  shellOpacity: number;
  coreOpacity: number;
  bonds: boolean;
  ghost: boolean;
  line: boolean;
}

const defaultParams: DemoParams = {
  defect: 'vacancy',
  size: 8,
  shell: 2.5,
  tilt: 18,
  bulkOpacity: 1,
  shellOpacity: 1,
  coreOpacity: 1,
  bonds: true,
  ghost: true,
  line: true,
};

const TYPES_3D = defectTypes(3);
const ATOM_RADIUS = 0.36;
const BOND_RADIUS = 0.05;
/** Groups of atoms that get their own mesh so each can have its own opacity */
type Group = 'bulk' | 'shell' | 'core';
const GROUPS: Group[] = ['bulk', 'shell', 'core'];
const LINE_COLOR = '#ffd84a';
const BURGERS_COLOR = '#ff5ad1';

function groupOf(role: Role): Group {
  return role === 'extra' ? 'core' : role;
}

function parseParams(src: Record<string, string>, params: DemoParams): void {
  const num = (v: string, lo: number, hi: number, fallback: number) => {
    const x = parseFloat(v);
    return clamp(Number.isFinite(x) ? x : fallback, lo, hi);
  };
  if (src.defect && TYPES_3D.includes(src.defect as DefectType)) {
    params.defect = src.defect as DefectType;
  }
  if (src.size) params.size = Math.round(num(src.size, 4, 12, 8));
  if (src.shell) params.shell = num(src.shell, 1, 4, 2.5);
  if (src.tilt) params.tilt = num(src.tilt, 5, 40, 18);
  if (src.bulkOpacity) params.bulkOpacity = num(src.bulkOpacity, 0, 1, 1);
  if (src.shellOpacity) params.shellOpacity = num(src.shellOpacity, 0, 1, 1);
  if (src.coreOpacity) params.coreOpacity = num(src.coreOpacity, 0, 1, 1);
  if (src.bonds !== undefined) params.bonds = src.bonds === 'true';
  if (src.ghost !== undefined) params.ghost = src.ghost === 'true';
  if (src.line !== undefined) params.line = src.line === 'true';
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
  camera.add(keyLight);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;

  const sphereGeometry = new THREE.SphereGeometry(1, 24, 16);
  const bondGeometry = new THREE.CylinderGeometry(BOND_RADIUS, BOND_RADIUS, 1, 8, 1);
  const atomMaterials = {} as Record<Group, THREE.MeshStandardMaterial>;
  const bondMaterials = {} as Record<Group, THREE.MeshStandardMaterial>;
  for (const g of GROUPS) {
    atomMaterials[g] = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 });
    bondMaterials[g] = new THREE.MeshStandardMaterial({ color: '#c8ccd4', roughness: 0.5 });
  }
  const ghostMaterial = new THREE.MeshBasicMaterial({ color: '#dddddd', wireframe: true });
  const lineMaterial = new THREE.LineBasicMaterial({ color: LINE_COLOR });
  const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);

  let atomMeshes: THREE.InstancedMesh[] = [];
  let bondMeshes: THREE.InstancedMesh[] = [];
  let ghostMeshes: THREE.Mesh[] = [];
  let lineObj: THREE.Line | null = null;
  let burgersArrow: THREE.ArrowHelper | null = null;

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
    'Drag to rotate · scroll to zoom · right-drag to pan · lower the opacity of the blue atoms to see the defect';
  container.appendChild(hint);

  // --- state ------------------------------------------------------------
  let structure: DefectStructure;
  let boundRadius = 5;
  let sliceValue = 0;
  const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);

  function disposeMeshes(): void {
    for (const m of [...atomMeshes, ...bondMeshes]) {
      scene.remove(m);
      m.dispose();
    }
    for (const m of ghostMeshes) scene.remove(m);
    if (lineObj) {
      scene.remove(lineObj);
      lineObj.geometry.dispose();
      lineObj = null;
    }
    if (burgersArrow) {
      scene.remove(burgersArrow);
      burgersArrow.dispose();
      burgersArrow = null;
    }
    atomMeshes = [];
    bondMeshes = [];
    ghostMeshes = [];
  }

  function rebuild(resetView: boolean): void {
    disposeMeshes();
    structure = buildDefect(params.defect, {
      dim: 3,
      size: params.size,
      shellRadius: params.shell,
      tilt: params.tilt,
    });
    const { atoms, bonds } = structure;
    const col = new THREE.Color();

    // Atoms: one instanced mesh per group
    const members: Record<Group, number[]> = { bulk: [], shell: [], core: [] };
    atoms.forEach((a, i) => members[groupOf(a.role)].push(i));
    for (const g of GROUPS) {
      const list = members[g];
      const mesh = new THREE.InstancedMesh(
        sphereGeometry,
        atomMaterials[g],
        Math.max(list.length, 1)
      );
      mesh.count = list.length;
      mesh.name = g;
      list.forEach((idx, k) => {
        const a = atoms[idx]!;
        dummy.position.set(...a.pos);
        dummy.quaternion.identity();
        dummy.scale.setScalar(ATOM_RADIUS);
        dummy.updateMatrix();
        mesh.setMatrixAt(k, dummy.matrix);
        mesh.setColorAt(k, col.set(ROLE_COLORS[a.role]));
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      scene.add(mesh);
      atomMeshes.push(mesh);
    }

    // Bonds take the most prominent group of their two atoms
    const rank: Record<Group, number> = { bulk: 0, shell: 1, core: 2 };
    const bondMembers: Record<Group, [number, number][]> = { bulk: [], shell: [], core: [] };
    for (const [i, j] of bonds) {
      const gi = groupOf(atoms[i]!.role);
      const gj = groupOf(atoms[j]!.role);
      bondMembers[rank[gi] >= rank[gj] ? gi : gj].push([i, j]);
    }
    for (const g of GROUPS) {
      const list = bondMembers[g];
      const mesh = new THREE.InstancedMesh(
        bondGeometry,
        bondMaterials[g],
        Math.max(list.length, 1)
      );
      mesh.count = list.length;
      list.forEach(([i, j], k) => {
        const p = new THREE.Vector3(...atoms[i]!.pos);
        const q = new THREE.Vector3(...atoms[j]!.pos);
        const dir = q.clone().sub(p);
        dummy.position.copy(p).add(q).multiplyScalar(0.5);
        dummy.quaternion.setFromUnitVectors(up, dir.clone().normalize());
        dummy.scale.set(1, dir.length(), 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(k, dummy.matrix);
      });
      scene.add(mesh);
      bondMeshes.push(mesh);
    }

    // Vacant sites
    for (const g of structure.ghosts) {
      const m = new THREE.Mesh(sphereGeometry, ghostMaterial);
      m.position.set(...g);
      m.scale.setScalar(ATOM_RADIUS);
      scene.add(m);
      ghostMeshes.push(m);
    }

    // Dislocation line and Burgers vector
    const span = structure.n / 2 + 0.6;
    if (structure.burgers) {
      const pts = [new THREE.Vector3(0, 0, -span), new THREE.Vector3(0, 0, span)];
      lineObj = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMaterial);
      scene.add(lineObj);
      const b = new THREE.Vector3(...structure.burgers);
      const origin =
        params.defect === 'edge'
          ? new THREE.Vector3(-0.5, -span - 0.4, span)
          : new THREE.Vector3(span + 0.6, -span - 0.4, -0.5);
      burgersArrow = new THREE.ArrowHelper(b, origin, 1, BURGERS_COLOR, 0.35, 0.22);
      scene.add(burgersArrow);
    }

    boundRadius = Math.max((structure.n * Math.sqrt(3)) / 2 + 1, 3);
    sliceValue = structure.n / 2 + 0.6;
    if (resetView) setView('reset');
    applyDisplay();
    updateOverlay();
  }

  function groupOpacity(g: Group): number {
    return g === 'bulk'
      ? params.bulkOpacity
      : g === 'shell'
        ? params.shellOpacity
        : params.coreOpacity;
  }

  function applyDisplay(): void {
    const slicing = sliceSlider !== null && sliceValue < structure.n / 2 + 0.5;
    clipPlane.constant = sliceValue;
    const planes = slicing ? [clipPlane] : [];
    GROUPS.forEach((g, k) => {
      const opacity = groupOpacity(g);
      const translucent = opacity < 1;
      for (const [mesh, mat] of [
        [atomMeshes[k]!, atomMaterials[g]],
        [bondMeshes[k]!, bondMaterials[g]],
      ] as const) {
        mat.transparent = translucent;
        mat.opacity = opacity;
        mat.depthWrite = !translucent;
        mat.clippingPlanes = planes;
        mat.needsUpdate = true;
        mesh.visible = opacity > 0;
        mesh.renderOrder = k;
      }
      bondMeshes[k]!.visible = opacity > 0 && params.bonds;
    });
    ghostMaterial.clippingPlanes = planes;
    for (const m of ghostMeshes) m.visible = params.ghost;
    if (lineObj) lineObj.visible = params.line;
    if (burgersArrow) burgersArrow.visible = params.line;
  }

  function updateOverlay(): void {
    const counts: Record<Role, number> = { bulk: 0, shell: 0, core: 0, extra: 0 };
    for (const a of structure.atoms) counts[a.role]++;
    const roles: Role[] = ['bulk', 'shell', 'core'];
    if (params.defect === 'interstitial') roles.push('extra');
    const swatch = (color: string, shape = 'border-radius:50%') =>
      `<span style="display:inline-block;width:10px;height:10px;${shape};background:${color};margin-right:6px"></span>`;
    let html = `<div style="font-weight:600;margin-bottom:2px">${DEFECT_INFO[params.defect].label}</div>`;
    for (const role of roles) {
      html += `<div>${swatch(ROLE_COLORS[role])}${ROLE_LABELS[role]}: ${counts[role]}</div>`;
    }
    if (structure.ghosts.length > 0 && params.ghost) {
      html += `<div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;border:1px solid #ddd;margin-right:6px"></span>Empty lattice site</div>`;
    }
    if (structure.burgers) {
      html += `<div>${swatch(LINE_COLOR, 'height:3px;border-radius:0;vertical-align:middle')}Dislocation line</div>`;
      html += `<div>${swatch(BURGERS_COLOR, 'border-radius:0')}Burgers vector b</div>`;
    }
    overlay.innerHTML = html;
  }

  function setView(kind: 'reset' | 'z' | 'y'): void {
    const fov = (camera.fov * Math.PI) / 180;
    const dist = (boundRadius / Math.sin(fov / 2)) * 1.05;
    const dir =
      kind === 'z'
        ? new THREE.Vector3(0, 0, 1)
        : kind === 'y'
          ? new THREE.Vector3(0, 1, 1e-3).normalize()
          : new THREE.Vector3(0.9, 0.7, 1.4).normalize();
    controls.target.set(0, 0, 0);
    camera.position.copy(dir.multiplyScalar(dist));
    camera.lookAt(0, 0, 0);
    controls.update();
  }

  // --- controls ---------------------------------------------------------
  const disposables: Disposable[] = [];
  let defectSelect: SelectControl | null = null;
  let sizeSlider: SliderControl | null = null;
  let tiltSlider: SliderControl | null = null;
  let shellSlider: SliderControl | null = null;
  let bulkSlider: SliderControl | null = null;
  let shellOpSlider: SliderControl | null = null;
  let coreOpSlider: SliderControl | null = null;
  let sliceSlider: SliderControl | null = null;
  let bondsCheckbox: CheckboxControl | null = null;
  let ghostCheckbox: CheckboxControl | null = null;
  let lineCheckbox: CheckboxControl | null = null;
  let description: HTMLElement | null = null;

  function syncControls(): void {
    defectSelect?.setValue(params.defect);
    sizeSlider?.setValue(params.size);
    tiltSlider?.setValue(params.tilt);
    shellSlider?.setValue(params.shell);
    bulkSlider?.setValue(params.bulkOpacity);
    shellOpSlider?.setValue(params.shellOpacity);
    coreOpSlider?.setValue(params.coreOpacity);
    bondsCheckbox?.setChecked(params.bonds);
    ghostCheckbox?.setChecked(params.ghost);
    lineCheckbox?.setChecked(params.line);
    if (sliceSlider && structure) {
      const top = structure.n / 2 + 0.6;
      sliceSlider.element.querySelector('input')?.setAttribute('max', String(top));
      sliceSlider.setValue(sliceValue);
    }
    if (tiltSlider)
      tiltSlider.element.style.display = params.defect === 'grain-boundary' ? '' : 'none';
    if (ghostCheckbox)
      ghostCheckbox.element.style.display = params.defect === 'vacancy' ? '' : 'none';
    if (lineCheckbox) {
      lineCheckbox.element.style.display =
        params.defect === 'edge' || params.defect === 'screw' ? '' : 'none';
    }
    if (description) description.textContent = DEFECT_INFO[params.defect].description;
  }

  function onChange(rebuildNeeded: boolean, resetView = false): void {
    if (rebuildNeeded) rebuild(resetView);
    else {
      applyDisplay();
      updateOverlay();
    }
    syncControls();
    options.setParams(getParamRecord());
  }

  function getParamRecord(): Record<string, string> {
    return {
      defect: params.defect,
      size: String(params.size),
      shell: params.shell.toFixed(1),
      tilt: params.tilt.toFixed(0),
      bulkOpacity: params.bulkOpacity.toFixed(2),
      shellOpacity: params.shellOpacity.toFixed(2),
      coreOpacity: params.coreOpacity.toFixed(2),
      bonds: String(params.bonds),
      ghost: String(params.ghost),
      line: String(params.line),
    };
  }

  if (controlsPanel) {
    const defectSection = createSection({ title: 'Defect' });
    disposables.push(defectSection);

    defectSelect = createSelect({
      label: 'Defect type',
      options: TYPES_3D.map((t) => ({ value: t, label: DEFECT_INFO[t].label })),
      value: params.defect,
      onChange: (v) => {
        params.defect = v as DefectType;
        onChange(true, true);
      },
    });
    disposables.push(defectSelect);
    defectSection.content.appendChild(defectSelect.element);

    description = createHelperText(DEFECT_INFO[params.defect].description);
    defectSection.content.appendChild(description);

    sizeSlider = createSlider({
      label: 'Crystal size',
      min: 4,
      max: 12,
      step: 1,
      value: params.size,
      format: (v) => `${v.toFixed(0)}³ atoms`,
      onChange: (v) => {
        params.size = Math.round(v);
        onChange(true, true);
      },
    });
    disposables.push(sizeSlider);
    defectSection.content.appendChild(sizeSlider.element);

    tiltSlider = createSlider({
      label: 'Misorientation angle',
      min: 5,
      max: 40,
      step: 1,
      value: params.tilt,
      format: (v) => `${v.toFixed(0)}°`,
      onChange: (v) => {
        params.tilt = v;
        onChange(true);
      },
    });
    disposables.push(tiltSlider);
    defectSection.content.appendChild(tiltSlider.element);
    controlsPanel.appendChild(defectSection.element);

    const highlightSection = createSection({ title: 'Highlight & Opacity' });
    disposables.push(highlightSection);

    shellSlider = createSlider({
      label: 'Highlight radius',
      min: 1,
      max: 4,
      step: 0.5,
      value: params.shell,
      format: (v) => `${v.toFixed(1)} a`,
      onChange: (v) => {
        params.shell = v;
        onChange(true);
      },
    });
    disposables.push(shellSlider);
    highlightSection.content.appendChild(shellSlider.element);

    const opacitySlider = (
      label: string,
      get: () => number,
      set: (v: number) => void
    ): SliderControl => {
      const s = createSlider({
        label,
        min: 0,
        max: 1,
        step: 0.05,
        value: get(),
        format: (v) => `${(v * 100).toFixed(0)}%`,
        onChange: (v) => {
          set(v);
          onChange(false);
        },
      });
      disposables.push(s);
      highlightSection.content.appendChild(s.element);
      return s;
    };
    bulkSlider = opacitySlider(
      'Bulk atoms opacity',
      () => params.bulkOpacity,
      (v) => (params.bulkOpacity = v)
    );
    shellOpSlider = opacitySlider(
      'Nearby atoms opacity',
      () => params.shellOpacity,
      (v) => (params.shellOpacity = v)
    );
    coreOpSlider = opacitySlider(
      'Core atoms opacity',
      () => params.coreOpacity,
      (v) => (params.coreOpacity = v)
    );
    controlsPanel.appendChild(highlightSection.element);

    const viewSection = createSection({ title: 'Display & View' });
    disposables.push(viewSection);

    bondsCheckbox = createCheckbox({
      label: 'Show bonds',
      checked: params.bonds,
      onChange: (checked) => {
        params.bonds = checked;
        onChange(false);
      },
    });
    disposables.push(bondsCheckbox);
    viewSection.content.appendChild(bondsCheckbox.element);

    ghostCheckbox = createCheckbox({
      label: 'Show empty lattice site',
      checked: params.ghost,
      onChange: (checked) => {
        params.ghost = checked;
        onChange(false);
      },
    });
    disposables.push(ghostCheckbox);
    viewSection.content.appendChild(ghostCheckbox.element);

    lineCheckbox = createCheckbox({
      label: 'Show dislocation line & b',
      checked: params.line,
      onChange: (checked) => {
        params.line = checked;
        onChange(false);
      },
    });
    disposables.push(lineCheckbox);
    viewSection.content.appendChild(lineCheckbox.element);

    sliceSlider = createSlider({
      label: 'Slice (hide atoms above)',
      min: -6,
      max: 12,
      step: 0.5,
      value: 12,
      format: (v) => (!structure || v >= structure.n / 2 + 0.5 ? 'off' : `z = ${v.toFixed(1)}`),
      onChange: (v) => {
        sliceValue = v;
        applyDisplay();
      },
    });
    disposables.push(sliceSlider);
    viewSection.content.appendChild(sliceSlider.element);

    const buttonRow = document.createElement('div');
    buttonRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    const addButton = (label: string, kind: 'reset' | 'z' | 'y') => {
      const b = createButton({ label, variant: 'secondary', onClick: () => setView(kind) });
      disposables.push(b);
      buttonRow.appendChild(b.element);
    };
    addButton('Reset view', 'reset');
    addButton('Along z', 'z');
    addButton('Along y', 'y');
    viewSection.content.appendChild(buttonRow);
    controlsPanel.appendChild(viewSection.element);
  }

  // --- resize / lifecycle -------------------------------------------------
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

  const loop = new AnimationLoop(() => {
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
      controls.dispose();
      disposeMeshes();
      sphereGeometry.dispose();
      bondGeometry.dispose();
      for (const g of GROUPS) {
        atomMaterials[g].dispose();
        bondMaterials[g].dispose();
      }
      ghostMaterial.dispose();
      lineMaterial.dispose();
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

export const defects3DDemo: DemoDefinition = {
  id: 'defects-3d',
  title: 'Crystal Defects in 3D',
  description:
    'Vacancy, self-interstitial, edge and screw dislocations and a grain boundary in a simple cubic crystal. Atoms around each defect are coloured, and their opacity can be adjusted to look inside.',
  category: 'Crystallography',
  tags: ['defects', 'vacancy', 'interstitial', 'dislocation', 'grain boundary', 'crystal'],
  create,
};

export default defects3DDemo;
