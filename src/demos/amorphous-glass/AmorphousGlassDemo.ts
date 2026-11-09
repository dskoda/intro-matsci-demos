/**
 * Metallic glass / amorphous solid in 2D (Kob-Andersen binary Lennard-Jones)
 *
 * Built on the 2D Lennard-Jones crystallization demo. A binary mixture with
 * strongly non-additive interactions (the Kob-Andersen model) is cooled from a
 * melt. Depending on composition and cooling rate it either crystallises or is
 * trapped in a disordered, glassy state. The demo tracks the potential energy
 * versus temperature (a kink at the glass transition rather than a jump at a
 * melting point), the radial distribution function, and a local sixfold order
 * parameter psi6 to tell crystal from glass.
 *
 * Reduced LJ units throughout; the physics is in kobAndersen.ts.
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
import { KobAndersen2D, SIGMA, type OrderResult } from './kobAndersen';

type ColorMode = 'species' | 'order' | 'mobility';

interface DemoParams {
  n: number;
  /** Fraction of the small, strongly-binding B species (0..0.5). */
  fractionB: number;
  density: number;
  tHot: number;
  tCold: number;
  /** Time spent cooling from tHot to tCold. */
  duration: number;
  stepsPerFrame: number;
  colorMode: ColorMode;
  keepGhost: boolean;
}

const defaultParams: DemoParams = {
  n: 400,
  fractionB: 0.35,
  density: 1.2,
  tHot: 1.5,
  tCold: 0.1,
  duration: 60,
  stepsPerFrame: 20,
  colorMode: 'species',
  keepGhost: true,
};

const COLOR_MODES: ColorMode[] = ['species', 'order', 'mobility'];

const DT = 0.005;
const HOLD_TIME = 10; // equilibrate the melt at tHot before cooling starts
const SAMPLE_INTERVAL = 0.5; // time between points on the PE(T) curve
const MOBILITY_LAG = 5; // reference snapshots refresh every this many time units
const FRAME_BUDGET_MS = 12;
const RDF_BINS = 90;

const COLOR_A = '#4a9eff';
const COLOR_B = '#ff9f4a';
const COLOR_NOW = '#7CFF9F';
const COLOR_GHOST = '#8a8a8a';

function parseParams(raw: Record<string, string>, base: DemoParams): DemoParams {
  const num = (key: string, fallback: number): number => {
    const v = parseFloat(raw[key] ?? '');
    return Number.isFinite(v) ? v : fallback;
  };
  const colorMode = COLOR_MODES.includes(raw.color as ColorMode)
    ? (raw.color as ColorMode)
    : base.colorMode;
  return {
    n: Math.round(clamp(num('n', base.n), 100, 900)),
    fractionB: clamp(num('fb', base.fractionB), 0, 0.5),
    density: clamp(num('density', base.density), 0.8, 1.3),
    tHot: clamp(num('tHot', base.tHot), 0.5, 3),
    tCold: clamp(num('tCold', base.tCold), 0.02, 1),
    duration: clamp(num('duration', base.duration), 5, 1000),
    stepsPerFrame: Math.round(clamp(num('steps', base.stepsPerFrame), 1, 100)),
    colorMode,
    keepGhost: raw.ghost !== undefined ? raw.ghost === 'true' : base.keepGhost,
  };
}

