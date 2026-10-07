/**
 * Elastic and Plastic Deformation of an Atomic Bar
 *
 * A bar of close-packed atoms (a 2D triangular layer, or a 3D hcp crystal)
 * interacting through Lennard-Jones pair forces. The left end is fixed and the
 * right end is pulled; every bond is coloured by how much it is stretched
 * (red) or compressed (blue). The measured force is plotted next to the bar.
 *
 * Elastic mode: small strains, the curve retraces itself when the bar is released.
 * Plastic mode: pull (and shear) until the bar flows and fractures.
 *
 * Rotating the crystal relative to the pulling direction shows how the response
 * depends on direction. Units are reduced LJ units (epsilon = sigma = mass = 1).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import { Plot2D } from '@core/canvas/Plot2D';
import {
  createSlider,
  createSelect,
  createCheckbox,
  createButton,
  type Disposable,
  type SliderControl,
  type SelectControl,
  type CheckboxControl,
  type ButtonControl,
} from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import { Bar, DT, SIZE_COUNT, type Command, type Dim } from './elasticPlastic';

type Mode = 'elastic' | 'plastic';
/** Strain control moves the grip and measures the force; stress control applies a force and measures the strain */
type Control = 'strain' | 'stress';

interface DemoParams {
  mode: Mode;
  control: Control;
  dim: Dim;
  /** Angle between the pulling direction and the close-packed rows (deg) */
  angle: number;
  /** 3D: tilt of the hcp c-axis towards the pulling direction (deg) */
  tilt: number;
  /** Temperature (reduced units) */
  T: number;
  /** log10 of the strain rate (per unit time) */
  logRate: number;
  /** Plastic mode: transverse displacement of the pulled end, in gauge lengths */
  shear: number;
  notch: boolean;
  /** Bar size, 0 to SIZE_COUNT - 1 */
  size: number;
  bonds: boolean;
  ghost: boolean;
}

const defaultParams: DemoParams = {
  mode: 'elastic',
  control: 'strain',
  dim: 2,
  angle: 0,
  tilt: 0,
  T: 0.02,
  logRate: -2.4,
  shear: 0,
  notch: false,
  size: 1,
  bonds: true,
  ghost: true,
};

/** Largest applied strain in each mode */
const MAX_STRAIN: Record<Mode, number> = { elastic: 0.05, plastic: 0.75 };
const MAX_SHEAR = 0.3;
/** Largest applied stress in stress control (above the strength in plastic mode, so the bar runs away) */
const MAX_STRESS: Record<Mode, number> = { elastic: 2.2, plastic: 4 };
/** Stress-control loading rate is this many times the strain rate (about the modulus / 4) */
const STRESS_PER_STRAIN = 20;
/** Bond colour scale: strain that saturates red (stretch) and blue (compression) */
const COLOR_RANGE: Record<Mode, { pos: number; neg: number }> = {
  elastic: { pos: 0.06, neg: 0.03 },
  plastic: { pos: 0.25, neg: 0.08 },
};
const MAX_STEPS_PER_FRAME: Record<Dim, number> = { 2: 40, 3: 16 };
/** Rough cost of one time step per neighbour-list pair (ms), used to keep frames fast */
const MS_PER_PAIR_STEP = 7.6e-6;
const FRAME_BUDGET_MS = 8;
const SIZE_LABELS = [
  'Small (250 / 410)',
  'Medium (620 / 980)',
  'Large (1160 / 1950)',
  'Very large (2190 / 3360)',
];
const FIT_STRAIN = 0.02;

const COLOR_LOAD = '#ff6b6b';
const COLOR_UNLOAD = '#38bdf8';
const STORED_COLORS = ['#a3e635', '#c084fc', '#2dd4bf', '#fb923c'];
const COLOR_GRIP = '#8b93a1';
const COLOR_BULK = '#6ea8fe';
const COLOR_SURFACE = '#ffc078';
const BOND_NEUTRAL: [number, number, number] = [122, 127, 138];
const BOND_STRETCH: [number, number, number] = [255, 59, 48];
const BOND_COMPRESS: [number, number, number] = [59, 130, 246];
const PALETTE_SIZE = 32;

function num(v: string | undefined, lo: number, hi: number, fallback: number): number {
  const x = v === undefined ? NaN : parseFloat(v);
  return clamp(Number.isFinite(x) ? x : fallback, lo, hi);
}

function parseParams(src: Record<string, string>, params: DemoParams): void {
  if (src.mode === 'elastic' || src.mode === 'plastic') params.mode = src.mode;
  if (src.control === 'strain' || src.control === 'stress') params.control = src.control;
  if (src.dim === '2' || src.dim === '3') params.dim = src.dim === '3' ? 3 : 2;
  params.angle = Math.round(num(src.angle, 0, 90, params.angle));
  params.tilt = Math.round(num(src.tilt, 0, 90, params.tilt));
  params.T = num(src.T, 0, 0.3, params.T);
  params.logRate = num(src.logRate, -3.3, -1.5, params.logRate);
  params.shear = num(src.shear, -MAX_SHEAR, MAX_SHEAR, params.shear);
  if (src.notch !== undefined) params.notch = src.notch === 'true';
  params.size = Math.round(num(src.size, 0, SIZE_COUNT - 1, params.size));
  if (src.bonds !== undefined) params.bonds = src.bonds === 'true';
  if (src.ghost !== undefined) params.ghost = src.ghost === 'true';
}

