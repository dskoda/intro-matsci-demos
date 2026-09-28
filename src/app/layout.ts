/**
 * Layout Manager
 *
 * Handles rendering of the main layout including:
 * - Navbar with demos dropdown
 * - Home page with demo grid
 * - Demo page layout
 */

import { getAllDemos } from './registry';
import type { DemoDefinition } from './types';
import { navigateToDemo } from './router';

/**
 * Render the navbar demos dropdown.
 */
export function renderNavDropdown(): void {
  const dropdown = document.getElementById('demos-dropdown');
  if (!dropdown) return;

  const demos = getAllDemos();
  dropdown.innerHTML = '';

  if (demos.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'nav-dropdown-empty';
    empty.style.padding = '8px 16px';
    empty.style.color = 'var(--color-text-muted)';
    empty.textContent = 'No demos available';
    dropdown.appendChild(empty);
    return;
  }

  demos.forEach((demo) => {
    const link = document.createElement('a');
    link.href = `#/demo/${demo.id}`;
    link.textContent = demo.title;
    dropdown.appendChild(link);
  });
}

/**
 * Render the home page with demo grid.
 */
export function renderHomePage(container: HTMLElement): void {
  const demos = getAllDemos();

  container.innerHTML = `
    <div class="home-page">
      <header class="home-header">
        <h1>MAT SCI 104 Demos</h1>
        <p>Interactive visualizations for MAT SCI 104 (UCLA, Fall 2026)</p>
      </header>
      <div class="demo-grid" id="demo-grid"></div>
      <footer class="home-footer">
        <p>Created by Daniel Schwalbe-Koda</p>
      </footer>
    </div>
  `;

  const grid = container.querySelector('#demo-grid');
  if (!grid) return;

  if (demos.length === 0) {
    grid.innerHTML = `
      <div class="demo-card">
        <h3>No demos yet</h3>
        <p>Add demos to get started. See the README for instructions.</p>
      </div>
    `;
    return;
  }

  demos.forEach((demo) => {
    const card = createDemoCard(demo);
    grid.appendChild(card);
  });
}

/**
 * Create a demo card element.
 */
function createDemoCard(demo: DemoDefinition): HTMLElement {
  const card = document.createElement('div');
  card.className = 'demo-card';
  card.innerHTML = `
    <h3>${escapeHtml(demo.title)}</h3>
    <p>${escapeHtml(demo.description)}</p>
  `;

  const button = document.createElement('a');
  button.className = 'demo-card-btn';
  button.href = `#/demo/${demo.id}`;
  button.textContent = 'Open Demo';
  card.appendChild(button);

  // Also allow clicking the card
  card.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).tagName !== 'A') {
      navigateToDemo(demo.id);
    }
  });

  return card;
}

/**
 * Render the demo page layout.
 * Returns the render container and controls panel for the demo to use.
 */
export function renderDemoLayout(container: HTMLElement): {
  renderArea: HTMLElement;
  controlsPanel: HTMLElement;
} {
  container.innerHTML = `
    <div class="demo-layout">
      <div class="demo-render-area" id="demo-render-area"></div>
      <aside class="demo-controls-panel" id="demo-controls-panel">
        <div class="panel-header">
          <h2>Controls</h2>
        </div>
        <div class="panel-content" id="panel-content"></div>
      </aside>
    </div>
  `;

  const renderArea = container.querySelector('#demo-render-area') as HTMLElement;
  const controlsPanel = container.querySelector('#panel-content') as HTMLElement;

  return { renderArea, controlsPanel };
}

/**
 * Render 404 not found page.
 */
export function renderNotFound(container: HTMLElement): void {
  container.innerHTML = `
    <div class="home-page">
      <header class="home-header">
        <h1>404 - Not Found</h1>
        <p>The requested page or demo was not found.</p>
        <a href="#/" class="demo-card-btn" style="display: inline-block; margin-top: 16px;">
          Go Home
        </a>
      </header>
    </div>
  `;
}

/**
 * Set the document title.
 */
export function setPageTitle(title?: string): void {
  document.title = title ? `${title} | Physics Demos` : 'Physics Demos';
}

/**
 * Escape HTML entities.
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
