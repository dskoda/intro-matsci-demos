/**
 * PN junction in three steps (Lecture 14: Electrical properties)
 *
 *  1. Separated: a P box with a dense gas of holes and an N box with a dense gas of
 *     electrons. Each box is neutral: the free carriers balance the fixed ions.
 *  2. Joined: carriers diffuse across and annihilate. The fixed ions left behind form a
 *     depletion zone with a built-in field that stops the diffusion. Far from the
 *     junction the carriers remain.
 *  3. Biased: contacts and an applied voltage. Forward bias shrinks the zone and injects
 *     carriers (current); reverse bias widens it (almost no current).
 *
 * No atoms and no band diagram: carriers are tiny dots. The physics is in pn.ts.
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import { Plot2D } from '@core/canvas/Plot2D';
import {
  createSlider,
  createSelect,
  createButton,
  type Disposable,
  type SliderControl,
  type SelectControl,
  type ButtonControl,
} from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import { PNJunction, LX, LY, XJ, NB, DXB, E_REF } from './pn';

type Step = 1 | 2 | 3;

interface DemoParams {
  step: Step;
  voltage: number;
  nN: number;
  nP: number;
  speed: number;
}

const defaultParams: DemoParams = { step: 1, voltage: 0, nN: 1000, nP: 1000, speed: 1 };

/** Speeds from slow motion to fast; below 1 the time step shrinks so the motion stays smooth. */
const SPEEDS = [0.1, 0.2, 0.5, 1, 2, 4, 8];
const nearestSpeed = (v: number): number =>
  SPEEDS.reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best), SPEEDS[0]!);

/** Displayed voltage that corresponds to the built-in potential (silicon-like). */
const V_BI_DISPLAY = 0.7;
const DT = 0.01;
const HISTORY_SPAN = 60;
const I_REF = 350;

const COLOR_E = '#4ac3ff';
const COLOR_H = '#ff5a6e';
const COLOR_DON = '#ffb347';
const COLOR_ACC = '#c77dff';

