/**
 * Elastic and plastic deformation of an ionic crystal and of a glass (Lecture 12).
 *
 * One implementation, two registered demos: a tensile test on a 2D bar of
 *   - an ionic crystal (hexagonal AB2 layer: cations +2, anions -1), or
 *   - a Kob-Andersen glass quenched from the melt.
 * Strain control only: the right grip is displaced and the force is measured.
 * The engine is in bar.ts; this file is the UI (atom view, stress-strain plot).
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { Plot2D } from '@core/canvas/Plot2D';
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
  type ButtonControl,
} from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import { Bar, GlassPreparer, DT, type GlassSample, type Material } from './bar';

type Mode = 'elastic' | 'plastic';
type ColorMode = 'species' | 'rearrangement';

interface DemoParams {
  mode: Mode;
  /** Bar size, 0 to SIZES - 1 */
  size: number;
  /** Ionic: angle between the pulling axis and the close-packed rows (deg) */
  angle: number;
  T: number;
  /** log10 of the strain rate (per unit time) */
  logRate: number;
  notch: boolean;
  bonds: boolean;
  color: ColorMode;
  ghost: boolean;
}

function defaultParams(): DemoParams {
  return {
    mode: 'elastic',
    size: 1,
    angle: 0,
    T: 0.03,
    logRate: -2.4,
    notch: false,
    bonds: true,
    color: 'species',
    ghost: true,
  };
}

const MAX_STRAIN: Record<Mode, number> = { elastic: 0.03, plastic: 0.5 };
const COLOR_RANGE: Record<Mode, { pos: number; neg: number }> = {
  elastic: { pos: 0.04, neg: 0.02 },
  plastic: { pos: 0.25, neg: 0.08 },
};
/** Non-affine displacement (sigma^2) that saturates the rearrangement colour */
const D2_SATURATION = 0.25;
const MAX_STEPS_PER_FRAME = 40;
const MS_PER_PAIR_STEP = 7.6e-6;
const FRAME_BUDGET_MS = 8;
const FIT_STRAIN = 0.02;
const PALETTE_SIZE = 32;

/** Honeycomb unit cells per bar: [along, across] (two ions per cell) */
const IONIC_SIZES: [number, number][] = [
  [16, 10],
  [24, 14],
  [34, 20],
];
const GLASS_ATOMS = [400, 700, 1100];
const GLASS_ASPECT = 2.2;
const SIZE_LABELS: Record<Material, string[]> = {
  ionic: ['Small (~300 ions)', 'Medium (~620 ions)', 'Large (~1300 ions)'],
  glass: ['Small (400 atoms)', 'Medium (700 atoms)', 'Large (1100 atoms)'],
};

const COLOR_LOAD = '#ff6b6b';
const COLOR_UNLOAD = '#38bdf8';
const STORED_COLORS = ['#a3e635', '#c084fc', '#2dd4bf', '#fb923c'];
const COLOR_GRIP = '#8b93a1';
const SPECIES_COLORS: Record<Material, [string, string]> = {
  ionic: ['#ff6b6b', '#4a9eff'],
  glass: ['#4a9eff', '#ff9f4a'],
};
const BOND_NEUTRAL = [122, 127, 138];
const BOND_STRETCH = [255, 59, 48];
const BOND_COMPRESS = [59, 130, 246];

