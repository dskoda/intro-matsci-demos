/**
 * 2D Lennard-Jones Molecular Dynamics
 *
 * A minimal 2D MD engine (velocity Verlet, periodic boundary conditions,
 * Berendsen thermostat) that cools a Lennard-Jones fluid from a high
 * "hot" temperature to a low "cold" one along a chosen schedule, so
 * students can watch a disordered fluid crystallize into a 2D lattice
 * while the total energy relaxes toward a minimum.
 *
 * Everything is in reduced LJ units: epsilon = sigma = mass = kB = 1.
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
} from '@core/ui/controls';
import { createSection } from '@core/ui/panel';
import { clamp } from '@core/math/validation';

type Schedule = 'constant' | 'linear' | 'exponential' | 'step';

interface DemoParams {
  n: number;
  tHot: number;
  tCold: number;
  schedule: Schedule;
  duration: number;
  stepsPerFrame: number;
  colorBySpeed: boolean;
}

const defaultParams: DemoParams = {
  n: 36,
  tHot: 2.0,
  tCold: 0.1,
  schedule: 'linear',
  duration: 30,
  stepsPerFrame: 8,
  colorBySpeed: true,
};

// Simulation constants (reduced LJ units)
const DENSITY = 0.85;
const DT = 0.005;
const CUTOFF = 2.5;
const THERMOSTAT_TAU = 0.05;
const MIN_R2 = 0.09; // safety floor against pathological close encounters
const ENERGY_WINDOW = 40; // time units shown in the scrolling energy plot
const MAX_ENERGY_SAMPLES = 3000;

function randNormal(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function targetTemperature(t: number, params: DemoParams): number {
  const { tHot, tCold, schedule, duration } = params;
  switch (schedule) {
    case 'constant':
      return tHot;
    case 'linear':
      return tHot + (tCold - tHot) * clamp(t / duration, 0, 1);
    case 'exponential': {
      const tau = duration / 4;
      return tCold + (tHot - tCold) * Math.exp(-t / tau);
    }
    case 'step':
      return t < duration / 2 ? tHot : tCold;
  }
}

function lerpColor(a: [number, number, number], b: [number, number, number], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

function speedColor(speed: number, tRef: number): string {
  const COLD: [number, number, number] = [74, 158, 255];
  const HOT: [number, number, number] = [255, 90, 90];
  const scale = Math.sqrt(2 * Math.max(tRef, 0.05));
  return lerpColor(COLD, HOT, clamp(speed / (scale * 1.6), 0, 1));
}

/** Simulation state: positions, velocities, forces, and box size. */
class MDState {
  n = 0;
  L = 1;
  x = new Float64Array(0);
  y = new Float64Array(0);
  vx = new Float64Array(0);
  vy = new Float64Array(0);
  fx = new Float64Array(0);
  fy = new Float64Array(0);
  time = 0;