function mix(a: number[], b: number[], t: number): string {
  const c = a.map((v, i) => Math.round(v + (b[i]! - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** Bond colours from blue (compressed) through grey to red (stretched) */
const PALETTE_CSS: string[] = [];
for (let k = -PALETTE_SIZE; k <= PALETTE_SIZE; k++) {
  const t = Math.abs(k) / PALETTE_SIZE;
  PALETTE_CSS.push(mix(BOND_NEUTRAL, k >= 0 ? BOND_STRETCH : BOND_COMPRESS, t));
}

function paletteIndex(strain: number, range: { pos: number; neg: number }): number {
  const t = strain >= 0 ? strain / range.pos : strain / range.neg;
  return Math.round(clamp(t, -1, 1) * PALETTE_SIZE) + PALETTE_SIZE;
}

interface Sample {
  strain: number;
  stress: number;
  unloading: boolean;
}

interface StoredCurve {
  label: string;
  color: string;
  strain: number[];
  stress: number[];
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  const params: DemoParams = { ...defaultParams };
  parseParams(options.getParams(), params);

  // --- layout: atom view on the left, plot on the right ------------------
  container.style.display = 'flex';
  const viewPane = document.createElement('div');
  viewPane.style.cssText = 'position:relative;flex:1 1 0;min-width:0;height:100%;overflow:hidden;';
  const plotPane = document.createElement('div');
  plotPane.style.cssText =
    'position:relative;flex:0 0 42%;min-width:0;height:100%;overflow:hidden;border-left:1px solid #222;';
  container.appendChild(viewPane);
  container.appendChild(plotPane);

  const view2d = new HiDPICanvas(viewPane, { backgroundColor: '#0a0a0a', autoResize: true });
  const plotCanvas = new HiDPICanvas(plotPane, { backgroundColor: '#0a0a0a', autoResize: true });
  for (const c of [view2d.canvas, plotCanvas.canvas]) {
    c.style.position = 'absolute';
    c.style.top = '0';
    c.style.left = '0';
  }
  const plot = new Plot2D(plotCanvas.ctx, {
    bounds: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
    margins: { top: 44, right: 18, bottom: 48, left: 62 },
  });

  const overlayCss =
    'position:absolute;color:#ddd;font:13px -apple-system,BlinkMacSystemFont,sans-serif;' +
    'line-height:1.45;pointer-events:none;text-shadow:0 1px 2px #000;';
  const info = document.createElement('div');
  info.style.cssText = overlayCss + 'top:8px;left:10px;';
  viewPane.appendChild(info);
  const legend = document.createElement('div');
  legend.style.cssText = overlayCss + 'bottom:8px;left:10px;font-size:12px;color:#aaa;';
  viewPane.appendChild(legend);

  // --- state --------------------------------------------------------------
  let seed = 1;
  let bar: Bar = newBar();
  let samples: Sample[] = [{ strain: 0, stress: 0, unloading: false }];
  let stored: StoredCurve[] = [];
  let targetStrain = 0;
  let targetStress = 0;
  let appliedStress = 0;
  /** Strain control, after a release: the grip is free (no external force) */
  let gripFree = false;
  let freeFrames = 0;
  let pendingSet = false;
  let strainLimit = false;
  let tempTimer: number | undefined;
  let pulling = false;
  let releasing = false;
  let fractured = false;
  let fractureStrain = 0;
  let permanentSet: number | null = null;
  let frame = 0;
  let cn: Uint8Array = bar.coordination();
  let yTop = 1;
  let yBottom = 0;
  let lastUx = 0;
  let releaseFrames = 0;
  let ramp = 0;

  let modeSelect: SelectControl | null = null;
  let dimSelect: SelectControl | null = null;
  let sizeSelect: SelectControl | null = null;
  let angleSlider: SliderControl | null = null;
  let tiltSlider: SliderControl | null = null;
  let tempSlider: SliderControl | null = null;
  let strainSlider: SliderControl | null = null;
  let stressSlider: SliderControl | null = null;
  let controlSelect: SelectControl | null = null;
  let rateSlider: SliderControl | null = null;
  let shearSlider: SliderControl | null = null;
  let notchCheckbox: CheckboxControl | null = null;
  let bondsCheckbox: CheckboxControl | null = null;
  let ghostCheckbox: CheckboxControl | null = null;
  let pullButton: ButtonControl | null = null;
  let tiltBox: HTMLElement | null = null;
  let shearBox: HTMLElement | null = null;
  let notchBox: HTMLElement | null = null;
  const disposables: Disposable[] = [];

  function newBar(): Bar {
    return new Bar({
      dim: params.dim,
      angle: params.angle,
      tilt: params.tilt,
      notch: params.mode === 'plastic' && params.notch,
      size: params.size,
      temperature: params.T,
      seed,
    });
  }

  const maxStrain = () => MAX_STRAIN[params.mode];
  const shearTarget = () => (params.mode === 'plastic' ? params.shear : 0);
  const elastic = () => params.mode === 'elastic';

  // --- three.js (created the first time the 3D view is needed) -------------
  interface Scene3D {
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    atoms: THREE.InstancedMesh | null;
    bonds: THREE.InstancedMesh | null;
    sphere: THREE.SphereGeometry;
    cylinder: THREE.CylinderGeometry;
    atomMaterial: THREE.MeshStandardMaterial;
    bondMaterial: THREE.MeshStandardMaterial;
    bondCapacity: number;
    paletteColors: THREE.Color[];
    gripColor: THREE.Color;
    bulkColor: THREE.Color;
    surfaceColor: THREE.Color;
  }
  let three: Scene3D | null = null;
  const dummy = new THREE.Object3D();
  const up = new THREE.Vector3(0, 1, 0);
  const vp = new THREE.Vector3();
  const vq = new THREE.Vector3();
  const vd = new THREE.Vector3();

  function ensureThree(): Scene3D {
    if (three) return three;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setClearColor('#0a0a0a');
    renderer.domElement.style.cssText = 'position:absolute;top:0;left:0;display:none;';
    viewPane.insertBefore(renderer.domElement, info);
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
    three = {
      renderer,
      scene,
      camera,
      controls,
      atoms: null,
      bonds: null,
      sphere: new THREE.SphereGeometry(1, 20, 14),
      cylinder: new THREE.CylinderGeometry(1, 1, 1, 8, 1),
      atomMaterial: new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 }),
      bondMaterial: new THREE.MeshStandardMaterial({ roughness: 0.5 }),
      bondCapacity: 0,
      paletteColors: PALETTE_CSS.map((c) => new THREE.Color(c)),
      gripColor: new THREE.Color(COLOR_GRIP),
      bulkColor: new THREE.Color(COLOR_BULK),
      surfaceColor: new THREE.Color(COLOR_SURFACE),
    };
    return three;
  }

  function resetCamera(): void {
    if (!three) return;
    const target = new THREE.Vector3(bar.lx * 0.55, bar.ly / 2, bar.lz / 2);
    three.controls.target.copy(target);
    three.camera.position.copy(target).add(new THREE.Vector3(0, 0.3 * bar.lx, 2.4 * bar.lx));
    three.controls.update();
  }

  function rebuildMeshes3D(): void {
    const t = ensureThree();
    for (const m of [t.atoms, t.bonds]) {
      if (m) {
        t.scene.remove(m);
        m.dispose();
      }
    }
    t.atoms = new THREE.InstancedMesh(t.sphere, t.atomMaterial, bar.n);
    t.bondCapacity = Math.ceil(bar.bonds().length * 1.3) + 200;
    t.bonds = new THREE.InstancedMesh(t.cylinder, t.bondMaterial, t.bondCapacity);
    t.atoms.frustumCulled = false;
    t.bonds.frustumCulled = false;
    t.scene.add(t.atoms);
    t.scene.add(t.bonds);
  }

  // --- simulation control ---------------------------------------------------
  function rebuild(): void {
    bar = newBar();
    cn = bar.coordination();
    samples = [{ strain: 0, stress: 0, unloading: false }];
    targetStrain = 0;
    targetStress = 0;
    appliedStress = 0;
    gripFree = false;
    freeFrames = 0;
    pendingSet = false;
    strainLimit = false;
    pulling = false;
    releasing = false;
    releaseFrames = 0;
    fractured = false;
    fractureStrain = 0;
    permanentSet = null;
    lastUx = 0;
    resetAxis();
    if (params.dim === 3) {
      rebuildMeshes3D();
      resetCamera();
    }
    pullButton?.setLabel('Pull');
    strainSlider?.setValue(0);
    stressSlider?.setValue(0);
    updateVisibility();
    updateLegend();
    render();
  }

  function resetAxis(): void {
    yTop = elastic() ? 1.2 * bar.area : 1.2;
    yBottom = 0;
  }

  function stopPulling(): void {
    pulling = false;
    pullButton?.setLabel('Pull');
  }

  function stepFrame(): void {
    const steps = clamp(
      Math.floor(FRAME_BUDGET_MS / (bar.pairs.i.length * MS_PER_PAIR_STEP)),
      4,
      MAX_STEPS_PER_FRAME[params.dim]
    );
    const dtFrame = steps * DT;
    const rate = Math.pow(10, params.logRate);
    const maxS = maxStrain();

    // Ease into the motion, so starting does not send a shock wave through the bar
    ramp = releasing || (pulling && !fractured) ? Math.min(1, ramp + dtFrame / 3) : 0;

    const uy = shearTarget() * bar.gauge;
    const speed = 2 * rate * bar.gauge;
    const stressControl = params.control === 'stress';
    const lastApplied = appliedStress;
    let cmd: Command;

    if (stressControl) {
      const maxSigma = MAX_STRESS[params.mode];
      const stressRate = rate * STRESS_PER_STRAIN;
      if (releasing) {
        targetStress = Math.max(0, targetStress - stressRate * ramp * dtFrame);
      } else if (pulling && !fractured) {
        targetStress = Math.min(maxSigma, targetStress + stressRate * ramp * dtFrame);
        if (targetStress >= maxSigma) stopPulling();
      }
      const d = targetStress - appliedStress;
      const maxD = 2 * stressRate * dtFrame;
      appliedStress += Math.abs(d) <= maxD ? d : Math.sign(d) * maxD;
      if (releasing && appliedStress <= 1e-9) {
        releasing = false;
        pendingSet = true;
        freeFrames = 0;
      }
      cmd = { mode: 'force', force: appliedStress * bar.area, uy, speed, maxUx: maxS * bar.gauge };
    } else if (gripFree) {
      cmd = { mode: 'force', force: 0, uy, speed, maxUx: maxS * bar.gauge };
    } else {
      if (releasing) {
        targetStrain = Math.max(0, bar.strain - rate * ramp * dtFrame);
        releaseFrames = bar.stress <= 0.04 ? releaseFrames + 1 : 0;
        if (bar.strain <= 0.0005 || releaseFrames >= 6) {
          // no external force any more: let go of the grip
          releasing = false;
          gripFree = true;
          pendingSet = true;
          freeFrames = 0;
          targetStrain = bar.strain;
          strainSlider?.setValue(clamp(targetStrain / maxS, 0, 1));
        }
      } else if (pulling && !fractured) {
        targetStrain = Math.min(maxS, targetStrain + rate * ramp * dtFrame);
        if (targetStrain >= maxS) stopPulling();
      }
      cmd = { mode: 'displacement', ux: targetStrain * bar.gauge, uy, speed };
    }
    if (fractured && pulling) stopPulling();

    bar.temperature = params.T;
    bar.advance(steps, cmd);
    frame++;
    if (stressControl) {
      if (pulling || releasing)
        stressSlider?.setValue(clamp(targetStress / MAX_STRESS[params.mode], 0, 1));
      if (bar.ux >= maxS * bar.gauge - 1e-6 && pulling) {
        // strain limit of the demo reached while still being pulled
        strainLimit = true;
        stopPulling();
      }
    } else if (gripFree) {
      strainSlider?.setValue(clamp(bar.strain / maxS, 0, 1));
    } else if (pulling || releasing) {
      strainSlider?.setValue(clamp(targetStrain / maxS, 0, 1));
    }

    // Permanent set: strain left once the bar has settled with no external force
    const unloadedFree = gripFree || (stressControl && appliedStress <= 1e-9 && !pulling);
    if (pendingSet && unloadedFree) {
      freeFrames++;
      if (freeFrames >= 60) {
        permanentSet = Math.max(0, bar.strainSmooth);
        pendingSet = false;
      }
    }

    // Record the curve
    const last = samples[samples.length - 1];
    let unloading = last?.unloading ?? false;
    if (stressControl) {
      if (appliedStress > lastApplied + 1e-9) unloading = false;
      else if (appliedStress < lastApplied - 1e-9) unloading = true;
    } else if (!gripFree) {
      if (bar.ux < lastUx - 1e-9) unloading = true;
      else if (bar.ux > lastUx + 1e-9) unloading = false;
    }
    lastUx = bar.ux;
    if (fractured) {
      // the curve ends at fracture
    } else if (!last || Math.abs(bar.strainSmooth - last.strain) > 0.001) {
      samples.push({ strain: bar.strainSmooth, stress: bar.stress, unloading });
    } else if (samples.length > 1) {
      last.stress = bar.stress;
    }

    if (frame % 4 === 0) cn = bar.coordination();
    if (!fractured && frame % 8 === 0 && !bar.isConnected()) {
      fractured = true;
      fractureStrain = bar.strain;
      stopPulling();
      releasing = false;
      targetStress = 0;
      appliedStress = 0;
      samples.push({ strain: bar.strain, stress: 0, unloading: false });
    }
  }

  /** Elastic constant from the initial loading slope (through the origin) */
  function fitModulus(): number | null {
    let sxy = 0;
    let sxx = 0;
    let n = 0;
    for (const s of samples) {
      if (s.unloading || s.strain <= 0.001 || s.strain > FIT_STRAIN) continue;
      sxy += s.strain * s.stress;
      sxx += s.strain * s.strain;
      n++;
    }
    return n >= 3 && sxx > 0 ? sxy / sxx : null;
  }

  // --- rendering ---------------------------------------------------------------
  function render(): void {
    if (params.dim === 2) renderView2D();
    else renderView3D();
    renderPlot();
    updateInfo();
  }

  function renderView2D(): void {
    const ctx = view2d.ctx;
    const w = view2d.width;
    const h = view2d.height;
    view2d.clear();
    if (w === 0 || h === 0) return;
    const shearSpan = Math.abs(shearTarget()) * bar.gauge;
    const worldW = bar.lx * (1 + maxStrain()) + 3;
    const worldH = bar.ly + 2 * shearSpan + 3;
    const s = Math.min((w - 20) / worldW, (h - 90) / worldH);
    const ox = 10 + 1.2 * s;
    const oy = h / 2 + 10 + (bar.ly / 2) * s;
    const X = (x: number) => ox + x * s;
    const Y = (y: number) => oy - y * s;
    const { pos, ref, role } = bar;

    // Undeformed positions
    if (params.ghost) {
      ctx.strokeStyle = 'rgba(200,200,200,0.22)';
      ctx.lineWidth = 1;
      const r = 0.42 * bar.a * s;
      ctx.beginPath();
      for (let i = 0; i < bar.n; i++) {
        const x = X(ref[3 * i]!);
        const y = Y(ref[3 * i + 1]!);
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, Math.PI * 2);
      }
      ctx.stroke();
    }

    // Bonds
    if (params.bonds) {
      const range = COLOR_RANGE[params.mode];
      ctx.lineWidth = Math.max(2, 0.2 * bar.a * s);
      ctx.lineCap = 'round';
      for (const b of bar.bonds()) {
        ctx.strokeStyle = PALETTE_CSS[paletteIndex(b.strain, range)]!;
        ctx.beginPath();
        ctx.moveTo(X(pos[3 * b.i]!), Y(pos[3 * b.i + 1]!));
        ctx.lineTo(X(pos[3 * b.j]!), Y(pos[3 * b.j + 1]!));
        ctx.stroke();
      }
    }

    // Atoms
    const full = 6;
    const r = (params.bonds ? 0.3 : 0.45) * bar.a * s;
    for (let i = 0; i < bar.n; i++) {
      ctx.fillStyle = role[i] !== 0 ? COLOR_GRIP : cn[i]! >= full ? COLOR_BULK : COLOR_SURFACE;
      ctx.beginPath();
      ctx.arc(X(pos[3 * i]!), Y(pos[3 * i + 1]!), r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Grip labels and force arrow
    ctx.fillStyle = '#9aa';
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('fixed grip', X(0), oy + 0.6 * bar.a * s + 6);
    ctx.textAlign = 'right';
    ctx.fillText('pulled grip', X(bar.lx + bar.ux + 0.5 * bar.a), Y(bar.uy) + 0.6 * bar.a * s + 6);
    const fx = bar.lx + bar.ux + 0.9;
    const arrow = clamp(bar.forceSmooth / (3 * bar.area), 0, 1) * 70;
    if (arrow > 4) {
      const ay = Y(bar.ly / 2 + bar.uy);
      ctx.strokeStyle = '#ff6b6b';
      ctx.fillStyle = '#ff6b6b';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(X(fx), ay);
      ctx.lineTo(X(fx) + arrow, ay);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(X(fx) + arrow + 10, ay);
      ctx.lineTo(X(fx) + arrow, ay - 6);
      ctx.lineTo(X(fx) + arrow, ay + 6);
      ctx.closePath();
      ctx.fill();
    }
  }

  function renderView3D(): void {
    const t = three;
    if (!t || !t.atoms || !t.bonds) return;
    const { pos, role } = bar;
    const full = 12;
    const atomR = 0.24 * bar.a;
    for (let i = 0; i < bar.n; i++) {
      dummy.position.set(pos[3 * i]!, pos[3 * i + 1]!, pos[3 * i + 2]);
      dummy.quaternion.identity();
      dummy.scale.setScalar(atomR);
      dummy.updateMatrix();
      t.atoms.setMatrixAt(i, dummy.matrix);
      t.atoms.setColorAt(
        i,
        role[i] !== 0 ? t.gripColor : cn[i]! >= full ? t.bulkColor : t.surfaceColor
      );
    }
    t.atoms.instanceMatrix.needsUpdate = true;
    if (t.atoms.instanceColor) t.atoms.instanceColor.needsUpdate = true;

    const bonds = params.bonds ? bar.bonds() : [];
    const range = COLOR_RANGE[params.mode];
    const count = Math.min(bonds.length, t.bondCapacity);
    const bondR = 0.09 * bar.a;
    for (let k = 0; k < count; k++) {
      const b = bonds[k]!;
      vp.set(pos[3 * b.i]!, pos[3 * b.i + 1]!, pos[3 * b.i + 2]);
      vq.set(pos[3 * b.j]!, pos[3 * b.j + 1]!, pos[3 * b.j + 2]);
      vd.copy(vq).sub(vp);
      const len = vd.length();
      dummy.position.copy(vp).add(vq).multiplyScalar(0.5);
      dummy.quaternion.setFromUnitVectors(up, vd.multiplyScalar(1 / len));
      dummy.scale.set(bondR, len, bondR);
      dummy.updateMatrix();
      t.bonds.setMatrixAt(k, dummy.matrix);
      t.bonds.setColorAt(k, t.paletteColors[paletteIndex(b.strain, range)]!);
    }
    t.bonds.count = count;
    t.bonds.instanceMatrix.needsUpdate = true;
    if (t.bonds.instanceColor) t.bonds.instanceColor.needsUpdate = true;

    t.controls.update();
    t.renderer.render(t.scene, t.camera);
  }

  /** Curve point in plot coordinates */
  function toPlot(strain: number, stress: number): [number, number] {
    return elastic() ? [strain * bar.gauge, stress * bar.area] : [strain, stress];
  }

  function renderPlot(): void {
    const ctx = plotCanvas.ctx;
    const w = plotCanvas.width;
    const h = plotCanvas.height;
    plotCanvas.clear();
    if (w === 0 || h === 0) return;

    // y range only grows, so the curve does not jump around
    for (const s of samples) {
      const y = toPlot(s.strain, s.stress)[1];
      yTop = Math.max(yTop, y * 1.12);
      yBottom = Math.min(yBottom, y * 1.12);
    }
    const xMax = elastic() ? maxStrain() * bar.gauge : maxStrain();
    plot.setSize(w, h);
    plot.setBounds({ xMin: 0, xMax, yMin: yBottom, yMax: yTop });
    const xTicks = Plot2D.generateTicks(0, xMax, 5);
    const yTicks = Plot2D.generateTicks(yBottom, yTop, 5);
    plot.drawGrid(xTicks, yTicks);
    const stressUnit = params.dim === 2 ? 'ε/σ²' : 'ε/σ³';
    plot.drawAxes(
      elastic() ? 'Elongation Δ (σ)' : 'Strain ε',
      elastic() ? 'Force F (ε/σ)' : `Stress (${stressUnit})`
    );
    plot.drawTickLabels(
      xTicks,
      yTicks,
      elastic() ? (v) => v.toFixed(1) : (v) => (v * 100).toFixed(0) + '%',
      (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1))
    );

    ctx.save();
    ctx.font = '600 13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = '#ddd';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(elastic() ? 'Force vs. elongation' : 'Stress–strain curve', 14, 10);

    // Legend
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    const items: [string, string][] = [
      [COLOR_LOAD, 'loading'],
      [COLOR_UNLOAD, 'unloading'],
      ...stored.map((c): [string, string] => [c.color, c.label]),
    ];
    let lx = 14;
    for (const [color, label] of items) {
      ctx.fillStyle = color;
      ctx.fillRect(lx, 29, 12, 3);
      ctx.fillStyle = '#aaa';
      ctx.fillText(label, lx + 16, 24);
      lx += 24 + ctx.measureText(label).width;
    }

    // Curves, clipped to the plot area
    const left = plot.toCanvasX(0);
    const right = plot.toCanvasX(xMax);
    const topY = plot.toCanvasY(yTop);
    const bottomY = plot.toCanvasY(yBottom);
    ctx.beginPath();
    ctx.rect(left, topY, right - left, bottomY - topY);
    ctx.clip();

    // Initial elastic slope
    const modulus = fitModulus();
    if (modulus !== null) {
      const slope = elastic() ? (modulus * bar.area) / bar.gauge : modulus;
      const xEnd = Math.min(xMax, yTop / slope);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(plot.toCanvasX(0), plot.toCanvasY(0));
      ctx.lineTo(plot.toCanvasX(xEnd), plot.toCanvasY(slope * xEnd));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const c of stored) {
      const xs = c.strain.map((e, i) => toPlot(e, c.stress[i]!)[0]);
      const ys = c.strain.map((e, i) => toPlot(e, c.stress[i]!)[1]);
      plot.drawLine(xs, ys, c.color, 1.8);
    }

    // Current curve, split into loading / unloading runs
    let run: number[][] = [];
    let runUnloading = false;
    const flush = () => {
      if (run.length > 1) {
        plot.drawLine(
          run.map((p) => p[0]!),
          run.map((p) => p[1]!),
          runUnloading ? COLOR_UNLOAD : COLOR_LOAD,
          2.2
        );
      }
    };
    samples.forEach((s, i) => {
      const p = toPlot(s.strain, s.stress);
      if (i > 0 && s.unloading !== runUnloading) {
        const prev = run[run.length - 1];
        flush();
        run = prev ? [prev] : [];
      }
      runUnloading = s.unloading;
      run.push(p);
    });
    flush();

    // Peak, live point
    let peak = -1;
    let peakIdx = -1;
    samples.forEach((s, i) => {
      if (!s.unloading && s.stress > peak) {
        peak = s.stress;
        peakIdx = i;
      }
    });
    const lastSample = samples[samples.length - 1];
    const showPeak =
      peakIdx >= 0 &&
      peak > 0.3 &&
      samples.slice(peakIdx + 1).some((s) => !s.unloading && s.stress < 0.85 * peak);
    if (showPeak) {
      const [px, py] = toPlot(samples[peakIdx]!.strain, peak);
      plot.drawPoint(px, py, 4, '#ffffff');
    }
    const [lx2, ly2] = toPlot(bar.strainSmooth, fractured ? 0 : bar.stress);
    plot.drawPoint(lx2, ly2, 5, releasing || lastSample?.unloading ? COLOR_UNLOAD : COLOR_LOAD);
    ctx.restore();

    if (showPeak) {
      const [px, py] = toPlot(samples[peakIdx]!.strain, peak);
      ctx.save();
      ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = '#ddd';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText('maximum', plot.toCanvasX(px) + 7, plot.toCanvasY(py) - 3);
      ctx.restore();
    }

    if (fractured) {
      ctx.save();
      ctx.font = '600 13px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = '#ff6b6b';
      ctx.textAlign = 'center';
      const [fx2] = toPlot(fractureStrain, 0);
      ctx.fillText('fracture', plot.toCanvasX(fx2), plot.toCanvasY(0) - 10);
      ctx.restore();
    }
  }

  function updateInfo(): void {
    const E = fitModulus();
    const lines: string[] = [];
    const unit = params.dim === 2 ? 'ε/σ²' : 'ε/σ³';
    lines.push(
      `<b>${params.dim === 2 ? '2D close-packed layer' : '3D hcp crystal'}</b> · ${bar.n} atoms · pull at ${params.angle}° to the close-packed rows${params.dim === 3 ? `, c-axis tilt ${params.tilt}°` : ''}`
    );
    const stress = fractured ? 0 : bar.stress;
    if (params.control === 'stress') {
      lines.push(
        `Applied stress = ${stress.toFixed(2)} ${unit} (F = ${(stress * bar.area).toFixed(1)} ε/σ) → strain ε = ${(bar.strain * 100).toFixed(1)} % (Δ = ${bar.ux.toFixed(2)} σ)`
      );
    } else {
      lines.push(
        `Strain ε = ${(bar.strain * 100).toFixed(1)} % (Δ = ${bar.ux.toFixed(2)} σ) · ` +
          (gripFree
            ? 'grip released: no external force, stress = 0'
            : `measured F = ${(stress * bar.area).toFixed(1)} ε/σ · stress = ${stress.toFixed(2)} ${unit}`)
      );
    }
    if (strainLimit) lines.push('Strain limit of the demo reached: the bar is still being pulled.');
    if (E !== null) {
      lines.push(
        elastic()
          ? `Stiffness k = dF/dΔ ≈ ${((E * bar.area) / bar.gauge).toFixed(2)} ε/σ²`
          : `Modulus E ≈ ${E.toFixed(0)} ${unit}`
      );
    }
    if (permanentSet !== null) {
      lines.push(
        `After release: permanent set = ${(permanentSet * 100).toFixed(1)} %` +
          (permanentSet < 0.004 ? ' (fully elastic)' : ' (plastic deformation)')
      );
    }
    if (fractured)
      lines.push(
        `<span style="color:#ff6b6b">Fractured at ε = ${(fractureStrain * 100).toFixed(0)} %</span>`
      );
    info.innerHTML = lines.join('<br>');
  }

  function updateLegend(): void {
    const range = COLOR_RANGE[params.mode];
    const swatch = (color: string) =>
      `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:5px"></span>`;
    const gradient = `linear-gradient(to right, ${PALETTE_CSS[0]}, ${PALETTE_CSS[PALETTE_SIZE]}, ${PALETTE_CSS[2 * PALETTE_SIZE]})`;
    legend.innerHTML =
      `<div>${swatch(COLOR_GRIP)}grip &nbsp; ${swatch(COLOR_BULK)}fully coordinated &nbsp; ${swatch(COLOR_SURFACE)}surface / defect</div>` +
      `<div style="display:flex;align-items:center;gap:6px;margin-top:3px"><span>−${(range.neg * 100).toFixed(0)} %</span>` +
      `<span style="display:inline-block;width:130px;height:8px;border-radius:4px;background:${gradient}"></span>` +
      `<span>+${(range.pos * 100).toFixed(0)} %</span><span>&nbsp;bond length change</span></div>`;
  }

  // --- controls -------------------------------------------------------------
  function getParamRecord(): Record<string, string> {
    return {
      mode: params.mode,
      control: params.control,
      dim: String(params.dim),
      angle: String(params.angle),
      tilt: String(params.tilt),
      T: params.T.toFixed(3),
      logRate: params.logRate.toFixed(2),
      shear: params.shear.toFixed(2),
      size: String(params.size),
      notch: String(params.notch),
      bonds: String(params.bonds),
      ghost: String(params.ghost),
    };
  }

  function onChange(): void {
    options.setParams(getParamRecord());
  }

  function updateVisibility(): void {
    const show = (el: HTMLElement | null, on: boolean) => {
      if (el) el.style.display = on ? '' : 'none';
    };
    show(tiltBox, params.dim === 3);
    show(strainSlider?.element ?? null, params.control === 'strain');
    show(stressSlider?.element ?? null, params.control === 'stress');
    show(shearBox, params.mode === 'plastic');
    show(notchBox, params.mode === 'plastic');
    view2d.canvas.style.display = params.dim === 2 ? 'block' : 'none';
    if (three) three.renderer.domElement.style.display = params.dim === 3 ? 'block' : 'none';
    if (params.dim === 3) ensureThree().renderer.domElement.style.display = 'block';
    handleResize();
  }

  function syncControls(): void {
    modeSelect?.setValue(params.mode);
    controlSelect?.setValue(params.control);
    dimSelect?.setValue(String(params.dim));
    sizeSelect?.setValue(String(params.size));
    angleSlider?.setValue(params.angle);
    tiltSlider?.setValue(params.tilt);
    tempSlider?.setValue(params.T);
    rateSlider?.setValue(params.logRate);
    shearSlider?.setValue(params.shear);
    notchCheckbox?.setChecked(params.notch);
    bondsCheckbox?.setChecked(params.bonds);
    ghostCheckbox?.setChecked(params.ghost);
    strainSlider?.setValue(clamp(targetStrain / maxStrain(), 0, 1));
    stressSlider?.setValue(clamp(targetStress / MAX_STRESS[params.mode], 0, 1));
  }

  function addButton(
    parent: HTMLElement,
    label: string,
    onClick: () => void,
    variant: 'primary' | 'secondary' = 'secondary'
  ): ButtonControl {
    const b = createButton({ label, variant, onClick });
    disposables.push(b);
    parent.appendChild(b.element);
    return b;
  }

  function buttonRow(parent: HTMLElement): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin:6px 0;';
    parent.appendChild(row);
    return row;
  }

  if (controlsPanel) {
    // Material
    const material = createSection({ title: 'Material' });
    disposables.push(material);
    modeSelect = createSelect({
      label: 'Regime',
      options: [
        { value: 'elastic', label: 'Elastic (small strain, reversible)' },
        { value: 'plastic', label: 'Plastic (large strain, slip, fracture)' },
      ],
      value: params.mode,
      onChange: (v) => {
        params.mode = v as Mode;
        stored = [];
        rebuild();
        onChange();
      },
    });
    disposables.push(modeSelect);
    material.content.appendChild(modeSelect.element);
    dimSelect = createSelect({
      label: 'Crystal',
      options: [
        { value: '2', label: '2D close-packed layer' },
        { value: '3', label: '3D hcp crystal' },
      ],
      value: String(params.dim),
      onChange: (v) => {
        params.dim = v === '3' ? 3 : 2;
        stored = [];
        rebuild();
        onChange();
      },
    });
    disposables.push(dimSelect);
    material.content.appendChild(dimSelect.element);
    sizeSelect = createSelect({
      label: 'Number of atoms (2D / 3D)',
      options: SIZE_LABELS.map((label, i) => ({ value: String(i), label })),
      value: String(params.size),
      onChange: (v) => {
        params.size = parseInt(v, 10);
        stored = [];
        rebuild();
        onChange();
      },
    });
    disposables.push(sizeSelect);
    material.content.appendChild(sizeSelect.element);
    tempSlider = createSlider({
      label: 'Temperature',
      min: 0,
      max: 0.3,
      step: 0.005,
      value: params.T,
      format: (v) => v.toFixed(3) + ' ε/k',
      onChange: (v) => {
        params.T = v;
        onChange();
        // A pristine bar is rebuilt so its stress-free length follows the thermal expansion
        window.clearTimeout(tempTimer);
        tempTimer = window.setTimeout(() => {
          if (samples.length <= 1 && !fractured && targetStrain === 0 && appliedStress === 0)
            rebuild();
        }, 300);
      },
    });
    disposables.push(tempSlider);
    material.content.appendChild(tempSlider.element);
    material.content.appendChild(
      createHelperText(
        'Atoms attract at long range and repel at short range (Lennard-Jones). Each bond is coloured by its length change: red = stretched, blue = compressed.'
      )
    );
    controlsPanel.appendChild(material.element);

    // Direction
    const direction = createSection({ title: 'Pulling direction' });
    disposables.push(direction);
    angleSlider = createSlider({
      label: 'Angle to close-packed rows',
      min: 0,
      max: 90,
      step: 1,
      value: params.angle,
      format: (v) => v.toFixed(0) + '°',
      onChange: (v) => {
        params.angle = v;
        rebuild();
        onChange();
      },
    });
    disposables.push(angleSlider);
    direction.content.appendChild(angleSlider.element);
    const presets = buttonRow(direction.content);
    for (const [label, a] of [
      ['Horizontal', 0],
      ['Diagonal', 45],
      ['Vertical', 90],
    ] as const) {
      addButton(presets, label, () => {
        params.angle = a;
        angleSlider?.setValue(a);
        rebuild();
        onChange();
      });
    }
    tiltBox = document.createElement('div');
    tiltSlider = createSlider({
      label: 'c-axis tilt towards pull',
      min: 0,
      max: 90,
      step: 1,
      value: params.tilt,
      format: (v) => v.toFixed(0) + '°' + (v === 90 ? ' (along c)' : v === 0 ? ' (basal)' : ''),
      onChange: (v) => {
        params.tilt = v;
        rebuild();
        onChange();
      },
    });
    disposables.push(tiltSlider);
    tiltBox.appendChild(tiltSlider.element);
    direction.content.appendChild(tiltBox);
    direction.content.appendChild(
      createHelperText(
        'The bar is always pulled left–right; this rotates the crystal inside it. Compare the force curves of different directions with “Keep curve”.'
      )
    );
    controlsPanel.appendChild(direction.element);

    // Loading
    const loading = createSection({ title: 'Loading' });
    disposables.push(loading);
    controlSelect = createSelect({
      label: 'Loading control',
      options: [
        { value: 'strain', label: 'Strain: move the grip, measure the force' },
        { value: 'stress', label: 'Stress: apply a force, measure the strain' },
      ],
      value: params.control,
      onChange: (v) => {
        params.control = v as Control;
        rebuild();
        onChange();
      },
    });
    disposables.push(controlSelect);
    loading.content.appendChild(controlSelect.element);
    strainSlider = createSlider({
      label: 'Applied strain',
      min: 0,
      max: 1,
      step: 0.005,
      value: 0,
      format: (v) => (v * maxStrain() * 100).toFixed(1) + ' %',
      onChange: (v) => {
        targetStrain = v * maxStrain();
        stopPulling();
        releasing = false;
        gripFree = false;
        pendingSet = false;
        permanentSet = null;
      },
    });
    disposables.push(strainSlider);
    loading.content.appendChild(strainSlider.element);
    stressSlider = createSlider({
      label: 'Applied stress',
      min: 0,
      max: 1,
      step: 0.005,
      value: 0,
      format: (v) =>
        (v * MAX_STRESS[params.mode]).toFixed(2) + (params.dim === 2 ? ' ε/σ²' : ' ε/σ³'),
      onChange: (v) => {
        targetStress = v * MAX_STRESS[params.mode];
        stopPulling();
        releasing = false;
        pendingSet = false;
        permanentSet = null;
      },
    });
    disposables.push(stressSlider);
    loading.content.appendChild(stressSlider.element);
    rateSlider = createSlider({
      label: 'Loading rate',
      min: -3.3,
      max: -1.5,
      step: 0.05,
      value: params.logRate,
      format: (v) =>
        params.control === 'stress'
          ? (Math.pow(10, v) * STRESS_PER_STRAIN).toFixed(3) + ' stress / t'
          : (Math.pow(10, v) * 1000).toFixed(1) + ' ×10⁻³ strain / t',
      onChange: (v) => {
        params.logRate = v;
        onChange();
      },
    });
    disposables.push(rateSlider);
    loading.content.appendChild(rateSlider.element);
    shearBox = document.createElement('div');
    shearSlider = createSlider({
      label: 'Shear (pulled end moves sideways)',
      min: -MAX_SHEAR,
      max: MAX_SHEAR,
      step: 0.01,
      value: params.shear,
      format: (v) => (v * 100).toFixed(0) + ' % of length',
      onChange: (v) => {
        params.shear = v;
        permanentSet = null;
        onChange();
      },
    });
    disposables.push(shearSlider);
    shearBox.appendChild(shearSlider.element);
    loading.content.appendChild(shearBox);
    notchBox = document.createElement('div');
    notchCheckbox = createCheckbox({
      label: 'Notch in the top edge',
      checked: params.notch,
      onChange: (c) => {
        params.notch = c;
        rebuild();
        onChange();
      },
    });
    disposables.push(notchCheckbox);
    notchBox.appendChild(notchCheckbox.element);
    loading.content.appendChild(notchBox);

    const actions = buttonRow(loading.content);
    pullButton = addButton(
      actions,
      'Pull',
      () => {
        if (fractured) return;
        releasing = false;
        permanentSet = null;
        pendingSet = false;
        if (gripFree) {
          // take hold of the grip again where it is
          gripFree = false;
          targetStrain = Math.max(0, bar.strain);
        }
        pulling = !pulling;
        pullButton?.setLabel(pulling ? 'Pause' : 'Pull');
      },
      'primary'
    );
    addButton(actions, 'Release', () => {
      if (gripFree) return;
      stopPulling();
      releasing = true;
      releaseFrames = 0;
      permanentSet = null;
    });
    addButton(actions, 'Reset', () => {
      seed = Math.floor(Math.random() * 1e9);
      rebuild();
    });
    loading.content.appendChild(
      createHelperText(
        'Pull, or drag the slider. “Release” removes the external force: the leftover strain is the permanent set. With no external force the stress is zero. In stress control the stress is exactly what you apply and the bar’s strain is the response; above its strength the bar runs away and fractures.'
      )
    );
    controlsPanel.appendChild(loading.element);

    // Display
    const display = createSection({ title: 'Display and comparison' });
    disposables.push(display);
    bondsCheckbox = createCheckbox({
      label: 'Show bonds (coloured by stretch)',
      checked: params.bonds,
      onChange: (c) => {
        params.bonds = c;
        onChange();
        render();
      },
    });
    disposables.push(bondsCheckbox);
    display.content.appendChild(bondsCheckbox.element);
    ghostCheckbox = createCheckbox({
      label: 'Show undeformed positions (2D)',
      checked: params.ghost,
      onChange: (c) => {
        params.ghost = c;
        onChange();
        render();
      },
    });
    disposables.push(ghostCheckbox);
    display.content.appendChild(ghostCheckbox.element);
    const curveRow = buttonRow(display.content);
    addButton(curveRow, 'Keep curve', () => {
      if (samples.length < 2 || stored.length >= STORED_COLORS.length) return;
      stored.push({
        label: `${params.angle}°${params.dim === 3 ? `/${params.tilt}°` : ''}`,
        color: STORED_COLORS[stored.length]!,
        strain: samples.map((s) => s.strain),
        stress: samples.map((s) => s.stress),
      });
      render();
    });
    addButton(curveRow, 'Reset 3D view', () => {
      resetCamera();
    });
    addButton(curveRow, 'Clear curves', () => {
      stored = [];
      render();
    });
    display.content.appendChild(
      createHelperText(
        'Kept curves are labelled with the pulling angle. Change the angle, pull again, and compare.'
      )
    );
    if (params.dim === 3)
      display.content.appendChild(createHelperText('3D: drag to rotate, scroll to zoom.'));
    controlsPanel.appendChild(display.element);
  }

  // --- resize / lifecycle -------------------------------------------------------
  function handleResize(): void {
    const w = viewPane.clientWidth;
    const h = viewPane.clientHeight;
    if (three && w > 0 && h > 0) {
      three.renderer.setSize(w, h);
      three.camera.aspect = w / h;
      three.camera.updateProjectionMatrix();
    }
    if (!loop.running) render();
  }

  const resizeObserver = new ResizeObserver(handleResize);
  resizeObserver.observe(viewPane);

  const loop = new AnimationLoop(() => {
    stepFrame();
    render();
  });
  view2d.onResize(() => {
    if (!loop.running) render();
  });
  plotCanvas.onResize(() => {
    if (!loop.running) render();
  });

  resetAxis();
  if (params.dim === 3) rebuildMeshes3D();
  updateVisibility();
  resetCamera();
  updateLegend();
  syncControls();
  render();

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
      window.clearTimeout(tempTimer);
      resizeObserver.disconnect();
      disposables.forEach((d) => d.dispose());
      if (three) {
        three.controls.dispose();
        three.atoms?.dispose();
        three.bonds?.dispose();
        three.sphere.dispose();
        three.cylinder.dispose();
        three.atomMaterial.dispose();
        three.bondMaterial.dispose();
        three.renderer.dispose();
        three.renderer.domElement.remove();
      }
      view2d.dispose();
      plotCanvas.dispose();
      info.remove();
      legend.remove();
      viewPane.remove();
      plotPane.remove();
    },
    getParams: getParamRecord,
    setParams(p: Record<string, string>) {
      const before = JSON.stringify([
        params.mode,
        params.control,
        params.size,
        params.dim,
        params.angle,
        params.tilt,
        params.notch,
      ]);
      parseParams(p, params);
      const after = JSON.stringify([
        params.mode,
        params.control,
        params.size,
        params.dim,
        params.angle,
        params.tilt,
        params.notch,
      ]);
      if (before !== after) {
        stored = [];
        rebuild();
      }
      syncControls();
    },
  };
}

export const elasticPlasticDemo: DemoDefinition = {
  id: 'elastic-plastic',
  title: 'Elastic and Plastic Deformation',
  description:
    'Pull a bar of Lennard-Jones atoms (2D close-packed layer or 3D hcp) in any direction. Watch bonds stretch, read the force or stress–strain curve, and see reversible elastic response turn into slip and fracture.',
  category: 'Mechanical',
  tags: ['elastic', 'plastic', 'stress-strain', 'Lennard-Jones', 'anisotropy', 'fracture', 'hcp'],
  create,
};

export default elasticPlasticDemo;
