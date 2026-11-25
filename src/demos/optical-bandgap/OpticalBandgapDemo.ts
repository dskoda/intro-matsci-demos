/**
 * Optical band gap (Lecture 16)
 *
 * Photons hit a semiconductor slab. A photon with E ≥ Eg lifts an electron across the gap
 * (absorbed); one with E < Eg cannot, so it passes through (transmitted). The excited electron
 * gives its excess energy to the lattice as heat (phonons), drops to the bottom of the
 * conduction band and finally falls back, emitting a photon of energy Eg (photoluminescence)
 * or just more heat. Pores in the material scatter light of every energy, so more pores
 * means fewer photons go straight through and the material looks milky.
 *
 * Physics in optical.ts. This file: photon transport, band diagram, spectrum bar, controls.
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import {
  createSlider,
  createCheckbox,
  createButton,
  type Disposable,
  type SliderControl,
  type CheckboxControl,
} from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import {
  E_MIN,
  E_MAX,
  E_IR_MAX,
  E_UV_MIN,
  absorption,
  bodyColor,
  makePores,
  poreCount,
  photonColor,
  region,
  wavelength,
  PORE_R,
} from './optical';

interface DemoParams {
  eg: number;
  eph: number;
  thickness: number;
  porosity: number; // area fraction, 0..0.12
  pl: boolean;
  white: boolean;
  flux: number;
  speed: number;
}

const defaultParams: DemoParams = {
  eg: 2.0,
  eph: 2.6,
  thickness: 0.5,
  porosity: 0,
  pl: true,
  white: false,
  flux: 30,
  speed: 250,
};

const QUANTUM_YIELD = 0.75;
const MAX_PHOTONS = 700;
const MAX_EVENTS = 60;
const EG_MAX = 5.5;
const POROSITY_MAX = 0.12;
const BOTTOM_H = 130;

const T_EXCITE = 0.3;
const T_RELAX = 0.8;
const T_REST = 1.1;
const T_TOTAL = 1.5;

interface Photon {
  x: number;
  y: number;
  vx: number;
  vy: number;
  e: number;
  inside: boolean;
  resolved: boolean;
  fromPL: boolean;
}

interface Excitation {
  x: number;
  y: number;
  e: number;
  t: number;
  pl: boolean;
  emitted: boolean;
  slot: number;
}

interface Layout {
  W: number;
  H: number;
  sceneW: number;
  sceneH: number;
  slabX: number;
  slabY: number;
  slabW: number;
  slabH: number;
  panelX: number;
  panelW: number;
}

function parseParams(raw: Record<string, string>, base: DemoParams): DemoParams {
  const num = (key: string, fallback: number): number => {
    const v = parseFloat(raw[key] ?? '');
    return Number.isFinite(v) ? v : fallback;
  };
  const flag = (key: string, fallback: boolean): boolean =>
    raw[key] === undefined ? fallback : raw[key] === '1';
  return {
    eg: clamp(num('eg', base.eg), 0.3, EG_MAX),
    eph: clamp(num('eph', base.eph), E_MIN, E_MAX),
    thickness: clamp(num('t', base.thickness), 0.1, 1),
    porosity: clamp(num('por', base.porosity), 0, POROSITY_MAX),
    pl: flag('pl', base.pl),
    white: flag('white', base.white),
    flux: clamp(num('flux', base.flux), 5, 120),
    speed: clamp(num('speed', base.speed), 50, 400),
  };
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  let params: DemoParams = parseParams(options.getParams(), defaultParams);
  const canvas = new HiDPICanvas(container, { backgroundColor: '#0a0a0a', autoResize: true });
  const ctx = canvas.ctx;
  const poreSet = makePores();

  let photons: Photon[] = [];
  let events: Excitation[] = [];
  let counters = { abs: 0, trans: 0, back: 0, pl: 0 };
  let spawnAcc = 0;
  let slotCounter = 0;
  let paused = false;
  let running = false;
  let rafId = 0;
  let lastTs = 0;

  // Pore pixel positions + lookup grid, rebuilt every frame from the layout.
  let px: number[] = [];
  let py: number[] = [];
  const CELL = 10;
  let grid: number[][] = [];
  let gridCols = 0;
  let gridRows = 0;

  function layout(): Layout {
    const W = canvas.width;
    const H = canvas.height;
    const panelW = Math.max(230, W * 0.3);
    const sceneW = W - panelW - 8;
    const sceneH = H - BOTTOM_H;
    const slabW = 40 + params.thickness * (sceneW * 0.5 - 40);
    const slabH = sceneH * 0.72;
    return {
      W,
      H,
      sceneW,
      sceneH,
      slabX: sceneW * 0.42 - slabW / 2,
      slabY: sceneH * 0.14,
      slabW,
      slabH,
      panelX: W - panelW,
      panelW,
    };
  }

  function buildPores(L: Layout): void {
    const n = poreCount(params.porosity, L.slabW * L.slabH);
    px = [];
    py = [];
    gridCols = Math.ceil(L.slabW / CELL) + 1;
    gridRows = Math.ceil(L.slabH / CELL) + 1;
    grid = Array.from({ length: gridCols * gridRows }, () => []);
    for (let i = 0; i < n; i++) {
      const p = poreSet[i]!;
      const x = L.slabX + p.u * L.slabW;
      const y = L.slabY + p.v * L.slabH;
      px.push(x);
      py.push(y);
      const cx = Math.floor((x - L.slabX) / CELL);
      const cy = Math.floor((y - L.slabY) / CELL);
      grid[cy * gridCols + cx]!.push(i);
    }
  }

  function resetCounters(): void {
    counters = { abs: 0, trans: 0, back: 0, pl: 0 };
  }

  function clearAll(): void {
    photons = [];
    events = [];
    spawnAcc = 0;
    resetCounters();
  }

  /* ---- simulation ------------------------------------------------------------------- */

  function spawnPhoton(L: Layout): void {
    const e = params.white ? E_MIN + 0.1 + Math.random() * (E_MAX - E_MIN - 0.3) : params.eph;
    photons.push({
      x: -2,
      y: L.slabY + 6 + Math.random() * (L.slabH - 12),
      vx: params.speed,
      vy: 0,
      e,
      inside: false,
      resolved: false,
      fromPL: false,
    });
  }

  /** Scatter a photon off pore i: leave from the pore surface in a random direction. */
  function scatter(p: Photon, i: number): void {
    const th = Math.random() * Math.PI * 2;
    const s = Math.hypot(p.vx, p.vy);
    p.vx = Math.cos(th) * s;
    p.vy = Math.sin(th) * s;
    p.x = px[i]! + Math.cos(th) * (PORE_R + 1.6);
    p.y = py[i]! + Math.sin(th) * (PORE_R + 1.6);
  }

  function tick(dtRaw: number, L: Layout): void {
    const dt = Math.min(dtRaw, 0.05);
    buildPores(L);

    spawnAcc += dt;
    const interval = 1 / params.flux;
    while (spawnAcc >= interval) {
      spawnAcc -= interval;
      if (photons.length < MAX_PHOTONS) spawnPhoton(L);
    }

    const maxW = L.sceneW * 0.5;
    const alphaCache = new Map<number, number>();
    const next: Photon[] = [];

    for (const p of photons) {
      const speed = Math.hypot(p.vx, p.vy);
      const n = Math.max(1, Math.ceil((speed * dt) / 2));
      const h = dt / n;
      let alive = true;
      for (let s = 0; s < n && alive; s++) {
        p.x += p.vx * h;
        p.y += p.vy * h;
        const was = p.inside;
        p.inside =
          p.x >= L.slabX && p.x <= L.slabX + L.slabW && p.y >= L.slabY && p.y <= L.slabY + L.slabH;

        if (p.inside) {
          // Absorption (Beer-Lambert) for photons still being counted.
          if (!p.resolved) {
            const key = Math.round(p.e * 1000);
            let a = alphaCache.get(key);
            if (a === undefined) {
              a = absorption(p.e, params.eg);
              alphaCache.set(key, a);
            }
            if (a > 0 && Math.random() < 1 - Math.exp(-(a * speed * h) / maxW)) {
              counters.abs++;
              if (events.length < MAX_EVENTS) {
                events.push({
                  x: p.x,
                  y: p.y,
                  e: p.e,
                  t: 0,
                  pl: Math.random() < QUANTUM_YIELD,
                  emitted: false,
                  slot: slotCounter++,
                });
              }
              alive = false;
              break;
            }
          }
          // Scattering by pores.
          if (px.length > 0) {
            const cx = Math.floor((p.x - L.slabX) / CELL);
            const cy = Math.floor((p.y - L.slabY) / CELL);
            let hit = -1;
            for (let gy = Math.max(0, cy - 1); gy <= Math.min(gridRows - 1, cy + 1) && hit < 0; gy++) {
              for (let gx = Math.max(0, cx - 1); gx <= Math.min(gridCols - 1, cx + 1) && hit < 0; gx++) {
                for (const i of grid[gy * gridCols + gx]!) {
                  const dx = p.x - px[i]!;
                  const dy = p.y - py[i]!;
                  if (dx * dx + dy * dy < (PORE_R + 0.8) ** 2) {
                    hit = i;
                    break;
                  }
                }
              }
            }
            if (hit >= 0) scatter(p, hit);
          }
        } else if (was && !p.resolved) {
          p.resolved = true;
          if (p.x >= L.slabX + L.slabW && p.vx > 0) counters.trans++;
          else counters.back++;
        }
      }
      if (!alive) continue;
      if (p.x < -20 || p.x > L.sceneW + 10 || p.y < -10 || p.y > L.sceneH + 10) continue;
      next.push(p);
    }
    photons = next;

    // Excitation events: excite, relax (heat), rest, recombine (photon or heat).
    const live: Excitation[] = [];
    for (const ev of events) {
      ev.t += dt;
      if (ev.t >= T_REST && params.pl && ev.pl && !ev.emitted) {
        ev.emitted = true;
        const th = Math.random() * Math.PI * 2;
        const sp = params.speed * 0.8;
        if (photons.length < MAX_PHOTONS) {
          photons.push({
            x: ev.x,
            y: ev.y,
            vx: Math.cos(th) * sp,
            vy: Math.sin(th) * sp,
            e: params.eg,
            inside: true,
            resolved: true,
            fromPL: true,
          });
          counters.pl++;
        }
      }
      if (ev.t < T_TOTAL) live.push(ev);
    }
    events = live;
  }

  /* ---- drawing ---------------------------------------------------------------------- */

  function drawScene(L: Layout): void {
    const body = bodyColor(params.eg);
    const [r, g, b] = body.rgb;
    const bodyAlpha = body.clear >= 1 ? 0.14 : 0.9 - 0.7 * body.clear;

    // Slab body
    ctx.fillStyle = `rgba(${r},${g},${b},${bodyAlpha.toFixed(2)})`;
    ctx.fillRect(L.slabX, L.slabY, L.slabW, L.slabH);

    // Pores make the material milky
    const milk = 0.65 * (1 - Math.exp(-params.porosity * 14));
    if (milk > 0.01) {
      ctx.fillStyle = `rgba(255,255,255,${milk.toFixed(2)})`;
      ctx.fillRect(L.slabX, L.slabY, L.slabW, L.slabH);
    }

    // Photoluminescence glow around recombining electrons
    for (const ev of events) {
      if (!params.pl || !ev.pl || ev.t < T_REST - 0.1) continue;
      const k = Math.max(0, 1 - (ev.t - (T_REST - 0.1)) / 0.5);
      const rad = 18 + (1 - k) * 22;
      const gr = ctx.createRadialGradient(ev.x, ev.y, 0, ev.x, ev.y, rad);
      gr.addColorStop(0, photonColor(params.eg, 0.9 * k));
      gr.addColorStop(1, photonColor(params.eg, 0));
      ctx.fillStyle = gr;
      ctx.fillRect(ev.x - rad, ev.y - rad, 2 * rad, 2 * rad);
    }

    ctx.strokeStyle = 'rgba(200,210,230,0.6)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(L.slabX, L.slabY, L.slabW, L.slabH);

    // Pores
    for (let i = 0; i < px.length; i++) {
      ctx.beginPath();
      ctx.arc(px[i]!, py[i]!, PORE_R, 0, Math.PI * 2);
      ctx.fillStyle = '#0a0a0a';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Absorbed electrons: small flash at the absorption site
    for (const ev of events) {
      if (ev.t < 0.25) {
        const k = ev.t / 0.25;
        ctx.beginPath();
        ctx.arc(ev.x, ev.y, 4 + 8 * k, 0, Math.PI * 2);
        ctx.strokeStyle = photonColor(ev.e, 1 - k);
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Photons
    for (const p of photons) {
      const c = photonColor(p.e);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.fromPL ? 3.4 : 3.2, 0, Math.PI * 2);
      ctx.shadowColor = c;
      ctx.shadowBlur = 7;
      ctx.fillStyle = c;
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Labels
    ctx.textAlign = 'center';
    ctx.fillStyle = '#c9d1d9';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText('Material', L.slabX + L.slabW / 2, L.slabY - 24);
    ctx.font = '11px sans-serif';
    ctx.fillStyle = `rgb(${Math.max(r, 90)},${Math.max(g, 90)},${Math.max(b, 90)})`;
    ctx.fillText(`looks ${body.name} in white light`, L.slabX + L.slabW / 2, L.slabY - 8);
    ctx.fillStyle = '#8b949e';
    ctx.textAlign = 'left';
    ctx.fillText('incoming light', 8, L.slabY - 8);
    ctx.textAlign = 'right';
    ctx.fillText('transmitted', L.sceneW - 8, L.slabY - 8);
  }

  function eToX(e: number, L: Layout): number {
    const x0 = 24;
    const x1 = L.sceneW - 24;
    return x0 + ((e - E_MIN) / (E_MAX - E_MIN)) * (x1 - x0);
  }

  function drawSpectrum(L: Layout): void {
    const y = L.sceneH + 26;
    const h = 26;
    const x0 = eToX(E_MIN, L);
    const x1 = eToX(E_MAX, L);
    const xg = eToX(Math.min(params.eg, E_MAX), L);

    // Rainbow strip (IR and UV dimmed: not visible)
    for (let x = x0; x < x1; x += 2) {
      const e = E_MIN + ((x - x0) / (x1 - x0)) * (E_MAX - E_MIN);
      const vis = e >= E_IR_MAX && e <= E_UV_MIN;
      ctx.fillStyle = photonColor(e, vis ? 1 : 0.55);
      ctx.fillRect(x, y, 2.5, h);
    }
    // Hatch the invisible parts
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    for (const [a, c] of [
      [x0, eToX(E_IR_MAX, L)],
      [eToX(E_UV_MIN, L), x1],
    ] as [number, number][]) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(a, y, c - a, h);
      ctx.clip();
      for (let x = a - h; x < c; x += 6) {
        ctx.beginPath();
        ctx.moveTo(x, y + h);
        ctx.lineTo(x + h, y);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Absorbed region (E >= Eg) darkened
    if (xg < x1) {
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      ctx.fillRect(Math.max(xg, x0), y, x1 - Math.max(xg, x0), h);
    }
    ctx.strokeStyle = '#8b949e';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, y, x1 - x0, h);

    // Region labels above
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#c9a0a0';
    ctx.fillText('Infrared', (x0 + eToX(E_IR_MAX, L)) / 2, y - 14);
    ctx.fillStyle = '#e6edf3';
    ctx.fillText('Visible', (eToX(E_IR_MAX, L) + eToX(E_UV_MIN, L)) / 2, y - 14);
    ctx.fillStyle = '#b9a6e8';
    ctx.fillText('Ultraviolet', (eToX(E_UV_MIN, L) + x1) / 2, y - 14);
    ctx.strokeStyle = '#484f58';
    for (const e of [E_IR_MAX, E_UV_MIN]) {
      ctx.beginPath();
      ctx.moveTo(eToX(e, L), y - 22);
      ctx.lineTo(eToX(e, L), y);
      ctx.stroke();
    }

    // Eg marker
    if (params.eg <= E_MAX) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xg, y - 4);
      ctx.lineTo(xg, y + h + 4);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('transmitted ◂', xg - 6, y + h / 2 + 4);
      ctx.textAlign = 'left';
      ctx.fillText(`▸ absorbed  (Eg = ${params.eg.toFixed(2)} eV)`, xg + 6, y + h / 2 + 4);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        `Eg = ${params.eg.toFixed(2)} eV is above the whole range: everything is transmitted`,
        (x0 + x1) / 2,
        y + h / 2 + 4
      );
    }

    // Photon energy marker
    if (!params.white) {
      const xe = eToX(params.eph, L);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(xe, y + h + 2);
      ctx.lineTo(xe - 6, y + h + 11);
      ctx.lineTo(xe + 6, y + h + 11);
      ctx.closePath();
      ctx.fill();
    }

    // Ticks: eV and nm
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8b949e';
    for (const e of [1, 2, 3, 4]) {
      const x = eToX(e, L);
      ctx.fillText(`${e} eV`, x, y + h + 24);
      ctx.fillText(`${Math.round(wavelength(e))} nm`, x, y + h + 36);
    }
  }

  function drawReadout(L: Layout): void {
    const tot = counters.abs + counters.trans + counters.back;
    const pc = (n: number): string => (tot > 0 ? `${((100 * n) / tot).toFixed(0)}%` : '–');
    ctx.font = '12px monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e6edf3';
    ctx.fillText(
      `absorbed ${pc(counters.abs)}   transmitted ${pc(counters.trans)}   scattered back/out ${pc(counters.back)}`,
      10,
      L.H - 12
    );
  }

  function drawBands(L: Layout): void {
    const x0 = L.panelX;
    const w = L.panelW;
    ctx.fillStyle = '#10151c';
    ctx.fillRect(x0, 0, w, L.H);
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, 0.5, w - 0.5, L.H - 1);

    ctx.fillStyle = '#e6edf3';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Band diagram', x0 + w / 2, 20);

    const eg = params.eg;
    const eMin = -1;
    const eMax = Math.max(4.8, eg + 1.2);
    const top = 40;
    const bot = L.H - 40;
    const eToY = (e: number): number => bot - ((e - eMin) / (eMax - eMin)) * (bot - top);
    const bl = x0 + 54;
    const br = x0 + w - 14;
    const yV = eToY(0);
    const yC = eToY(eg);

    // Bands
    ctx.fillStyle = 'rgba(70,130,220,0.18)';
    ctx.fillRect(bl, yV, br - bl, bot - yV);
    ctx.fillStyle = 'rgba(220,90,80,0.12)';
    ctx.fillRect(bl, top, br - bl, yC - top);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#58a6ff';
    ctx.beginPath();
    ctx.moveTo(bl, yV);
    ctx.lineTo(br, yV);
    ctx.stroke();
    ctx.strokeStyle = '#ff7b72';
    ctx.beginPath();
    ctx.moveTo(bl, yC);
    ctx.lineTo(br, yC);
    ctx.stroke();
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#58a6ff';
    ctx.fillText('valence band (full)', bl + 3, yV + 14);
    ctx.fillStyle = '#ff7b72';
    ctx.fillText('conduction band (empty)', bl + 3, yC - 5);

    // Valence electrons
    ctx.fillStyle = 'rgba(230,237,243,0.55)';
    for (let yy = yV + 26; yy < bot - 4; yy += 14) {
      for (let xx = bl + 12; xx < br - 6; xx += 16) {
        ctx.beginPath();
        ctx.arc(xx, yy, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Eg bracket
    const ax = bl - 12;
    ctx.strokeStyle = '#e6edf3';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ax, yV);
    ctx.lineTo(ax, yC);
    ctx.moveTo(ax - 4, yV);
    ctx.lineTo(ax + 4, yV);
    ctx.moveTo(ax - 4, yC);
    ctx.lineTo(ax + 4, yC);
    ctx.stroke();
    ctx.fillStyle = '#e6edf3';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`Eg`, ax - 6, (yV + yC) / 2 - 2);
    ctx.fillText(`${eg.toFixed(2)} eV`, ax - 6, (yV + yC) / 2 + 11);

    // Photon energy arrow
    if (!params.white) {
      const ex = br - 20;
      const yE = eToY(params.eph);
      const col = photonColor(params.eph);
      ctx.strokeStyle = col;
      ctx.lineWidth = 3;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(ex, yV);
      ctx.lineTo(ex, yE);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(ex, yE);
      ctx.lineTo(ex - 5, yE + 8);
      ctx.lineTo(ex + 5, yE + 8);
      ctx.closePath();
      ctx.fill();
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(`photon ${params.eph.toFixed(2)} eV`, ex - 8, yE + 4);
      if (params.eph < eg - 0.05) {
        ctx.fillStyle = '#8b949e';
        ctx.fillText('too small to lift an electron', ex - 8, yE + 17);
      }
    }

    // Static holes and electron dots for each event
    const slotsX = (slot: number): number => bl + 14 + (slot % 7) * ((br - bl - 60) / 6);
    for (const ev of events) {
      const sx = slotsX(ev.slot);
      const yTop = eToY(Math.min(ev.e, eMax));
      let y: number;
      let color = '#ffffff';
      let heat = 0;
      const photonCol = photonColor(ev.e);
      if (ev.t < T_EXCITE) {
        y = yV + (ev.t / T_EXCITE) * (yTop - yV);
        color = photonCol;
      } else if (ev.t < T_RELAX) {
        const k = (ev.t - T_EXCITE) / (T_RELAX - T_EXCITE);
        y = yTop + k * (yC - yTop);
        color = '#ff6a3d';
        heat = 1;
      } else if (ev.t < T_REST) {
        y = yC;
        color = '#ff6a3d';
      } else {
        const k = (ev.t - T_REST) / (T_TOTAL - T_REST);
        y = yC + k * (yV - yC);
        color = params.pl && ev.pl ? photonColor(eg) : '#ff6a3d';
        heat = params.pl && ev.pl ? 0 : 1;
      }
      // Hole left in the valence band until recombination
      if (ev.t < T_TOTAL - 0.05) {
        ctx.beginPath();
        ctx.arc(sx, yV + 9, 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#58a6ff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      // Heat zigzag (phonons)
      if (heat) {
        ctx.strokeStyle = 'rgba(255,106,61,0.85)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const xx = sx + 6 + i * 3;
          const yy = y + (i % 2 ? -4 : 4);
          if (i === 0) ctx.moveTo(sx + 5, y);
          ctx.lineTo(xx, yy);
        }
        ctx.stroke();
      }
      // Emitted photon squiggle on recombination
      if (params.pl && ev.pl && ev.t >= T_REST) {
        const k = (ev.t - T_REST) / (T_TOTAL - T_REST);
        ctx.strokeStyle = photonColor(eg, 1 - 0.5 * k);
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i <= 20; i++) {
          const xx = sx + 6 + i * 2.2;
          const yy = y + Math.sin(i * 1.1) * 4;
          if (i === 0) ctx.moveTo(xx, yy);
          else ctx.lineTo(xx, yy);
        }
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(sx, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#0a0a0a';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Legend
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    const ly = L.H - 24;
    const items: [string, string][] = [
      ['#ffffff', 'electron'],
      ['#ff6a3d', 'heat (phonons)'],
      [params.pl ? photonColor(eg) : '#8b949e', params.pl ? 'emitted photon' : 'PL off'],
    ];
    let lx = x0 + 10;
    for (const [c, t] of items) {
      ctx.beginPath();
      ctx.arc(lx + 4, ly, 4, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
      ctx.fillStyle = '#8b949e';
      ctx.fillText(t, lx + 12, ly + 3);
      lx += 14 + ctx.measureText(t).width + 10;
    }
    ctx.fillStyle = '#8b949e';
    ctx.fillText(
      params.white ? 'white light: every photon has its own energy' : '',
      x0 + 10,
      L.H - 8
    );
  }

  function render(dt: number): void {
    const L = layout();
    if (!paused) tick(dt, L);
    else buildPores(L);
    ctx.clearRect(0, 0, L.W, L.H);
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, L.W, L.H);
    drawScene(L);
    drawSpectrum(L);
    drawReadout(L);
    drawBands(L);
  }

  /* ---- controls --------------------------------------------------------------------- */

  const disposables: Disposable[] = [];
  const sliders: Record<string, SliderControl> = {};
  let plBox: CheckboxControl | undefined;
  let whiteBox: CheckboxControl | undefined;

  function currentUrlParams(): Record<string, string> {
    return {
      eg: params.eg.toFixed(2),
      eph: params.eph.toFixed(2),
      t: params.thickness.toFixed(2),
      por: params.porosity.toFixed(3),
      pl: params.pl ? '1' : '0',
      white: params.white ? '1' : '0',
      flux: String(Math.round(params.flux)),
      speed: String(Math.round(params.speed)),
    };
  }

  function onChange(resetStats = false): void {
    if (resetStats) resetCounters();
    options.setParams(currentUrlParams());
  }

  function accent(): void {
    const el = sliders.eph?.element.querySelector('.control-slider') as HTMLInputElement | null;
    if (el) el.style.accentColor = photonColor(params.eph);
  }

  function syncControls(): void {
    sliders.eg?.setValue(params.eg);
    sliders.eph?.setValue(params.eph);
    sliders.t?.setValue(params.thickness);
    sliders.por?.setValue(params.porosity * 100);
    sliders.flux?.setValue(params.flux);
    sliders.speed?.setValue(params.speed);
    plBox?.setChecked(params.pl);
    whiteBox?.setChecked(params.white);
    accent();
  }

  function addSlider(
    section: HTMLElement,
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
    section.appendChild(s.element);
  }

  if (controlsPanel) {
    controlsPanel.appendChild(
      createHelperText(
        'Photons enter from the left. A photon with energy above the band gap lifts an electron across the gap and is absorbed; a photon below the gap cannot, and passes through. The excited electron loses its excess energy as heat, then falls back and may emit light of energy Eg (photoluminescence). Pores scatter light in all directions, so fewer photons go straight through.'
      )
    );

    const mat = createSection({ title: 'Material' });
    disposables.push(mat);
    addSlider(mat.content, 'eg', {
      label: 'Band gap Eg (eV)',
      min: 0.3,
      max: EG_MAX,
      step: 0.01,
      value: params.eg,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        params.eg = v;
        onChange(true);
      },
    });
    addSlider(mat.content, 't', {
      label: 'Thickness',
      min: 0.1,
      max: 1,
      step: 0.01,
      value: params.thickness,
      format: (v) => v.toFixed(2),
      onChange: (v) => {
        params.thickness = v;
        onChange(true);
      },
    });
    addSlider(mat.content, 'por', {
      label: 'Pores (% of area)',
      min: 0,
      max: POROSITY_MAX * 100,
      step: 0.5,
      value: params.porosity * 100,
      format: (v) => `${v.toFixed(1)} %`,
      onChange: (v) => {
        params.porosity = v / 100;
        onChange(true);
      },
    });
    plBox = createCheckbox({
      label: 'Photoluminescence',
      checked: params.pl,
      onChange: (c) => {
        params.pl = c;
        if (!c) photons = photons.filter((p) => !p.fromPL);
        onChange(true);
      },
    });
    disposables.push(plBox);
    mat.content.appendChild(plBox.element);
    controlsPanel.appendChild(mat.element);

    const light = createSection({ title: 'Light' });
    disposables.push(light);
    whiteBox = createCheckbox({
      label: 'White light (all energies)',
      checked: params.white,
      onChange: (c) => {
        params.white = c;
        onChange(true);
      },
    });
    disposables.push(whiteBox);
    light.content.appendChild(whiteBox.element);
    addSlider(light.content, 'eph', {
      label: 'Photon energy (eV)',
      min: E_MIN,
      max: E_MAX,
      step: 0.01,
      value: params.eph,
      format: (v) => `${v.toFixed(2)} eV (${Math.round(wavelength(v))} nm, ${region(v)})`,
      onChange: (v) => {
        params.eph = v;
        accent();
        onChange(true);
      },
    });
    addSlider(light.content, 'flux', {
      label: 'Photon flux (/s)',
      min: 5,
      max: 120,
      step: 1,
      value: params.flux,
      format: (v) => String(Math.round(v)),
      onChange: (v) => {
        params.flux = v;
        onChange();
      },
    });
    addSlider(light.content, 'speed', {
      label: 'Photon speed (px/s)',
      min: 50,
      max: 400,
      step: 5,
      value: params.speed,
      format: (v) => String(Math.round(v)),
      onChange: (v) => {
        params.speed = v;
        onChange();
      },
    });
    controlsPanel.appendChild(light.element);

    const act = createSection({ title: 'Actions' });
    disposables.push(act);
    const pauseBtn = createButton({
      label: 'Pause',
      onClick: () => {
        paused = !paused;
        pauseBtn.setLabel(paused ? 'Resume' : 'Pause');
      },
    });
    disposables.push(pauseBtn);
    act.content.appendChild(pauseBtn.element);
    const resetBtn = createButton({ label: 'Reset', variant: 'secondary', onClick: clearAll });
    disposables.push(resetBtn);
    act.content.appendChild(resetBtn.element);
    controlsPanel.appendChild(act.element);
    accent();
  }

  /* ---- lifecycle -------------------------------------------------------------------- */

  function frame(ts: number): void {
    if (!running) return;
    const dt = lastTs ? (ts - lastTs) / 1000 : 0;
    lastTs = ts;
    render(dt);
    rafId = requestAnimationFrame(frame);
  }

  canvas.onResize(() => {
    if (!running) render(0);
  });

  return {
    start() {
      if (running) return;
      running = true;
      lastTs = 0;
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(rafId);
    },
    resize() {
      if (!running) render(0);
    },
    dispose() {
      running = false;
      cancelAnimationFrame(rafId);
      disposables.forEach((d) => d.dispose());
      disposables.length = 0;
      canvas.dispose();
    },
    getParams: currentUrlParams,
    setParams(p) {
      params = parseParams(p, params);
      syncControls();
      clearAll();
    },
  };
}

export const opticalBandgapDemo: DemoDefinition = {
  id: 'optical-bandgap',
  title: 'Optical band gap: absorption, colour and scattering by pores',
  description:
    'Send photons of different energies into a semiconductor. Photons above the band gap lift electrons across it and are absorbed, those below pass through, so the gap sets the colour of the material. See the excited electron lose energy as heat and fall back, optionally emitting light (photoluminescence), and add pores to scatter the light.',
  category: 'Optical properties',
  tags: ['band gap', 'absorption', 'colour', 'photoluminescence', 'scattering', 'pores', 'optics'],
  create,
};
