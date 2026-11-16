/**
 * Electron-hole pairs in semiconductors and insulators (Lecture 13: Electrical properties)
 *
 * An ordered 2D crystal in which heat promotes valence electrons across the band gap.
 * Each excitation leaves a hole on an atom (a missing valence electron) and puts a
 * conduction electron in the open space between atoms. Both wander (a hole moves when a
 * neighbouring valence electron slides into it), and when an electron meets a hole they
 * annihilate. A band diagram next to the lattice counts the electrons in the conduction
 * band and the holes in the valence band.
 *
 * The physics is in pairs.ts.
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import { Plot2D } from '@core/canvas/Plot2D';
import {
  createSlider,
  createButton,
  type Disposable,
  type SliderControl,
  type ButtonControl,
} from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import { PairLattice, NX, NY, KB, SLIDE_TIME, MAX_PAIRS } from './pairs';

interface DemoParams {
  temperature: number;
  gap: number;
  field: number;
  speed: number;
}

const defaultParams: DemoParams = { temperature: 1000, gap: 1.12, field: 0, speed: 1 };

const DT = 0.05;
const HISTORY_SPAN = 120;
const HISTORY_DT = 0.5;
const RATE_WINDOW = 6;

const COLOR_E = '#4ac3ff';
const COLOR_H = '#ff5a6e';
const COLOR_VAL = '#aab8d8';

function parseParams(raw: Record<string, string>, base: DemoParams): DemoParams {
  const num = (key: string, fallback: number): number => {
    const v = parseFloat(raw[key] ?? '');
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    temperature: clamp(num('T', base.temperature), 0, 1500),
    gap: clamp(num('eg', base.gap), 0.3, 6),
    field: clamp(num('e', base.field), 0, 3),
    speed: Math.round(clamp(num('speed', base.speed), 1, 8)),
  };
}

function wrapPos(v: number, n: number): number {
  return ((v % n) + n) % n;
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  let params: DemoParams = parseParams(options.getParams(), defaultParams);

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0a0a0a', autoResize: true });
  const pairPlot = new Plot2D(canvas.ctx, {
    bounds: { xMin: 0, xMax: HISTORY_SPAN, yMin: 0, yMax: 10 },
    margins: { top: 22, right: 14, bottom: 36, left: 46 },
  });

  const lat = new PairLattice();

  // ---- run state ----------------------------------------------------------------------
  let paused = false;
  let hist: { t: number[]; n: number[] } = { t: [], n: [] };
  let lastSample = 0;
  let genRate = 0;
  let recRate = 0;
  let current = 0;
  let win = { t: 0, gen: 0, rec: 0, hopE: 0, hopH: 0 };

  function applyParams(): void {
    lat.temperature = params.temperature;
    lat.gap = params.gap;
    lat.field = params.field;
  }

  function resetStats(): void {
    hist = { t: [], n: [] };
    lastSample = lat.time;
    genRate = recRate = current = 0;
    win = {
      t: lat.time,
      gen: lat.generated,
      rec: lat.recombined,
      hopE: lat.netHopE,
      hopH: lat.netHopH,
    };
  }

  function equilibrateNow(): void {
    lat.clear();
    applyParams();
    lat.equilibrate(500);
    resetStats();
  }

  // ---- controls -----------------------------------------------------------------------
  const disposables: Disposable[] = [];
  const sliders: Record<string, SliderControl> = {};
  let pauseButton: ButtonControl | undefined;

  function syncControls(): void {
    sliders.T?.setValue(params.temperature);
    sliders.eg?.setValue(params.gap);
    sliders.e?.setValue(params.field);
    sliders.speed?.setValue(params.speed);
  }

  function currentUrlParams(): Record<string, string> {
    return {
      T: params.temperature.toFixed(0),
      eg: params.gap.toFixed(2),
      e: params.field.toFixed(2),
      speed: String(params.speed),
    };
  }

  function onChange(): void {
    applyParams();
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
        'Every atom holds one valence electron. Heat can kick one into the empty space between atoms (a conduction electron, blue), leaving a hole (red) behind. A hole moves when a neighbouring valence electron slides into it. When an electron meets a hole they annihilate. The number of pairs rises steeply with temperature and falls steeply with the band gap. (Demo temperatures are exaggerated: a real crystal has about 10²² atoms per cm³, so even a tiny fraction of excited atoms is many carriers.)'
      )
    );

    const matSection = createSection({ title: 'Material' });
    disposables.push(matSection);
    const presets: Array<[string, number, 'primary' | 'secondary']> = [
      ['Germanium (0.67 eV)', 0.67, 'secondary'],
      ['Silicon (1.12 eV)', 1.12, 'primary'],
      ['GaAs (1.42 eV)', 1.42, 'secondary'],
      ['Diamond, an insulator (5.5 eV)', 5.5, 'secondary'],
    ];
    for (const [label, gap, variant] of presets) {
      const b = createButton({
        label,
        variant,
        onClick: () => {
          params.gap = gap;
          syncControls();
          onChange();
        },
      });
      disposables.push(b);
      matSection.content.appendChild(b.element);
    }
    addSlider(matSection.content, 'eg', {
      label: 'Band gap Eg',
      min: 0.3,
      max: 6,
      step: 0.05,
      value: params.gap,
      format: (v) => `${v.toFixed(2)} eV`,
      onChange: (v) => {
        params.gap = v;
        onChange();
      },
    });
    controlsPanel.appendChild(matSection.element);

    const condSection = createSection({ title: 'Conditions' });
    disposables.push(condSection);
    addSlider(condSection.content, 'T', {
      label: 'Temperature',
      min: 0,
      max: 1500,
      step: 25,
      value: params.temperature,
      format: (v) => `${v.toFixed(0)} K`,
      onChange: (v) => {
        params.temperature = v;
        onChange();
      },
    });
    addSlider(condSection.content, 'e', {
      label: 'Electric field (points right)',
      min: 0,
      max: 3,
      step: 0.25,
      value: params.field,
      format: (v) => (v === 0 ? 'off' : v.toFixed(2)),
      onChange: (v) => {
        params.field = v;
        onChange();
      },
    });
    addSlider(condSection.content, 'speed', {
      label: 'Simulation speed',
      min: 1,
      max: 8,
      step: 1,
      value: params.speed,
      format: (v) => `${v.toFixed(0)}×`,
      onChange: (v) => {
        params.speed = Math.round(v);
        onChange();
      },
    });
    controlsPanel.appendChild(condSection.element);

    const runSection = createSection({ title: 'Run' });
    disposables.push(runSection);
    pauseButton = createButton({
      label: 'Pause',
      variant: 'secondary',
      onClick: () => {
        paused = !paused;
        pauseButton?.setLabel(paused ? 'Resume' : 'Pause');
      },
    });
    const eqBtn = createButton({
      label: 'Jump to equilibrium',
      variant: 'secondary',
      onClick: () => equilibrateNow(),
    });
    const clearBtn = createButton({
      label: 'Remove all pairs',
      variant: 'secondary',
      onClick: () => {
        lat.clear();
        resetStats();
      },
    });
    disposables.push(pauseButton, eqBtn, clearBtn);
    runSection.content.appendChild(pauseButton.element);
    runSection.content.appendChild(eqBtn.element);
    runSection.content.appendChild(clearBtn.element);
    controlsPanel.appendChild(runSection.element);
  }

  equilibrateNow();

  // ---- stepping -----------------------------------------------------------------------
  function stepSimulation(): void {
    for (let s = 0; s < params.speed; s++) lat.step(DT);

    if (lat.time - lastSample >= HISTORY_DT) {
      hist.t.push(lat.time);
      hist.n.push(lat.pairs);
      if (hist.t.length > HISTORY_SPAN / HISTORY_DT + 2) {
        hist.t.shift();
        hist.n.shift();
      }
      lastSample = lat.time;
    }

    if (lat.time - win.t >= RATE_WINDOW) {
      const dtWin = lat.time - win.t;
      genRate = (lat.generated - win.gen) / dtWin;
      recRate = (lat.recombined - win.rec) / dtWin;
      // conventional current along +x: holes moving right plus electrons moving left
      current = (lat.netHopH - win.hopH - (lat.netHopE - win.hopE)) / dtWin / NY;
      win = {
        t: lat.time,
        gen: lat.generated,
        rec: lat.recombined,
        hopE: lat.netHopE,
        hopH: lat.netHopH,
      };
    }
  }

  // ---- rendering ----------------------------------------------------------------------
  function render(): void {
    const width = canvas.width;
    const height = canvas.height;
    const ctx = canvas.ctx;
    const headerH = 44;
    const legendH = 24;
    const arrowsH = 78;
    const leftW = width * 0.6;

    canvas.clear();
    renderHeader();

    const s = Math.max(
      6,
      Math.min((leftW - 16) / NX, (height - headerH - legendH - arrowsH - 8) / NY)
    );
    const ox = (leftW - s * NX) / 2;
    const oy = headerH;
    renderLattice(ctx, s, ox, oy);
    renderLegend(ctx, ox, oy + s * NY + 6);
    renderArrows(ctx, ox, oy + s * NY + legendH + 4, s * NX);

    const rx = leftW;
    const rw = width - leftW;
    const rh = height - headerH;
    const bandH = Math.max(160, rh * 0.64);
    ctx.save();
    ctx.translate(rx, headerH - 6);
    renderBands(ctx, rw, bandH);
    ctx.restore();

    const plotH = height - headerH - bandH;
    if (plotH > 80) {
      ctx.save();
      ctx.translate(rx, headerH + bandH - 6);
      renderHistory(rw, plotH);
      ctx.restore();
    }
  }

  function renderHeader(): void {
    const ctx = canvas.ctx;
    const kT = KB * params.temperature;
    const ratio = kT > 0 ? params.gap / kT : Infinity;
    const kind = params.gap > 3 ? 'insulator' : 'semiconductor';
    const lines = [
      `T = ${params.temperature.toFixed(0)} K    kT = ${kT.toFixed(3)} eV    Eg = ${params.gap.toFixed(2)} eV (${kind})    Eg / kT = ${
        Number.isFinite(ratio) ? ratio.toFixed(1) : '∞'
      }${paused ? '    (paused)' : ''}`,
      `pairs now: ${lat.pairs}    created ${genRate.toFixed(2)} / time    annihilated ${recRate.toFixed(2)} / time`,
    ];
    ctx.save();
    ctx.fillStyle = '#ddd';
    ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, 10, 6 + i * 18));

    ctx.restore();
  }

  /** Draw something at (x, y) in lattice units, repeating it across periodic edges. */
  function atWrapped(
    x: number,
    y: number,
    s: number,
    ox: number,
    oy: number,
    draw: (cx: number, cy: number) => void
  ): void {
    const xs = [x];
    const ys = [y];
    if (x < 0.7) xs.push(x + NX);
    if (x > NX - 0.7) xs.push(x - NX);
    if (y < 0.7) ys.push(y + NY);
    if (y > NY - 0.7) ys.push(y - NY);
    for (const px of xs) for (const py of ys) draw(ox + px * s, oy + py * s);
  }

  function renderLattice(ctx: CanvasRenderingContext2D, s: number, ox: number, oy: number): void {
    ctx.save();
    ctx.fillStyle = '#10131a';
    ctx.fillRect(ox, oy, s * NX, s * NY);
    ctx.beginPath();
    ctx.rect(ox, oy, s * NX, s * NY);
    ctx.clip();

    // bonds
    ctx.strokeStyle = '#2a3347';
    ctx.lineWidth = Math.max(1.5, s * 0.07);
    ctx.beginPath();
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const cx = ox + (i + 0.5) * s;
        const cy = oy + (j + 0.5) * s;
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + s, cy);
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx, cy + s);
      }
    }
    ctx.stroke();
    // stubs that continue across the periodic edges
    ctx.beginPath();
    for (let j = 0; j < NY; j++) {
      ctx.moveTo(ox, oy + (j + 0.5) * s);
      ctx.lineTo(ox + 0.5 * s, oy + (j + 0.5) * s);
    }
    ctx.stroke();

    // atom cores and their valence electron
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const cx = ox + (i + 0.5) * s;
        const cy = oy + (j + 0.5) * s;
        ctx.fillStyle = '#1b2436';
        ctx.strokeStyle = '#3b4a68';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.fillStyle = COLOR_VAL;
    ctx.beginPath();
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const k = j * NX + i;
        if (lat.hOcc[k] || lat.hiddenUntil[k]! > lat.time) continue;
        const cx = ox + (i + 0.5) * s;
        const cy = oy + (j + 0.5) * s;
        ctx.moveTo(cx + s * 0.1, cy);
        ctx.arc(cx, cy, s * 0.1, 0, Math.PI * 2);
      }
    }
    ctx.fill();

    // valence electrons sliding into holes
    ctx.fillStyle = COLOR_VAL;
    for (const sl of lat.slides) {
      const f = clamp((lat.time - sl.t) / SLIDE_TIME, 0, 1);
      const x = sl.x0 + (sl.x1 - sl.x0) * f;
      const y = sl.y0 + (sl.y1 - sl.y0) * f;
      atWrapped(wrapPos(x, NX), wrapPos(y, NY), s, ox, oy, (cx, cy) => {
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.1, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // holes
    for (const h of lat.holes) {
      atWrapped(h.px, h.py, s, ox, oy, (cx, cy) => {
        ctx.fillStyle = 'rgba(255, 90, 110, 0.28)';
        ctx.strokeStyle = COLOR_H;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.round(s * 0.42)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('+', cx, cy + 1);
      });
    }

    // electrons
    for (const e of lat.electrons) {
      atWrapped(e.px, e.py, s, ox, oy, (cx, cy) => {
        ctx.save();
        ctx.shadowColor = COLOR_E;
        ctx.shadowBlur = 10;
        ctx.fillStyle = COLOR_E;
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.21, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        ctx.fillStyle = '#06222f';
        ctx.font = `bold ${Math.round(s * 0.38)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('−', cx, cy);
      });
    }

    // annihilation: the electron falls into the hole, then a ring expands
    for (const f of lat.falls) {
      const age = lat.time - f.t;
      const fall = 0.3;
      const x1 = f.x0 + minImg(f.x1 - f.x0, NX);
      const y1 = f.y0 + minImg(f.y1 - f.y0, NY);
      if (age < fall) {
        const p = age / fall;
        const x = f.x0 + (x1 - f.x0) * p;
        const y = f.y0 + (y1 - f.y0) * p;
        atWrapped(wrapPos(x, NX), wrapPos(y, NY), s, ox, oy, (cx, cy) => {
          ctx.fillStyle = COLOR_E;
          ctx.beginPath();
          ctx.arc(cx, cy, s * 0.21 * (1 - 0.5 * p), 0, Math.PI * 2);
          ctx.fill();
        });
      } else {
        const p = (age - fall) / (1 - fall);
        atWrapped(wrapPos(x1, NX), wrapPos(y1, NY), s, ox, oy, (cx, cy) => {
          ctx.strokeStyle = `rgba(255, 225, 74, ${1 - p})`;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(cx, cy, s * (0.3 + 0.9 * p), 0, Math.PI * 2);
          ctx.stroke();
        });
      }
    }
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox, oy, s * NX, s * NY);
    ctx.restore();
  }

  function minImg(d: number, L: number): number {
    return d - L * Math.round(d / L);
  }

  /** Large field and current arrows below the lattice. Lengths scale with the quantity. */
  function renderArrows(ctx: CanvasRenderingContext2D, x: number, y: number, w: number): void {
    const maxLen = w - 150;
    const rows: Array<{ label: string; value: string; len: number; color: string }> = [
      {
        label: 'E field',
        value: params.field > 0 ? params.field.toFixed(2) : 'off',
        len: params.field > 0 ? 20 + (params.field / 3) * (maxLen - 20) : 0,
        color: '#ffb347',
      },
      {
        label: 'Current',
        value: params.field > 0 ? current.toFixed(2) : '0',
        len: params.field > 0 && current > 0.02 ? 20 + Math.min(1, current / 8) * (maxLen - 20) : 0,
        color: '#7CFF9F',
      },
    ];
    ctx.save();
    ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'middle';
    rows.forEach((r, i) => {
      const cy = y + 16 + i * 34;
      ctx.fillStyle = r.color;
      ctx.textAlign = 'left';
      ctx.fillText(r.label, x, cy);
      const ax = x + 80;
      if (r.len > 0) {
        const head = 16;
        ctx.strokeStyle = r.color;
        ctx.lineWidth = 9;
        ctx.beginPath();
        ctx.moveTo(ax, cy);
        ctx.lineTo(ax + r.len - head + 2, cy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ax + r.len, cy);
        ctx.lineTo(ax + r.len - head, cy - 13);
        ctx.lineTo(ax + r.len - head, cy + 13);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#ddd';
        ctx.fillText(r.value, ax + r.len + 10, cy);
      } else {
        ctx.fillStyle = '#888';
        ctx.fillText(r.value, ax, cy);
      }
    });
    ctx.restore();
  }

  function renderLegend(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    ctx.save();
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const cy = y + 9;
    ctx.fillStyle = COLOR_VAL;
    ctx.beginPath();
    ctx.arc(x + 6, cy, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#bbb';
    ctx.fillText('valence electron (bound to an atom)', x + 15, cy);
    ctx.fillStyle = COLOR_E;
    ctx.beginPath();
    ctx.arc(x + 232, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#bbb';
    ctx.fillText('conduction electron', x + 243, cy);
    ctx.strokeStyle = COLOR_H;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x + 375, cy, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#bbb';
    ctx.fillText('hole (missing valence electron)', x + 386, cy);
    ctx.restore();
  }

  function renderBands(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const top = 26;
    const availH = h - top - 10;
    const n = lat.pairs;
    const bandX = 44;
    const bandW = w - bandX - 14;
    const gapPx = Math.max(14, (params.gap / 6) * availH * 0.36);
    const bh = Math.min((availH - gapPx) / 2, availH * 0.34);
    const stack = 2 * bh + gapPx;
    const y0 = top + (availH - stack) / 2;
    const cbTop = y0;
    const cbBot = y0 + bh;
    const vbTop = cbBot + gapPx;
    const vbBot = vbTop + bh;

    ctx.save();
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = '#ddd';
    ctx.textAlign = 'left';
    ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText('Band diagram', 8, 10);
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';

    // energy axis
    ctx.strokeStyle = '#888';
    ctx.fillStyle = '#888';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(20, vbBot);
    ctx.lineTo(20, cbTop - 6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(20, cbTop - 12);
    ctx.lineTo(16, cbTop - 4);
    ctx.lineTo(24, cbTop - 4);
    ctx.closePath();
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillText('E', 20, cbTop - 20);

    // bands
    ctx.fillStyle = 'rgba(74, 195, 255, 0.10)';
    ctx.fillRect(bandX, cbTop, bandW, bh);
    ctx.fillStyle = 'rgba(170, 184, 216, 0.10)';
    ctx.fillRect(bandX, vbTop, bandW, bh);
    ctx.strokeStyle = COLOR_E;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bandX, cbBot);
    ctx.lineTo(bandX + bandW, cbBot);
    ctx.stroke();
    ctx.strokeStyle = COLOR_VAL;
    ctx.beginPath();
    ctx.moveTo(bandX, vbTop);
    ctx.lineTo(bandX + bandW, vbTop);
    ctx.stroke();

    // Fermi level and gap
    ctx.strokeStyle = '#777';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    const mid = (cbBot + vbTop) / 2;
    ctx.beginPath();
    ctx.moveTo(bandX, mid);
    ctx.lineTo(bandX + bandW, mid);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#888';
    ctx.textAlign = 'left';
    ctx.fillText('E_F', bandX + 4, mid - 7);
    ctx.fillStyle = '#ddd';
    ctx.textAlign = 'center';
    ctx.fillText(`Eg = ${params.gap.toFixed(2)} eV`, bandX + bandW / 2, mid - (gapPx > 30 ? 0 : 0));

    ctx.fillStyle = COLOR_E;
    ctx.textAlign = 'right';
    ctx.fillText(
      `conduction band: ${n} electron${n === 1 ? '' : 's'}`,
      bandX + bandW - 6,
      cbTop + 11
    );
    ctx.fillStyle = COLOR_H;
    ctx.fillText(`valence band: ${n} hole${n === 1 ? '' : 's'}`, bandX + bandW - 6, vbBot - 11);

    // carriers
    const d = 11;
    const cols = Math.max(1, Math.floor((bandW - 12) / d));
    const rowsMax = Math.max(1, Math.floor((bh - 22) / d));
    ctx.fillStyle = COLOR_E;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const row = Math.floor(k / cols);
      if (row >= rowsMax) break;
      const x = bandX + 8 + (k % cols) * d + d / 2;
      const y = cbBot - d / 2 - 2 - row * d;
      ctx.moveTo(x + 3.5, y);
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    }
    ctx.fill();

    const vRows = Math.max(1, Math.floor((bh - 22) / d));
    ctx.fillStyle = COLOR_VAL;
    ctx.beginPath();
    for (let k = n; k < cols * vRows; k++) {
      const row = Math.floor(k / cols);
      const x = bandX + 8 + (k % cols) * d + d / 2;
      const y = vbTop + d / 2 + 2 + row * d;
      ctx.moveTo(x + 3, y);
      ctx.arc(x, y, 3, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.strokeStyle = COLOR_H;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const row = Math.floor(k / cols);
      if (row >= vRows) break;
      const x = bandX + 8 + (k % cols) * d + d / 2;
      const y = vbTop + d / 2 + 2 + row * d;
      ctx.moveTo(x + 3.8, y);
      ctx.arc(x, y, 3.8, 0, Math.PI * 2);
    }
    ctx.stroke();

    // transitions across the gap
    for (const ev of lat.bandEvents) {
      const age = lat.time - ev.t;
      const alpha = clamp(1 - age / 1.2, 0, 1);
      const x = bandX + (0.12 + 0.76 * ev.u) * bandW;
      const up = ev.kind === 'gen';
      const y0a = up ? vbTop : cbBot;
      const y1a = up ? cbBot : vbTop;
      ctx.strokeStyle = up ? `rgba(255, 179, 71, ${alpha})` : `rgba(255, 225, 74, ${alpha})`;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, y0a);
      ctx.lineTo(x, y1a + (up ? 6 : -6));
      ctx.stroke();
      const dir = up ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(x, y1a);
      ctx.lineTo(x - 6, y1a - dir * 9);
      ctx.lineTo(x + 6, y1a - dir * 9);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = '#999';
    ctx.textAlign = 'left';
    ctx.fillText('↑ heat excites an electron    ↓ electron falls into a hole', 8, h - 4);
    ctx.restore();
  }

  function renderHistory(width: number, height: number): void {
    const t = lat.time;
    let hi = 5;
    for (const v of hist.n) if (v > hi) hi = v;
    hi *= 1.2;
    const xMin = Math.max(0, t - HISTORY_SPAN);
    pairPlot.setBounds({ xMin, xMax: xMin + HISTORY_SPAN, yMin: 0, yMax: hi });
    pairPlot.setSize(width, height);
    const xTicks = Plot2D.generateTicks(xMin, xMin + HISTORY_SPAN, 4);
    const yTicks = Plot2D.generateTicks(0, hi, 4);
    pairPlot.drawGrid(xTicks, yTicks);
    pairPlot.drawAxes('time', 'pairs');
    pairPlot.drawTickLabels(
      xTicks,
      yTicks,
      (v) => v.toFixed(0),
      (v) => v.toFixed(0)
    );
    if (hist.t.length > 1) pairPlot.drawLine(hist.t, hist.n, '#7CFF9F', 2);
    if (lat.pairs >= MAX_PAIRS) {
      pairPlot.drawText('saturated (demo limit)', xMin + HISTORY_SPAN * 0.97, hi * 0.9, {
        color: '#ff9f4a',
        align: 'right',
        fontSize: 11,
      });
    }
  }

  const loop = new AnimationLoop(() => {
    if (!paused) stepSimulation();
    lat.animate(0.25);
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
      equilibrateNow();
    },
  };
}

export const semiconductorPairsDemo: DemoDefinition = {
  id: 'semiconductor-pairs',
  title: 'Electron-hole pairs in semiconductors and insulators',
  description:
    'Heat lifts valence electrons across the band gap, creating conduction electrons and holes in an ordered lattice. Watch holes move as neighbouring electrons slide into them, see electrons and holes annihilate, and read the carrier numbers off a band diagram as you change temperature, band gap and field.',
  category: 'Electrical properties',
  tags: [
    'semiconductor',
    'insulator',
    'band gap',
    'electron-hole pair',
    'holes',
    'recombination',
    'band diagram',
  ],
  create,
};

export default semiconductorPairsDemo;
