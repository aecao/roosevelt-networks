// Captures the annotated screenshots and GIFs used by public/tutorial/.
// Start the dev server first (`npm run dev`), then run `npm run capture:tutorial`.
// Optional: `npm run capture:tutorial -- --url=http://localhost:5173/ --only=overview,select`
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'tutorial', 'media');
const option = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const APP_URL = option('url') || 'http://localhost:5173/';
const ONLY = option('only')?.split(',');
const VIEWPORT = { width: 1400, height: 860 };
const ACCENT = '#afff2e';
const FOCUS_ACTOR = 'Roosevelt Island Operating Corporation';
const SECOND_ACTOR = 'Cornell Tech';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openApp(browser, { width = VIEWPORT.width, height = VIEWPORT.height, scale = 2, legend = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
  const page = await context.newPage();
  await page.goto(APP_URL);
  await page.waitForFunction(() => window.__rooseveltNetworks?.renderer, null, { timeout: 30000 });
  await page.addStyleTag({ content: '*, *::before, *::after { caret-color: transparent !important; }' });
  await sleep(2500);
  await setLegendOpen(page, legend);
  return { context, page };
}

// Draws numbered callouts over elements. Each mark is { target, n, at } where target is a
// selector, an element-returning function source, or a {x,y,width,height} rect, and `at`
// places the badge ('tl', 'tr', 'bl', 'br', 'l', 'r', 't', 'b').
async function annotate(page, marks) {
  await page.evaluate(({ marks, accent }) => {
    document.getElementById('__tutorial-annotations')?.remove();
    const layer = document.createElement('div');
    layer.id = '__tutorial-annotations';
    Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: 2147483646 });
    document.body.appendChild(layer);
    for (const mark of marks) {
      let rect = mark.rect;
      if (!rect) {
        const element = mark.text
          ? [...document.querySelectorAll(mark.target)].find((el) => el.textContent.trim().startsWith(mark.text))
          : document.querySelector(mark.target);
        if (!element) throw new Error(`Annotation target not found: ${mark.target} ${mark.text || ''}`);
        rect = element.getBoundingClientRect();
        if (mark.union) {
          const other = document.querySelector(mark.union).getBoundingClientRect();
          const x = Math.min(rect.left, other.left);
          const y = Math.min(rect.top, other.top);
          rect = { x, y, width: Math.max(rect.right, other.right) - x, height: Math.max(rect.bottom, other.bottom) - y };
        }
        if (mark.clipTo) {
          const bounds = document.querySelector(mark.clipTo).getBoundingClientRect();
          const x = Math.max(rect.x, bounds.left);
          const y = Math.max(rect.y, bounds.top);
          rect = { x, y, width: Math.min(rect.x + rect.width, bounds.right) - x, height: Math.min(rect.y + rect.height, bounds.bottom) - y };
        }
      }
      const pad = mark.pad ?? 3;
      const box = { x: rect.x - pad, y: rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
      if (mark.outline !== false) {
        const outline = document.createElement('div');
        Object.assign(outline.style, {
          position: 'fixed', left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px`,
          border: `2px solid ${accent}`, borderRadius: '6px', boxSizing: 'border-box',
          boxShadow: '0 0 0 1px rgba(0,0,0,.35)',
        });
        layer.appendChild(outline);
      }
      const size = 22;
      const at = mark.at || 'tl';
      const cx = at.includes('l') ? box.x : at.includes('r') ? box.x + box.width : box.x + box.width / 2;
      const cy = at.includes('t') ? box.y : at.includes('b') ? box.y + box.height : box.y + box.height / 2;
      const badge = document.createElement('div');
      badge.textContent = mark.n;
      Object.assign(badge.style, {
        position: 'fixed', left: `${cx - size / 2 + (mark.dx || 0)}px`, top: `${cy - size / 2 + (mark.dy || 0)}px`,
        width: `${size}px`, height: `${size}px`, borderRadius: '50%', background: accent, color: '#000',
        font: '700 12px/22px "Helvetica Neue", Helvetica, Arial, sans-serif', textAlign: 'center',
        boxShadow: '0 0 0 2px #fff, 0 1px 4px rgba(0,0,0,.45)',
      });
      layer.appendChild(badge);
    }
  }, { marks, accent: ACCENT });
}

const clearAnnotations = (page) => page.evaluate(() => document.getElementById('__tutorial-annotations')?.remove());

async function shot(page, name, { clip, selector, pad = 0, type = 'png' } = {}) {
  let region = clip;
  if (selector) {
    const box = await page.locator(selector).first().boundingBox();
    region = { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 };
  }
  if (region) {
    // Grow the crop so annotation badges and outlines are never clipped.
    const marks = await page.evaluate(() => [...(document.getElementById('__tutorial-annotations')?.children || [])]
      .map((el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; }));
    const margin = 8;
    let left = region.x;
    let top = region.y;
    let right = region.x + region.width;
    let bottom = region.y + region.height;
    for (const mark of marks) {
      left = Math.min(left, mark.left - margin);
      top = Math.min(top, mark.top - margin);
      right = Math.max(right, mark.right + margin);
      bottom = Math.max(bottom, mark.bottom + margin);
    }
    const viewport = page.viewportSize();
    const x = Math.max(0, left);
    const y = Math.max(0, top);
    region = { x, y, width: Math.min(viewport.width, right) - x, height: Math.min(viewport.height, bottom) - y };
  }
  const file = path.join(OUT_DIR, `${name}.${type}`);
  await page.screenshot({ path: file, clip: region, type, ...(type === 'jpeg' ? { quality: 82 } : {}) });
  console.log(`  wrote ${path.relative(process.cwd(), file)}`);
}

async function actorPosition(page, label) {
  return page.evaluate((label) => {
    const { renderer, graph } = window.__rooseveltNetworks;
    const node = graph.findNode((_, attributes) => attributes.label === label || attributes.fullName === label) || label;
    const display = renderer.getNodeDisplayData(node);
    if (!display) throw new Error(`Actor not displayed: ${label}`);
    const point = renderer.graphToViewport(display);
    const bounds = renderer.getContainer().getBoundingClientRect();
    return { x: bounds.left + point.x, y: bounds.top + point.y };
  }, label);
}

async function selectBySearch(page, label) {
  await page.fill('#search', label);
  await page.locator('#search-results button', { hasText: label }).first().click();
  await page.fill('#search', '');
  await sleep(700);
}

async function setDetailsOpen(page, open) {
  const expanded = await page.getAttribute('#details-toggle', 'aria-expanded');
  if ((expanded === 'true') !== open) await page.click('#details-toggle');
  await sleep(300);
}

async function setLegendOpen(page, open) {
  const expanded = await page.getAttribute('#legend-toggle', 'aria-expanded');
  if ((expanded === 'true') !== open) await page.click('#legend-toggle');
  await sleep(500);
}

async function expandGroup(page, groupId) {
  const toggle = page.locator(`button[aria-controls="${groupId}"]`);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

// ---------- GIF recording ----------

async function installCursor(page) {
  await page.evaluate(() => {
    if (document.getElementById('__tutorial-cursor')) return;
    const cursor = document.createElement('div');
    cursor.id = '__tutorial-cursor';
    cursor.innerHTML = '<svg width="22" height="26" viewBox="0 0 22 26"><path d="M2 2 L2 20 L7 15.5 L10.5 23.5 L13.8 22 L10.4 14.2 L17 14.2 Z" fill="#fff" stroke="#000" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(cursor.style, { position: 'fixed', left: '-40px', top: '-40px', pointerEvents: 'none', zIndex: 2147483647 });
    document.body.appendChild(cursor);
    window.__tutorialCursor = (x, y) => { cursor.style.left = `${x - 2}px`; cursor.style.top = `${y - 2}px`; };
    window.__tutorialRipple = (x, y) => {
      const ripple = document.createElement('div');
      Object.assign(ripple.style, {
        position: 'fixed', left: `${x - 16}px`, top: `${y - 16}px`, width: '32px', height: '32px', borderRadius: '50%',
        border: '3px solid #afff2e', boxSizing: 'border-box', pointerEvents: 'none', zIndex: 2147483646,
        transition: 'transform .45s ease-out, opacity .45s ease-out', transform: 'scale(.3)', opacity: '1',
      });
      document.body.appendChild(ripple);
      requestAnimationFrame(() => { ripple.style.transform = 'scale(1.3)'; ripple.style.opacity = '0'; });
      setTimeout(() => ripple.remove(), 600);
    };
  });
}

class Recorder {
  constructor(page, clip) {
    this.page = page;
    this.clip = clip;
    this.frames = [];
    this.mouse = { x: clip.x + clip.width / 2, y: clip.y + clip.height / 2 };
  }

  async frame() {
    const png = await this.page.screenshot({ clip: this.clip, type: 'png' });
    this.frames.push({ png, time: Date.now() });
  }

  hold(ms) {
    const last = this.frames[this.frames.length - 1];
    if (last) last.extra = (last.extra || 0) + ms;
  }

  async record(ms) {
    const end = Date.now() + ms;
    do await this.frame(); while (Date.now() < end);
  }

  async moveTo(x, y, { steps = 10, drag = false } = {}) {
    const from = { ...this.mouse };
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const px = from.x + (x - from.x) * eased;
      const py = from.y + (y - from.y) * eased;
      await this.page.mouse.move(px, py);
      await this.page.evaluate(([cx, cy]) => window.__tutorialCursor(cx, cy), [px, py]);
      if (!drag || step % 2 === 0 || step === steps) await this.frame();
    }
    this.mouse = { x, y };
  }

  async click(x, y, { button = 'left', settle = 700 } = {}) {
    await this.moveTo(x, y);
    await this.page.evaluate(([cx, cy]) => window.__tutorialRipple(cx, cy), [x, y]);
    await this.page.mouse.click(x, y, { button });
    await this.record(settle);
  }

  async clickSelector(selector, options = {}) {
    const box = await this.page.locator(selector).first().boundingBox();
    await this.click(box.x + box.width / 2, box.y + box.height / 2, options);
  }

  async drag(fromX, fromY, toX, toY) {
    await this.moveTo(fromX, fromY);
    await this.page.mouse.down();
    await this.moveTo(toX, toY, { steps: 16, drag: true });
    await this.page.mouse.up();
    await this.record(300);
  }

  async wheel(deltaY, times = 4) {
    for (let index = 0; index < times; index += 1) {
      await this.page.mouse.wheel(0, deltaY);
      await this.record(140);
    }
    await this.record(400);
  }

  async save(name, { endHold = 1600 } = {}) {
    const file = path.join(OUT_DIR, `${name}.gif`);
    await writeFile(file, encodeGif(this.frames, endHold));
    console.log(`  wrote ${path.relative(process.cwd(), file)} (${this.frames.length} frames)`);
  }
}

function encodeGif(frames, endHold) {
  const decoded = frames.map(({ png }) => PNG.sync.read(png));
  const { width, height } = decoded[0];
  const sampleEvery = Math.max(1, Math.floor(decoded.length / 6));
  const samples = decoded.filter((_, index) => index % sampleEvery === 0 || index === decoded.length - 1);
  const sample = new Uint8Array(samples.length * width * height * 4);
  samples.forEach((image, index) => sample.set(image.data, index * width * height * 4));
  const colors = quantize(sample, 255, { format: 'rgb565' });
  const palette = [...colors];
  while (palette.length < 256) palette.push([255, 0, 255]);
  const transparentIndex = 255;
  const encoder = GIFEncoder();
  let previous = null;
  decoded.forEach((image, index) => {
    const indices = applyPalette(image.data, colors, 'rgb565');
    const next = frames[index + 1];
    const delay = next ? next.time - frames[index].time + (frames[index].extra || 0) : endHold + (frames[index].extra || 0);
    if (!previous) {
      encoder.writeFrame(indices, width, height, { palette, delay });
    } else {
      const output = new Uint8Array(indices.length);
      for (let pixel = 0; pixel < indices.length; pixel += 1) {
        output[pixel] = indices[pixel] === previous[pixel] ? transparentIndex : indices[pixel];
      }
      encoder.writeFrame(output, width, height, { delay, transparent: true, transparentIndex, dispose: 1 });
    }
    previous = indices;
  });
  encoder.finish();
  return Buffer.from(encoder.bytes());
}

// ---------- Captures ----------

const GRAPH_CLIP = { x: 300, y: 40, width: 800, height: 560 };

const captures = {
  async overview(browser) {
    const { context, page } = await openApp(browser, { legend: true });
    await selectBySearch(page, FOCUS_ACTOR);
    await setDetailsOpen(page, true);
    await page.evaluate(() => {
      const legend = document.getElementById('legend-panel');
      legend.style.left = '320px';
      legend.style.top = '520px';
    });
    await sleep(400);
    await annotate(page, [
      { target: '.mode-tabs', n: 1, at: 'b', dy: 4 },
      { target: '#theme-toggle', union: '#header-info-toggle', n: 2, at: 'l', dx: -16 },
      { target: '#sidebar', n: 3, at: 'r', pad: -2 },
      { rect: { x: 560, y: 120, width: 380, height: 300 }, n: 4, at: 'tl', outline: false },
      { target: '.zoom-controls', n: 5, at: 'l', dx: -16 },
      { target: '#details-sidebar', n: 6, at: 'l', pad: -2 },
      { target: '#legend-panel', n: 7, at: 'tr' },
    ]);
    await shot(page, 'overview', { type: 'jpeg' });
    await context.close();
  },

  async modes(browser) {
    const { context, page } = await openApp(browser, { width: 1200, height: 760, scale: 1.5 });
    await shot(page, 'mode-relationships', { type: 'jpeg' });
    await page.click('.mode-tab[data-mode="map"]');
    await sleep(2500);
    await shot(page, 'mode-map', { type: 'jpeg' });
    await page.click('.mode-tab[data-mode="timeline"]');
    await sleep(2000);
    await shot(page, 'mode-timeline', { type: 'jpeg' });
    await context.close();
  },

  async header(browser) {
    const { context, page } = await openApp(browser);
    await annotate(page, [
      { target: '#theme-toggle', n: 1, at: 'b', dy: 6 },
      { target: '#export-toggle', n: 2, at: 'b', dy: 6 },
      { target: '#legend-toggle', n: 3, at: 'b', dy: 6 },
      { target: '#refresh-sheets', n: 4, at: 'b', dy: 6 },
      { target: '#header-info-toggle', n: 5, at: 'b', dy: 6 },
    ]);
    await shot(page, 'header-controls', { clip: { x: 1090, y: 0, width: 310, height: 64 } });
    await clearAnnotations(page);
    await page.click('#header-info-toggle');
    await sleep(300);
    const menu = await page.locator('#header-info-menu').boundingBox();
    await shot(page, 'info-menu', { clip: { x: menu.x - 10, y: 0, width: menu.width + 20, height: menu.y + menu.height + 10 } });
    await context.close();
  },

  async zoom(browser) {
    const { context, page } = await openApp(browser);
    await annotate(page, [
      { target: '#zoom-level', n: 1, at: 'l', dx: -8 },
      { target: '#zoom-in', n: 2, at: 'r', dx: 8 },
      { target: '#zoom-out', n: 3, at: 'r', dx: 8 },
      { target: '#zoom-fit', n: 4, at: 'r', dx: 8 },
      { target: '#fullscreen-toggle', n: 5, at: 'r', dx: 8 },
    ]);
    const box = await page.locator('.zoom-controls').boundingBox();
    await shot(page, 'zoom-controls', { clip: { x: box.x - 30, y: box.y - 12, width: box.width + 62, height: box.height + 24 } });
    await context.close();
  },

  async panZoomGif(browser) {
    const { context, page } = await openApp(browser, { scale: 1 });
    await installCursor(page);
    const rec = new Recorder(page, GRAPH_CLIP);
    await rec.moveTo(700, 330, { steps: 4 });
    rec.hold(400);
    await rec.drag(700, 330, 560, 250);
    await rec.drag(560, 250, 760, 360);
    await rec.moveTo(700, 320, { steps: 6 });
    await rec.wheel(-240, 4);
    rec.hold(400);
    await rec.wheel(240, 4);
    await rec.clickSelector('#zoom-fit', { settle: 800 }).catch(async () => {
      await page.click('#zoom-fit');
      await rec.record(800);
    });
    await rec.save('pan-zoom');
    await context.close();
  },

  async legendGif(browser) {
    const { context, page } = await openApp(browser, { scale: 1 });
    await installCursor(page);
    const rec = new Recorder(page, { x: 300, y: 0, width: 1100, height: 560 });
    await rec.frame();
    rec.hold(500);
    await rec.clickSelector('#legend-toggle', { settle: 900 });
    await rec.clickSelector('#legend-text-larger', { settle: 500 });
    await rec.clickSelector('#legend-text-smaller', { settle: 500 });
    const header = await page.locator('#legend-panel-header').boundingBox();
    await rec.drag(header.x + 60, header.y + header.height / 2, header.x + 240, header.y + header.height / 2 + 90);
    await rec.clickSelector('#legend-close', { settle: 1000 });
    await rec.save('legend');
    await context.close();
  },

  async filters(browser) {
    const { context, page } = await openApp(browser, { width: 1400, height: 1500 });
    await page.click('#year-filter-toggle');
    await sleep(300);
    const fit = await page.evaluate(() => {
      const scroll = document.getElementById('sidebar-filters-scroll');
      return window.innerHeight + scroll.scrollHeight - scroll.clientHeight;
    });
    await page.setViewportSize({ width: 1400, height: fit + 4 });
    await sleep(500);
    await annotate(page, [
      { target: '#search', n: 1, at: 'r', dx: 4 },
      { target: '#appearance-group', n: 2, at: 'tr', union: 'button[aria-controls="appearance-group"]' },
      { target: 'button[aria-controls="centrality-group"]', n: 3, at: 'r', dx: 4 },
      { target: 'button[aria-controls="node-type-group"]', union: 'button[aria-controls="scale-group"]', n: 4, at: 'r', dx: 4 },
      { target: '#edge-type-select-all', union: '#edge-type-filters', n: 5, at: 'tr' },
      { target: 'label[for="edge-curvature-slider"]', union: '#layout-gravity-increment', n: 6, at: 'tr' },
      { target: '#year-filter-toggle', union: '#year-controls', n: 7, at: 'tr' },
      { target: '#sidebar-footer', n: 8, at: 'tr' },
    ]);
    const sidebar = await page.locator('#sidebar').boundingBox();
    const footer = await page.locator('#sidebar-footer').boundingBox();
    await shot(page, 'filters-sidebar', { clip: { x: 0, y: 40, width: sidebar.width + 14, height: footer.y + footer.height + 18 - 40 } });
    await context.close();
  },

  async filterGif(browser) {
    const { context, page } = await openApp(browser, { scale: 1 });
    await installCursor(page);
    await page.locator('button[aria-controls="appearance-group"]').click();
    await sleep(300);
    const rec = new Recorder(page, { x: 0, y: 40, width: 1100, height: 600 });
    await rec.frame();
    rec.hold(300);
    await rec.clickSelector('button[aria-controls="node-type-group"]', { settle: 400 });
    const labels = page.locator('#node-type-filters label');
    const count = await labels.count();
    for (let index = 0; index < Math.min(2, count); index += 1) {
      await rec.clickSelector(`#node-type-filters label >> nth=${index}`, { settle: 900 });
    }
    rec.hold(600);
    for (let index = 0; index < Math.min(2, count); index += 1) {
      await rec.clickSelector(`#node-type-filters label >> nth=${index}`, { settle: 700 });
    }
    await rec.clickSelector('button[aria-controls="centrality-group"]', { settle: 400 });
    for (let index = 0; index < 4; index += 1) {
      await rec.clickSelector('#centrality-threshold-increment', { settle: 500 });
    }
    rec.hold(600);
    await rec.save('filtering');
    await context.close();
  },

  async appearance(browser) {
    const { context, page } = await openApp(browser);
    await page.click('#label-threshold-toggle');
    await sleep(300);
    await annotate(page, [
      { target: '#labels-toggle', union: '#text-size-increment', n: 1, at: 'tr', dx: 8 },
      { target: '#label-threshold-toggle', union: '#text-threshold-increment', n: 2, at: 'tr', dx: 8 },
      { target: '#node-size-decrement', union: '#node-size-value', n: 3, at: 'tr', dx: 8 },
      { target: '#color-mode', n: 4, at: 'tr', dx: 8 },
      { target: '#halo-toggle', union: '#size-mode', n: 5, at: 'tr', dx: 8 },
    ]);
    await shot(page, 'appearance', { selector: '#appearance-group', pad: 16 });
    await context.close();
  },

  async appearanceGif(browser) {
    const { context, page } = await openApp(browser, { scale: 1 });
    await installCursor(page);
    const rec = new Recorder(page, { x: 0, y: 40, width: 1100, height: 600 });
    await rec.frame();
    rec.hold(300);
    for (const mode of ['sector', 'sentiment', 'category']) {
      const has = await page.locator(`#color-mode option[value="${mode}"]`).count();
      if (!has) continue;
      await rec.clickSelector('#color-mode', { settle: 150 });
      await page.selectOption('#color-mode', mode);
      await rec.record(900);
    }
    for (let index = 0; index < 3; index += 1) await rec.clickSelector('#node-size-increment', { settle: 350 });
    for (let index = 0; index < 3; index += 1) await rec.clickSelector('#node-size-decrement', { settle: 350 });
    await rec.clickSelector('#halo-toggle', { settle: 800 });
    await rec.clickSelector('#halo-toggle', { settle: 800 });
    await rec.save('appearance');
    await context.close();
  },

  async selectGif(browser) {
    const { context, page } = await openApp(browser, { scale: 1 });
    await installCursor(page);
    await page.click('#zoom-to-selected');
    await sleep(200);
    const rec = new Recorder(page, { x: 300, y: 40, width: 1100, height: 620 });
    const target = await actorPosition(page, FOCUS_ACTOR);
    await rec.moveTo(target.x - 120, target.y + 80, { steps: 3 });
    rec.hold(300);
    await rec.moveTo(target.x, target.y, { steps: 10 });
    await rec.record(700);
    await rec.click(target.x, target.y, { settle: 1200 });
    const blank = { x: 1040, y: 600 };
    await rec.click(blank.x, blank.y, { settle: 900 });
    await rec.save('select');
    await context.close();
  },

  async pinGif(browser) {
    const { context, page } = await openApp(browser, { scale: 1 });
    await installCursor(page);
    await page.click('#zoom-to-selected');
    await sleep(200);
    const rec = new Recorder(page, { x: 300, y: 40, width: 1100, height: 620 });
    const first = await actorPosition(page, FOCUS_ACTOR);
    await rec.moveTo(first.x - 100, first.y + 60, { steps: 3 });
    await rec.click(first.x, first.y, { button: 'right', settle: 600 });
    await rec.clickSelector('#context-pin-toggle', { settle: 900 });
    const second = await actorPosition(page, SECOND_ACTOR).catch(() => null);
    if (second) {
      await rec.click(second.x, second.y, { settle: 1200 });
    }
    rec.hold(800);
    await rec.save('pinning');
    await context.close();
  },

  async details(browser) {
    const { context, page } = await openApp(browser);
    await selectBySearch(page, SECOND_ACTOR);
    await page.click('#pin-selection');
    const thirdActor = await page.evaluate(([focus, second]) => {
      const { graph } = window.__rooseveltNetworks;
      return graph.neighbors(focus).find((node) => node !== second);
    }, [FOCUS_ACTOR, SECOND_ACTOR]);
    await selectBySearch(page, thirdActor);
    await page.click('#pin-selection');
    await selectBySearch(page, FOCUS_ACTOR);
    await setDetailsOpen(page, true);
    await sleep(500);
    await annotate(page, [
      { target: '#current-selection-title', n: 1, at: 'b', dy: 4 },
      { target: '#pin-selection', n: 2, at: 'b', dy: 6 },
      { target: '#node-details', clipTo: '#active-selection', n: 3, at: 'r', dx: -14 },
      { target: '#pinned-section', clipTo: '#details-content', n: 4, at: 'tr', dx: -14, dy: 14 },
    ]);
    const sidebar = await page.locator('#details-sidebar').boundingBox();
    await shot(page, 'details-panel', { clip: { x: sidebar.x - 20, y: 40, width: sidebar.width + 20, height: sidebar.height } });
    await clearAnnotations(page);
    const position = await actorPosition(page, FOCUS_ACTOR);
    await page.mouse.click(position.x, position.y, { button: 'right' });
    await sleep(300);
    await shot(page, 'context-menu', { clip: { x: position.x - 90, y: position.y - 60, width: 300, height: 140 } });
    await context.close();
  },

  async exporting(browser) {
    const { context, page } = await openApp(browser);
    await page.click('#export-toggle');
    await sleep(300);
    await shot(page, 'export-menu', { clip: { x: 1060, y: 0, width: 340, height: 150 } });
    await page.click('#advanced-export-option');
    await sleep(500);
    await shot(page, 'export-advanced', { selector: '#advanced-export-window', pad: 12 });
    await context.close();
  },
};

const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
await mkdir(OUT_DIR, { recursive: true });
try {
  for (const [name, capture] of Object.entries(captures)) {
    if (ONLY && !ONLY.includes(name)) continue;
    console.log(name);
    try {
      await capture(browser);
    } catch (error) {
      console.error(`  failed: ${error.message.split('\n')[0]}`);
      process.exitCode = 1;
    }
  }
} finally {
  await browser.close();
}