function lerpColor(a: [number, number, number], b: [number, number, number], t: number): string {
  const f = clamp(t, 0, 1);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)}, ${Math.round(a[1] + (b[1] - a[1]) * f)}, ${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

interface Trace {
  T: number[];
  pe: number[];
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  let params: DemoParams = parseParams(options.getParams(), defaultParams);

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0a0a0a', autoResize: true });
  const stagePlot = new Plot2D(canvas.ctx, {
    bounds: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
    margins: { top: 12, right: 12, bottom: 12, left: 12 },
  });
  const pePlot = new Plot2D(canvas.ctx, {
    bounds: { xMin: 0, xMax: 2, yMin: -4, yMax: 0 },
    margins: { top: 20, right: 16, bottom: 40, left: 55 },
  });
  const rdfPlot = new Plot2D(canvas.ctx, {
    bounds: { xMin: 0, xMax: 4, yMin: 0, yMax: 3 },
    margins: { top: 20, right: 20, bottom: 40, left: 45 },
  });

  const sim = new KobAndersen2D();

  // ---- run state ----------------------------------------------------------------------
  let paused = false;
  let trace: Trace = { T: [], pe: [] };
  let ghost: Trace | null = null;
  let accT = 0;
  let accPE = 0;
  let accN = 0;
  let lastSampleTime = 0;
  let lastT = params.tHot;
  let lastTarget = params.tHot;
  let lastPE = 0;

  let refAX = new Float64Array(0);
  let refAY = new Float64Array(0);
  let refBX = new Float64Array(0);
  let refBY = new Float64Array(0);
  let lastRefTime = 0;
  let mobility = new Float64Array(0);

  let order: OrderResult | null = null;
  let rdf: Float64Array | null = null;
  let rdfRMax = 4;
  let frame = 0;

  function targetTemperature(t: number): number {
    if (t < HOLD_TIME) return params.tHot;
    const f = clamp((t - HOLD_TIME) / params.duration, 0, 1);
    return params.tHot + (params.tCold - params.tHot) * f;
  }

  function resetSimulation(): void {
    if (params.keepGhost && trace.T.length > 8) ghost = trace;
    if (!params.keepGhost) ghost = null;
    trace = { T: [], pe: [] };
    sim.reset(params.n, params.density, params.fractionB, params.tHot);
    accT = accPE = accN = 0;
    lastSampleTime = 0;
    lastT = params.tHot;
    lastTarget = params.tHot;
    lastPE = 0;
    refAX = sim.ux.slice();
    refAY = sim.uy.slice();
    refBX = sim.ux.slice();
    refBY = sim.uy.slice();
    lastRefTime = 0;
    mobility = new Float64Array(params.n);
    order = null;
    rdf = null;
    frame = 0;
  }

  // ---- controls -----------------------------------------------------------------------
  const disposables: Disposable[] = [];
  const sliders: Record<string, SliderControl> = {};
  let colorSelect: SelectControl | undefined;
  let ghostCheck: CheckboxControl | undefined;
  let pauseButton: ButtonControl | undefined;

  function syncControls(): void {
    sliders.fb?.setValue(params.fractionB * 100);
    sliders.n?.setValue(params.n);
    sliders.density?.setValue(params.density);
    sliders.tHot?.setValue(params.tHot);
    sliders.tCold?.setValue(params.tCold);
    sliders.duration?.setValue(params.duration);
    sliders.steps?.setValue(params.stepsPerFrame);
    colorSelect?.setValue(params.colorMode);
    ghostCheck?.setChecked(params.keepGhost);
  }

  function currentUrlParams(): Record<string, string> {
    return {
      n: String(params.n),
      fb: params.fractionB.toFixed(2),
      density: params.density.toFixed(2),
      tHot: params.tHot.toFixed(2),
      tCold: params.tCold.toFixed(2),
      duration: String(params.duration),
      steps: String(params.stepsPerFrame),
      color: params.colorMode,
      ghost: String(params.keepGhost),
    };
  }

  function onChange(rebuild: boolean): void {
    if (rebuild) resetSimulation();
    options.setParams(currentUrlParams());
  }

  function applyPreset(patch: Partial<DemoParams>): void {
    params = { ...params, ...patch };
    syncControls();
    resetSimulation();
    options.setParams(currentUrlParams());
  }

  function addSlider(
    parent: HTMLElement,
    key: string,
    opts: {
      label: string;
      min: number;
      max: number;
      step: number;
      value: number;
      format: (v: number) => string;
      onChange: (v: number) => void;
    }
  ): void {
    const s = createSlider(opts);
    sliders[key] = s;
    disposables.push(s);
    parent.appendChild(s.element);
  }

  if (controlsPanel) {
    controlsPanel.appendChild(
      createHelperText(
        'Cool a binary Lennard-Jones liquid. Frustrated mixtures (about 35% small B atoms) cannot crystallise and freeze into a glass; pure A crystallises.'
      )
    );

    const presetSection = createSection({ title: 'Presets' });
    disposables.push(presetSection);
    const glassBtn = createButton({
      label: 'Glass former (35% B, ρ = 1.2)',
      variant: 'primary',
      onClick: () =>
        applyPreset({ fractionB: 0.35, density: 1.2, tHot: 1.5, tCold: 0.1, duration: 60 }),
    });
    const crystalBtn = createButton({
      label: 'Crystal former (pure A, ρ = 0.95)',
      variant: 'secondary',
      onClick: () =>
        applyPreset({ fractionB: 0, density: 0.95, tHot: 1.5, tCold: 0.1, duration: 60 }),
    });
    disposables.push(glassBtn, crystalBtn);
    presetSection.content.appendChild(glassBtn.element);
    presetSection.content.appendChild(crystalBtn.element);
    controlsPanel.appendChild(presetSection.element);

    const matSection = createSection({ title: 'Material' });
    disposables.push(matSection);
    addSlider(matSection.content, 'fb', {
      label: 'Fraction of B atoms',
      min: 0,
      max: 50,
      step: 5,
      value: params.fractionB * 100,
      format: (v) => `${v.toFixed(0)} %`,
      onChange: (v) => {
        params.fractionB = v / 100;
        onChange(true);
      },
    });
    addSlider(matSection.content, 'n', {
      label: 'Atoms (N)',
      min: 100,
      max: 900,
      step: 50,
      value: params.n,
      format: (v) => v.toFixed(0),
      onChange: (v) => {
        params.n = Math.round(v);
        onChange(true);
      },
    });
    addSlider(matSection.content, 'density', {
      label: 'Density (atoms / σ²)',
      min: 0.8,
      max: 1.3,
      step: 0.05,
      value: params.density,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        params.density = v;
        onChange(true);
      },
    });
    controlsPanel.appendChild(matSection.element);

    const quenchSection = createSection({ title: 'Quench' });
    disposables.push(quenchSection);
    addSlider(quenchSection.content, 'tHot', {
      label: 'T melt (start)',
      min: 0.5,
      max: 3,
      step: 0.1,
      value: params.tHot,
      format: (v) => v.toFixed(1),
      onChange: (v) => {
        params.tHot = v;
        onChange(false);
      },
    });
    addSlider(quenchSection.content, 'tCold', {
      label: 'T final',
      min: 0.02,
      max: 1,
      step: 0.02,
      value: params.tCold,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        params.tCold = v;
        onChange(false);
      },
    });
    addSlider(quenchSection.content, 'duration', {
      label: 'Cooling time (slow ↔ fast quench)',
      min: 5,
      max: 1000,
      step: 5,
      value: params.duration,
      format: (v) => `${v.toFixed(0)} τ  (rate ${((params.tHot - params.tCold) / v).toFixed(3)})`,
      onChange: (v) => {
        params.duration = v;
        onChange(false);
      },
    });
    addSlider(quenchSection.content, 'steps', {
      label: 'Simulation speed',
      min: 1,
      max: 100,
      step: 1,
      value: params.stepsPerFrame,
      format: (v) => `${v.toFixed(0)} steps/frame`,
      onChange: (v) => {
        params.stepsPerFrame = Math.round(v);
        onChange(false);
      },
    });
    controlsPanel.appendChild(quenchSection.element);

    const displaySection = createSection({ title: 'Display' });
    disposables.push(displaySection);
    colorSelect = createSelect({
      label: 'Colour atoms by',
      options: [
        { value: 'species', label: 'Species (A blue, B orange)' },
        { value: 'order', label: 'Local order ψ6 (green = crystal)' },
        { value: 'mobility', label: 'Mobility (red = moving)' },
      ],
      value: params.colorMode,
      onChange: (v) => {
        params.colorMode = v as ColorMode;
        onChange(false);
      },
    });
    disposables.push(colorSelect);
    displaySection.content.appendChild(colorSelect.element);

    ghostCheck = createCheckbox({
      label: 'Keep previous run on the energy plot',
      checked: params.keepGhost,
      onChange: (checked) => {
        params.keepGhost = checked;
        if (!checked) ghost = null;
        onChange(false);
      },
    });
    disposables.push(ghostCheck);
    displaySection.content.appendChild(ghostCheck.element);

    pauseButton = createButton({
      label: 'Pause',
      variant: 'secondary',
      onClick: () => {
        paused = !paused;
        pauseButton?.setLabel(paused ? 'Resume' : 'Pause');
      },
    });
    disposables.push(pauseButton);
    displaySection.content.appendChild(pauseButton.element);

    const restartBtn = createButton({
      label: 'Reheat & restart',
      variant: 'secondary',
      onClick: () => resetSimulation(),
    });
    disposables.push(restartBtn);
    displaySection.content.appendChild(restartBtn.element);
    controlsPanel.appendChild(displaySection.element);
  }

  resetSimulation();

  // ---- simulation stepping ----------------------------------------------------------------
  function stepSimulation(): void {
    const start = performance.now();
    for (let s = 0; s < params.stepsPerFrame; s++) {
      const target = targetTemperature(sim.time);
      const { pe, ke } = sim.step(DT, target);
      lastTarget = target;
      lastT = ke / sim.n;
      lastPE = pe / sim.n;
      accT += lastT;
      accPE += lastPE;
      accN++;

      if (sim.time - lastSampleTime >= SAMPLE_INTERVAL && accN > 0) {
        trace.T.push(accT / accN);
        trace.pe.push(accPE / accN);
        accT = accPE = accN = 0;
        lastSampleTime = sim.time;
      }
      if (sim.time - lastRefTime >= MOBILITY_LAG) {
        refAX = refBX;
        refAY = refBY;
        refBX = sim.ux.slice();
        refBY = sim.uy.slice();
        lastRefTime = sim.time;
      }
      if (performance.now() - start > FRAME_BUDGET_MS) break;
    }
  }

  function updateAnalysis(): void {
    if (frame % 4 === 0 || order === null) order = sim.orderParameters();
    sim.displacementFrom(refAX, refAY, mobility);
    if (frame % 6 === 0 || rdf === null) {
      rdfRMax = Math.min(4, sim.L / 2 - 0.01);
      rdf = sim.rdf(RDF_BINS, rdfRMax);
    }
  }

  // ---- rendering ---------------------------------------------------------------------------
  function meanMobility(): number {
    let s = 0;
    for (let i = 0; i < mobility.length; i++) s += mobility[i]!;
    return mobility.length ? s / mobility.length : 0;
  }

  function stateLabel(): string {
    if (!order) return '';
    const frac = order.crystalFraction;
    const mob = meanMobility();
    if (mob > 0.6) return 'liquid';
    if (frac > 0.6) return 'crystal';
    if (frac > 0.3) return 'crystal + amorphous';
    return 'amorphous solid (glass)';
  }

  function render(): void {
    const width = canvas.width;
    const height = canvas.height;
    const stageHeight = Math.max(200, height * 0.6);
    const plotHeight = height - stageHeight;

    canvas.clear();

    const side = Math.max(50, Math.min(width - 20, stageHeight - 20));
    canvas.ctx.save();
    canvas.ctx.translate((width - side) / 2, (stageHeight - side) / 2);
    renderStage(side);
    canvas.ctx.restore();

    canvas.ctx.save();
    canvas.ctx.translate(0, stageHeight);
    renderEnergyPlot(width * 0.55, plotHeight);
    canvas.ctx.translate(width * 0.55, 0);
    renderRdfPlot(width * 0.45, plotHeight);
    canvas.ctx.restore();

    renderReadout();
  }

  function renderStage(side: number): void {
    stagePlot.setBounds({ xMin: 0, xMax: sim.L, yMin: 0, yMax: sim.L });
    stagePlot.setSize(side, side);
    const ctx = canvas.ctx;
    const x0 = stagePlot.toCanvasX(0);
    const x1 = stagePlot.toCanvasX(sim.L);
    const y0 = stagePlot.toCanvasY(sim.L);
    const y1 = stagePlot.toCanvasY(0);
    ctx.save();
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();

    const pxPerUnit = (x1 - x0) / sim.L;
    const SLOW: [number, number, number] = [45, 60, 105];
    const FAST: [number, number, number] = [255, 90, 90];
    const LOWORD: [number, number, number] = [70, 80, 120];
    const HIGHORD: [number, number, number] = [124, 255, 159];

    for (let i = 0; i < sim.n; i++) {
      const t = sim.type[i]!;
      let color: string;
      if (params.colorMode === 'order' && order) {
        color = lerpColor(LOWORD, HIGHORD, (order.psi6[i]! - 0.3) / 0.6);
      } else if (params.colorMode === 'mobility') {
        color = lerpColor(SLOW, FAST, mobility[i]! / 1.2);
      } else {
        color = t === 0 ? COLOR_A : COLOR_B;
      }
      const radius = Math.max(1.5, pxPerUnit * 0.5 * SIGMA[t]![t]! * 0.95);
      stagePlot.drawPoint(sim.x[i]!, sim.y[i]!, radius, color);
    }
  }

  function renderEnergyPlot(width: number, height: number): void {
    const traces = [trace, ghost].filter((t): t is Trace => t !== null && t.pe.length > 1);
    let lo = Infinity;
    let hi = -Infinity;
    for (const tr of traces) {
      for (const v of tr.pe) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!Number.isFinite(lo)) {
      lo = -3;
      hi = 0;
    }
    const pad = Math.max(0.15, (hi - lo) * 0.1);
    const xMax = params.tHot * 1.1;
    pePlot.setBounds({ xMin: 0, xMax, yMin: lo - pad, yMax: hi + pad });
    pePlot.setSize(width, height);

    const xTicks = Plot2D.generateTicks(0, xMax, 5);
    const yTicks = Plot2D.generateTicks(lo - pad, hi + pad, 4);
    pePlot.drawGrid(xTicks, yTicks);
    pePlot.drawAxes('temperature T', 'PE / atom');
    pePlot.drawTickLabels(
      xTicks,
      yTicks,
      (v) => v.toFixed(1),
      (v) => v.toFixed(1)
    );

    if (ghost && ghost.pe.length > 1) pePlot.drawLine(ghost.T, ghost.pe, COLOR_GHOST, 1.5);
    if (trace.pe.length > 1) pePlot.drawLine(trace.T, trace.pe, COLOR_NOW, 2);
    if (trace.pe.length > 0) {
      const cx = pePlot.toCanvasX(trace.T[trace.T.length - 1]!);
      const cy = pePlot.toCanvasY(trace.pe[trace.pe.length - 1]!);
      canvas.ctx.save();
      canvas.ctx.fillStyle = COLOR_NOW;
      canvas.ctx.beginPath();
      canvas.ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
      canvas.ctx.fill();
      canvas.ctx.restore();
    }

    pePlot.drawText('this run', xMax * 0.97, lo - pad + (hi - lo + 2 * pad) * 0.18, {
      color: COLOR_NOW,
      align: 'right',
      fontSize: 12,
    });
    if (ghost) {
      pePlot.drawText('previous run', xMax * 0.97, lo - pad + (hi - lo + 2 * pad) * 0.08, {
        color: COLOR_GHOST,
        align: 'right',
        fontSize: 12,
      });
    }
  }

  function renderRdfPlot(width: number, height: number): void {
    let yMax = 3;
    if (rdf) {
      for (let b = 0; b < rdf.length; b++) yMax = Math.max(yMax, rdf[b]! * 1.1);
    }
    rdfPlot.setBounds({ xMin: 0, xMax: rdfRMax, yMin: 0, yMax });
    rdfPlot.setSize(width, height);
    const xTicks = Plot2D.generateTicks(0, rdfRMax, 4);
    const yTicks = Plot2D.generateTicks(0, yMax, 4);
    rdfPlot.drawGrid(xTicks, yTicks);
    rdfPlot.drawAxes('r (σ)', 'g(r)');
    rdfPlot.drawTickLabels(
      xTicks,
      yTicks,
      (v) => v.toFixed(1),
      (v) => v.toFixed(0)
    );
    rdfPlot.drawLine([0, rdfRMax], [1, 1], '#555', 1);
    if (rdf) {
      const dr = rdfRMax / RDF_BINS;
      const rs: number[] = [];
      const gs: number[] = [];
      for (let b = 0; b < rdf.length; b++) {
        rs.push((b + 0.5) * dr);
        gs.push(rdf[b]!);
      }
      rdfPlot.drawLine(rs, gs, '#c9a0ff', 1.8);
    }
  }

  function renderReadout(): void {
    const ctx = canvas.ctx;
    const nB = KobAndersen2D.countB(sim.n, params.fractionB);
    const phase = sim.time < HOLD_TIME ? 'equilibrating melt' : stateLabel();
    const lines = [
      `t = ${sim.time.toFixed(1)} τ${paused ? '  (paused)' : ''}`,
      `T target = ${lastTarget.toFixed(2)}   T measured = ${lastT.toFixed(2)}`,
      `A : B = ${sim.n - nB} : ${nB}`,
      order ? `crystal-like atoms (ψ6 > 0.85) = ${(order.crystalFraction * 100).toFixed(0)} %` : '',
      `state: ${phase}`,
    ];
    ctx.save();
    ctx.fillStyle = '#ddd';
    ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => ctx.fillText(line, 10, 8 + i * 16));
    ctx.restore();
  }

  const loop = new AnimationLoop(() => {
    if (!paused) stepSimulation();
    updateAnalysis();
    frame++;
    render();
  });

  function handleResize(): void {
    if (loop.running) render();
  }
  canvas.onResize(handleResize);

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
      disposables.forEach((d) => d.dispose());
      canvas.dispose();
    },
    getParams() {
      return currentUrlParams();
    },
    setParams(newParams: Record<string, string>) {
      params = parseParams(newParams, params);
      syncControls();
      resetSimulation();
    },
  };
}

export const amorphousGlassDemo: DemoDefinition = {
  id: 'amorphous-glass',
  title: 'Amorphous solids: glass vs crystal (2D Kob-Andersen)',
  description:
    'Quench a 2D binary Lennard-Jones mixture (Kob-Andersen model). Frustrated compositions cannot crystallise and freeze into a disordered glass; watch the energy-temperature curve, g(r) and local order to tell glass from crystal.',
  category: 'Molecular Dynamics',
  tags: ['glass', 'amorphous', 'metallic glass', 'Kob-Andersen', 'molecular dynamics', 'quench'],
  create,
};

export default amorphousGlassDemo;