  reset(n: number, tHot: number): void {
    this.n = n;
    this.L = Math.sqrt(n / DENSITY);
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.fx = new Float64Array(n);
    this.fy = new Float64Array(n);
    this.time = 0;

    const nSide = Math.ceil(Math.sqrt(n));
    const spacing = this.L / nSide;
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / nSide);
      const col = i % nSide;
      const jitter = spacing * 0.05;
      this.x[i] = (col + 0.5) * spacing + (Math.random() - 0.5) * jitter;
      this.y[i] = (row + 0.5) * spacing + (Math.random() - 0.5) * jitter;
      this.vx[i] = randNormal();
      this.vy[i] = randNormal();
    }

    let meanVx = 0;
    let meanVy = 0;
    for (let i = 0; i < n; i++) {
      meanVx += this.vx[i]!;
      meanVy += this.vy[i]!;
    }
    meanVx /= n;
    meanVy /= n;

    let ke = 0;
    for (let i = 0; i < n; i++) {
      this.vx[i]! -= meanVx;
      this.vy[i]! -= meanVy;
      ke += this.vx[i]! * this.vx[i]! + this.vy[i]! * this.vy[i]!;
    }
    ke *= 0.5;
    const tCurrent = ke / n;
    const scale = Math.sqrt(tHot / Math.max(tCurrent, 1e-6));
    for (let i = 0; i < n; i++) {
      this.vx[i]! *= scale;
      this.vy[i]! *= scale;
    }
  }

  /** Compute LJ forces (with cutoff + energy shift) under periodic boundaries. Returns PE. */
  computeForces(): number {
    const { n, L, x, y, fx, fy } = this;
    fx.fill(0);
    fy.fill(0);

    const rc2 = CUTOFF * CUTOFF;
    const sr6c = Math.pow(1 / CUTOFF, 6);
    const sr12c = sr6c * sr6c;
    const vShift = 4 * (sr12c - sr6c);

    let pe = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = x[i]! - x[j]!;
        let dy = y[i]! - y[j]!;
        dx -= L * Math.round(dx / L);
        dy -= L * Math.round(dy / L);

        const r2raw = dx * dx + dy * dy;
        if (r2raw >= rc2) continue;
        const r2 = Math.max(r2raw, MIN_R2);

        const sr2 = 1 / r2;
        const sr6 = sr2 * sr2 * sr2;
        const sr12 = sr6 * sr6;
        const fr2 = 24 * (2 * sr12 - sr6) * sr2;

        fx[i]! += fr2 * dx;
        fy[i]! += fr2 * dy;
        fx[j]! -= fr2 * dx;
        fy[j]! -= fr2 * dy;

        pe += 4 * (sr12 - sr6) - vShift;
      }
    }
    return pe;
  }

  /** One velocity-Verlet step with Berendsen rescaling toward tTarget. Returns {pe, ke, tInst}. */
  step(dt: number, tTarget: number): { pe: number; ke: number; tInst: number } {
    const { n, L, x, y, vx, vy, fx, fy } = this;

    const fxOld = fx.slice();
    const fyOld = fy.slice();

    for (let i = 0; i < n; i++) {
      x[i]! += vx[i]! * dt + 0.5 * fxOld[i]! * dt * dt;
      y[i]! += vy[i]! * dt + 0.5 * fyOld[i]! * dt * dt;
      x[i] = ((x[i]! % L) + L) % L;
      y[i] = ((y[i]! % L) + L) % L;
    }

    const pe = this.computeForces();

    for (let i = 0; i < n; i++) {
      vx[i]! += 0.5 * (fxOld[i]! + fx[i]!) * dt;
      vy[i]! += 0.5 * (fyOld[i]! + fy[i]!) * dt;
    }

    let ke = 0;
    for (let i = 0; i < n; i++) {
      ke += vx[i]! * vx[i]! + vy[i]! * vy[i]!;
    }
    ke *= 0.5;
    const tInst = ke / n;

    const lambda = clamp(
      Math.sqrt(Math.max(0, 1 + (dt / THERMOSTAT_TAU) * (tTarget / Math.max(tInst, 1e-6) - 1))),
      0.5,
      1.5
    );
    for (let i = 0; i < n; i++) {
      vx[i]! *= lambda;
      vy[i]! *= lambda;
    }
    ke *= lambda * lambda;

    this.time += dt;
    return { pe, ke, tInst: ke / n };
  }
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  const params: DemoParams = { ...defaultParams };
  const urlParams = options.getParams();
  if (urlParams.n) params.n = parseInt(urlParams.n, 10);
  if (urlParams.tHot) params.tHot = parseFloat(urlParams.tHot);
  if (urlParams.tCold) params.tCold = parseFloat(urlParams.tCold);
  if (urlParams.schedule) params.schedule = urlParams.schedule as Schedule;
  if (urlParams.duration) params.duration = parseFloat(urlParams.duration);
  if (urlParams.stepsPerFrame) params.stepsPerFrame = parseInt(urlParams.stepsPerFrame, 10);
  if (urlParams.colorBySpeed !== undefined) {
    params.colorBySpeed = urlParams.colorBySpeed === 'true';
  }

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0a0a0a', autoResize: true });

  const stagePlot = new Plot2D(canvas.ctx, {
    bounds: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
    margins: { top: 12, right: 12, bottom: 12, left: 12 },
  });
  const curvePlot = new Plot2D(canvas.ctx, {
    bounds: { xMin: 0, xMax: ENERGY_WINDOW, yMin: -6, yMax: 4 },
    margins: { top: 20, right: 20, bottom: 40, left: 55 },
  });

  const state = new MDState();
  state.reset(params.n, params.tHot);

  // Rolling energy history (per-particle KE, PE, total) over a fixed time window.
  let histTime: number[] = [];
  let histKE: number[] = [];
  let histPE: number[] = [];
  let histTE: number[] = [];
  let lastTInst = params.tHot;
  let lastTTarget = params.tHot;

  function resetSimulation(): void {
    state.reset(params.n, params.tHot);
    histTime = [];
    histKE = [];
    histPE = [];
    histTE = [];
    lastTInst = params.tHot;
    lastTTarget = params.tHot;
  }

  const disposables: Disposable[] = [];

  if (controlsPanel) {
    const simSection = createSection({ title: 'Simulation' });
    disposables.push(simSection);

    const nSelect = createSelect({
      label: 'Particles (N)',
      options: [16, 25, 36, 49, 64].map((v) => ({ value: String(v), label: String(v) })),
      value: String(params.n),
      onChange: (v) => {
        params.n = parseInt(v, 10);
        resetSimulation();
        updateUrlParams();
      },
    });
    disposables.push(nSelect);
    simSection.content.appendChild(nSelect.element);

    const speedSlider = createSlider({
      label: 'Simulation speed',
      min: 1,
      max: 20,
      step: 1,
      value: params.stepsPerFrame,
      format: (v) => `${v.toFixed(0)} steps/frame`,
      onChange: (v) => {
        params.stepsPerFrame = v;
        updateUrlParams();
      },
    });
    disposables.push(speedSlider);
    simSection.content.appendChild(speedSlider.element);

    controlsPanel.appendChild(simSection.element);

    const tempSection = createSection({ title: 'Temperature & Cooling' });
    disposables.push(tempSection);

    const tHotSlider = createSlider({
      label: 'T_hot (LJ units)',
      min: 0.2,
      max: 3.0,
      step: 0.1,
      value: params.tHot,
      format: (v) => v.toFixed(1),
      onChange: (v) => {
        params.tHot = v;
        updateUrlParams();
      },
    });
    disposables.push(tHotSlider);
    tempSection.content.appendChild(tHotSlider.element);

    const tColdSlider = createSlider({
      label: 'T_cold (LJ units)',
      min: 0.01,
      max: 1.0,
      step: 0.01,
      value: params.tCold,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        params.tCold = v;
        updateUrlParams();
      },
    });
    disposables.push(tColdSlider);
    tempSection.content.appendChild(tColdSlider.element);

    const scheduleSelect = createSelect({
      label: 'Cooling schedule',
      options: [
        { value: 'linear', label: 'Linear' },
        { value: 'exponential', label: 'Exponential' },
        { value: 'step', label: 'Step quench' },
        { value: 'constant', label: 'Constant (isothermal)' },
      ],
      value: params.schedule,
      onChange: (v) => {
        params.schedule = v as Schedule;
        updateUrlParams();
      },
    });
    disposables.push(scheduleSelect);
    tempSection.content.appendChild(scheduleSelect.element);

    const durationSlider = createSlider({
      label: 'Cooling duration',
      min: 5,
      max: 100,
      step: 5,
      value: params.duration,
      format: (v) => `${v.toFixed(0)} time units`,
      onChange: (v) => {
        params.duration = v;
        updateUrlParams();
      },
    });
    disposables.push(durationSlider);
    tempSection.content.appendChild(durationSlider.element);

    controlsPanel.appendChild(tempSection.element);

    const displaySection = createSection({ title: 'Display' });
    disposables.push(displaySection);

    const colorCheckbox = createCheckbox({
      label: 'Color particles by speed',
      checked: params.colorBySpeed,
      onChange: (checked) => {
        params.colorBySpeed = checked;
        updateUrlParams();
      },
    });
    disposables.push(colorCheckbox);
    displaySection.content.appendChild(colorCheckbox.element);

    const restartButton = createButton({
      label: 'Reheat & restart',
      variant: 'secondary',
      onClick: () => resetSimulation(),
    });
    disposables.push(restartButton);
    displaySection.content.appendChild(restartButton.element);

    controlsPanel.appendChild(displaySection.element);
  }

  function updateUrlParams(): void {
    options.setParams({
      n: String(params.n),
      tHot: params.tHot.toFixed(2),
      tCold: params.tCold.toFixed(2),
      schedule: params.schedule,
      duration: String(params.duration),
      stepsPerFrame: String(params.stepsPerFrame),
      colorBySpeed: String(params.colorBySpeed),
    });
  }

  function stepSimulation(): void {
    for (let s = 0; s < params.stepsPerFrame; s++) {
      const tTarget = targetTemperature(state.time, params);
      const { pe, ke, tInst } = state.step(DT, tTarget);
      lastTInst = tInst;
      lastTTarget = tTarget;

      histTime.push(state.time);
      histKE.push(ke / state.n);
      histPE.push(pe / state.n);
      histTE.push((ke + pe) / state.n);
    }

    const cutoff = state.time - ENERGY_WINDOW;
    let dropTo = 0;
    while (dropTo < histTime.length && histTime[dropTo]! < cutoff) dropTo++;
    if (dropTo > 0) {
      histTime = histTime.slice(dropTo);
      histKE = histKE.slice(dropTo);
      histPE = histPE.slice(dropTo);
      histTE = histTE.slice(dropTo);
    }
    if (histTime.length > MAX_ENERGY_SAMPLES) {
      const excess = histTime.length - MAX_ENERGY_SAMPLES;
      histTime = histTime.slice(excess);
      histKE = histKE.slice(excess);
      histPE = histPE.slice(excess);
      histTE = histTE.slice(excess);
    }
  }

  function render(): void {
    const width = canvas.width;
    const height = canvas.height;
    const stageHeight = Math.max(200, height * 0.6);
    const plotHeight = height - stageHeight;

    canvas.clear();

    const squareSide = Math.max(50, Math.min(width - 20, stageHeight - 20));
    const offsetX = (width - squareSide) / 2;
    const offsetY = (stageHeight - squareSide) / 2;

    canvas.ctx.save();
    canvas.ctx.translate(offsetX, offsetY);
    renderStage(squareSide);
    canvas.ctx.restore();

    canvas.ctx.save();
    canvas.ctx.translate(0, stageHeight);
    renderCurves(width, plotHeight);
    canvas.ctx.restore();

    renderReadout();
  }

  function renderStage(side: number): void {
    stagePlot.setBounds({ xMin: 0, xMax: state.L, yMin: 0, yMax: state.L });
    stagePlot.setSize(side, side);

    const ctx = canvas.ctx;
    const x0 = stagePlot.toCanvasX(0);
    const x1 = stagePlot.toCanvasX(state.L);
    const y0 = stagePlot.toCanvasY(state.L);
    const y1 = stagePlot.toCanvasY(0);
    ctx.save();
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();

    const pixelsPerUnit = (x1 - x0) / state.L;
    const radius = Math.max(2, pixelsPerUnit * 0.5 * 0.9);

    for (let i = 0; i < state.n; i++) {
      const speed = Math.hypot(state.vx[i]!, state.vy[i]!);
      const color = params.colorBySpeed ? speedColor(speed, lastTTarget) : '#4a9eff';
      stagePlot.drawPoint(state.x[i]!, state.y[i]!, radius, color);
    }
  }

  function renderCurves(width: number, height: number): void {
    const tMax = Math.max(ENERGY_WINDOW, state.time);
    const tMin = tMax - ENERGY_WINDOW;
    curvePlot.setBounds({ xMin: tMin, xMax: tMax });
    curvePlot.setSize(width, height);

    const xTicks = Plot2D.generateTicks(tMin, tMax, 6);
    const yTicks = Plot2D.generateTicks(-6, 4, 5);
    curvePlot.drawGrid(xTicks, yTicks);
    curvePlot.drawAxes('time', 'energy / particle');
    curvePlot.drawTickLabels(xTicks, yTicks);

    if (histTime.length > 1) {
      curvePlot.drawLine(histTime, histKE, '#ff9f4a', 1.5);
      curvePlot.drawLine(histTime, histPE, '#4a9eff', 1.5);
      curvePlot.drawLine(histTime, histTE, '#7CFF9F', 2);
    }

    curvePlot.drawText('KE/N', tMax - 1, 3, { color: '#ff9f4a', align: 'right', fontSize: 12 });
    curvePlot.drawText('PE/N', tMax - 1, 2.2, { color: '#4a9eff', align: 'right', fontSize: 12 });
    curvePlot.drawText('Total/N', tMax - 1, 1.4, {
      color: '#7CFF9F',
      align: 'right',
      fontSize: 12,
    });
  }

  function renderReadout(): void {
    const ctx = canvas.ctx;
    ctx.save();
    ctx.fillStyle = '#ddd';
    ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const lines = [
      `t = ${state.time.toFixed(1)}`,
      `T_target = ${lastTTarget.toFixed(2)}`,
      `T_measured = ${lastTInst.toFixed(2)}`,
    ];
    lines.forEach((line, i) => {
      ctx.fillText(line, 10, 8 + i * 16);
    });
    ctx.restore();
  }

  const loop = new AnimationLoop(() => {
    stepSimulation();
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
      return {
        n: String(params.n),
        tHot: params.tHot.toFixed(2),
        tCold: params.tCold.toFixed(2),
        schedule: params.schedule,
        duration: String(params.duration),
        stepsPerFrame: String(params.stepsPerFrame),
        colorBySpeed: String(params.colorBySpeed),
      };
    },
    setParams(newParams: Record<string, string>) {
      if (newParams.n) params.n = parseInt(newParams.n, 10);
      if (newParams.tHot) params.tHot = parseFloat(newParams.tHot);
      if (newParams.tCold) params.tCold = parseFloat(newParams.tCold);
      if (newParams.schedule) params.schedule = newParams.schedule as Schedule;
      if (newParams.duration) params.duration = parseFloat(newParams.duration);
      if (newParams.stepsPerFrame) params.stepsPerFrame = parseInt(newParams.stepsPerFrame, 10);
      if (newParams.colorBySpeed !== undefined) {
        params.colorBySpeed = newParams.colorBySpeed === 'true';
      }
    },
  };
}

export const ljMD2DDemo: DemoDefinition = {
  id: 'lj-2d-crystallization',
  title: '2D Crystallization (Lennard-Jones MD)',
  description:
    'A 2D molecular dynamics engine with periodic boundary conditions that cools a Lennard-Jones fluid and watches it crystallize while tracking the total energy.',
  category: 'Molecular Dynamics',
  tags: ['molecular dynamics', 'lennard-jones', 'crystallization', 'periodic boundary conditions'],
  create,
};

export default ljMD2DDemo;
