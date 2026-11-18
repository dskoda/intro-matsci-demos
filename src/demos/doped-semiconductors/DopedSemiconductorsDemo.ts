/**
 * N-type and P-type doped semiconductors (Lecture 14: Electrical properties)
 *
 * Follows the electron-hole pair demo of Lecture 13, but a fraction of the atoms are
 * dopants. A donor (N-type) carries one extra electron, bound in a level just below the
 * conduction band; heat frees it. An acceptor (P-type) lacks one electron, so a hole is
 * bound in a level just above the valence band; heat makes a neighbouring valence
 * electron jump into it and leaves a free hole. The band diagram shows the dopant level
 * and the jumps to and from it. With many dopants, one carrier type dominates.
 *
 * The physics is in doped.ts.
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
import { DopedLattice, NX, NY, KB, SLIDE_TIME, MAX_DOPANTS, type DopantType } from './doped';

interface DemoParams {
  type: DopantType;
  dopants: number;
  binding: number;
  gap: number;
  temperature: number;
  field: number;
  speed: number;
}

const defaultParams: DemoParams = {
  type: 'n',
  dopants: 1,
  binding: 0.05,
  gap: 1.12,
  temperature: 300,
  field: 0,
  speed: 1,
};

const DT = 0.05;
const HISTORY_SPAN = 120;
const HISTORY_DT = 0.5;

const COLOR_E = '#4ac3ff';
const COLOR_H = '#ff5a6e';
const COLOR_VAL = '#aab8d8';
const COLOR_DON = '#ffb347';
const COLOR_ACC = '#c77dff';

function parseParams(raw: Record<string, string>, base: DemoParams): DemoParams {
  const num = (key: string, fallback: number): number => {
    const v = parseFloat(raw[key] ?? '');
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    type: raw.type === 'p' ? 'p' : raw.type === 'n' ? 'n' : base.type,
    dopants: Math.round(clamp(num('nd', base.dopants), 0, MAX_DOPANTS)),
    binding: clamp(num('eb', base.binding), 0.02, 0.3),
    gap: clamp(num('eg', base.gap), 0.5, 3),
    temperature: clamp(num('T', base.temperature), 0, 1500),
    field: clamp(num('e', base.field), 0, 3),
    speed: Math.round(clamp(num('speed', base.speed), 1, 8)),
  };
}

function wrapPos(v: number, n: number): number {
  return ((v % n) + n) % n;
}

function minImg(d: number, L: number): number {
  return d - L * Math.round(d / L);
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  let params: DemoParams = parseParams(options.getParams(), defaultParams);

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0a0a0a', autoResize: true });
  const histPlot = new Plot2D(canvas.ctx, {
    bounds: { xMin: 0, xMax: HISTORY_SPAN, yMin: 0, yMax: 10 },
    margins: { top: 22, right: 14, bottom: 36, left: 62 },
  });

  const lat = new DopedLattice();

  let paused = false;
  let hist = { t: [] as number[], n: [] as number[], p: [] as number[] };
  let lastSample = 0;
  let fermi = 0.5; // smoothed Fermi level position, 0 = valence band top, 1 = conduction band bottom

  function applyParams(): void {
    lat.temperature = params.temperature;
    lat.gap = params.gap;
    lat.binding = Math.min(params.binding, params.gap * 0.9);
    lat.field = params.field;
  }

  function rebuild(): void {
    applyParams();
    lat.setDopants(params.type, params.dopants);
    lat.equilibrate(60);
    resetStats();
  }

  function resetStats(): void {
    hist = { t: [], n: [], p: [] };
    lastSample = lat.time;
    fermi = targetFermi();
  }

  /**
   * Schematic Fermi level: mid-gap when intrinsic, halfway between the dopant level and
   * the band when the dopants dominate (also when they are frozen out).
   */
  function levelFrac(): number {
    return clamp(lat.binding / params.gap, 0.22, 0.45);
  }

  function targetFermi(): number {
    const ne = lat.nElectrons;
    const nh = lat.nHoles;
    const nd = lat.dopList.length;
    const eb = levelFrac();
    const w = nd > 0 ? Math.min(1, (Math.abs(ne - nh) + 1) / (ne + nh + 1)) : 0;
    const ext = params.type === 'n' ? 1 - eb / 2 : eb / 2;
    return 0.5 + (ext - 0.5) * w;
  }

  // ---- controls -----------------------------------------------------------------------
  const disposables: Disposable[] = [];
  const sliders: Record<string, SliderControl> = {};
  let typeSelect: SelectControl | undefined;
  let pauseButton: ButtonControl | undefined;

  function syncControls(): void {
    typeSelect?.setValue(params.type);
    sliders.nd?.setValue(params.dopants);
    sliders.eb?.setValue(params.binding);
    sliders.eg?.setValue(params.gap);
    sliders.T?.setValue(params.temperature);
    sliders.e?.setValue(params.field);
    sliders.speed?.setValue(params.speed);
  }

  function currentUrlParams(): Record<string, string> {
    return {
      type: params.type,
      nd: String(params.dopants),
      eb: params.binding.toFixed(3),
      eg: params.gap.toFixed(2),
      T: params.temperature.toFixed(0),
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
        'Some atoms are replaced by dopants. A donor (N-type, orange) has one electron too many: it sits in a level just below the conduction band and heat frees it, leaving a fixed + ion. An acceptor (P-type, purple) has one too few: a neighbouring valence electron jumps into it, leaving a mobile hole and a fixed − ion. The dopants supply one carrier type (electrons in N-type, holes in P-type), which then outnumbers the thermally generated pairs at moderate temperature; the intrinsic pairs only matter at high temperature. Try low T to see the carriers freeze out.'
      )
    );

    const dopSection = createSection({ title: 'Doping' });
    disposables.push(dopSection);
    typeSelect = createSelect({
      label: 'Dopant type',
      options: [
        { value: 'n', label: 'N-type: donors (extra electron)' },
        { value: 'p', label: 'P-type: acceptors (missing electron)' },
      ],
      value: params.type,
      onChange: (v) => {
        params.type = v === 'p' ? 'p' : 'n';
        onChange();
        rebuild();
      },
    });
    disposables.push(typeSelect);
    dopSection.content.appendChild(typeSelect.element);
    addSlider(dopSection.content, 'nd', {
      label: 'Number of dopants',
      min: 0,
      max: MAX_DOPANTS,
      step: 1,
      value: params.dopants,
      format: (v) => `${v.toFixed(0)} in ${NX * NY} atoms`,
      onChange: (v) => {
        params.dopants = Math.round(v);
        onChange();
        rebuild();
      },
    });
    addSlider(dopSection.content, 'eb', {
      label: 'Dopant level distance from band',
      min: 0.02,
      max: 0.3,
      step: 0.01,
      value: params.binding,
      format: (v) => `${v.toFixed(2)} eV`,
      onChange: (v) => {
        params.binding = v;
        onChange();
      },
    });
    addSlider(dopSection.content, 'eg', {
      label: 'Band gap Eg',
      min: 0.5,
      max: 3,
      step: 0.05,
      value: params.gap,
      format: (v) => `${v.toFixed(2)} eV`,
      onChange: (v) => {
        params.gap = v;
        onChange();
      },
    });
    controlsPanel.appendChild(dopSection.element);

    const condSection = createSection({ title: 'Conditions' });
    disposables.push(condSection);
    addSlider(condSection.content, 'T', {
      label: 'Temperature',
      min: 0,
      max: 1500,
      step: 10,
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
      onClick: () => {
        applyParams();
        lat.equilibrate(60);
        resetStats();
      },
    });
    const clearBtn = createButton({
      label: 'Freeze everything (T = 0 start)',
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

  rebuild();

  // ---- stepping -----------------------------------------------------------------------
  function stepSimulation(): void {
    for (let s = 0; s < params.speed; s++) lat.step(DT);
    if (lat.time - lastSample >= HISTORY_DT) {
      hist.t.push(lat.time);
      hist.n.push(lat.nElectrons);
      hist.p.push(lat.nHoles);
      if (hist.t.length > HISTORY_SPAN / HISTORY_DT + 2) {
        hist.t.shift();
        hist.n.shift();
        hist.p.shift();
      }
      lastSample = lat.time;
    }
  }

  // ---- rendering ----------------------------------------------------------------------
  function render(time: number): void {
    const width = canvas.width;
    const height = canvas.height;
    const ctx = canvas.ctx;
    const headerH = 44;
    const legendH = 44;
    const leftW = width * 0.56;

    canvas.clear();
    renderHeader();

    const s = Math.max(6, Math.min((leftW - 16) / NX, (height - headerH - legendH - 8) / NY));
    const ox = (leftW - s * NX) / 2;
    const oy = headerH;
    renderLattice(ctx, s, ox, oy, time);
    renderLegend(ctx, ox, oy + s * NY + 8);

    const rx = leftW;
    const rw = width - leftW;
    const rh = height - headerH;
    ctx.save();
    ctx.translate(rx, headerH - 6);
    renderBands(ctx, rw, rh + 6);
    ctx.restore();

    renderFieldArrow(ctx, ox, oy + s * NY + legendH, s * NX);
    const histTop = oy + s * NY + legendH + 40;
    const plotH = height - histTop - 4;
    if (plotH > 90) {
      ctx.save();
      ctx.translate(0, histTop);
      renderHistory(leftW, plotH);
      ctx.restore();
    }
  }

  function renderHeader(): void {
    const ctx = canvas.ctx;
    const kT = KB * params.temperature;
    const nd = lat.dopList.length;
    const kind = params.type === 'n' ? 'N-type' : 'P-type';
    const dom =
      lat.nElectrons > lat.nHoles ? 'electrons' : lat.nHoles > lat.nElectrons ? 'holes' : '-';
    const lines = [
      `T = ${params.temperature.toFixed(0)} K    kT = ${kT.toFixed(3)} eV    ${
        nd > 0 ? kind : 'undoped'
      }, ${nd} dopants (${lat.nIonised} ionised)${paused ? '    (paused)' : ''}`,
      `electrons n = ${lat.nElectrons}    holes p = ${lat.nHoles}    majority carriers: ${dom}`,
    ];
    ctx.save();
    ctx.fillStyle = '#ddd';
    ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, 10, 6 + i * 18));
    ctx.restore();
  }

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

  function renderLattice(
    ctx: CanvasRenderingContext2D,
    s: number,
    ox: number,
    oy: number,
    time: number
  ): void {
    ctx.save();
    ctx.fillStyle = '#10131a';
    ctx.fillRect(ox, oy, s * NX, s * NY);
    ctx.beginPath();
    ctx.rect(ox, oy, s * NX, s * NY);
    ctx.clip();

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
    ctx.beginPath();
    for (let j = 0; j < NY; j++) {
      ctx.moveTo(ox, oy + (j + 0.5) * s);
      ctx.lineTo(ox + 0.5 * s, oy + (j + 0.5) * s);
    }
    ctx.stroke();

    const isN = params.type === 'n';
    const dopColor = isN ? COLOR_DON : COLOR_ACC;
    const letter = isN ? 'P' : 'B';

    // atoms, dopants with their charge state
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const k = j * NX + i;
        const cx = ox + (i + 0.5) * s;
        const cy = oy + (j + 0.5) * s;
        const isDop = lat.dop[k] === 1;
        ctx.fillStyle = isDop ? (isN ? '#3d2a0e' : '#2f1a40') : '#1b2436';
        ctx.strokeStyle = isDop ? dopColor : '#3b4a68';
        ctx.lineWidth = isDop ? 2 : 1;
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (!isDop) continue;
        const ion = lat.ion[k] === 1;
        // The element letter sits on the atom; the charge sign sits at its corner.
        ctx.fillStyle = dopColor;
        ctx.font = `bold ${Math.round(s * 0.34)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(letter, cx, cy + 1);
        if (ion) {
          ctx.fillStyle = '#fff';
          ctx.font = `bold ${Math.round(s * 0.4)}px sans-serif`;
          ctx.fillText(isN ? '+' : '−', cx + s * 0.36, cy - s * 0.34);
        } else if (isN) {
          // bound extra electron orbiting the donor
          const a = time * 3 + k;
          const ex = cx + Math.cos(a) * s * 0.42;
          const ey = cy + Math.sin(a) * s * 0.42;
          ctx.strokeStyle = 'rgba(74,195,255,0.35)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(cx, cy, s * 0.42, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = COLOR_E;
          ctx.beginPath();
          ctx.arc(ex, ey, s * 0.1, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // bound hole: dashed red ring around the acceptor
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = COLOR_H;
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.arc(cx, cy, s * 0.43, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    // valence electrons (an acceptor holds one only when ionised; a donor always does)
    ctx.fillStyle = COLOR_VAL;
    ctx.beginPath();
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const k = j * NX + i;
        if (lat.hOcc[k] || lat.hiddenUntil[k]! > lat.time) continue;
        if (lat.dop[k]) continue;
        const cx = ox + (i + 0.5) * s;
        const cy = oy + (j + 0.5) * s;
        const dy = lat.dop[k] ? -s * 0.0 : 0;
        ctx.moveTo(cx + s * 0.1, cy + dy + (lat.dop[k] ? s * 0.0 : 0));
        ctx.arc(cx, cy + dy, s * 0.1, 0, Math.PI * 2);
      }
    }
    ctx.fill();

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

    // captures / annihilations
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
          ctx.arc(cx, cy, s * (0.3 + 0.6 * p), 0, Math.PI * 2);
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

  /** Field arrow below the lattice; its length scales with the field. */
  function renderFieldArrow(ctx: CanvasRenderingContext2D, x: number, y: number, w: number): void {
    const color = '#ffb347';
    const cy = y + 16;
    ctx.save();
    ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = color;
    ctx.fillText('E field', x, cy);
    const ax = x + 80;
    if (params.field > 0) {
      const len = 20 + (params.field / 3) * (w - 80 - 90);
      const head = 16;
      ctx.strokeStyle = color;
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.moveTo(ax, cy);
      ctx.lineTo(ax + len - head + 2, cy);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ax + len, cy);
      ctx.lineTo(ax + len - head, cy - 13);
      ctx.lineTo(ax + len - head, cy + 13);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ddd';
      ctx.fillText(params.field.toFixed(2), ax + len + 10, cy);
    } else {
      ctx.fillStyle = '#888';
      ctx.fillText('off', ax, cy);
    }
    ctx.restore();
  }

  function renderLegend(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    ctx.save();
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const row1 = y + 9;
    const row2 = y + 28;
    const item = (cx: number, cy: number, draw: () => void, label: string): number => {
      draw();
      ctx.fillStyle = '#bbb';
      ctx.fillText(label, cx + 12, cy);
      return cx + 12 + ctx.measureText(label).width + 18;
    };
    let cx = x;
    cx = item(
      cx + 6,
      row1,
      () => {
        ctx.fillStyle = COLOR_VAL;
        ctx.beginPath();
        ctx.arc(cx + 6, row1, 3, 0, Math.PI * 2);
        ctx.fill();
      },
      'valence electron'
    );
    cx = item(
      cx,
      row1,
      () => {
        ctx.fillStyle = COLOR_E;
        ctx.beginPath();
        ctx.arc(cx + 6, row1, 5, 0, Math.PI * 2);
        ctx.fill();
      },
      'conduction electron'
    );
    item(
      cx,
      row1,
      () => {
        ctx.strokeStyle = COLOR_H;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx + 6, row1, 5, 0, Math.PI * 2);
        ctx.stroke();
      },
      'free hole'
    );
    if (params.type === 'n') {
      item(
        x + 6,
        row2,
        () => {
          ctx.strokeStyle = COLOR_DON;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x + 12, row2, 5, 0, Math.PI * 2);
          ctx.stroke();
        },
        'donor P: electron bound (orbiting), or + ion once the electron is free'
      );
    } else {
      item(
        x + 6,
        row2,
        () => {
          ctx.strokeStyle = COLOR_ACC;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x + 12, row2, 5, 0, Math.PI * 2);
          ctx.stroke();
        },
        'acceptor B: hole bound (dashed ring), or − ion once it took an electron'
      );
    }
    ctx.restore();
  }

  function renderBands(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const isN = params.type === 'n';
    const dopColor = isN ? COLOR_DON : COLOR_ACC;
    const top = 26;
    const availH = h - top - 36;
    const bandX = 56;
    const bandW = w - bandX - 14;
    const gapPx = clamp((params.gap / 3) * availH * 0.5, 140, availH * 0.5);
    const bh = Math.min((availH - gapPx) / 2, availH * 0.3);
    const stack = 2 * bh + gapPx;
    const y0 = top + (availH - stack) / 2;
    const cbTop = y0;
    const cbBot = y0 + bh;
    const vbTop = cbBot + gapPx;
    const vbBot = vbTop + bh;
    const nd = lat.dopList.length;
    const frac = levelFrac();
    const levelY = isN ? cbBot + frac * gapPx : vbTop - frac * gapPx;

    ctx.save();
    ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ddd';
    ctx.textAlign = 'left';
    ctx.fillText('Band diagram', 8, 10);
    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';

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

    ctx.fillStyle = 'rgba(74, 195, 255, 0.10)';
    ctx.fillRect(bandX, cbTop, bandW, bh);
    ctx.fillStyle = 'rgba(170, 184, 216, 0.10)';
    ctx.fillRect(bandX, vbTop, bandW, bh);
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLOR_E;
    ctx.beginPath();
    ctx.moveTo(bandX, cbBot);
    ctx.lineTo(bandX + bandW, cbBot);
    ctx.stroke();
    ctx.strokeStyle = COLOR_VAL;
    ctx.beginPath();
    ctx.moveTo(bandX, vbTop);
    ctx.lineTo(bandX + bandW, vbTop);
    ctx.stroke();

    // Fermi level (smoothed, schematic)
    const efY = vbTop - fermi * gapPx;
    ctx.strokeStyle = '#999';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(bandX, efY);
    ctx.lineTo(bandX + bandW, efY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#aaa';
    ctx.textAlign = 'right';
    ctx.fillText('E_F', bandX - 4, efY);
    ctx.fillStyle = '#ddd';
    ctx.textAlign = 'right';
    ctx.fillText(`Eg = ${params.gap.toFixed(2)} eV`, bandX + bandW - 6, (cbBot + vbTop) / 2 + 4);

    // Dopant level and its states
    if (nd > 0) {
      ctx.strokeStyle = dopColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(bandX, levelY);
      ctx.lineTo(bandX + bandW, levelY);
      ctx.stroke();
      ctx.fillStyle = dopColor;
      ctx.textAlign = 'right';
      ctx.fillText(
        isN
          ? `donor level, ${lat.binding.toFixed(2)} eV below the band`
          : `acceptor level, ${lat.binding.toFixed(2)} eV above the band`,
        bandX + bandW - 6,
        levelY + (isN ? -9 : 9)
      );
      // one slot per dopant: neutral ones first
      const dd = 9;
      const cols = Math.max(1, Math.floor((bandW - 16) / dd));
      const nIon = lat.nIonised;
      const nNeutral = nd - nIon;
      for (let k = 0; k < nd; k++) {
        const row = Math.floor(k / cols);
        const x = bandX + 10 + (k % cols) * dd + dd / 2;
        const y = levelY + (isN ? 1 : -1) * (7 + row * dd);
        const neutral = k < nNeutral;
        ctx.beginPath();
        if (isN) {
          // filled = electron still on the donor
          ctx.arc(x, y, 3.3, 0, Math.PI * 2);
          if (neutral) {
            ctx.fillStyle = COLOR_E;
            ctx.fill();
          } else {
            ctx.strokeStyle = '#667';
            ctx.lineWidth = 1.2;
            ctx.stroke();
          }
        } else {
          // filled = acceptor has taken an electron; ring = empty, hole still bound
          ctx.arc(x, y, 3.3, 0, Math.PI * 2);
          if (!neutral) {
            ctx.fillStyle = COLOR_VAL;
            ctx.fill();
          } else {
            ctx.strokeStyle = COLOR_H;
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
      }
      const rowsUsed = Math.ceil(nd / cols);
      const ty = levelY + (isN ? 1 : -1) * (7 + (rowsUsed - 1) * dd + 14);
      ctx.fillStyle = '#999';
      ctx.textAlign = 'left';
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(
        isN
          ? `${nNeutral} donors hold their electron, ${nIon} ionised`
          : `${nNeutral} acceptors empty (hole bound), ${nIon} filled (hole freed)`,
        bandX + 4,
        ty
      );
      ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    }

    // Carriers in the bands, packed at the band edges
    const ne = lat.nElectrons;
    const nh = lat.nHoles;
    const most = Math.max(ne, nh, 1);
    let d = 11;
    const fits = (dd: number): boolean => {
      const c = Math.max(1, Math.floor((bandW - 12) / dd));
      const r = Math.max(1, Math.floor((bh - 22) / dd));
      return c * r >= most;
    };
    while (d > 5 && !fits(d)) d -= 1;
    const cols = Math.max(1, Math.floor((bandW - 12) / d));
    const rowsMax = Math.max(1, Math.floor((bh - 22) / d));
    const rad = Math.min(3.5, d * 0.34);

    ctx.fillStyle = COLOR_E;
    ctx.beginPath();
    for (let k = 0; k < ne; k++) {
      const row = Math.floor(k / cols);
      if (row >= rowsMax) break;
      const x = bandX + 8 + (k % cols) * d + d / 2;
      const y = cbBot - d / 2 - 2 - row * d;
      ctx.moveTo(x + rad, y);
      ctx.arc(x, y, rad, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillStyle = COLOR_VAL;
    ctx.beginPath();
    for (let k = nh; k < cols * rowsMax; k++) {
      const row = Math.floor(k / cols);
      const x = bandX + 8 + (k % cols) * d + d / 2;
      const y = vbTop + d / 2 + 2 + row * d;
      ctx.moveTo(x + rad, y);
      ctx.arc(x, y, rad, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.strokeStyle = COLOR_H;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let k = 0; k < nh; k++) {
      const row = Math.floor(k / cols);
      if (row >= rowsMax) break;
      const x = bandX + 8 + (k % cols) * d + d / 2;
      const y = vbTop + d / 2 + 2 + row * d;
      ctx.moveTo(x + rad + 0.6, y);
      ctx.arc(x, y, rad + 0.6, 0, Math.PI * 2);
    }
    ctx.stroke();

    ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = COLOR_E;
    ctx.textAlign = 'right';
    ctx.fillText(
      `conduction band: ${ne} electron${ne === 1 ? '' : 's'}`,
      bandX + bandW - 6,
      cbTop + 11
    );
    ctx.fillStyle = COLOR_H;
    ctx.fillText(`valence band: ${nh} hole${nh === 1 ? '' : 's'}`, bandX + bandW - 6, vbBot - 11);

    // Transitions
    const arrow = (x: number, ya: number, yb: number, color: string): void => {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2.5;
      const dir = yb < ya ? -1 : 1;
      ctx.beginPath();
      ctx.moveTo(x, ya);
      ctx.lineTo(x, yb - dir * 6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, yb);
      ctx.lineTo(x - 6, yb - dir * 9);
      ctx.lineTo(x + 6, yb - dir * 9);
      ctx.closePath();
      ctx.fill();
    };
    for (const ev of lat.bandEvents.slice(-8)) {
      const alpha = clamp(1 - (lat.time - ev.t) / 1.2, 0, 1);
      const x = bandX + (0.12 + 0.76 * ev.u) * bandW;
      const up = `rgba(255, 179, 71, ${alpha})`;
      const down = `rgba(255, 225, 74, ${alpha})`;
      if (ev.kind === 'gen') arrow(x, vbTop, cbBot, up);
      else if (ev.kind === 'rec') arrow(x, cbBot, vbTop, down);
      else if (isN) {
        // donor level <-> conduction band
        if (ev.kind === 'ion') arrow(x, levelY, cbBot, up);
        else arrow(x, cbBot, levelY, down);
      } else {
        // valence band <-> acceptor level (an electron jumps up into it)
        if (ev.kind === 'ion') arrow(x, vbTop, levelY, up);
        else arrow(x, levelY, vbTop, down);
      }
    }

    ctx.fillStyle = '#999';
    ctx.textAlign = 'left';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(
      isN
        ? '↑ heat frees the donor electron    ↓ it falls back into a + donor'
        : '↑ a valence electron jumps into the acceptor    ↓ it falls back into a hole',
      8,
      h - 16
    );
    ctx.restore();
  }

  function renderHistory(width: number, height: number): void {
    const t = lat.time;
    let hi = 5;
    for (const v of hist.n) if (v > hi) hi = v;
    for (const v of hist.p) if (v > hi) hi = v;
    hi *= 1.2;
    const xMin = Math.max(0, t - HISTORY_SPAN);
    histPlot.setBounds({ xMin, xMax: xMin + HISTORY_SPAN, yMin: 0, yMax: hi });
    histPlot.setSize(width, height);
    const xTicks = Plot2D.generateTicks(xMin, xMin + HISTORY_SPAN, 4);
    const yTicks = Plot2D.generateTicks(0, hi, 4);
    histPlot.drawGrid(xTicks, yTicks);
    histPlot.drawAxes('time', 'carriers');
    histPlot.drawTickLabels(
      xTicks,
      yTicks,
      (v) => v.toFixed(0),
      (v) => v.toFixed(0)
    );
    if (hist.t.length > 1) {
      histPlot.drawLine(hist.t, hist.n, COLOR_E, 2);
      histPlot.drawLine(hist.t, hist.p, COLOR_H, 2);
    }
    histPlot.drawText('electrons', xMin + HISTORY_SPAN * 0.03, hi * 0.92, {
      color: COLOR_E,
      fontSize: 11,
    });
    histPlot.drawText('holes', xMin + HISTORY_SPAN * 0.03, hi * 0.8, {
      color: COLOR_H,
      fontSize: 11,
    });
  }

  const loop = new AnimationLoop((_dt, time) => {
    if (!paused) stepSimulation();
    lat.animate(0.25);
    fermi += (targetFermi() - fermi) * 0.05;
    render(time);
  });

  function handleResize(): void {
    if (loop.running) render(loop.elapsed / 1000);
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

export const dopedSemiconductorsDemo: DemoDefinition = {
  id: 'doped-semiconductors',
  title: 'N-type and P-type doped semiconductors',
  description:
    'Replace atoms of a semiconductor by donors or acceptors. Donor electrons are freed into the conduction band, and acceptors pull electrons out of the valence band and leave mobile holes. See the dopant level in the band diagram, the carrier freeze-out at low temperature, and how a few dopants set the majority carrier.',
  category: 'Electrical properties',
  tags: [
    'doping',
    'n-type',
    'p-type',
    'donor',
    'acceptor',
    'semiconductor',
    'band diagram',
    'holes',
    'freeze-out',
  ],
  create,
};

export default dopedSemiconductorsDemo;
