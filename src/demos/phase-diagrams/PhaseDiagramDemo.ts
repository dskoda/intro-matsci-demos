/**
 * Phase diagrams and microstructure (Lecture 8: Phase diagrams).
 *
 * Left: a binary T–x phase diagram (isomorphous Cu–Ni or a model eutectic),
 * computed from the convex hull of ideal-solution free energies. Click or drag
 * to choose the alloy composition C₀ and temperature T; in two-phase fields the
 * tie line and lever rule are drawn. Right: a lattice Monte Carlo simulation
 * with the same free energies, where each pixel is an atom in a phase. The
 * phase fractions and compositions measured in the simulation can be overlaid
 * on the diagram. Cooling and heating paths, with slow solid diffusion, show
 * how the microstructure develops (and cores) on solidification.
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import { Plot2D } from '@core/canvas/Plot2D';
import {
  createSlider,
  createSelect,
  createButton,
  createCheckbox,
  type Disposable,
} from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import {
  K0,
  L,
  PHASE_NAMES,
  SYSTEMS,
  buildDiagram,
  equilibrium,
  type Diagram,
  type Equilibrium,
  type SystemDef,
} from './thermo';
import { LatticeMC, N, INERT } from './latticeMC';

type SysId = SystemDef['id'];

interface DemoParams {
  sys: SysId;
  x: number;
  T: number;
  view: 'phase' | 'comp' | 'both';
  rate: number;
  dsol: number;
  speed: number;
  inoc: boolean;
  tie: boolean;
  mc: boolean;
  seed: number;
}

const START: Record<SysId, { x: number; T: number }> = {
  iso: { x: 0.35, T: 1350 },
  eut: { x: 0.4, T: 750 },
};

const defaultParams: DemoParams = {
  sys: 'iso',
  x: START.iso.x,
  T: START.iso.T,
  view: 'phase',
  rate: 5,
  dsol: 0,
  speed: 20,
  inoc: true,
  tie: true,
  mc: true,
  seed: 1,
};

const N_INOC = 12;
/** Phase fraction below which a phase counts as thermal speckle, not as present */
const MIN_FRAC = 0.05;
const BG: [number, number, number] = [11, 14, 20];
const PHASE_RGB: [number, number, number][] = [
  [86, 132, 201], // L
  [245, 158, 66], // α
  [74, 194, 128], // β
];
const INERT_RGB: [number, number, number] = [12, 12, 14];

const rgb = (c: [number, number, number], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

function num(v: string | undefined, lo: number, hi: number, fb: number): number {
  const x = parseFloat(v ?? '');
  return clamp(Number.isFinite(x) ? x : fb, lo, hi);
}

function parseParams(src: Record<string, string>, p: DemoParams): void {
  if (src.sys === 'iso' || src.sys === 'eut') p.sys = src.sys;
  const sys = SYSTEMS[p.sys];
  if (src.x !== undefined) p.x = num(src.x, 0.005, 0.995, START[p.sys].x);
  if (src.T !== undefined)
    p.T = Math.round(num(src.T, sys.Tmin - K0, sys.Tmax - K0, START[p.sys].T));
  if (src.view === 'phase' || src.view === 'comp' || src.view === 'both') p.view = src.view;
  if (src.rate !== undefined) p.rate = num(src.rate, 1, 50, defaultParams.rate);
  if (src.dsol !== undefined) p.dsol = num(src.dsol, -3, 0, defaultParams.dsol);
  if (src.speed !== undefined) p.speed = Math.round(num(src.speed, 1, 60, defaultParams.speed));
  if (src.inoc !== undefined) p.inoc = src.inoc !== 'false';
  if (src.tie !== undefined) p.tie = src.tie !== 'false';
  if (src.mc !== undefined) p.mc = src.mc !== 'false';
  if (src.seed !== undefined) p.seed = Math.round(num(src.seed, 1, 9999, defaultParams.seed));
}

function toRecord(p: DemoParams): Record<string, string> {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]));
}

