/**
 * Layout Manager
 *
 * Handles rendering of the main layout including:
 * - Home page with demos listed per lecture
 * - Demo page layout
 */

import { getAllDemos } from './registry';
import type { DemoDefinition } from './types';
import { lectures } from './lectures';

const GITHUB_URL = 'https://github.com/dskoda/intro-matsci-demos';

/**
 * Render the home page: course header followed by demos grouped per lecture.
 */
export function renderHomePage(container: HTMLElement): void {
  const demos = getAllDemos();
  const byId = new Map(demos.map((d) => [d.id, d]));
  const listed = new Set<string>();

  const sections = lectures.map((lecture) => {
    const items = lecture.demos
      .map((id) => byId.get(id))
      .filter((d): d is DemoDefinition => d !== undefined);
    items.forEach((d) => listed.add(d.id));
    return demoSection(`Lecture ${lecture.number}: ${lecture.title}`, items);
  });

  const others = demos.filter((d) => !listed.has(d.id));
  if (others.length > 0) sections.push(demoSection('Other demos', others));

  container.innerHTML = `
    <div class="home-page">
      <div class="home-content">
        <header class="home-header">
          <h1>MAT SCI 104 Demos</h1>
          <p>Interactive visualizations for UCLA's MAT SCI 104 course</p>
        </header>
        <p class="home-info">
          <strong>Term:</strong> Fall 2026<br />
          <strong>Instructor:</strong> Daniel Schwalbe-Koda<br />
          <strong>Source:</strong> <a href="${GITHUB_URL}">GitHub repository</a>
        </p>
        <hr />
        <h2>Lectures and Demos</h2>
        ${sections.join('<hr />')}
        <footer class="home-footer">
          <p>Created by Daniel Schwalbe-Koda</p>
        </footer>
      </div>
    </div>
  `;
}

function demoSection(heading: string, demos: DemoDefinition[]): string {
  const items = demos
    .map(
      (d) =>
        `<li><a href="#/demo/${escapeHtml(d.id)}">${escapeHtml(d.title)}</a></li>`
    )
    .join('');
  return `
    <section class="lecture">
      <h3>${escapeHtml(heading)}</h3>
      ${items ? `<ul>${items}</ul>` : '<p class="lecture-empty">No demos for this lecture.</p>'}
    </section>
  `;
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
  document.title = title ? `${title} | MatSci Demos` : 'MatSci Demos';
}

/**
 * Escape HTML entities.
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
