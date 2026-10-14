/**
 * Fracture, Fatigue and Creep of a Notched (or Voided) Crystal
 *
 * A 2D close-packed crystal with an edge notch is pulled apart by its top
 * and bottom grips. Bonds are coloured by how much they are stretched (red) or
 * compressed (blue), so the stress concentration at the notch tip and the crack
 * that grows from it are visible.
 *
 * - Monotonic: pull at a constant rate and read the stress-strain curve.
 * - Constant stress: hold a stress (creep). Raise the temperature and atoms
 *   flow, the strain grows with time and the plate eventually ruptures.
 * - Cyclic: oscillate the stress (fatigue). Crack length vs number of cycles.
 *
 * The bond range sets brittle (short range, the crack runs) vs ductile (long
 * range, the tip blunts and the plate flows). Units are reduced (r0 = mass = 1).
 */

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
import { Specimen, SIZE_COUNT, type Command, type Setup } from './fracture';

type Mode = 'ramp' | 'hold' | 'cyclic';
type ColorBy = 'strain' | 'damage' | 'displacement';
type Phase = 'idle' | 'loading' | 'unloading';

interface DemoParams {
  mode: Mode;
  /** 0 = short-range bonds (brittle), 1 = long-range bonds (ductile) */
  ductility: number;
  /** Bond strength */
  D: number;
  /** Temperature (reduced units) */
  T: number;
  size: number;
  /** Which specimen is loaded how (see Setup) */
  setup: Setup;
  /** Fraction of the top and bottom edges, from the notch side, that is gripped and pulled */
  gripFrac: number;
  /** Void radius in bond lengths (void setup) */
  voidSize: number;
  /** Notch depth as a fraction of the plate width */
  depth: number;
  /** 0 = sharp, 1 = round */
  round: number;
  /** log10 of the strain rate (monotonic loading) */
  logRate: number;
  /** Stress held during creep */
  holdStress: number;
  /** Peak stress, stress ratio and period of the cyclic load */
  sigmaMax: number;
  R: number;
  period: number;
  /** Cumulative damage rate of overstretched bonds (cyclic loading) */
  damage: number;
  colorBy: ColorBy;
  trails: boolean;
  ghost: boolean;
  speed: number;
}

const defaultParams: DemoParams = {
  mode: 'ramp',
  ductility: 0.15,
  D: 1,
  T: 0.04,
  size: 1,
  setup: 'notch',
  gripFrac: 0.4,
  voidSize: 4,
  depth: 0.3,
  round: 0,
  logRate: -2.4,
  holdStress: 1.6,
  sigmaMax: 1.6,
  R: 0.1,
  period: 8,
  damage: 0.03,
  colorBy: 'strain',
  trails: false,
  ghost: false,
  speed: 1,
};

/** Bond range alpha at the brittle and ductile ends of the slider */
const ALPHA_BRITTLE = 7.5;
const ALPHA_DUCTILE = 4.5;
function alphaOf(ductility: number): number {
  return ALPHA_BRITTLE + (ALPHA_DUCTILE - ALPHA_BRITTLE) * ductility;
}

const PRESETS: { label: string; params: Partial<DemoParams> }[] = [
  {
    label: 'Brittle',
    params: {
      setup: 'notch',
      mode: 'ramp',
      ductility: 0,
      T: 0.03,
      D: 1,
      depth: 0.3,
      round: 0,
      logRate: -2.4,
    },
  },
  {
    label: 'Ductile',
    params: {
      setup: 'notch',
      mode: 'ramp',
      ductility: 0.9,
      T: 0.1,
      D: 1,
      depth: 0.3,
      round: 0,
      logRate: -2.4,
    },
  },
  {
    label: 'Void',
    params: {
      setup: 'void',
      mode: 'ramp',
      ductility: 0,
      T: 0.03,
      D: 1,
      gripFrac: 1,
      voidSize: 4,
      logRate: -2.4,
    },
  },
  {
    label: 'Fatigue',
    params: {
      setup: 'notch',
      mode: 'cyclic',
      ductility: 0.33,
      T: 0.05,
      D: 1,
      depth: 0.3,
      round: 0,
      sigmaMax: 1.6,
      R: 0.1,
      period: 6,
      damage: 0.05,
    },
  },
  {
    label: 'Creep',
    params: {
      setup: 'notch',
      mode: 'hold',
      ductility: 0.67,
      T: 0.2,
      D: 1,
      depth: 0.3,
      round: 0,
      holdStress: 1.6,
    },
  },
];

/** Breaking force per plate width falls with the gripped fraction roughly as this power of it */
const LOAD_SCALE_EXPONENT = 0.7;
const MAX_STEPS_PER_FRAME = 40;
const MS_PER_PAIR_STEP = 7.6e-6;
const FRAME_BUDGET_MS = 8;
/** Time over which force-controlled loads are applied or removed */
const RAMP_TIME = 5;
/** The plate counts as failed when it has stretched this much (necked through) */
const MAX_STRAIN = 0.4;
const SIZE_LABELS = ['Small (~620 atoms)', 'Medium (~1150 atoms)', 'Large (~2200 atoms)'];
const SPEED_OPTIONS = [1, 2, 4];

const COLOR_CURVE = '#ff6b6b';
const COLOR_UNLOAD = '#38bdf8';
const STORED_COLORS = ['#a3e635', '#c084fc', '#2dd4bf', '#fb923c'];
const COLOR_GRIP = '#8b93a1';
const COLOR_BULK = '#6ea8fe';
const COLOR_SURFACE = '#ffc078';
const BOND_NEUTRAL: [number, number, number] = [122, 127, 138];
const BOND_STRETCH: [number, number, number] = [255, 59, 48];
const BOND_COMPRESS: [number, number, number] = [59, 130, 246];
const PALETTE_SIZE = 32;
const STRAIN_RANGE = { pos: 0.14, neg: 0.05 };
const FONT = '-apple-system, BlinkMacSystemFont, sans-serif';