function parseParams(raw: Record<string, string>, base: DemoParams): DemoParams {
  const num = (key: string, fallback: number): number => {
    const v = parseFloat(raw[key] ?? '');
    return Number.isFinite(v) ? v : fallback;
  };
  const st = Math.round(num('step', base.step));
  return {
    step: (st === 2 ? 2 : st === 3 ? 3 : 1) as Step,
    voltage: clamp(num('v', base.voltage), -2, 1.5),
    nN: Math.round(clamp(num('nn', base.nN), 300, 1500) / 100) * 100,
    nP: Math.round(clamp(num('np', base.nP), 300, 1500) / 100) * 100,
    speed: nearestSpeed(num('speed', base.speed)),
  };
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  let params: DemoParams = parseParams(options.getParams(), defaultParams);

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0a0a0a', autoResize: true });
  const histPlot = new Plot2D(canvas.ctx, {
    bounds: { xMin: 0, xMax: HISTORY_SPAN, yMin: -10, yMax: 10 },
    margins: { top: 18, right: 14, bottom: 30, left: 56 },
  });

  const lat = new PNJunction();

  let step: Step = 1;
  let paused = false;
  let gapFrac = 1; // visual separation of the two boxes, eased
  let joinedFor = 0; // sim time since the sides were joined
  let current = 0;
  let annihilationRate = 0;
  let hist = { t: [] as number[], i: [] as number[] };
  let form = { t: [] as number[], w: [] as number[], e: [] as number[] };
  let lastForm = 0;
  let win = { t: 0, cross: 0, rec: 0 };

  function resetStats(): void {
    hist = { t: [], i: [] };
    form = { t: [], w: [], e: [] };
    lastForm = 0;
    win = { t: lat.time, cross: lat.crossings, rec: lat.recombinedTotal };
    current = 0;
  }

  function applyVoltage(): void {
    lat.voltage = step === 3 ? (params.voltage / V_BI_DISPLAY) * lat.phiBi : 0;
    // High forward bias: carriers cross without recombining (different energy ranges).
    const fwd = step === 3 ? Math.max(0, params.voltage) / V_BI_DISPLAY : 0;
    lat.recFactor = Math.max(0.003, Math.exp(-Math.pow(fwd / 0.5, 2)));
  }

  function goTo(target: Step): void {
    if (target === 1) {
      lat.reset(params.nN, params.nP);
      joinedFor = 0;
      resetStats();
    } else {
      if (step === 1) {
        lat.wall = false;
        joinedFor = 0;
        form = { t: [], w: [], e: [] };
        lastForm = 0;
      }
      if (target === 2) {
        lat.disconnectContacts();
      } else if (!lat.contacts) {
        // Make sure the junction has formed before the circuit is attached.
        if (joinedFor < 25) lat.equilibrate(25 - joinedFor);
        joinedFor = Math.max(joinedFor, 25);
        lat.connectContacts();
        resetStats();
      }
    }
    step = target;
    params.step = target;
    applyVoltage();
  }

  function rebuild(): void {
    const wanted = params.step;
    step = 1;
    lat.reset(params.nN, params.nP);
    joinedFor = 0;
    resetStats();
    if (wanted > 1) goTo(wanted);
    gapFrac = wanted === 1 ? 1 : 0;
  }

  // ---- controls -----------------------------------------------------------------------
  const disposables: Disposable[] = [];
  const sliders: Record<string, SliderControl> = {};
  let stepSelect: SelectControl | undefined;
  let pauseButton: ButtonControl | undefined;

  function syncControls(): void {
    stepSelect?.setValue(String(params.step));
    sliders.v?.setValue(params.voltage);
    sliders.nn?.setValue(params.nN);
    sliders.np?.setValue(params.nP);
    sliders.speed?.setValue(SPEEDS.indexOf(params.speed));
  }

  function currentUrlParams(): Record<string, string> {
    return {
      step: String(params.step),
      v: params.voltage.toFixed(2),
      nn: String(params.nN),
      np: String(params.nP),
      speed: String(params.speed),
    };
  }

  function onChange(): void {
    applyVoltage();
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
        'Step 1: a P-type and an N-type crystal, each neutral. Step 2: join them. Electrons (blue) diffuse into the P side and holes (red) into the N side and annihilate (yellow flashes), leaving the fixed donor (+) and acceptor (−) ions uncompensated. This charged depletion zone creates a built-in field that stops the diffusion. Step 3: attach contacts and apply a voltage. Forward bias lowers the barrier and carriers flow through; reverse bias raises it.'
      )
    );

    const stepSection = createSection({ title: 'Step' });
    disposables.push(stepSection);
    stepSelect = createSelect({
      label: 'Stage',
      options: [
        { value: '1', label: '1 · Separated P and N sides' },
        { value: '2', label: '2 · Joined, in equilibrium' },
        { value: '3', label: '3 · External voltage applied' },
      ],
      value: String(params.step),
      onChange: (v) => {
        goTo(v === '3' ? 3 : v === '2' ? 2 : 1);
        onChange();
      },
    });
    disposables.push(stepSelect);
    stepSection.content.appendChild(stepSelect.element);
    const nextBtn = createButton({
      label: 'Next step ▶',
      onClick: () => {
        // Joining the sides: slow down so the formation of the zone can be followed.
        if (step === 1) params.speed = 0.2;
        goTo(Math.min(3, step + 1) as Step);
        syncControls();
        onChange();
      },
    });
    const eqBtn = createButton({
      label: 'Jump to equilibrium',
      variant: 'secondary',
      onClick: () => {
        lat.equilibrate(25);
        if (!lat.wall) joinedFor += 25;
        win = { t: lat.time, cross: lat.crossings, rec: lat.recombinedTotal };
      },
    });
    const replayBtn = createButton({
      label: 'Replay the joining ↺',
      variant: 'secondary',
      onClick: () => {
        goTo(1);
        gapFrac = 1;
        goTo(2);
        syncControls();
        onChange();
      },
    });
    pauseButton = createButton({
      label: 'Pause',
      variant: 'secondary',
      onClick: () => {
        paused = !paused;
        pauseButton?.setLabel(paused ? 'Resume' : 'Pause');
      },
    });
    disposables.push(nextBtn, replayBtn, eqBtn, pauseButton);
    stepSection.content.appendChild(nextBtn.element);
    stepSection.content.appendChild(replayBtn.element);
    stepSection.content.appendChild(eqBtn.element);
    stepSection.content.appendChild(pauseButton.element);
    controlsPanel.appendChild(stepSection.element);

    const biasSection = createSection({ title: 'External voltage (step 3)' });
    disposables.push(biasSection);
    addSlider(biasSection.content, 'v', {
      label: 'Applied voltage (+ = positive terminal on P)',
      min: -2,
      max: 1.5,
      step: 0.05,
      value: params.voltage,
      format: (v) =>
        v === 0 ? '0 V' : `${v > 0 ? '+' : ''}${v.toFixed(2)} V ${v > 0 ? 'forward' : 'reverse'}`,
      onChange: (v) => {
        params.voltage = v;
        onChange();
      },
    });
    controlsPanel.appendChild(biasSection.element);

    const matSection = createSection({ title: 'Doping' });
    disposables.push(matSection);
    addSlider(matSection.content, 'np', {
      label: 'P side: acceptors (holes)',
      min: 300,
      max: 1500,
      step: 100,
      value: params.nP,
      format: (v) => v.toFixed(0),
      onChange: (v) => {
        params.nP = Math.round(v);
        onChange();
        rebuild();
      },
    });
    addSlider(matSection.content, 'nn', {
      label: 'N side: donors (electrons)',
      min: 300,
      max: 1500,
      step: 100,
      value: params.nN,
      format: (v) => v.toFixed(0),
      onChange: (v) => {
        params.nN = Math.round(v);
        onChange();
        rebuild();
      },
    });
    addSlider(matSection.content, 'speed', {
      label: 'Simulation speed (slow motion to fast)',
      min: 0,
      max: SPEEDS.length - 1,
      step: 1,
      value: SPEEDS.indexOf(params.speed),
      format: (v) => `${SPEEDS[Math.round(v)]}×`,
      onChange: (v) => {
        params.speed = SPEEDS[Math.round(v)]!;
        onChange();
      },
    });
    controlsPanel.appendChild(matSection.element);
  }

  rebuild();

  // ---- stepping -----------------------------------------------------------------------
  function stepSimulation(): void {
    // Below 1x one smaller step per frame (smooth slow motion); above, several steps.
    const before = lat.time;
    if (params.speed < 1) lat.step(DT * params.speed);
    else for (let s = 0; s < params.speed; s++) lat.step(DT);
    if (!lat.wall) joinedFor += lat.time - before;
    if (!lat.wall && step === 2 && joinedFor - lastForm >= 0.5) {
      lastForm = joinedFor;
      let peak = 0;
      for (let b = 0; b < NB; b++) peak = Math.max(peak, -lat.eInt[b]!);
      form.t.push(joinedFor);
      form.w.push(lat.depletionWidth);
      form.e.push(peak / E_REF);
      if (form.t.length > 400) {
        form.t.shift();
        form.w.shift();
        form.e.shift();
      }
    }
    const dtw = lat.time - win.t;
    if (dtw >= 0.5) {
      const raw = (lat.crossings - win.cross) / dtw;
      current += (raw - current) * 0.3;
      annihilationRate = (lat.recombinedTotal - win.rec) / dtw;
      win = { t: lat.time, cross: lat.crossings, rec: lat.recombinedTotal };
      if (step === 3) {
        hist.t.push(lat.time);
        hist.i.push(current);
        if (hist.t.length > (HISTORY_SPAN / 0.5) * 1.2) {
          hist.t.shift();
          hist.i.shift();
        }
      }
    }
  }

  // ---- rendering ----------------------------------------------------------------------
  function render(): void {
    const W = canvas.width;
    const H = canvas.height;
    const ctx = canvas.ctx;
    canvas.clear();

    const capH = 84;
    const fieldH = 56;
    const curH = 58;
    const plotH = clamp(H - 640, 0, 150);
    const boxTop = capH + fieldH;
    const boxH = Math.max(120, H - boxTop - curH - plotH - 10);
    const marginX = 30;
    const gapPx = gapFrac * Math.min(90, W * 0.1);
    const sx = (W - 2 * marginX - gapPx) / LX;
    const sy = boxH / LY;
    const X = (x: number): number => marginX + x * sx + (x >= XJ ? gapPx : 0);
    const Y = (y: number): number => boxTop + y * sy;

    renderCaption(ctx, W);
    renderBoxes(ctx, X, Y, sx, sy, boxTop, boxH);
    renderFieldRow(ctx, X, sx, capH, fieldH);
    renderCurrentRow(ctx, marginX, boxTop + boxH + 6, W - 2 * marginX);

    if (plotH >= 110 && (step === 3 || step === 2)) {
      ctx.save();
      ctx.translate(0, H - plotH);
      if (step === 3) renderHistory(W, plotH);
      else renderFormation(W, plotH);
      ctx.restore();
    }
  }

  function renderCaption(ctx: CanvasRenderingContext2D, W: number): void {
    const v = params.voltage;
    const titles: Record<Step, string> = {
      1: 'Step 1: separated P and N sides',
      2: 'Step 2: the junction forms (slow it down with the speed slider)',
      3: `Step 3: ${v > 0.01 ? 'forward' : v < -0.01 ? 'reverse' : 'zero'} bias${
        v === 0 ? '' : `, ${v > 0 ? '+' : ''}${v.toFixed(2)} V`
      }`,
    };
    const texts: Record<Step, string[]> = {
      1: [
        'The P side (left) has free holes, the N side (right) free electrons. Each side is neutral:',
        'the mobile carriers are balanced by the fixed acceptor (−) and donor (+) ions.',
      ],
      2: [
        'Electrons diffuse into the P side and holes into the N side, where they annihilate. The ions left',
        'behind form a charged depletion zone and a built-in field (arrows) that stops further diffusion.',
      ],
      3:
        v > 0.01
          ? [
              'The applied field opposes the built-in one: the depletion zone shrinks, electrons and holes are',
              v > 0.5
                ? 'injected and cross the junction. At this bias they sit at different energy levels and hardly recombine.'
                : 'injected from the contacts and cross the junction, so a current flows (it grows with the voltage).',
            ]
          : v < -0.01
            ? [
                'The applied field adds to the built-in one: the depletion zone widens and carriers are pulled',
                'away from the junction. Only a tiny leakage current flows.',
              ]
            : ['Zero voltage: no net current, the junction stays in equilibrium.', ''],
    };
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#eee';
    ctx.font = 'bold 15px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(titles[step], 12, 8);
    ctx.fillStyle = '#bbb';
    ctx.font = '12.5px -apple-system, BlinkMacSystemFont, sans-serif';
    texts[step].forEach((l, i) => ctx.fillText(l, 12, 30 + i * 17));
    ctx.fillStyle = '#999';
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    const dep = lat.wall ? 'none' : `${lat.depletionWidth.toFixed(2)}`;
    ctx.fillText(
      `electrons ${lat.electrons.n}   holes ${lat.holes.n}   depletion zone ${dep}   annihilations ${annihilationRate.toFixed(0)} / s${
        paused ? '   (paused)' : ''
      }`,
      12,
      64
    );
    ctx.restore();
    void W;
  }

  function renderBoxes(
    ctx: CanvasRenderingContext2D,
    X: (x: number) => number,
    Y: (y: number) => number,
    sx: number,
    sy: number,
    boxTop: number,
    boxH: number
  ): void {
    const time = lat.time;
    const boxes: Array<{ x0: number; x1: number; ion: string; color: string }> = [
      { x0: 0, x1: XJ, ion: '−', color: COLOR_ACC },
      { x0: XJ, x1: LX, ion: '+', color: COLOR_DON },
    ];
    for (const b of boxes) {
      const px0 = X(b.x0 + 1e-9);
      const px1 = b.x1 === XJ ? X(XJ - 1e-9) : X(LX);
      ctx.save();
      ctx.fillStyle = '#10131a';
      ctx.fillRect(px0, boxTop, px1 - px0, boxH);
      // fixed ions as a faint grid
      ctx.fillStyle = b.color;
      ctx.globalAlpha = 0.22;
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let x = px0 + 14; x < px1 - 6; x += 30) {
        for (let y = boxTop + 14; y < boxTop + boxH - 6; y += 30) ctx.fillText(b.ion, x, y);
      }
      ctx.restore();
    }

    // charged depletion zone: net charge of the region
    if (!lat.wall) {
      for (let k = 0; k < NB; k++) {
        const r = lat.rho[k]!;
        const ion = k >= NB / 2 ? lat.nDonors / (NB / 2) : lat.nAcceptors / (NB / 2);
        const frac = Math.abs(r / ion);
        const a = Math.min(0.45, Math.max(0, (frac - 0.25) * 0.8));
        if (a < 0.03) continue;
        ctx.fillStyle = r > 0 ? `rgba(255,179,71,${a})` : `rgba(199,125,255,${a})`;
        const x0 = X(k * DXB);
        ctx.fillRect(x0, boxTop, X((k + 1) * DXB) - x0 + 0.5, boxH);
      }
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#667';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(X(XJ), boxTop);
      ctx.lineTo(X(XJ), boxTop + boxH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // carriers
    ctx.fillStyle = COLOR_H;
    ctx.beginPath();
    const h = lat.holes;
    for (let i = 0; i < h.n; i++) {
      const x = X(h.x[i]!);
      const y = Y(h.y[i]!);
      ctx.moveTo(x + 1.9, y);
      ctx.arc(x, y, 1.9, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillStyle = COLOR_E;
    ctx.beginPath();
    const e = lat.electrons;
    for (let i = 0; i < e.n; i++) {
      const x = X(e.x[i]!);
      const y = Y(e.y[i]!);
      ctx.moveTo(x + 1.9, y);
      ctx.arc(x, y, 1.9, 0, Math.PI * 2);
    }
    ctx.fill();

    // annihilation and generation flashes
    for (const f of lat.flashes) {
      const age = time - f.t;
      if (age > 0.5) continue;
      const p = age / 0.5;
      const x = X(f.x);
      const y = Y(f.y);
      ctx.strokeStyle =
        f.kind === 'rec' ? `rgba(255, 225, 74, ${1 - p})` : `rgba(255, 255, 255, ${0.7 * (1 - p)})`;
      ctx.lineWidth = f.kind === 'rec' ? 2 : 1.2;
      ctx.beginPath();
      ctx.arc(x, y, 3 + p * (f.kind === 'rec' ? 11 : 8), 0, Math.PI * 2);
      ctx.stroke();
    }

    // frames
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(X(0), boxTop, X(XJ - 1e-9) - X(0), boxH);
    ctx.strokeRect(X(XJ), boxTop, X(LX) - X(XJ), boxH);

    // contacts with the applied voltage
    if (step === 3) {
      const v = params.voltage;
      const plate = (x: number, sign: number): void => {
        ctx.fillStyle = sign === 0 ? '#555' : sign > 0 ? '#d94a4a' : '#4a7bd9';
        ctx.fillRect(x, boxTop, 8, boxH);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 18px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (sign !== 0) ctx.fillText(sign > 0 ? '+' : '−', x + 4, boxTop + boxH / 2);
      };
      const s = v > 0.005 ? 1 : v < -0.005 ? -1 : 0;
      plate(X(0) - 10, s);
      plate(X(LX) + 2, -s);
    }

    // labels
    ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tag = (label: string, cx: number, color: string): void => {
      const w = ctx.measureText(label).width + 16;
      ctx.fillStyle = 'rgba(10,10,10,0.75)';
      ctx.fillRect(cx - w / 2, boxTop + 8, w, 22);
      ctx.fillStyle = color;
      ctx.fillText(label, cx, boxTop + 19);
    };
    tag('P side: holes', (X(0) + X(XJ - 1e-9)) / 2, COLOR_H);
    tag('N side: electrons', (X(XJ) + X(LX)) / 2, COLOR_E);
    void sx;
    void sy;
  }

  function renderFieldRow(
    ctx: CanvasRenderingContext2D,
    X: (x: number) => number,
    sx: number,
    top: number,
    h: number
  ): void {
    ctx.save();
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLOR_DON;
    const cy = top + h / 2 + 6;
    ctx.fillText(
      lat.wall ? 'electric field: none, each side is neutral' : 'electric field in the crystal',
      X(0),
      top + 8
    );
    if (!lat.wall) {
      const stride = 4;
      const spacing = stride * DXB * sx;
      for (let b = 2; b < NB; b += stride) {
        const E = lat.eTot[b]!;
        const len = clamp(E / E_REF, -1.2, 1.2) * spacing * 0.95;
        if (Math.abs(len) < 4) continue;
        const x = X((b + 0.5) * DXB);
        const dir = Math.sign(len);
        ctx.strokeStyle = COLOR_DON;
        ctx.fillStyle = COLOR_DON;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(x - len / 2, cy);
        ctx.lineTo(x + len / 2 - dir * 5, cy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + len / 2, cy);
        ctx.lineTo(x + len / 2 - dir * 9, cy - 5);
        ctx.lineTo(x + len / 2 - dir * 9, cy + 5);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function renderCurrentRow(ctx: CanvasRenderingContext2D, x: number, y: number, w: number): void {
    ctx.save();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, sans-serif';
    const cy = y + 14;
    ctx.fillStyle = '#7CFF9F';
    ctx.fillText('Current', x, cy);
    const ax = x + 80;
    if (step === 3) {
      const len = clamp(Math.abs(current) / I_REF, 0, 1) * (w - 200);
      if (len > 6) {
        const dir = Math.sign(current);
        const x0 = dir > 0 ? ax : ax + len;
        const x1 = dir > 0 ? ax + len : ax;
        ctx.strokeStyle = '#7CFF9F';
        ctx.lineWidth = 9;
        ctx.beginPath();
        ctx.moveTo(x0, cy);
        ctx.lineTo(x1 - dir * 14, cy);
        ctx.stroke();
        ctx.fillStyle = '#7CFF9F';
        ctx.beginPath();
        ctx.moveTo(x1, cy);
        ctx.lineTo(x1 - dir * 16, cy - 13);
        ctx.lineTo(x1 - dir * 16, cy + 13);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = '#ddd';
      ctx.font = '14px -apple-system, BlinkMacSystemFont, sans-serif';
      const label = `${current >= 0 ? '' : '−'}${Math.abs(current).toFixed(0)} carriers / s through the junction`;
      ctx.fillText(label, ax + (len > 6 ? len + 12 : 0), cy);
    } else {
      ctx.fillStyle = '#888';
      ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(step === 1 ? 'no circuit' : 'none: no net current at equilibrium', ax, cy);
    }

    // legend
    const ly = y + 42;
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    let lx = x;
    const item = (draw: () => void, label: string): void => {
      draw();
      ctx.fillStyle = '#bbb';
      ctx.fillText(label, lx + 12, ly);
      lx += 12 + ctx.measureText(label).width + 16;
    };
    item(() => {
      ctx.fillStyle = COLOR_E;
      ctx.beginPath();
      ctx.arc(lx + 4, ly, 3, 0, Math.PI * 2);
      ctx.fill();
    }, 'electron');
    item(() => {
      ctx.fillStyle = COLOR_H;
      ctx.beginPath();
      ctx.arc(lx + 4, ly, 3, 0, Math.PI * 2);
      ctx.fill();
    }, 'hole');
    item(() => {
      ctx.fillStyle = COLOR_DON;
      ctx.fillText('+', lx, ly);
    }, 'donor ion (fixed)');
    item(() => {
      ctx.fillStyle = COLOR_ACC;
      ctx.fillText('−', lx, ly);
    }, 'acceptor ion (fixed)');
    item(() => {
      ctx.strokeStyle = '#ffe14a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(lx + 4, ly, 4, 0, Math.PI * 2);
      ctx.stroke();
    }, 'annihilation');
    item(() => {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(lx + 4, ly, 4, 0, Math.PI * 2);
      ctx.stroke();
    }, 'thermal pair creation');
    item(() => {
      ctx.fillStyle = 'rgba(255,179,71,0.5)';
      ctx.fillRect(lx, ly - 5, 8, 10);
      ctx.fillStyle = 'rgba(199,125,255,0.5)';
      ctx.fillRect(lx + 8, ly - 5, 8, 10);
      lx += 8;
    }, 'uncompensated ions (depletion zone)');
    ctx.restore();
  }

  function renderHistory(width: number, height: number): void {
    const t = lat.time;
    let hi = 10;
    let lo = -10;
    for (const v of hist.i) {
      if (v > hi) hi = v;
      if (v < lo) lo = v;
    }
    hi *= 1.15;
    lo *= 1.15;
    const xMin = Math.max(0, t - HISTORY_SPAN);
    histPlot.setBounds({ xMin, xMax: xMin + HISTORY_SPAN, yMin: lo, yMax: hi });
    histPlot.setSize(width, height);
    const xTicks = Plot2D.generateTicks(xMin, xMin + HISTORY_SPAN, 6);
    const yTicks = Plot2D.generateTicks(lo, hi, 4);
    histPlot.drawGrid(xTicks, yTicks);
    histPlot.drawAxes('time', 'current');
    histPlot.drawTickLabels(
      xTicks,
      yTicks,
      (v) => v.toFixed(0),
      (v) => v.toFixed(0)
    );
    if (hist.t.length > 1) histPlot.drawLine(hist.t, hist.i, '#7CFF9F', 2);
  }

  function renderFormation(width: number, height: number): void {
    const last = form.t.length > 0 ? form.t[form.t.length - 1]! : 0;
    const xMax = Math.max(30, last * 1.05);
    histPlot.setBounds({ xMin: 0, xMax, yMin: 0, yMax: 1.1 });
    histPlot.setSize(width, height);
    const xTicks = Plot2D.generateTicks(0, xMax, 6);
    const yTicks = Plot2D.generateTicks(0, 1, 4);
    histPlot.drawGrid(xTicks, yTicks);
    histPlot.drawAxes('time since the sides were joined', 'zone / field');
    histPlot.drawTickLabels(
      xTicks,
      yTicks,
      (v) => v.toFixed(0),
      (v) => v.toFixed(1)
    );
    if (form.t.length > 1) {
      histPlot.drawLine(form.t, form.w, COLOR_DON, 2);
      histPlot.drawLine(form.t, form.e, '#ffffff', 2);
    }
    histPlot.drawText('depletion zone width (box widths)', xMax * 0.97, 0.3, {
      color: COLOR_DON,
      align: 'right',
      fontSize: 11,
    });
    histPlot.drawText('built-in field (relative)', xMax * 0.97, 0.15, {
      color: '#fff',
      align: 'right',
      fontSize: 11,
    });
  }

  const loop = new AnimationLoop(() => {
    if (!paused) stepSimulation();
    const target = step === 1 ? 1 : 0;
    gapFrac += (target - gapFrac) * 0.08;
    if (Math.abs(target - gapFrac) < 0.002) gapFrac = target;
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
      rebuild();
    },
  };
}

export const pnJunctionDemo: DemoDefinition = {
  id: 'pn-junction',
  title: 'PN junction: depletion zone, built-in field and bias',
  description:
    'Follow a PN junction in three steps. First the P and N sides apart, each with its free holes or electrons. Then join them and watch carriers diffuse and annihilate, leaving a charged depletion zone and a built-in field. Finally apply a forward or reverse voltage and see the zone change and the current flow.',
  category: 'Electrical properties',
  tags: [
    'pn junction',
    'diode',
    'depletion zone',
    'built-in field',
    'forward bias',
    'reverse bias',
    'current',
    'holes',
    'electrons',
  ],
  create,
};

export default pnJunctionDemo;