function mix(a: number[], b: number[], t: number): string {
  const c = a.map((v, i) => Math.round(v + (b[i]! - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const PALETTE_CSS: string[] = [];
for (let k = -PALETTE_SIZE; k <= PALETTE_SIZE; k++) {
  PALETTE_CSS.push(
    mix(BOND_NEUTRAL, k >= 0 ? BOND_STRETCH : BOND_COMPRESS, Math.abs(k) / PALETTE_SIZE)
  );
}
function paletteIndex(strain: number, range: { pos: number; neg: number }): number {
  const t = strain >= 0 ? strain / range.pos : strain / range.neg;
  return Math.round(clamp(t, -1, 1) * PALETTE_SIZE) + PALETTE_SIZE;
}

/** Rearrangement colour: dark blue-grey, through orange, to yellow */
const D2_CSS: string[] = [];
for (let k = 0; k <= 24; k++) {
  const t = k / 24;
  D2_CSS.push(
    t < 0.5
      ? mix([52, 62, 92], [255, 140, 30], t / 0.5)
      : mix([255, 140, 30], [255, 240, 120], (t - 0.5) / 0.5)
  );
}

/** Glass samples are expensive to quench, so each size is made once per page visit */
const glassCache = new Map<number, GlassSample>();

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

function num(v: string | undefined, lo: number, hi: number, fallback: number): number {
  const x = v === undefined ? NaN : parseFloat(v);
  return clamp(Number.isFinite(x) ? x : fallback, lo, hi);
}

function parseParams(src: Record<string, string>, params: DemoParams): void {
  if (src.mode === 'elastic' || src.mode === 'plastic') params.mode = src.mode;
  params.size = Math.round(num(src.size, 0, 2, params.size));
  params.angle = Math.round(num(src.angle, 0, 30, params.angle));
  params.T = num(src.T, 0, 0.5, params.T);
  params.logRate = num(src.logRate, -3.3, -1.5, params.logRate);
  if (src.notch !== undefined) params.notch = src.notch === 'true';
  if (src.bonds !== undefined) params.bonds = src.bonds === 'true';
  if (src.color === 'species' || src.color === 'rearrangement') params.color = src.color;
  if (src.ghost !== undefined) params.ghost = src.ghost === 'true';
}

function create(
  container: HTMLElement,
  options: DemoCreateOptions,
  material: Material
): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;
  const params = defaultParams();
  parseParams(options.getParams(), params);
  const ionic = material === 'ionic';

  // --- layout: atom view on the left, plot on the right ---------------------------------
  container.style.display = 'flex';
  const viewPane = document.createElement('div');
  viewPane.style.cssText = 'position:relative;flex:1 1 0;min-width:0;height:100%;overflow:hidden;';
  const plotPane = document.createElement('div');
  plotPane.style.cssText =
    'position:relative;flex:0 0 42%;min-width:0;height:100%;overflow:hidden;border-left:1px solid #222;';
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
    'position:absolute;color:#ddd;font:13px -apple-system,BlinkMacSystemFont,sans-serif;' +
    'line-height:1.45;pointer-events:none;text-shadow:0 1px 2px #000;';
  const info = document.createElement('div');
  info.style.cssText = overlayCss + 'top:8px;left:10px;';
  viewPane.appendChild(info);
  const legend = document.createElement('div');
  legend.style.cssText = overlayCss + 'bottom:8px;left:10px;font-size:12px;color:#aaa;';
  viewPane.appendChild(legend);

  // --- state ------------------------------------------------------------------------------
  let seed = 1;
  let bar: Bar | null = null;
  let prep: GlassPreparer | null = null;
  let samples: Sample[] = [{ strain: 0, stress: 0, unloading: false }];
  let stored: StoredCurve[] = [];
  let targetStrain = 0;
  let gripFree = false;
  let freeFrames = 0;
  let pendingSet = false;
  let pulling = false;
  let releasing = false;
  let fractured = false;
  let fractureStrain = 0;
  let permanentSet: number | null = null;
  let frame = 0;
  let cn: Uint8Array = new Uint8Array(0);
  let d2 = new Float64Array(0);
  let yTop = 1;
  let lastUx = 0;
  let releaseFrames = 0;
  let ramp = 0;
  let tempTimer: number | undefined;
  let disposed = false;

  const sliders: Record<string, SliderControl> = {};
  const selects: Record<string, SelectControl> = {};
  const checks: Record<string, CheckboxControl> = {};
  let pullButton: ButtonControl | null = null;
  let angleBox: HTMLElement | null = null;
  const disposables: Disposable[] = [];

  const maxStrain = (): number => MAX_STRAIN[params.mode];
  const elastic = (): boolean => params.mode === 'elastic';

  // --- bar construction ---------------------------------------------------------------------
  function buildBar(glass?: GlassSample): void {
    const [nx, ny] = IONIC_SIZES[params.size]!;
    bar = new Bar({
      material,
      angle: params.angle,
      notch: params.notch,
      nx,
      ny,
      temperature: params.T,
      seed: seed++,
      glass,
    });
    cn = bar.coordination();
    d2 = new Float64Array(bar.n);
    bar.nonAffine(d2);
    lastUx = 0;
  }

  /** (Re)creates the bar and clears the loading history. */
  function rebuild(): void {
    pulling = false;
    releasing = false;
    fractured = false;
    gripFree = false;
    pendingSet = false;
    permanentSet = null;
    targetStrain = 0;
    ramp = 0;
    freeFrames = 0;
    releaseFrames = 0;
    samples = [{ strain: 0, stress: 0, unloading: false }];
    yTop = 1;
    pullButton?.setLabel('Pull');
    sliders.strain?.setValue(0);
    if (ionic) {
      buildBar();
      prep = null;
    } else {
      const n = GLASS_ATOMS[params.size]!;
      const cached = glassCache.get(n);
      if (cached) {
        prep = null;
        buildBar(cached);
      } else {
        bar = null;
        prep = new GlassPreparer(n, GLASS_ASPECT);
      }
    }
  }

  function stopPulling(): void {
    pulling = false;
    pullButton?.setLabel('Pull');
  }

  function stepFrame(): void {
    if (!bar) return;
    const steps = clamp(
      Math.floor(FRAME_BUDGET_MS / (bar.pairCount * MS_PER_PAIR_STEP)),
      4,
      MAX_STEPS_PER_FRAME
    );
    const dtFrame = steps * DT;
    const rate = Math.pow(10, params.logRate);
    const maxS = maxStrain();

    // Ease into the motion so starting does not send a shock wave through the bar
    ramp = releasing || (pulling && !fractured) ? Math.min(1, ramp + dtFrame / 3) : 0;

    if (!gripFree) {
      if (releasing) {
        targetStrain = Math.max(0, bar.strain - rate * ramp * dtFrame);
        releaseFrames = bar.stress <= 0.04 ? releaseFrames + 1 : 0;
        if (bar.strain <= 0.0005 || releaseFrames >= 6) {
          releasing = false;
          gripFree = true;
          pendingSet = true;
          freeFrames = 0;
          targetStrain = bar.strain;
        }
      } else if (pulling && !fractured) {
        targetStrain = Math.min(maxS, targetStrain + rate * ramp * dtFrame);
        if (targetStrain >= maxS) stopPulling();
      }
    }
    if (fractured && pulling) stopPulling();

    bar.temperature = params.T;
    bar.advance(steps, targetStrain * bar.gauge, 2 * rate * bar.gauge, gripFree);
    frame++;

    if (gripFree) sliders.strain?.setValue(clamp(bar.strain / maxS, 0, 1));
    else if (pulling || releasing) sliders.strain?.setValue(clamp(targetStrain / maxS, 0, 1));

    // Permanent set: strain left once the bar has settled with no external force
    if (pendingSet && gripFree) {
      freeFrames++;
      if (freeFrames >= 60) {
        permanentSet = Math.max(0, bar.strainSmooth);
        pendingSet = false;
      }
    }

    // Record the curve
    const last = samples[samples.length - 1];
    let unloading = last?.unloading ?? false;
    if (!gripFree) {
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

    if (frame % 4 === 0) {
      cn = bar.coordination();
      bar.nonAffine(d2);
    }
    if (!fractured && frame % 8 === 0 && (!bar.isConnected() || bar.intactFraction() < 0.3)) {
      fractured = true;
      fractureStrain = bar.strain;
      stopPulling();
      releasing = false;
      samples.push({ strain: bar.strain, stress: 0, unloading: false });
    }
  }

  /** Elastic modulus from the initial loading slope (through the origin) */
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

  function peakStress(): number {
    let peak = 0;
    for (const s of samples) if (!s.unloading && s.stress > peak) peak = s.stress;
    return peak;
  }

  /** Work per unit area (2D) done on the bar while loading: area under the loading curve */
  function workDone(): number {
    let w = 0;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!;
      const b = samples[i]!;
      if (b.unloading || a.unloading) continue;
      w += 0.5 * (a.stress + b.stress) * (b.strain - a.strain);
    }
    return w;
  }

  // --- rendering --------------------------------------------------------------------------
  function render(): void {
    renderView();
    renderPlot();
    updateInfo();
  }

  function renderView(): void {
    const ctx = view.ctx;
    const w = view.width;
    const h = view.height;
    view.clear();
    if (w === 0 || h === 0) return;
    if (!bar) {
      ctx.save();
      ctx.fillStyle = '#ddd';
      ctx.font = '14px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center';
      const pct = prep ? Math.round(prep.progress * 100) : 0;
      ctx.fillText(`Quenching the glass from the melt… ${pct} %`, w / 2, h / 2 - 12);
      ctx.fillStyle = '#333';
      ctx.fillRect(w / 2 - 120, h / 2, 240, 6);
      ctx.fillStyle = '#7CFF9F';
      ctx.fillRect(w / 2 - 120, h / 2, 2.4 * pct, 6);
      ctx.restore();
      return;
    }
    const viewStrain = elastic() ? 0.08 : 0.3;
    const worldH = bar.ly + 3;
    const sBase = Math.min((w - 20) / (bar.lx * (1 + viewStrain) + 3), (h - 90) / worldH);
    const sFit = (w - 20) / (bar.lx + bar.ux + 3);
    const s = Math.min(sBase, sFit);
    const ox = 10 + 1.2 * s;
    const oy = h / 2 + 10 + (bar.ly / 2) * s;
    const X = (x: number) => ox + x * s;
    const Y = (y: number) => oy - y * s;
    const { pos, ref, role, type } = bar;

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

    if (params.bonds) {
      const range = COLOR_RANGE[params.mode];
      ctx.lineWidth = Math.max(1.5, 0.16 * bar.a * s);
      ctx.lineCap = 'round';
      for (const b of bar.bonds()) {
        ctx.strokeStyle = PALETTE_CSS[paletteIndex(b.strain, range)]!;
        ctx.beginPath();
        ctx.moveTo(X(pos[3 * b.i]!), Y(pos[3 * b.i + 1]!));
        ctx.lineTo(X(pos[3 * b.j]!), Y(pos[3 * b.j + 1]!));
        ctx.stroke();
      }
    }

    const [c0, c1] = SPECIES_COLORS[material];
    const baseR = (params.bonds ? 0.27 : 0.4) * bar.a * s;
    for (let i = 0; i < bar.n; i++) {
      let color: string;
      if (role[i] !== 0) color = COLOR_GRIP;
      else if (params.color === 'rearrangement') {
        color = D2_CSS[Math.round(clamp(d2[i]! / D2_SATURATION, 0, 1) * 24)]!;
      } else color = type[i] === 0 ? c0 : c1;
      ctx.fillStyle = color;
      // under-coordinated (surface) atoms get a thin ring
      ctx.beginPath();
      const radius = baseR;
      ctx.arc(X(pos[3 * i]!), Y(pos[3 * i + 1]!), radius, 0, Math.PI * 2);
      ctx.fill();
      if (cn[i]! < (ionic ? 3 : 4) && role[i] === 0 && params.color === 'species') {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    ctx.fillStyle = '#9aa';
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const labelY = Math.min(oy + (bar.ly / 2 + 0.8) * s, h - 70);
    ctx.fillText('fixed grip', X(0), labelY);
    ctx.textAlign = 'right';
    ctx.fillText('pulled grip', X(bar.lx + bar.ux + 0.5 * bar.a), labelY);
    const arrow = clamp(bar.forceSmooth / (3 * bar.area), 0, 1) * 70;
    if (arrow > 4) {
      const fx = bar.lx + bar.ux + 0.9;
      const ay = Y(bar.ly / 2);
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

  /** Plot x range: a few fixed steps in plastic mode, so the curve fills the plot */
  function plotXMax(): number {
    if (elastic()) return maxStrain();
    let reached = 0;
    for (const s of samples) reached = Math.max(reached, s.strain);
    for (const c of stored) for (const e of c.strain) reached = Math.max(reached, e);
    const steps = [0.1, 0.2, 0.3, 0.5];
    return steps.find((v) => v >= reached * 1.05) ?? 0.5;
  }

  function renderPlot(): void {
    const ctx = plotCanvas.ctx;
    const w = plotCanvas.width;
    const h = plotCanvas.height;
    plotCanvas.clear();
    if (w === 0 || h === 0 || !bar) return;

    for (const s of samples) yTop = Math.max(yTop, s.stress * 1.12);
    for (const c of stored) for (const v of c.stress) yTop = Math.max(yTop, v * 1.12);
    const xMax = plotXMax();
    plot.setSize(w, h);
    plot.setBounds({ xMin: 0, xMax, yMin: 0, yMax: yTop });
    const xTicks = Plot2D.generateTicks(0, xMax, 5);
    const yTicks = Plot2D.generateTicks(0, yTop, 5);
    plot.drawGrid(xTicks, yTicks);
    plot.drawAxes('Strain ε', 'Stress (ε/σ²)');
    plot.drawTickLabels(
      xTicks,
      yTicks,
      (v) => (v * 100).toFixed(xMax <= 0.05 ? 1 : 0) + '%',
      (v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1))
    );

    ctx.save();
    ctx.font = '600 13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = '#ddd';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('Stress–strain curve', 14, 10);
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

    const left = plot.toCanvasX(0);
    const right = plot.toCanvasX(xMax);
    const topY = plot.toCanvasY(yTop);
    const bottomY = plot.toCanvasY(0);
    ctx.beginPath();
    ctx.rect(left, topY, right - left, bottomY - topY);
    ctx.clip();

    const modulus = fitModulus();
    if (modulus !== null) {
      const xEnd = Math.min(xMax, yTop / modulus);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(plot.toCanvasX(0), plot.toCanvasY(0));
      ctx.lineTo(plot.toCanvasX(xEnd), plot.toCanvasY(modulus * xEnd));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const c of stored) plot.drawLine(c.strain, c.stress, c.color, 1.8);

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
      const p = [s.strain, s.stress];
      if (i > 0 && s.unloading !== runUnloading) {
        const prev = run[run.length - 1];
        flush();
        run = prev ? [prev] : [];
      }
      runUnloading = s.unloading;
      run.push(p);
    });
    flush();

    const lastSample = samples[samples.length - 1];
    plot.drawPoint(
      bar.strainSmooth,
      fractured ? 0 : bar.stress,
      5,
      releasing || lastSample?.unloading ? COLOR_UNLOAD : COLOR_LOAD
    );
    ctx.restore();

    if (fractured) {
      ctx.save();
      ctx.font = '600 13px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = '#ff6b6b';
      ctx.textAlign = 'right';
      ctx.fillText(
        'fracture',
        Math.min(plot.toCanvasX(fractureStrain) + 30, plot.toCanvasX(plotXMax())),
        plot.toCanvasY(0) - 10
      );
      ctx.restore();
    }
  }

  function updateInfo(): void {
    if (!bar) {
      info.innerHTML = '';
      return;
    }
    const E = fitModulus();
    const unit = 'ε/σ²';
    const lines: string[] = [];
    lines.push(
      ionic
        ? `<b>Ionic crystal</b> (hexagonal AB layer, honeycomb) · ${bar.n} ions · pull at ${params.angle}° to the zigzag rows`
        : `<b>Covalent-like glass</b> (stiff bond network) · ${bar.n} atoms`
    );
    const stress = fractured ? 0 : bar.stress;
    lines.push(
      `Strain ε = ${(bar.strain * 100).toFixed(1)} % (Δ = ${bar.ux.toFixed(2)} σ) · ` +
        (gripFree
          ? 'grip released: no external force, stress = 0'
          : `stress = ${stress.toFixed(2)} ${unit}`)
    );
    if (E !== null) lines.push(`Modulus E ≈ ${E.toFixed(0)} ${unit}`);
    const peak = peakStress();
    if (!elastic() && peak > 0.2) {
      lines.push(
        `Strength (peak stress) = ${peak.toFixed(2)} ${unit} · work done = ${workDone().toFixed(3)} ${unit}`
      );
    }
    if (permanentSet !== null) {
      lines.push(
        `After release: permanent set = ${(permanentSet * 100).toFixed(1)} %` +
          (permanentSet < 0.004 ? ' (fully elastic)' : ' (plastic deformation)')
      );
    }
    if (fractured) {
      lines.push(
        `<span style="color:#ff6b6b">Fractured at ε = ${(fractureStrain * 100).toFixed(0)} %</span>`
      );
    }
    info.innerHTML = lines.join('<br>');
  }

  function updateLegend(): void {
    const range = COLOR_RANGE[params.mode];
    const swatch = (color: string) =>
      `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:5px"></span>`;
    const gradient = `linear-gradient(to right, ${PALETTE_CSS[0]}, ${PALETTE_CSS[PALETTE_SIZE]}, ${PALETTE_CSS[2 * PALETTE_SIZE]})`;
    const [c0, c1] = SPECIES_COLORS[material];
    const species = ionic
      ? `${swatch(c0)}cation + &nbsp; ${swatch(c1)}anion −`
      : `${swatch(c0)}A &nbsp; ${swatch(c1)}B`;
    const atomKey =
      params.color === 'rearrangement'
        ? `${swatch(D2_CSS[0]!)}elastic &nbsp; ${swatch(D2_CSS[12]!)}${swatch(D2_CSS[24]!)}rearranged (slip / flow)`
        : species;
    legend.innerHTML =
      `<div>${swatch(COLOR_GRIP)}grip &nbsp; ${atomKey}</div>` +
      `<div style="display:flex;align-items:center;gap:6px;margin-top:3px"><span>−${(range.neg * 100).toFixed(0)} %</span>` +
      `<span style="display:inline-block;width:130px;height:8px;border-radius:4px;background:${gradient}"></span>` +
      `<span>+${(range.pos * 100).toFixed(0)} %</span><span>&nbsp;bond length change</span></div>`;
  }

  // --- controls ---------------------------------------------------------------------------
  function getParamRecord(): Record<string, string> {
    return {
      mode: params.mode,
      size: String(params.size),
      angle: String(params.angle),
      T: params.T.toFixed(2),
      logRate: params.logRate.toFixed(1),
      notch: String(params.notch),
      bonds: String(params.bonds),
      color: params.color,
      ghost: String(params.ghost),
    };
  }

  function onChange(): void {
    options.setParams(getParamRecord());
  }

  function syncControls(): void {
    selects.mode?.setValue(params.mode);
    selects.size?.setValue(String(params.size));
    selects.color?.setValue(params.color);
    sliders.angle?.setValue(params.angle);
    sliders.T?.setValue(params.T);
    sliders.rate?.setValue(params.logRate);
    checks.notch?.setChecked(params.notch);
    checks.bonds?.setChecked(params.bonds);
    checks.ghost?.setChecked(params.ghost);
    updateLegend();
  }

  function addButton(
    parent: HTMLElement,
    label: string,
    onClick: () => void,
    primary = false
  ): ButtonControl {
    const b = createButton({ label, onClick, variant: primary ? 'primary' : 'secondary' });
    disposables.push(b);
    parent.appendChild(b.element);
    return b;
  }

  if (controlsPanel) {
    controlsPanel.appendChild(
      createHelperText(
        ionic
          ? 'Pull a bar of an AB ionic crystal with hexagonal (honeycomb) layers, like hexagonal BN. Elastic regime: stretch and release, nothing is left over. Plastic regime: keep pulling until it cleaves, with no flow. Compare with the glass demo.'
          : 'Pull a bar of a covalent-like glass: a disordered network of stiff bonds that snap for good when over-stretched. Elastic regime: stretch and release, nothing is left over. Plastic regime: keep pulling until it fractures. Compare with the ionic crystal demo.'
      )
    );

    const materialSec = createSection({ title: 'Material and test' });
    disposables.push(materialSec);
    selects.mode = createSelect({
      label: 'Regime',
      options: [
        { value: 'elastic', label: 'Elastic (small strain, reversible)' },
        { value: 'plastic', label: 'Plastic (large strain, flow, fracture)' },
      ],
      value: params.mode,
      onChange: (v) => {
        params.mode = v as Mode;
        targetStrain = Math.min(targetStrain, maxStrain());
        updateLegend();
        rebuild();
        onChange();
      },
    });
    disposables.push(selects.mode);
    materialSec.content.appendChild(selects.mode.element);

    selects.size = createSelect({
      label: 'Size',
      options: SIZE_LABELS[material].map((label, i) => ({ value: String(i), label })),
      value: String(params.size),
      onChange: (v) => {
        params.size = parseInt(v, 10);
        rebuild();
        onChange();
      },
    });
    disposables.push(selects.size);
    materialSec.content.appendChild(selects.size.element);

    sliders.T = createSlider({
      label: 'Temperature',
      min: 0,
      max: 0.5,
      step: 0.01,
      value: params.T,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        params.T = v;
        onChange();
        // the stress-free reference depends on temperature, so rebuild once the slider rests
        window.clearTimeout(tempTimer);
        tempTimer = window.setTimeout(() => rebuild(), 400);
      },
    });
    disposables.push(sliders.T);
    materialSec.content.appendChild(sliders.T.element);

    if (ionic) {
      angleBox = document.createElement('div');
      sliders.angle = createSlider({
        label: 'Pull direction (0° = zigzag rows, 30° = armchair)',
        min: 0,
        max: 30,
        step: 5,
        value: params.angle,
        format: (v) => `${v.toFixed(0)}°`,
        onChange: (v) => {
          params.angle = Math.round(v);
          rebuild();
          onChange();
        },
      });
      disposables.push(sliders.angle);
      angleBox.appendChild(sliders.angle.element);
      materialSec.content.appendChild(angleBox);
    }

    checks.notch = createCheckbox({
      label: 'Notch in the top edge',
      checked: params.notch,
      onChange: (c) => {
        params.notch = c;
        rebuild();
        onChange();
      },
    });
    disposables.push(checks.notch);
    materialSec.content.appendChild(checks.notch.element);
    if (!ionic) {
      // forget the cached sample so rebuild() quenches a new glass from the melt
      addButton(materialSec.content, 'New glass (re-quench from the melt)', () => {
        glassCache.delete(GLASS_ATOMS[params.size]!);
        rebuild();
      });
    }
    controlsPanel.appendChild(materialSec.element);

    const loading = createSection({ title: 'Loading' });
    disposables.push(loading);
    sliders.strain = createSlider({
      label: 'Applied strain',
      min: 0,
      max: 1,
      step: 0.001,
      value: 0,
      format: (v) => `${(v * maxStrain() * 100).toFixed(1)} %`,
      onChange: (v) => {
        stopPulling();
        releasing = false;
        gripFree = false;
        pendingSet = false;
        permanentSet = null;
        targetStrain = v * maxStrain();
      },
    });
    disposables.push(sliders.strain);
    loading.content.appendChild(sliders.strain.element);

    sliders.rate = createSlider({
      label: 'Loading rate',
      min: -3.3,
      max: -1.5,
      step: 0.1,
      value: params.logRate,
      format: (v) => `${(Math.pow(10, v) * 100).toFixed(2)} % / τ`,
      onChange: (v) => {
        params.logRate = v;
        onChange();
      },
    });
    disposables.push(sliders.rate);
    loading.content.appendChild(sliders.rate.element);

    pullButton = addButton(
      loading.content,
      'Pull',
      () => {
        if (!bar || fractured) return;
        if (pulling) {
          stopPulling();
        } else {
          releasing = false;
          if (gripFree) {
            gripFree = false;
            targetStrain = bar.strain;
          }
          pendingSet = false;
          permanentSet = null;
          pulling = true;
          pullButton?.setLabel('Pause');
        }
      },
      true
    );
    addButton(loading.content, 'Release (unload)', () => {
      if (!bar || fractured) return;
      stopPulling();
      gripFree = false;
      releasing = true;
      releaseFrames = 0;
      ramp = 0;
      targetStrain = bar.strain;
    });
    addButton(loading.content, 'Reset', () => {
      rebuild();
    });
    addButton(loading.content, 'Keep this curve for comparison', () => {
      if (samples.length < 3) return;
      const n = stored.length;
      stored.push({
        label: `${params.T.toFixed(2)}${ionic ? ` / ${params.angle}°` : ''}${params.notch ? ' notch' : ''}`,
        color: STORED_COLORS[n % STORED_COLORS.length]!,
        strain: samples.map((s) => s.strain),
        stress: samples.map((s) => s.stress),
      });
      if (stored.length > STORED_COLORS.length) stored.shift();
    });
    addButton(loading.content, 'Clear kept curves', () => {
      stored = [];
    });
    controlsPanel.appendChild(loading.element);

    const display = createSection({ title: 'Display' });
    disposables.push(display);
    selects.color = createSelect({
      label: 'Colour atoms by',
      options: [
        { value: 'species', label: ionic ? 'Charge (cation / anion)' : 'Species (A / B)' },
        { value: 'rearrangement', label: 'Rearrangement (slip, flow, cracks)' },
      ],
      value: params.color,
      onChange: (v) => {
        params.color = v as ColorMode;
        updateLegend();
        onChange();
      },
    });
    disposables.push(selects.color);
    display.content.appendChild(selects.color.element);
    checks.bonds = createCheckbox({
      label: 'Show bonds (coloured by stretch)',
      checked: params.bonds,
      onChange: (c) => {
        params.bonds = c;
        onChange();
      },
    });
    disposables.push(checks.bonds);
    display.content.appendChild(checks.bonds.element);
    checks.ghost = createCheckbox({
      label: 'Show undeformed positions',
      checked: params.ghost,
      onChange: (c) => {
        params.ghost = c;
        onChange();
      },
    });
    disposables.push(checks.ghost);
    display.content.appendChild(checks.ghost.element);
    controlsPanel.appendChild(display.element);
  }

  updateLegend();
  rebuild();

  const loop = new AnimationLoop(() => {
    if (disposed) return;
    if (!bar && prep) {
      if (prep.advance(10)) {
        const n = GLASS_ATOMS[params.size]!;
        const sample = prep.sample();
        glassCache.set(n, sample);
        prep = null;
        buildBar(sample);
      }
    } else {
      stepFrame();
    }
    render();
  });

  function handleResize(): void {
    if (loop.running) render();
  }
  view.onResize(handleResize);
  plotCanvas.onResize(handleResize);

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
      disposed = true;
      window.clearTimeout(tempTimer);
      loop.dispose();
      disposables.forEach((d) => d.dispose());
      view.dispose();
      plotCanvas.dispose();
      container.style.display = '';
      viewPane.remove();
      plotPane.remove();
    },
    getParams() {
      return getParamRecord();
    },
    setParams(newParams: Record<string, string>) {
      parseParams(newParams, params);
      syncControls();
      rebuild();
    },
  };
}

export const ionicDeformationDemo: DemoDefinition = {
  id: 'deformation-ionic',
  title: 'Elastic and Plastic Deformation of an Ionic Ceramic',
  description:
    'Tensile test on a 2D AB ionic crystal with hexagonal (honeycomb) layers: very stiff and elastic up to a high stress, then sharp brittle fracture with no plastic flow. Try a notch and different pull directions.',
  category: 'Mechanical behavior',
  tags: ['ceramics', 'ionic', 'brittle', 'fracture', 'elastic', 'molecular dynamics'],
  create: (container, options) => create(container, options, 'ionic'),
};

export const glassDeformationDemo: DemoDefinition = {
  id: 'deformation-glass',
  title: 'Elastic and Plastic Deformation of a Covalent Glass',
  description:
    'Tensile test on a 2D covalent-like glass: a very stiff amorphous network of bonds that cannot flow, so it is elastic up to a sharp fracture. Compare with the ionic crystal.',
  category: 'Mechanical behavior',
  tags: ['glass', 'amorphous', 'covalent', 'brittle', 'fracture', 'elastic', 'molecular dynamics'],
  create: (container, options) => create(container, options, 'glass'),
};