function num(v: string | undefined, lo: number, hi: number, fallback: number): number {
  const x = v === undefined ? NaN : parseFloat(v);
  return clamp(Number.isFinite(x) ? x : fallback, lo, hi);
}

function parseParams(src: Record<string, string>, params: DemoParams): void {
  if (src.mode === 'ramp' || src.mode === 'hold' || src.mode === 'cyclic') params.mode = src.mode;
  params.ductility = num(src.ductility, 0, 1, params.ductility);
  params.D = num(src.D, 0.5, 1.6, params.D);
  params.T = num(src.T, 0, 0.3, params.T);
  params.size = Math.round(num(src.size, 0, SIZE_COUNT - 1, params.size));
  if (src.setup === 'notch' || src.setup === 'void') params.setup = src.setup;
  params.gripFrac = num(src.gripFrac, 0.25, 1, params.gripFrac);
  params.voidSize = num(src.voidSize, 2, 7, params.voidSize);
  params.depth = num(src.depth, 0.15, 0.5, params.depth);
  params.round = num(src.round, 0, 1, params.round);
  params.logRate = num(src.logRate, -3, -1.8, params.logRate);
  params.holdStress = num(src.holdStress, 0.3, 3.5, params.holdStress);
  params.sigmaMax = num(src.sigmaMax, 0.3, 4, params.sigmaMax);
  params.R = num(src.R, 0, 0.8, params.R);
  params.period = num(src.period, 4, 20, params.period);
  params.damage = num(src.damage, 0.005, 0.15, params.damage);
  if (src.colorBy === 'strain' || src.colorBy === 'damage' || src.colorBy === 'displacement') {
    params.colorBy = src.colorBy;
  }
  if (src.trails !== undefined) params.trails = src.trails === 'true';
  if (src.ghost !== undefined) params.ghost = src.ghost === 'true';
  const speed = Math.round(num(src.speed, 1, 4, params.speed));
  params.speed = SPEED_OPTIONS.includes(speed) ? speed : 1;
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
/** Bond colours from grey (intact) to red (fully damaged) */
const DAMAGE_CSS: string[] = [];
for (let k = 0; k <= PALETTE_SIZE; k++)
  DAMAGE_CSS.push(mix(BOND_NEUTRAL, BOND_STRETCH, k / PALETTE_SIZE));
/** Atom colours by displacement: dark blue to yellow */
const DISP_CSS: string[] = [];
for (let k = 0; k <= PALETTE_SIZE; k++) {
  const t = k / PALETTE_SIZE;
  DISP_CSS.push(
    t < 0.5
      ? mix([30, 50, 120], [30, 160, 150], t * 2)
      : mix([30, 160, 150], [250, 230, 60], (t - 0.5) * 2)
  );
}

function paletteIndex(strain: number): number {
  const t = strain >= 0 ? strain / STRAIN_RANGE.pos : strain / STRAIN_RANGE.neg;
  return Math.round(clamp(t, -1, 1) * PALETTE_SIZE) + PALETTE_SIZE;
}

/** A curve in the plot pane (x, y) */
interface Curve {
  x: number[];
  y: number[];
}

interface StoredCurve extends Curve {
  mode: Mode;
  label: string;
  color: string;
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
    'position:relative;flex:0 0 40%;min-width:0;height:100%;overflow:hidden;border-left:1px solid #222;';
  container.appendChild(viewPane);
  container.appendChild(plotPane);

  const view = new HiDPICanvas(viewPane, { backgroundColor: '#0a0a0a', autoResize: true });
  const plotCanvas = new HiDPICanvas(plotPane, { backgroundColor: '#0a0a0a', autoResize: true });
  for (const c of [view.canvas, plotCanvas.canvas]) {
    c.style.position = 'absolute';
    c.style.top = '0';
    c.style.left = '0';
  }
  const plot = new Plot2D(plotCanvas.ctx, {
    bounds: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
    margins: { top: 44, right: 18, bottom: 48, left: 62 },
  });

  const overlayCss =
    `position:absolute;color:#ddd;font:13px ${FONT};` +
    'line-height:1.45;pointer-events:none;text-shadow:0 1px 2px #000;';
  const info = document.createElement('div');
  info.style.cssText = overlayCss + 'top:8px;left:10px;';
  viewPane.appendChild(info);
  const legend = document.createElement('div');
  legend.style.cssText = overlayCss + 'bottom:8px;left:10px;font-size:12px;color:#aaa;';
  viewPane.appendChild(legend);

  // --- state --------------------------------------------------------------
  let specimen: Specimen;
  let seed = 7;
  let phase: Phase = 'idle';
  let ramp = 0;
  /** Loading time and the cycle phase carried over between loading episodes */
  let loadTime = 0;
  let targetUy = 0;
  let fractured = false;
  let crackLength = 0;
  let brokenBonds = 0;
  let frameCount = 0;
  let curve: Curve = { x: [], y: [] };
  let unloadCurve: Curve = { x: [], y: [] };
  let stored: StoredCurve[] = [];
  let yTop = 1;
  let fitHeight = 1;
  let coordination: Uint8Array = new Uint8Array(0);
  let trailFrames: Float32Array[] = [];
  const disposables: Disposable[] = [];
  let rebuildTimer = 0;

  function ramping(): boolean {
    return params.mode === 'ramp';
  }

  function resetData(): void {
    phase = 'idle';
    ramp = 0;
    loadTime = 0;
    targetUy = 0;
    fractured = false;
    curve = { x: [], y: [] };
    unloadCurve = { x: [], y: [] };
    yTop = 1;
    trailFrames = [];
    crackLength = specimen.notchLength;
    brokenBonds = 0;
    fitHeight = specimen.ly * 1.1;
    coordination = specimen.coordination();
  }

  function rebuild(): void {
    specimen = new Specimen({
      setup: params.setup,
      gripFraction: params.gripFrac,
      voidRadius: params.voidSize,
      size: params.size,
      alpha: alphaOf(params.ductility),
      D: params.D,
      depth: params.depth,
      roundness: params.round,
      temperature: params.T,
      seed,
    });
    resetData();
    updateLoadButton();
    render();
  }

  function scheduleRebuild(): void {
    window.clearTimeout(rebuildTimer);
    rebuildTimer = window.setTimeout(rebuild, 250);
  }

  /** Force on the grip for a nominal stress */
  function forceOf(stress: number): number {
    return stress * specimen.width * loadScale();
  }

  /** Partial grips break at a lower force per width; scaled so that the load sliders stay comparable */
  function loadScale(): number {
    return Math.pow(params.gripFrac, LOAD_SCALE_EXPONENT);
  }

  /** Nominal stress in slider units */
  function sigmaNow(): number {
    return specimen.stress / loadScale();
  }

  function command(): Command {
    const maxUy = MAX_STRAIN * specimen.gauge;
    const loading = phase === 'loading';
    if (params.mode === 'ramp') {
      const rate = Math.pow(10, params.logRate) * specimen.gauge;
      if (phase === 'unloading') return { mode: 'displacement', uy: 0, speed: 3 * rate };
      // when idle the grip stays where it is
      return { mode: 'displacement', uy: loading ? maxUy : targetUy, speed: rate };
    }
    if (params.mode === 'hold') {
      return {
        mode: 'force',
        force: forceOf(params.holdStress) * ramp,
        amp: 0,
        period: 1,
        t0: 0,
        maxUy,
      };
    }
    const mean = (forceOf(params.sigmaMax) * (1 + params.R)) / 2;
    const amp = (forceOf(params.sigmaMax) * (1 - params.R)) / 2;
    return {
      mode: 'force',
      force: mean * ramp,
      amp: amp * ramp,
      period: params.period,
      t0: specimen.time - loadTime,
      maxUy,
    };
  }

  function cycles(): number {
    return loadTime / params.period;
  }

  function stepFrame(): void {
    const budget = Math.floor(FRAME_BUDGET_MS / (specimen.pairCount * MS_PER_PAIR_STEP));
    const steps = clamp(budget, 4, MAX_STEPS_PER_FRAME) * params.speed;
    const dt = steps * 0.005;
    const loading = phase === 'loading' && !fractured;
    if (!ramping()) {
      // force-controlled loads fade in while loading and out otherwise
      const target = loading ? 1 : 0;
      ramp = clamp(ramp + (target - ramp) * Math.min(1, dt / (0.3 * RAMP_TIME)), 0, 1);
      if (loading) loadTime += dt;
    }
    specimen.damageRate = params.mode === 'cyclic' && loading ? params.damage : 0;
    if (ramping() && phase === 'loading') {
      targetUy = specimen.uy;
    }
    specimen.advance(steps, command());
    if (ramping() && phase === 'unloading' && specimen.uy <= 1e-6) phase = 'idle';
    frameCount++;

    if (frameCount % 4 === 0) {
      const c = specimen.crack();
      crackLength = c.length;
      brokenBonds = c.broken;
      coordination = specimen.coordination();
    }
    if (frameCount % 8 === 0 && !fractured && phase !== 'idle') {
      if (!specimen.isConnected() || specimen.strain >= MAX_STRAIN * 0.98) {
        fractured = true;
        phase = 'idle';
        targetUy = specimen.uy;
        updateLoadButton();
      }
    }
    recordSamples();
    if (params.trails && frameCount % 10 === 0) recordTrail();
  }

  function recordSamples(): void {
    if (phase === 'idle' && !fractured) return;
    if (params.mode === 'ramp') {
      const target = phase === 'unloading' ? unloadCurve : curve;
      const x = specimen.strainSmooth;
      const last = target.x[target.x.length - 1];
      if (last === undefined || Math.abs(x - last) > 0.0008) {
        target.x.push(x);
        target.y.push(sigmaNow());
      }
    } else if (frameCount % 3 === 0 && phase === 'loading') {
      if (params.mode === 'hold') {
        curve.x.push(loadTime);
        curve.y.push(specimen.strain);
      } else {
        curve.x.push(cycles());
        curve.y.push(crackLength / specimen.width);
      }
    }
  }

  function recordTrail(): void {
    const snap = new Float32Array(2 * specimen.n);
    for (let i = 0; i < specimen.n; i++) {
      snap[2 * i] = specimen.pos[3 * i]!;
      snap[2 * i + 1] = specimen.pos[3 * i + 1]!;
    }
    trailFrames.push(snap);
    if (trailFrames.length > 12) trailFrames.shift();
  }

  // --- rendering ----------------------------------------------------------
  function render(): void {
    renderView();
    renderPlot();
  }

  function atomColor(i: number, disp: Float32Array | null): string {
    if (specimen.role[i] !== 0) return COLOR_GRIP;
    if (disp) return DISP_CSS[Math.round(clamp(disp[i]! / 3, 0, 1) * PALETTE_SIZE)]!;
    return coordination[i]! >= 6 ? COLOR_BULK : COLOR_SURFACE;
  }

  function renderView(): void {
    const ctx = view.ctx;
    const w = view.width;
    const h = view.height;
    view.clear();
    if (w === 0 || h === 0 || !specimen) return;
    const sp = specimen;
    const { a } = sp;
    // zoom out as the plate stretches, never back in
    let maxY = sp.ly;
    for (let i = 0; i < sp.n; i++) maxY = Math.max(maxY, sp.pos[3 * i + 1]!);
    fitHeight = Math.max(fitHeight, maxY + 2 * a);
    const s = Math.min((w - 24) / (sp.lx + 2 * a), (h - 160) / fitHeight);
    const ox = (w - sp.lx * s) / 2;
    const oy = h - 50;
    const X = (x: number): number => ox + x * s;
    const Y = (y: number): number => oy - y * s;
    const radius = Math.max(1.5, 0.3 * a * s);

    const disp = params.colorBy === 'displacement' ? sp.displacements() : null;

    if (params.ghost) {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < sp.n; i++) {
        const x = X(sp.ref[3 * i]!);
        const y = Y(sp.ref[3 * i + 1]!);
        ctx.moveTo(x + radius, y);
        ctx.arc(x, y, radius, 0, 2 * Math.PI);
      }
      ctx.stroke();
    }

    if (params.trails && trailFrames.length > 1) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,224,130,0.55)';
      ctx.beginPath();
      const first = trailFrames[0]!;
      const thresh = 0.25 * a;
      for (let i = 0; i < sp.n; i++) {
        if (sp.role[i] !== 0) continue;
        const d = Math.hypot(
          sp.pos[3 * i]! - first[2 * i]!,
          sp.pos[3 * i + 1]! - first[2 * i + 1]!
        );
        if (d < thresh) continue;
        ctx.moveTo(X(first[2 * i]!), Y(first[2 * i + 1]!));
        for (let f = 1; f < trailFrames.length; f++) {
          ctx.lineTo(X(trailFrames[f]![2 * i]!), Y(trailFrames[f]![2 * i + 1]!));
        }
        ctx.lineTo(X(sp.pos[3 * i]!), Y(sp.pos[3 * i + 1]!));
      }
      ctx.stroke();
    }

    // bonds, one stroke per colour
    const bonds = sp.bonds();
    const buckets = new Map<string, number[]>();
    for (let k = 0; k < bonds.length; k++) {
      const b = bonds[k]!;
      let color: string;
      if (params.colorBy === 'strain') color = PALETTE_CSS[paletteIndex(b.strain)]!;
      else if (params.colorBy === 'damage') {
        color = DAMAGE_CSS[Math.round(clamp(b.damage, 0, 1) * PALETTE_SIZE)]!;
      } else color = 'rgb(70,74,84)';
      const list = buckets.get(color);
      if (list) list.push(k);
      else buckets.set(color, [k]);
    }
    ctx.lineWidth = Math.max(1, 0.1 * a * s);
    ctx.lineCap = 'round';
    for (const [color, list] of buckets) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (const k of list) {
        const b = bonds[k]!;
        ctx.moveTo(X(sp.pos[3 * b.i]!), Y(sp.pos[3 * b.i + 1]!));
        ctx.lineTo(X(sp.pos[3 * b.j]!), Y(sp.pos[3 * b.j + 1]!));
      }
      ctx.stroke();
    }

    // atoms
    for (let i = 0; i < sp.n; i++) {
      ctx.fillStyle = atomColor(i, disp);
      ctx.beginPath();
      ctx.arc(X(sp.pos[3 * i]!), Y(sp.pos[3 * i + 1]!), radius * 0.8, 0, 2 * Math.PI);
      ctx.fill();
    }

    // grip labels and load arrow
    const grips = sp.gripPoints();
    ctx.font = `12px ${FONT}`;
    ctx.fillStyle = COLOR_GRIP;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('top grip (pulled)', X(0), Y(grips.top.y) - 8);
    ctx.textBaseline = 'top';
    ctx.fillText('bottom grip (fixed)', X(0), Y(grips.bottom.y) + 8);
    const load = Math.max(0, sp.forceSmooth) / (sp.width * 4 * loadScale());
    if (load > 0.02) {
      const len = Math.min(70, 70 * load);
      const x = X(grips.top.x);
      const yTopPx = Y(grips.top.y) - 8;
      ctx.strokeStyle = '#ff6b6b';
      ctx.fillStyle = '#ff6b6b';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, yTopPx);
      ctx.lineTo(x, yTopPx - len);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, yTopPx - len - 9);
      ctx.lineTo(x - 6, yTopPx - len);
      ctx.lineTo(x + 6, yTopPx - len);
      ctx.fill();
    }

    updateInfo();
  }

  function modeName(): string {
    return params.mode === 'ramp'
      ? 'Monotonic loading'
      : params.mode === 'hold'
        ? 'Constant stress (creep)'
        : 'Cyclic stress (fatigue)';
  }

  function updateInfo(): void {
    const sp = specimen;
    const sigma = sigmaNow();
    const aLen = crackLength;
    const void_ = params.setup === 'void';
    // edge crack 1.12 σ √(π a); a central crack of length L has half-length L / 2
    const K = void_
      ? Math.max(sigma, 0) * Math.sqrt((Math.PI * aLen) / 2)
      : 1.12 * Math.max(sigma, 0) * Math.sqrt(Math.PI * aLen);
    const lines = [
      `<b>${modeName()}</b> &nbsp; bond range α = ${alphaOf(params.ductility).toFixed(1)}`,
      `stress σ = ${sigma.toFixed(2)} &nbsp; strain ε = ${(sp.strain * 100).toFixed(1)}%`,
      `${void_ ? 'void + crack length' : 'notch + crack a'} = ${aLen.toFixed(1)} (${((100 * aLen) / sp.width).toFixed(0)}% of width)` +
        ` &nbsp; K ≈ ${K.toFixed(1)}`,
    ];
    if (params.mode === 'ramp') {
      lines.push(`broken bonds: ${brokenBonds}`);
    } else if (params.mode === 'hold') {
      lines.push(`time under load t = ${loadTime.toFixed(0)}`);
    } else {
      lines.push(`cycles N = ${cycles().toFixed(1)} &nbsp; broken bonds: ${brokenBonds}`);
    }
    if (fractured) lines.push('<span style="color:#ff6b6b"><b>Fractured</b></span>');
    info.innerHTML = lines.join('<br>');
  }

  function updateLegend(): void {
    const bar = (css: string[]): string =>
      `<span style="display:inline-block;width:90px;height:8px;vertical-align:middle;background:linear-gradient(90deg,${css.join(',')})"></span>`;
    if (params.colorBy === 'strain') {
      legend.innerHTML = `bond strain: compressed ${bar(PALETTE_CSS.filter((_, k) => k % 8 === 0))} stretched &nbsp; atoms: <span style="color:${COLOR_BULK}">bulk</span> / <span style="color:${COLOR_SURFACE}">surface or defect</span>`;
    } else if (params.colorBy === 'damage') {
      legend.innerHTML = `bond damage: intact ${bar(DAMAGE_CSS.filter((_, k) => k % 8 === 0))} broken &nbsp; (damage accumulates in cyclic loading)`;
    } else {
      legend.innerHTML = `atom displacement: 0 ${bar(DISP_CSS.filter((_, k) => k % 8 === 0))} 3 bond lengths`;
    }
  }

  // --- plot pane ----------------------------------------------------------
  function activeCurves(): { c: Curve; color: string }[] {
    const list: { c: Curve; color: string }[] = [];
    for (const s of stored) if (s.mode === params.mode) list.push({ c: s, color: s.color });
    list.push({ c: unloadCurve, color: COLOR_UNLOAD });
    list.push({ c: curve, color: COLOR_CURVE });
    return list;
  }

  function renderPlot(): void {
    const ctx = plotCanvas.ctx;
    const w = plotCanvas.width;
    const h = plotCanvas.height;
    plotCanvas.clear();
    if (w === 0 || h === 0) return;

    const curves = activeCurves();
    let xMax = 0;
    let yMax = 0;
    for (const { c } of curves) {
      for (const v of c.x) xMax = Math.max(xMax, v);
      for (const v of c.y) yMax = Math.max(yMax, v);
    }
    let xTop: number;
    let yLim: number;
    let title: string;
    let xLabel: string;
    let yLabel: string;
    let xFmt: (v: number) => string;
    let yFmt: (v: number) => string;
    if (params.mode === 'ramp') {
      xTop = Math.max(0.1, xMax * 1.1);
      yTop = Math.max(yTop, yMax * 1.12, 1);
      yLim = yTop;
      title = 'Stress–strain curve';
      xLabel = 'Strain ε';
      yLabel = 'Stress σ (nominal)';
      xFmt = (v) => (v * 100).toFixed(0) + '%';
      yFmt = (v) => v.toFixed(1);
    } else if (params.mode === 'hold') {
      xTop = Math.max(50, xMax * 1.1);
      yTop = Math.max(yTop, yMax * 1.12, 0.05);
      yLim = yTop;
      title = 'Creep curve';
      xLabel = 'Time under load t';
      yLabel = 'Strain ε';
      xFmt = (v) => v.toFixed(0);
      yFmt = (v) => (v * 100).toFixed(0) + '%';
    } else {
      xTop = Math.max(20, xMax * 1.1);
      yTop = Math.max(yTop, yMax * 1.12, 0.5);
      yLim = yTop;
      title = 'Fatigue crack growth';
      xLabel = 'Cycles N';
      yLabel = 'Defect + crack length / W';
      xFmt = (v) => v.toFixed(0);
      yFmt = (v) => v.toFixed(1);
    }
    const yMin = 0;
    plot.setSize(w, h);
    plot.setBounds({ xMin: 0, xMax: xTop, yMin, yMax: yLim });
    const xTicks = Plot2D.generateTicks(0, xTop, 5);
    const yTicks = Plot2D.generateTicks(yMin, yLim, 5);
    plot.drawGrid(xTicks, yTicks);
    plot.drawAxes(xLabel, yLabel);
    plot.drawTickLabels(xTicks, yTicks, xFmt, yFmt);

    ctx.save();
    ctx.font = `600 13px ${FONT}`;
    ctx.fillStyle = '#ddd';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(title, 14, 10);
    ctx.font = `12px ${FONT}`;
    const items: [string, string][] = [
      [COLOR_CURVE, params.mode === 'ramp' ? 'loading' : 'current'],
      ...(params.mode === 'ramp' ? ([[COLOR_UNLOAD, 'unloading']] as [string, string][]) : []),
      ...stored
        .filter((c) => c.mode === params.mode)
        .map((c): [string, string] => [c.color, c.label]),
    ];
    let lx = 14;
    for (const [color, label] of items) {
      ctx.fillStyle = color;
      ctx.fillRect(lx, 29, 12, 3);
      ctx.fillStyle = '#aaa';
      ctx.fillText(label, lx + 16, 24);
      lx += 24 + ctx.measureText(label).width;
    }

    ctx.beginPath();
    ctx.rect(
      plot.toCanvasX(0),
      plot.toCanvasY(yLim),
      plot.toCanvasX(xTop) - plot.toCanvasX(0),
      plot.toCanvasY(yMin) - plot.toCanvasY(yLim)
    );
    ctx.clip();
    for (const { c, color } of curves) {
      if (c.x.length > 1) plot.drawLine(c.x, c.y, color, 2);
    }
    if (curve.x.length > 0) {
      plot.drawPoint(curve.x[curve.x.length - 1]!, curve.y[curve.y.length - 1]!, 4, '#fff');
    }
    ctx.restore();
  }

  // --- controls -----------------------------------------------------------
  let modeSelect: SelectControl | undefined;
  let ductilitySlider: SliderControl | undefined;
  let strengthSlider: SliderControl | undefined;
  let tempSlider: SliderControl | undefined;
  let sizeSelect: SelectControl | undefined;
  let setupSelect: SelectControl | undefined;
  let gripSlider: SliderControl | undefined;
  let voidSlider: SliderControl | undefined;
  const notchOnly: HTMLElement[] = [];
  const voidOnly: HTMLElement[] = [];
  let depthSlider: SliderControl | undefined;
  let roundSlider: SliderControl | undefined;
  let rateSlider: SliderControl | undefined;
  let holdSlider: SliderControl | undefined;
  let sigmaSlider: SliderControl | undefined;
  let ratioSlider: SliderControl | undefined;
  let periodSlider: SliderControl | undefined;
  let damageSlider: SliderControl | undefined;
  let colorSelect: SelectControl | undefined;
  let trailsCheckbox: CheckboxControl | undefined;
  let ghostCheckbox: CheckboxControl | undefined;
  let speedSelect: SelectControl | undefined;
  let loadButton: ButtonControl | undefined;
  const rampOnly: HTMLElement[] = [];
  const holdOnly: HTMLElement[] = [];
  const cyclicOnly: HTMLElement[] = [];
  let unloadRow: HTMLElement | undefined;

  function onChange(): void {
    options.setParams(getParamRecord());
  }

  function getParamRecord(): Record<string, string> {
    return {
      mode: params.mode,
      ductility: params.ductility.toFixed(2),
      D: params.D.toFixed(2),
      T: params.T.toFixed(3),
      size: String(params.size),
      setup: params.setup,
      gripFrac: params.gripFrac.toFixed(2),
      voidSize: params.voidSize.toFixed(1),
      depth: params.depth.toFixed(2),
      round: params.round.toFixed(2),
      logRate: params.logRate.toFixed(2),
      holdStress: params.holdStress.toFixed(2),
      sigmaMax: params.sigmaMax.toFixed(2),
      R: params.R.toFixed(2),
      period: params.period.toFixed(1),
      damage: params.damage.toFixed(3),
      colorBy: params.colorBy,
      trails: String(params.trails),
      ghost: String(params.ghost),
      speed: String(params.speed),
    };
  }

  function updateVisibility(): void {
    for (const e of notchOnly) e.style.display = params.setup === 'void' ? 'none' : '';
    for (const e of voidOnly) e.style.display = params.setup === 'void' ? '' : 'none';
    for (const e of rampOnly) e.style.display = params.mode === 'ramp' ? '' : 'none';
    for (const e of holdOnly) e.style.display = params.mode === 'hold' ? '' : 'none';
    for (const e of cyclicOnly) e.style.display = params.mode === 'cyclic' ? '' : 'none';
    if (unloadRow) unloadRow.style.display = params.mode === 'ramp' ? '' : 'none';
  }

  function updateLoadButton(): void {
    loadButton?.setLabel(phase === 'loading' ? 'Stop loading' : 'Start loading');
  }

  function syncControls(): void {
    modeSelect?.setValue(params.mode);
    ductilitySlider?.setValue(params.ductility);
    strengthSlider?.setValue(params.D);
    tempSlider?.setValue(params.T);
    sizeSelect?.setValue(String(params.size));
    setupSelect?.setValue(params.setup);
    gripSlider?.setValue(params.gripFrac);
    voidSlider?.setValue(params.voidSize);
    depthSlider?.setValue(params.depth);
    roundSlider?.setValue(params.round);
    rateSlider?.setValue(params.logRate);
    holdSlider?.setValue(params.holdStress);
    sigmaSlider?.setValue(params.sigmaMax);
    ratioSlider?.setValue(params.R);
    periodSlider?.setValue(params.period);
    damageSlider?.setValue(params.damage);
    colorSelect?.setValue(params.colorBy);
    trailsCheckbox?.setChecked(params.trails);
    ghostCheckbox?.setChecked(params.ghost);
    speedSelect?.setValue(String(params.speed));
    updateVisibility();
    updateLegend();
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

  function addSlider(
    parent: HTMLElement,
    label: string,
    min: number,
    max: number,
    step: number,
    get: () => number,
    set: (v: number) => void,
    format: (v: number) => string,
    structural: boolean
  ): SliderControl {
    const slider = createSlider({
      label,
      min,
      max,
      step,
      value: get(),
      format,
      onChange: (v) => {
        set(v);
        if (structural) scheduleRebuild();
        updateLegend();
        onChange();
        if (!loop.running) render();
      },
    });
    disposables.push(slider);
    parent.appendChild(slider.element);
    return slider;
  }

  function applyPreset(p: Partial<DemoParams>): void {
    Object.assign(params, p);
    stored = [];
    window.clearTimeout(rebuildTimer);
    rebuild();
    syncControls();
    onChange();
  }

  function keepCurve(): void {
    if (curve.x.length < 2) return;
    const label =
      params.mode === 'ramp'
        ? `α=${alphaOf(params.ductility).toFixed(1)}, T=${params.T.toFixed(2)}`
        : params.mode === 'hold'
          ? `σ=${params.holdStress.toFixed(1)}, T=${params.T.toFixed(2)}`
          : `σmax=${params.sigmaMax.toFixed(1)}`;
    stored.push({
      mode: params.mode,
      label,
      color: STORED_COLORS[stored.length % STORED_COLORS.length]!,
      x: [...curve.x],
      y: [...curve.y],
    });
    if (stored.length > STORED_COLORS.length) stored.shift();
    render();
  }

  if (controlsPanel) {
    // Material
    const material = createSection({ title: 'Material' });
    disposables.push(material);
    ductilitySlider = addSlider(
      material.content,
      'Bond range: short (brittle) → long (ductile)',
      0,
      1,
      0.01,
      () => params.ductility,
      (v) => (params.ductility = v),
      (v) => `α = ${alphaOf(v).toFixed(1)}`,
      true
    );
    strengthSlider = addSlider(
      material.content,
      'Bond strength',
      0.5,
      1.6,
      0.05,
      () => params.D,
      (v) => (params.D = v),
      (v) => v.toFixed(2),
      true
    );
    tempSlider = addSlider(
      material.content,
      'Temperature',
      0,
      0.3,
      0.01,
      () => params.T,
      (v) => {
        params.T = v;
        if (specimen) specimen.temperature = v;
      },
      (v) => v.toFixed(2),
      false
    );
    material.content.appendChild(
      createHelperText(
        'Short-range bonds snap at a small stretch, so the crack runs. Long-range bonds let the tip blunt and the plate flow. Heat makes both flow more easily.'
      )
    );
    controlsPanel.appendChild(material.element);

    // Specimen
    const notch = createSection({ title: 'Specimen' });
    disposables.push(notch);
    setupSelect = createSelect({
      label: 'Defect',
      options: [
        { value: 'notch', label: 'Edge notch' },
        { value: 'void', label: 'Void instead of a notch' },
      ],
      value: params.setup,
      onChange: (v) => {
        params.setup = v as Setup;
        window.clearTimeout(rebuildTimer);
        rebuild();
        updateVisibility();
        onChange();
      },
    });
    disposables.push(setupSelect);
    notch.content.appendChild(setupSelect.element);
    notch.content.appendChild(
      createHelperText(
        'The plate is gripped on the top and bottom edges, but only over the part nearest the notch mouth. The crack is then opened from the notch side, and the tip is loaded without breaking the whole plate at once. Void: no notch, a crack nucleates at the hole.'
      )
    );
    gripSlider = addSlider(
      notch.content,
      'Pulled region (from the notch side)',
      0.25,
      1,
      0.05,
      () => params.gripFrac,
      (v) => (params.gripFrac = v),
      (v) => `${(v * 100).toFixed(0)}% of the top and bottom edges`,
      true
    );
    depthSlider = addSlider(
      notch.content,
      'Notch depth',
      0.15,
      0.5,
      0.01,
      () => params.depth,
      (v) => (params.depth = v),
      (v) => `${(v * 100).toFixed(0)}% of width`,
      true
    );
    roundSlider = addSlider(
      notch.content,
      'Notch tip: sharp → round',
      0,
      1,
      0.05,
      () => params.round,
      (v) => (params.round = v),
      (v) => (v < 0.05 ? 'sharp slit' : `root radius ${(v * 5).toFixed(1)} bond lengths`),
      true
    );
    notchOnly.push(depthSlider.element, roundSlider.element);
    voidSlider = addSlider(
      notch.content,
      'Void radius',
      2,
      7,
      0.5,
      () => params.voidSize,
      (v) => (params.voidSize = v),
      (v) => `${v.toFixed(1)} bond lengths`,
      true
    );
    voidOnly.push(voidSlider.element);
    sizeSelect = createSelect({
      label: 'Plate size',
      options: SIZE_LABELS.map((label, k) => ({ value: String(k), label })),
      value: String(params.size),
      onChange: (v) => {
        params.size = parseInt(v, 10);
        scheduleRebuild();
        onChange();
      },
    });
    disposables.push(sizeSelect);
    notch.content.appendChild(sizeSelect.element);
    controlsPanel.appendChild(notch.element);

    // Loading
    const loading = createSection({ title: 'Loading' });
    disposables.push(loading);
    modeSelect = createSelect({
      label: 'Load type',
      options: [
        { value: 'ramp', label: 'Monotonic (constant pull rate)' },
        { value: 'hold', label: 'Constant stress (creep)' },
        { value: 'cyclic', label: 'Cyclic stress (fatigue)' },
      ],
      value: params.mode,
      onChange: (v) => {
        params.mode = v as Mode;
        window.clearTimeout(rebuildTimer);
        rebuild();
        updateVisibility();
        onChange();
      },
    });
    disposables.push(modeSelect);
    loading.content.appendChild(modeSelect.element);

    rateSlider = addSlider(
      loading.content,
      'Strain rate',
      -3,
      -1.8,
      0.05,
      () => params.logRate,
      (v) => (params.logRate = v),
      (v) => `${Math.pow(10, v).toExponential(1)} per time`,
      false
    );
    rampOnly.push(rateSlider.element);
    holdSlider = addSlider(
      loading.content,
      'Held stress σ',
      0.3,
      3.5,
      0.05,
      () => params.holdStress,
      (v) => (params.holdStress = v),
      (v) => v.toFixed(2),
      false
    );
    holdOnly.push(holdSlider.element);
    sigmaSlider = addSlider(
      loading.content,
      'Peak stress σmax',
      0.3,
      4,
      0.05,
      () => params.sigmaMax,
      (v) => (params.sigmaMax = v),
      (v) => v.toFixed(2),
      false
    );
    ratioSlider = addSlider(
      loading.content,
      'Stress ratio R = σmin / σmax',
      0,
      0.8,
      0.05,
      () => params.R,
      (v) => (params.R = v),
      (v) => v.toFixed(2),
      false
    );
    periodSlider = addSlider(
      loading.content,
      'Period of one cycle',
      4,
      20,
      0.5,
      () => params.period,
      (v) => (params.period = v),
      (v) => v.toFixed(1),
      false
    );
    damageSlider = addSlider(
      loading.content,
      'Fatigue damage per cycle',
      0.005,
      0.15,
      0.005,
      () => params.damage,
      (v) => (params.damage = v),
      (v) => v.toFixed(3),
      false
    );
    cyclicOnly.push(
      sigmaSlider.element,
      ratioSlider.element,
      periodSlider.element,
      damageSlider.element
    );
    const fatigueNote = createHelperText(
      'A pair potential has no irreversible slip, so cracks would close again on unloading. Bonds stretched past half their peak-force stretch therefore lose strength cumulatively (damage), standing in for the irreversible tip plasticity of real metals. The load is shared by the neighbours of an atom, so atoms with fewer neighbours (at the notch tip and on surfaces) accumulate damage faster, in proportion to 6 / neighbours.'
    );
    cyclicOnly.push(fatigueNote);
    loading.content.appendChild(fatigueNote);
    const holdNote = createHelperText(
      'Creep needs thermal activation: raise the temperature and atoms flow under a constant load. The plate strains, necks and ruptures.'
    );
    holdOnly.push(holdNote);
    loading.content.appendChild(holdNote);

    const actions = buttonRow(loading.content);
    loadButton = addButton(
      actions,
      'Start loading',
      () => {
        if (fractured) return;
        phase = phase === 'loading' ? 'idle' : 'loading';
        if (phase === 'idle') targetUy = specimen.uy;
        updateLoadButton();
      },
      'primary'
    );
    unloadRow = buttonRow(loading.content);
    addButton(unloadRow, 'Unload', () => {
      if (params.mode !== 'ramp') return;
      phase = 'unloading';
      updateLoadButton();
    });
    addButton(actions, 'Reset', () => {
      seed = (seed * 16807) % 2147483647;
      window.clearTimeout(rebuildTimer);
      rebuild();
    });
    controlsPanel.appendChild(loading.element);

    // Presets
    const presets = createSection({ title: 'Presets' });
    disposables.push(presets);
    const presetRow = buttonRow(presets.content);
    for (const preset of PRESETS)
      addButton(presetRow, preset.label, () => applyPreset(preset.params));
    presets.content.appendChild(
      createHelperText(
        'Brittle and Ductile: compare stress–strain curves with "Keep curve". Fatigue: start loading and watch the crack grow with the number of cycles. Creep: start loading, then change the temperature.'
      )
    );
    controlsPanel.appendChild(presets.element);

    // Display
    const display = createSection({ title: 'Display' });
    disposables.push(display);
    colorSelect = createSelect({
      label: 'Colour by',
      options: [
        { value: 'strain', label: 'Bond strain' },
        { value: 'damage', label: 'Bond damage' },
        { value: 'displacement', label: 'Atom displacement' },
      ],
      value: params.colorBy,
      onChange: (v) => {
        params.colorBy = v as ColorBy;
        updateLegend();
        onChange();
        if (!loop.running) render();
      },
    });
    disposables.push(colorSelect);
    display.content.appendChild(colorSelect.element);
    speedSelect = createSelect({
      label: 'Simulation speed',
      options: SPEED_OPTIONS.map((v) => ({ value: String(v), label: `${v}×` })),
      value: String(params.speed),
      onChange: (v) => {
        params.speed = parseInt(v, 10);
        onChange();
      },
    });
    disposables.push(speedSelect);
    display.content.appendChild(speedSelect.element);
    trailsCheckbox = createCheckbox({
      label: 'Show atom trails (motion over the last moments)',
      checked: params.trails,
      onChange: (v) => {
        params.trails = v;
        trailFrames = [];
        onChange();
        if (!loop.running) render();
      },
    });
    disposables.push(trailsCheckbox);
    display.content.appendChild(trailsCheckbox.element);
    ghostCheckbox = createCheckbox({
      label: 'Show starting positions',
      checked: params.ghost,
      onChange: (v) => {
        params.ghost = v;
        onChange();
        if (!loop.running) render();
      },
    });
    disposables.push(ghostCheckbox);
    display.content.appendChild(ghostCheckbox.element);
    const curveRow = buttonRow(display.content);
    addButton(curveRow, 'Keep curve', keepCurve);
    addButton(curveRow, 'Clear curves', () => {
      stored = [];
      render();
    });
    controlsPanel.appendChild(display.element);
  }

  // --- lifecycle ----------------------------------------------------------
  function handleResize(): void {
    if (!loop.running) render();
  }

  const resizeObserver = new ResizeObserver(handleResize);
  resizeObserver.observe(viewPane);

  const loop = new AnimationLoop(() => {
    stepFrame();
    render();
  });
  view.onResize(() => {
    if (!loop.running) render();
  });
  plotCanvas.onResize(() => {
    if (!loop.running) render();
  });

  rebuild();
  updateVisibility();
  updateLegend();
  syncControls();

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
      window.clearTimeout(rebuildTimer);
      resizeObserver.disconnect();
      disposables.forEach((d) => d.dispose());
      view.dispose();
      plotCanvas.dispose();
      info.remove();
      legend.remove();
      viewPane.remove();
      plotPane.remove();
    },
    getParams: getParamRecord,
    setParams(p: Record<string, string>) {
      const keys = [
        'mode',
        'ductility',
        'D',
        'size',
        'depth',
        'round',
        'setup',
        'voidSize',
        'gripFrac',
      ] as const;
      const before = JSON.stringify(keys.map((k) => params[k]));
      parseParams(p, params);
      const after = JSON.stringify(keys.map((k) => params[k]));
      if (specimen) specimen.temperature = params.T;
      if (before !== after) {
        stored = [];
        rebuild();
      }
      syncControls();
    },
  };
}

export const fractureDemo: DemoDefinition = {
  id: 'fracture',
  title: 'Fracture, Fatigue and Creep',
  description:
    'Pull a notched or voided crystal apart and watch a crack grow, either with the whole plate loaded or with only the notch mouth pulled open. Tune bond range (brittle vs ductile), notch sharpness and temperature, then apply a constant stress (creep) or a cyclic stress (fatigue).',
  category: 'Mechanical',
  tags: [
    'fracture',
    'fatigue',
    'creep',
    'notch',
    'crack',
    'brittle',
    'ductile',
    'stress concentration',
  ],
  create,
};

export default fractureDemo;