/** Composition colormap (fraction B): dark violet → teal → yellow */
const CMAP: [number, number, number][] = [
  [40, 20, 80],
  [60, 80, 160],
  [40, 160, 160],
  [140, 210, 90],
  [250, 230, 60],
];
function cmap(v: number): [number, number, number] {
  const t = clamp(v, 0, 1) * (CMAP.length - 1);
  const k = Math.min(CMAP.length - 2, Math.floor(t));
  const u = t - k;
  const a = CMAP[k]!;
  const b = CMAP[k + 1]!;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

function regionImage(d: Diagram): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = d.cols;
  c.height = d.rows;
  const g = c.getContext('2d')!;
  const im = g.createImageData(d.cols, d.rows);
  const tints = d.regions.map((name) => {
    const ph = name.split(' + ').map((s) => PHASE_NAMES.indexOf(s));
    const a = ph.length === 1 ? 0.3 : 0.14;
    const col = [0, 1, 2].map((k) => ph.reduce((s, p) => s + PHASE_RGB[p]![k]!, 0) / ph.length);
    return col.map((v, k) => BG[k]! * (1 - a) + v * a);
  });
  for (let r = 0; r < d.rows; r++) {
    for (let k = 0; k < d.cols; k++) {
      const t = tints[d.raster[r * d.cols + k]!]!;
      const o = ((d.rows - 1 - r) * d.cols + k) * 4;
      im.data[o] = t[0]!;
      im.data[o + 1] = t[1]!;
      im.data[o + 2] = t[2]!;
      im.data[o + 3] = 255;
    }
  }
  g.putImageData(im, 0, 0);
  return c;
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  const params: DemoParams = { ...defaultParams };
  parseParams(options.getParams(), params);

  const diagrams: Partial<Record<SysId, { d: Diagram; img: HTMLCanvasElement }>> = {};
  function diagramFor(id: SysId) {
    let entry = diagrams[id];
    if (!entry) {
      const d = buildDiagram(SYSTEMS[id]);
      entry = { d, img: regionImage(d) };
      diagrams[id] = entry;
    }
    return entry;
  }

  let sys = SYSTEMS[params.sys];
  let mc = new LatticeMC(sys, params.seed);
  let eq: Equilibrium = equilibrium(sys, params.x, params.T + K0);
  let frame = 0;
  let ramp = 0; // −1 cooling, +1 heating
  let lastSweeps = 0;

  // Smoothed Monte Carlo measurements
  let emaFrac: number[] = [];
  let emaX: number[] = [];
  let emaFresh = true;

  // Cooling/heating path and measured phase compositions along it
  const path: { x: number; T: number }[] = [];
  const trail: { x: number; T: number; p: number }[] = [];

  // Pointer state
  let dragging = false;
  let hover: { x: number; T: number } | null = null;

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0b0e14', autoResize: true });
  const plot = new Plot2D(canvas.ctx, {
    bounds: { xMin: 0, xMax: 100, yMin: 0, yMax: 1 },
    margins: { top: 16, right: 16, bottom: 42, left: 64 },
  });
  const layout = { dx: 0, dy: 0, dw: 1, dh: 1, mx: 0, my: 0, ms: 1, ry: 0, wide: true };

  const img = document.createElement('canvas');
  img.width = N;
  img.height = N;
  const imgCtx = img.getContext('2d')!;
  const imgData = imgCtx.createImageData(N, N);
  const local = new Float32Array(N * N);

  const disposables: Disposable[] = [];
  const sliders: Record<string, ReturnType<typeof createSlider>> = {};
  const selects: Record<string, ReturnType<typeof createSelect>> = {};
  const checks: Record<string, ReturnType<typeof createCheckbox>> = {};
  let tHost: HTMLElement | null = null;

  function updateUrl() {
    options.setParams(toRecord(params));
  }

  function clearPath() {
    path.length = 0;
    trail.length = 0;
  }

  /** New Monte Carlo lattice at the current state. Starts liquid wherever liquid is stable. */
  function resetMC(melt = false) {
    ramp = 0;
    mc = new LatticeMC(sys, params.seed);
    mc.dSolid = Math.pow(10, params.dsol);
    eq = equilibrium(sys, params.x, params.T + K0);
    let p0: number = L;
    if (!melt && !eq.phases.some((ph) => ph.phase === L)) {
      p0 = eq.phases.reduce((a, b) => (b.w > a.w ? b : a)).phase;
    }
    mc.reset(params.x, params.T + K0, p0, params.inoc ? N_INOC : 0);
    emaFresh = true;
    clearPath();
  }

  function setState(x: number, T: number, fromPointer: boolean) {
    const Tc = Math.round(clamp(T, sys.Tmin - K0, sys.Tmax - K0));
    const xc = clamp(x, 0.005, 0.995);
    if (fromPointer) {
      ramp = 0;
      clearPath();
    }
    if (xc !== params.x) {
      params.x = xc;
      mc.setComposition(xc);
    }
    if (Tc !== params.T) {
      params.T = Tc;
      mc.setT(Tc + K0);
    }
    eq = equilibrium(sys, params.x, params.T + K0);
    sliders.x?.setValue(Math.round(params.x * 1000) / 10);
    sliders.T?.setValue(params.T);
    if (ramp === 0) updateUrl();
  }

  function setSystem(id: SysId) {
    params.sys = id;
    sys = SYSTEMS[id];
    params.x = START[id].x;
    params.T = START[id].T;
    buildTSlider();
    sliders.x?.setValue(params.x * 100);
    resetMC();
    updateUrl();
  }

  function buildTSlider() {
    if (!tHost) return;
    sliders.T?.dispose();
    tHost.innerHTML = '';
    const s = createSlider({
      label: 'Temperature T',
      min: Math.round(sys.Tmin - K0),
      max: Math.round(sys.Tmax - K0),
      step: 1,
      value: params.T,
      format: (v) => v.toFixed(0) + ' °C',
      onChange: (v) => setState(params.x, v, true),
    });
    sliders.T = s;
    tHost.appendChild(s.element);
  }

  function startRamp(dir: number) {
    if (ramp === 0) clearPath();
    ramp = dir;
  }

  function stopRamp() {
    ramp = 0;
    updateUrl();
  }

  if (controlsPanel) {
    const info = createSection({ title: 'Phase diagrams' });
    disposables.push(info);
    info.content.appendChild(
      createHelperText(
        'Click or drag on the phase diagram to choose the alloy composition C₀ and the temperature T. In a two-phase field, the tie line gives the composition of each phase and the lever rule gives how much of each there is. The Monte Carlo microstructure on the right uses the same free energies.'
      )
    );
    controlsPanel.appendChild(info.element);

    const sysSec = createSection({ title: 'System' });
    disposables.push(sysSec);
    selects.sys = createSelect({
      label: 'Phase diagram',
      options: [
        { value: 'iso', label: 'Isomorphous (Cu–Ni)' },
        { value: 'eut', label: 'Binary eutectic' },
      ],
      value: params.sys,
      onChange: (v) => setSystem(v as SysId),
    });
    disposables.push(selects.sys);
    sysSec.content.appendChild(selects.sys.element);
    controlsPanel.appendChild(sysSec.element);

    const state = createSection({ title: 'State' });
    disposables.push(state);
    sliders.x = createSlider({
      label: 'Composition C₀',
      min: 0.5,
      max: 99.5,
      step: 0.5,
      value: params.x * 100,
      format: (v) => v.toFixed(1) + ' at.%',
      onChange: (v) => setState(v / 100, params.T, true),
    });
    disposables.push(sliders.x);
    state.content.appendChild(sliders.x.element);
    tHost = document.createElement('div');
    state.content.appendChild(tHost);
    buildTSlider();
    const melt = createButton({
      label: 'Melt & restart',
      variant: 'secondary',
      onClick: () => resetMC(true),
    });
    disposables.push(melt);
    state.content.appendChild(melt.element);
    controlsPanel.appendChild(state.element);

    const rampSec = createSection({ title: 'Cooling / heating' });
    disposables.push(rampSec);
    rampSec.content.appendChild(
      createHelperText(
        'Change T steadily from the current state. With slow solid diffusion the solid cannot keep up with the tie line: its average composition lags behind the solidus (coring).'
      )
    );
    sliders.rate = createSlider({
      label: 'Rate',
      min: 1,
      max: 50,
      step: 1,
      value: params.rate,
      format: (v) => v.toFixed(0) + ' °C / 100 sweeps',
      onChange: (v) => {
        params.rate = v;
        updateUrl();
      },
    });
    sliders.dsol = createSlider({
      label: 'Solid diffusion (relative to liquid)',
      min: -3,
      max: 0,
      step: 0.25,
      value: params.dsol,
      format: (v) => Math.pow(10, v).toPrecision(v > -0.01 ? 1 : 2),
      onChange: (v) => {
        params.dsol = v;
        mc.dSolid = Math.pow(10, v);
        updateUrl();
      },
    });
    const cool = createButton({ label: 'Cool', onClick: () => startRamp(-1) });
    const heat = createButton({ label: 'Heat', variant: 'secondary', onClick: () => startRamp(1) });
    const stop = createButton({ label: 'Stop', variant: 'secondary', onClick: stopRamp });
    for (const c of [sliders.rate, sliders.dsol, cool, heat, stop]) {
      disposables.push(c);
      rampSec.content.appendChild(c.element);
    }
    controlsPanel.appendChild(rampSec.element);

    const disp = createSection({ title: 'Display' });
    disposables.push(disp);
    selects.view = createSelect({
      label: 'Microstructure view',
      options: [
        { value: 'both', label: 'Phase + local composition' },
        { value: 'phase', label: 'Phase' },
        { value: 'comp', label: 'Local composition' },
      ],
      value: params.view,
      onChange: (v) => {
        params.view = v as DemoParams['view'];
        updateUrl();
      },
    });
    disposables.push(selects.view);
    disp.content.appendChild(selects.view.element);
    const addCheck = (key: 'tie' | 'mc' | 'inoc', label: string, onChange?: () => void) => {
      const c = createCheckbox({
        label,
        checked: params[key],
        onChange: (v) => {
          params[key] = v;
          updateUrl();
          onChange?.();
        },
      });
      checks[key] = c;
      disposables.push(c);
      disp.content.appendChild(c.element);
    };
    addCheck('tie', 'Tie line & lever rule');
    addCheck('mc', 'Monte Carlo measurements on diagram');
    addCheck('inoc', 'Inoculant particles (heterogeneous nucleation)', () => resetMC());
    controlsPanel.appendChild(disp.element);

    const sim = createSection({ title: 'Simulation' });
    disposables.push(sim);
    sliders.speed = createSlider({
      label: 'Speed',
      min: 1,
      max: 60,
      step: 1,
      value: params.speed,
      format: (v) => v.toFixed(0) + ' sweeps / frame',
      onChange: (v) => {
        params.speed = v;
        updateUrl();
      },
    });
    disposables.push(sliders.speed);
    sim.content.appendChild(sliders.speed.element);
    const seed = createButton({
      label: 'New random seed',
      variant: 'secondary',
      onClick: () => {
        params.seed = 1 + Math.floor(Math.random() * 9999);
        updateUrl();
        resetMC();
      },
    });
    disposables.push(seed);
    sim.content.appendChild(seed.element);
    controlsPanel.appendChild(sim.element);
  }

  function syncControls() {
    selects.sys?.setValue(params.sys);
    selects.view?.setValue(params.view);
    sliders.x?.setValue(params.x * 100);
    buildTSlider();
    sliders.rate?.setValue(params.rate);
    sliders.dsol?.setValue(params.dsol);
    sliders.speed?.setValue(params.speed);
    checks.tie?.setChecked(params.tie);
    checks.mc?.setChecked(params.mc);
    checks.inoc?.setChecked(params.inoc);
  }

  resetMC();

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------

  function measure() {
    const st = mc.stats();
    const nPh = sys.phases.length;
    if (emaFresh || emaFrac.length !== nPh) {
      emaFrac = st.frac.slice();
      emaX = st.x.map((v, p) => (Number.isFinite(st.xBulk[p]!) ? st.xBulk[p]! : v));
    }
    for (let p = 0; p < nPh; p++) {
      const f = st.frac[p]!;
      const xb = st.xBulk[p]!;
      const x = Number.isFinite(xb) ? xb : st.x[p]!;
      emaFrac[p] = emaFrac[p]! + 0.15 * (f - emaFrac[p]!);
      if (!Number.isFinite(x)) emaX[p] = NaN;
      else if (!Number.isFinite(emaX[p]!)) emaX[p] = x;
      else emaX[p] = emaX[p]! + 0.15 * (x - emaX[p]!);
    }
    emaFresh = false;
  }

  function advance() {
    frame++;
    const t0 = performance.now();
    let n = 0;
    for (; n < params.speed && performance.now() - t0 < 24; n++) mc.sweep();
    lastSweeps = n;
    if (ramp !== 0) {
      const lo = sys.Tmin - K0;
      const hi = sys.Tmax - K0;
      const Tn = params.T + (ramp * params.rate * n) / 100;
      const Tc = clamp(Tn, lo, hi);
      params.T = Tc;
      mc.setT(Tc + K0);
      eq = equilibrium(sys, params.x, Tc + K0);
      if (frame % 3 === 0) sliders.T?.setValue(Math.round(Tc));
      if (Tc <= lo || Tc >= hi) {
        params.T = Math.round(Tc);
        sliders.T?.setValue(params.T);
        stopRamp();
      }
    }
    if (frame % 2 === 0) measure();
    if (ramp !== 0 && frame % 4 === 0) {
      path.push({ x: params.x, T: params.T });
      for (let p = 1; p < sys.phases.length; p++) {
        if (emaFrac[p]! > MIN_FRAC && Number.isFinite(emaX[p]!))
          trail.push({ x: emaX[p]!, T: params.T, p });
      }
      if (trail.length > 3000) trail.splice(0, trail.length - 3000);
      if (path.length > 3000) path.splice(0, path.length - 3000);
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  const readoutH = () => (layout.wide ? 112 : 156);

  function computeLayout() {
    const W = canvas.width;
    const H = canvas.height;
    const wide = W >= H * 1.25;
    layout.wide = wide;
    const avail = H - readoutH();
    if (wide) {
      layout.dx = 0;
      layout.dy = 4;
      layout.dw = W * 0.52;
      layout.dh = avail - 8;
      const side = Math.min(W - layout.dw - 28, avail - 40);
      layout.ms = Math.max(60, side);
      layout.mx = layout.dw + (W - layout.dw - layout.ms) / 2;
      layout.my = 10;
    } else {
      layout.dx = 0;
      layout.dy = 4;
      layout.dw = W;
      layout.dh = Math.max(180, avail * 0.48);
      const side = Math.min(W - 20, avail - layout.dh - 36);
      layout.ms = Math.max(60, side);
      layout.mx = (W - layout.ms) / 2;
      layout.my = layout.dy + layout.dh + 4;
    }
    layout.ry = H - readoutH() + 6;
  }

  function pct(x: number): string {
    return (100 * x).toFixed(1) + ' %';
  }

  function drawDiagram(ctx: CanvasRenderingContext2D) {
    const { d, img: regionImg } = diagramFor(sys.id);
    const Tlo = sys.Tmin - K0;
    const Thi = sys.Tmax - K0;
    ctx.save();
    ctx.translate(layout.dx, layout.dy);
    plot.setSize(layout.dw, layout.dh);
    plot.setBounds({ xMin: 0, xMax: 100, yMin: Tlo, yMax: Thi });
    const X = (x: number) => plot.toCanvasX(100 * x);
    const Y = (T: number) => plot.toCanvasY(T - K0);

    const x0 = plot.toCanvasX(0);
    const x1 = plot.toCanvasX(100);
    const y0 = plot.toCanvasY(Thi);
    const y1 = plot.toCanvasY(Tlo);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(regionImg, x0, y0, x1 - x0, y1 - y0);
    const xt = Plot2D.generateTicks(0, 100, 5);
    const yt = Plot2D.generateTicks(Tlo, Thi, 6);
    plot.drawGrid(xt, yt);
    plot.drawAxes(`Composition (at.% ${sys.labelB})`, 'Temperature (°C)');
    plot.drawTickLabels(
      xt,
      yt,
      (v) => v.toFixed(0),
      (v) => v.toFixed(0)
    );

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();

    // Phase boundaries
    ctx.strokeStyle = '#e8ecf2';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (const b of d.boundaries) {
      ctx.beginPath();
      for (let k = 0; k < b.xs.length; k++) {
        const px = X(b.xs[k]!);
        const py = Y(b.Ts[k]!);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    if (d.eutectic) {
      const e = d.eutectic;
      ctx.beginPath();
      ctx.moveTo(X(e.xa), Y(e.T));
      ctx.lineTo(X(e.xb), Y(e.T));
      ctx.stroke();
      ctx.fillStyle = '#e8ecf2';
      ctx.beginPath();
      ctx.arc(X(e.x), Y(e.T), 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        `E (${(100 * e.x).toFixed(0)} %, ${(e.T - K0).toFixed(0)} °C)`,
        X(e.x),
        Y(e.T) + 16
      );
    }

    // Region labels
    ctx.font = '15px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = X(params.x);
    const cy = Y(params.T + K0);
    const tie: [number, number] | null =
      eq.phases.length === 2 ? [eq.phases[0]!.x, eq.phases[1]!.x] : null;
    for (const lab of d.labels) {
      ctx.fillStyle = 'rgba(255,255,255,0.78)';
      let x = lab.x;
      if (lab.name.length === 1 && x < 0.15) x = Math.max(x, 0.035);
      if (lab.name.length === 1 && x > 0.85) x = Math.min(x, 0.965);
      // Keep the region name clear of the state point and its tie line
      const lx = X(x);
      const ly = Y(lab.T);
      if (Math.hypot(lx - cx, ly - cy) < 30) continue;
      if (params.tie && tie && Math.abs(ly - cy) < 24 && lx > X(tie[0]) - 30 && lx < X(tie[1]) + 30)
        continue;
      ctx.fillText(lab.name, lx, ly);
    }
    ctx.textBaseline = 'alphabetic';

    // Cooling/heating path and measured solid compositions
    if (path.length > 1) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      path.forEach((q, k) =>
        k === 0 ? ctx.moveTo(X(q.x), Y(q.T + K0)) : ctx.lineTo(X(q.x), Y(q.T + K0))
      );
      ctx.stroke();
      ctx.restore();
    }
    for (const q of trail) {
      ctx.fillStyle = rgb(PHASE_RGB[q.p]!, 0.8);
      ctx.fillRect(X(q.x) - 1.5, Y(q.T + K0) - 1.5, 3, 3);
    }

    // Tie line and lever rule
    if (params.tie && eq.phases.length === 2) {
      const [a, b] = eq.phases as [Equilibrium['phases'][0], Equilibrium['phases'][0]];
      const xa = X(a.x);
      const xb = X(b.x);
      ctx.save();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      for (const xp of [xa, xb]) {
        ctx.beginPath();
        ctx.moveTo(xp, cy);
        ctx.lineTo(xp, y1);
        ctx.stroke();
      }
      ctx.restore();
      // Lever arms: the arm next to phase a measures the amount of b, and vice versa
      ctx.lineCap = 'round';
      ctx.lineWidth = 6;
      ctx.strokeStyle = rgb(PHASE_RGB[b.phase]!);
      ctx.beginPath();
      ctx.moveTo(xa, cy);
      ctx.lineTo(cx, cy);
      ctx.stroke();
      ctx.strokeStyle = rgb(PHASE_RGB[a.phase]!);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(xb, cy);
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xa, cy);
      ctx.lineTo(xb, cy);
      ctx.stroke();
      for (const [ph, xp] of [
        [a, xa],
        [b, xb],
      ] as const) {
        ctx.fillStyle = rgb(PHASE_RGB[ph.phase]!);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(xp, cy, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      const nameA = PHASE_NAMES[a.phase]!;
      const nameB = PHASE_NAMES[b.phase]!;
      ctx.fillStyle = '#fff';
      drawSub(ctx, 'C', nameA, '', xa - 4, cy - 10);
      drawSub(ctx, 'C', nameB, '', xb + 4, cy - 10);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillText((100 * a.x).toFixed(1), xa, y1 - 5);
      ctx.fillText((100 * b.x).toFixed(1), xb, y1 - 5);
      // Under each arm if there is room, otherwise stacked beside the tie line
      const roomy = cx - xa > 80 && xb - cx > 80;
      const side = xb < x1 - 90 ? xb + 50 : xa - 50;
      ctx.fillStyle = rgb(PHASE_RGB[b.phase]!);
      drawSub(
        ctx,
        'W',
        nameB,
        ` = ${b.w.toFixed(2)}`,
        roomy ? 0.5 * (xa + cx) : side,
        roomy ? cy + 20 : cy + 6
      );
      ctx.fillStyle = rgb(PHASE_RGB[a.phase]!);
      drawSub(
        ctx,
        'W',
        nameA,
        ` = ${a.w.toFixed(2)}`,
        roomy ? 0.5 * (cx + xb) : side,
        roomy ? cy + 20 : cy + 22
      );
    }

    // Monte Carlo measured phase compositions
    if (params.mc) {
      for (let p = 0; p < sys.phases.length; p++) {
        if (!(emaFrac[p]! > MIN_FRAC) || !Number.isFinite(emaX[p]!)) continue;
        ctx.strokeStyle = rgb(PHASE_RGB[p]!);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(X(emaX[p]!), cy, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // State point
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.fillText('C₀', cx + 8, cy - 8);

    // Hover crosshair
    if (hover && !dragging && Math.hypot(X(hover.x) - cx, Y(hover.T + K0) - cy) > 30) {
      const hx = X(hover.x);
      const hy = Y(hover.T + K0);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, y0);
      ctx.lineTo(hx, y1);
      ctx.moveTo(x0, hy);
      ctx.lineTo(x1, hy);
      ctx.stroke();
      const r = equilibrium(sys, hover.x, hover.T + K0).region;
      const text = `${r} · ${(100 * hover.x).toFixed(1)} % · ${hover.T.toFixed(0)} °C`;
      ctx.font = '12px sans-serif';
      const tw = ctx.measureText(text).width;
      const tx = Math.min(hx + 10, x1 - tw - 8);
      const ty = Math.max(hy - 10, y0 + 16);
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(tx - 4, ty - 13, tw + 8, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, tx, ty);
    }
    ctx.restore();

    // Legend
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    let ly = y0 + 16;
    ctx.fillText(sys.name, x1 - 8, ly);
    if (params.mc) {
      ly += 16;
      ctx.fillText('○ measured in Monte Carlo', x1 - 8, ly);
    }
    ctx.restore();
  }

  function renderMicrostructure(ctx: CanvasRenderingContext2D) {
    const { mx, my, ms } = layout;
    const data = imgData.data;
    const sp = mc.species;
    const ph = mc.phase;
    // 3×3 average composition
    for (let j = 0; j < N; j++) {
      const jm = ((j + N - 1) % N) * N;
      const j0 = j * N;
      const jp = ((j + 1) % N) * N;
      for (let i = 0; i < N; i++) {
        const im = (i + N - 1) % N;
        const ip = (i + 1) % N;
        local[j0 + i] =
          (sp[jm + im]! +
            sp[jm + i]! +
            sp[jm + ip]! +
            sp[j0 + im]! +
            sp[j0 + i]! +
            sp[j0 + ip]! +
            sp[jp + im]! +
            sp[jp + i]! +
            sp[jp + ip]!) /
          9;
      }
    }
    const view = params.view;
    for (let c = 0; c < N * N; c++) {
      const p = ph[c]!;
      let r: number;
      let g: number;
      let b: number;
      if (p === INERT) {
        [r, g, b] = INERT_RGB;
      } else if (view === 'comp') {
        [r, g, b] = cmap(local[c]!);
        const i = c % N;
        const right = c - i + ((i + 1) % N);
        const down = (c + N) % (N * N);
        if (ph[right] !== p || ph[down] !== p) {
          r *= 0.55;
          g *= 0.55;
          b *= 0.55;
        }
      } else {
        const col = PHASE_RGB[p]!;
        const f = view === 'both' ? 0.65 + 0.6 * local[c]! : 1;
        r = Math.min(255, col[0] * f);
        g = Math.min(255, col[1] * f);
        b = Math.min(255, col[2] * f);
      }
      const o = c * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
    imgCtx.putImageData(imgData, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, mx, my, ms, ms);
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(mx, my, ms, ms);

    ctx.font = '12px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const label = `Monte Carlo · t = ${mc.time} sweeps · T = ${params.T.toFixed(0)} °C`;
    const tw = ctx.measureText(label).width;
    ctx.fillRect(mx + ms - tw - 12, my + 4, tw + 8, 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, mx + ms - 8, my + 17);

    // Legend
    const ly = my + ms + 18;
    let lx = mx;
    ctx.textAlign = 'left';
    const swatch = (col: [number, number, number] | null, text: string) => {
      if (col) {
        ctx.fillStyle = rgb(col);
        ctx.fillRect(lx, ly - 10, 12, 12);
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.strokeRect(lx, ly - 10, 12, 12);
        lx += 17;
      }
      ctx.fillStyle = '#ccc';
      ctx.fillText(text, lx, ly);
      lx += ctx.measureText(text).width + 14;
    };
    if (view !== 'comp') {
      for (const p of sys.phases)
        swatch(PHASE_RGB[p]!, PHASE_NAMES[p] === 'L' ? 'liquid L' : `solid ${PHASE_NAMES[p]}`);
    }
    if (params.inoc) swatch(INERT_RGB, 'inoculant');
    if (view !== 'phase') {
      swatch(null, view === 'both' ? `brighter = richer in ${sys.labelB}` : `${sys.labelA}`);
      if (view === 'comp') {
        const grad = ctx.createLinearGradient(lx, 0, lx + 70, 0);
        for (let k = 0; k <= 4; k++) grad.addColorStop(k / 4, rgb(cmap(k / 4)));
        ctx.fillStyle = grad;
        ctx.fillRect(lx, ly - 10, 70, 12);
        lx += 76;
        swatch(null, sys.labelB);
      }
    }
  }

  function caption(): string {
    const d = diagramFor(sys.id).d;
    const names = eq.phases.map((p) => PHASE_NAMES[p.phase]!);
    const prefix = ramp < 0 ? 'Cooling. ' : ramp > 0 ? 'Heating. ' : '';
    // Waiting for nucleation of a phase that should be present
    for (const p of eq.phases) {
      if (p.phase !== L && p.w > 0.15 && (emaFrac[p.phase] ?? 0) < 0.02 && mc.time > 30) {
        return `${prefix}Undercooled: ${PHASE_NAMES[p.phase]} is stable but has not nucleated yet${
          params.inoc ? '' : ' (inoculant particles help)'
        }.`;
      }
    }
    if (names.length === 1) {
      if (names[0] === 'L')
        return `${prefix}Single-phase liquid: A and B atoms are randomly mixed.`;
      return `${prefix}Single-phase solid solution ${names[0]}: it has the alloy composition C₀ everywhere.`;
    }
    if (names.includes('L')) {
      return `${prefix}Two-phase ${eq.region}: the tie line fixes the compositions of both phases; the lever rule fixes their amounts.`;
    }
    const e = d.eutectic;
    if (e && params.x > e.xa && params.x < e.xb) {
      if (Math.abs(params.x - e.x) < 0.015)
        return `${prefix}Eutectic composition: at T_E all liquid turns into a fine mixture of α and β.`;
      const primary = params.x < e.x ? 'α' : 'β';
      return `${prefix}α + β. On cooling from the melt: primary ${primary} forms above T_E, then the remaining liquid (composition C_E) turns into eutectic α + β.`;
    }
    return `${prefix}Below the solvus: ${names[0] === 'α' ? 'β precipitates from α' : 'α precipitates from β'}.`;
  }

  function sub(name: string): string {
    return '_' + name;
  }

  /** Text "base_sub rest" centred at (x, y), with a real subscript, in the current font and colour. */
  function drawSub(
    ctx: CanvasRenderingContext2D,
    base: string,
    s: string,
    rest: string,
    x: number,
    y: number
  ) {
    const font = ctx.font;
    const small = '10px sans-serif';
    const wb = ctx.measureText(base).width;
    const wr = ctx.measureText(rest).width;
    ctx.font = small;
    const ws = ctx.measureText(s).width;
    ctx.textAlign = 'left';
    let ox = x - (wb + ws + wr) / 2;
    ctx.font = font;
    ctx.fillText(base, ox, y);
    ox += wb;
    ctx.font = small;
    ctx.fillText(s, ox, y + 4);
    ox += ws;
    ctx.font = font;
    ctx.fillText(rest, ox, y);
    ctx.textAlign = 'center';
  }

  function drawReadout(ctx: CanvasRenderingContext2D) {
    const W = canvas.width;
    const y = layout.ry;
    const x = 14;
    const wide = layout.wide;
    // Wide: fraction bars at the right of the text. Narrow: on their own row.
    const barW = wide ? Math.min(220, W * 0.25) : Math.min(260, W - 120);
    const textW = wide ? W - barW - 90 : W - 28;
    const barY = wide ? y + 4 : y + 66;
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(6, y - 4, W - 12, readoutH() - 6);
    ctx.textAlign = 'left';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = '#fff';
    const B = sys.labelB;
    ctx.fillText(
      `${eq.region}   ·   C₀ = ${pct(params.x)} ${B}   ·   T = ${params.T.toFixed(0)} °C`,
      x,
      y + 14,
      textW
    );
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#ccd3dd';
    let line2: string;
    if (eq.phases.length === 2) {
      const [a, b] = eq.phases as [Equilibrium['phases'][0], Equilibrium['phases'][0]];
      const na = PHASE_NAMES[a.phase]!;
      const nb = PHASE_NAMES[b.phase]!;
      line2 = `Tie line: C${sub(na)} = ${pct(a.x)}, C${sub(nb)} = ${pct(b.x)}.  Lever rule: W${sub(nb)} = (C₀ − C${sub(na)}) / (C${sub(nb)} − C${sub(na)}) = ${b.w.toFixed(2)},  W${sub(na)} = ${a.w.toFixed(2)}`;
    } else {
      line2 = `One phase (${eq.region}): W = 1 and its composition equals C₀ = ${pct(params.x)}.`;
    }
    ctx.fillText(line2, x, y + 34, textW);
    const parts: string[] = [];
    for (let p = 0; p < sys.phases.length; p++) {
      const f = emaFrac[p] ?? 0;
      if (f < MIN_FRAC) continue;
      const xs = Number.isFinite(emaX[p]!) ? ` at ${pct(emaX[p]!)}` : '';
      parts.push(`${PHASE_NAMES[p]} ${(100 * f).toFixed(0)} %${xs}`);
    }
    ctx.fillStyle = '#aab3c0';
    ctx.fillText(
      `Monte Carlo (${lastSweeps} sweeps/frame): ${parts.join('  ·  ')}`,
      x,
      y + 54,
      textW
    );
    ctx.fillStyle = '#e6e9ef';
    ctx.font = '13px sans-serif';
    ctx.fillText(caption(), x, wide ? y + 78 : y + 122, W - 28);

    // Lever rule vs Monte Carlo fractions
    const bx = wide ? W - barW - 18 : x + 80;
    const bar = (yy: number, label: string, fr: number[]) => {
      ctx.fillStyle = '#aab3c0';
      ctx.textAlign = 'right';
      ctx.font = '11px sans-serif';
      ctx.fillText(label, bx - 6, yy + 10);
      let ox = bx;
      for (let p = 0; p < fr.length; p++) {
        const w = clamp(fr[p]!, 0, 1) * barW;
        ctx.fillStyle = rgb(PHASE_RGB[p]!);
        ctx.fillRect(ox, yy, w, 13);
        ox += w;
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.strokeRect(bx, yy, barW, 13);
    };
    const theory = sys.phases.map((p) => eq.phases.find((q) => q.phase === p)?.w ?? 0);
    bar(barY, 'lever rule', theory);
    const tot = emaFrac.reduce((s, v) => s + v, 0) || 1;
    bar(
      barY + 20,
      'Monte Carlo',
      emaFrac.map((v) => v / tot)
    );
    ctx.textAlign = 'left';
  }

  function render() {
    canvas.clear();
    computeLayout();
    const ctx = canvas.ctx;
    drawDiagram(ctx);
    renderMicrostructure(ctx);
    drawReadout(ctx);
  }

  const loop = new AnimationLoop(() => {
    advance();
    render();
  });

  // ---------------------------------------------------------------------------
  // Pointer interaction on the diagram
  // ---------------------------------------------------------------------------

  function toState(e: PointerEvent): { x: number; T: number; inside: boolean } {
    const rect = canvas.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left - layout.dx;
    const py = e.clientY - rect.top - layout.dy;
    const x = plot.toDataX(px) / 100;
    const T = plot.toDataY(py);
    const inside =
      px >= 0 &&
      px <= layout.dw &&
      x >= -0.03 &&
      x <= 1.03 &&
      T >= sys.Tmin - K0 - 30 &&
      T <= sys.Tmax - K0 + 15;
    return { x: clamp(x, 0.005, 0.995), T: clamp(T, sys.Tmin - K0, sys.Tmax - K0), inside };
  }

  function onPointerDown(e: PointerEvent) {
    const s = toState(e);
    if (!s.inside) return;
    dragging = true;
    canvas.canvas.setPointerCapture(e.pointerId);
    setState(s.x, s.T, true);
  }

  function onPointerMove(e: PointerEvent) {
    const s = toState(e);
    if (dragging) {
      setState(s.x, s.T, true);
      return;
    }
    hover = s.inside ? { x: s.x, T: s.T } : null;
    canvas.canvas.style.cursor = s.inside ? 'crosshair' : 'default';
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    try {
      canvas.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // pointer capture may already be released
    }
  }

  function onPointerLeave() {
    hover = null;
  }

  canvas.canvas.addEventListener('pointerdown', onPointerDown);
  canvas.canvas.addEventListener('pointermove', onPointerMove);
  canvas.canvas.addEventListener('pointerup', onPointerUp);
  canvas.canvas.addEventListener('pointercancel', onPointerUp);
  canvas.canvas.addEventListener('pointerleave', onPointerLeave);

  canvas.onResize(render);

  return {
    start() {
      loop.start();
    },
    stop() {
      loop.stop();
    },
    resize() {
      render();
    },
    dispose() {
      loop.dispose();
      disposables.forEach((d) => d.dispose());
      sliders.T?.dispose();
      canvas.canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.canvas.removeEventListener('pointermove', onPointerMove);
      canvas.canvas.removeEventListener('pointerup', onPointerUp);
      canvas.canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.dispose();
    },
    getParams() {
      return toRecord(params);
    },
    setParams(p: Record<string, string>) {
      parseParams(p, params);
      sys = SYSTEMS[params.sys];
      syncControls();
      resetMC();
    },
  };
}

export const phaseDiagramDemo: DemoDefinition = {
  id: 'phase-diagrams',
  title: 'Phase diagrams and microstructure',
  description:
    'Navigate isomorphous and eutectic phase diagrams: tie lines, the lever rule and two-phase fields, with a Monte Carlo microstructure that follows the chosen composition and temperature.',
  category: 'Phase diagrams',
  tags: ['phase diagram', 'lever rule', 'tie line', 'eutectic', 'isomorphous', 'Monte Carlo'],
  create,
};

export default phaseDiagramDemo;
