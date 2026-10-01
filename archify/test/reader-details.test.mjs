import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ChromeVisualBrowser, findChrome } from '../bin/visual-check.mjs';
import { germanCatalogKeys, translateMessage, viewerCatalog } from '../renderers/shared/i18n.mjs';

// Fork features: reader notes (`details`), a detail popover anchored beside
// the clicked element, click without camera movement (`meta.viewer`), a type
// independent accent palette, and a German reader catalog (`meta.locale: de`).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');
const cli = path.join(skillRoot, 'bin/archify.mjs');
const templatePath = path.join(skillRoot, 'assets/template.html');
const commonSchema = JSON.parse(fs.readFileSync(path.join(skillRoot, 'schemas/common.schema.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-reader-details-'));
const chromePath = process.env.ARCHIFY_CHROME ? findChrome() : null;
let sequence = 0;

function baseSpec() {
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { title: 'Reader details' },
    components: [
      { id: 'client', type: 'frontend', label: 'Client', sublabel: 'Browser', pos: [40, 200], size: [140, 60] },
      { id: 'api', type: 'backend', label: 'API', sublabel: 'Service', pos: [300, 200], size: [140, 60], tag: 'v2' },
      { id: 'guard', type: 'security', label: 'Guard', sublabel: 'Roles', pos: [300, 60], size: [140, 60] },
      { id: 'store', type: 'database', label: 'Store', sublabel: 'Rows', pos: [560, 200], size: [140, 60] },
    ],
    connections: [
      { id: 'call', from: 'client', to: 'api', label: 'HTTPS' },
      { id: 'check', from: 'api', to: 'guard', label: 'check', fromSide: 'top', toSide: 'bottom' },
      { id: 'write', from: 'api', to: 'store', label: 'SQL' },
    ],
  };
}

function featureSpec() {
  const spec = baseSpec();
  spec.meta.locale = 'de';
  spec.meta.viewer = { click_zoom: false, detail_placement: 'anchored' };
  spec.components[1].details = 'Erster Absatz.\nZweite Zeile.\n\n- Punkt eins\n- Punkt <b>zwei</b>\n\n<script>alert(1)</script> bleibt Text';
  spec.components[1].accent = 'yellow';
  spec.components[2].accent = 'teal';
  spec.connections[2].details = 'Nur Lesezugriff.\n- Transaktion je Anfrage';
  return spec;
}

function run(document, command = 'render') {
  const id = sequence++;
  const input = path.join(tmp, `${id}.json`);
  const output = path.join(tmp, `${id}.html`);
  fs.writeFileSync(input, JSON.stringify(document));
  const args = command === 'render'
    ? [cli, 'render', 'architecture', input, output]
    : [cli, 'validate', 'architecture', input, '--json'];
  const result = spawnSync(process.execPath, args, {
    cwd: skillRoot,
    encoding: 'utf8',
    env: { ...process.env, ARCHIFY_UPDATE_CHECK_DISABLED: '1' },
  });
  return {
    ...result,
    output,
    html: result.status === 0 && command === 'render' ? fs.readFileSync(output, 'utf8') : '',
  };
}

function svgBlock(html) {
  const match = html.match(/<svg viewBox=[\s\S]*?<\/svg>/);
  assert.ok(match, 'rendered artifact has an SVG block');
  return match[0];
}

function scriptJson(html, id) {
  const match = html.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`));
  return match ? match[1] : null;
}

function luminance(hex) {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first, second) {
  const [high, low] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

test('schema accepts details, accent, viewer options and German locale, and rejects malformed values', () => {
  const ok = run(featureSpec(), 'validate');
  assert.equal(ok.status, 0, ok.stdout || ok.stderr);

  const bad = featureSpec();
  bad.meta.viewer = { click_zoom: 'no', detail_placement: 'floating' };
  bad.components[0].accent = 'purple';
  bad.components[0].details = '';
  bad.connections[0].details = 'x'.repeat(4001);
  bad.components[3].details = { html: '<b>x</b>' };
  const rejected = run(bad, 'validate');
  assert.notEqual(rejected.status, 0);
  const report = JSON.parse(rejected.stdout);
  for (const pointer of [
    '/meta/viewer/click_zoom',
    '/meta/viewer/detail_placement',
    '/components/0/accent',
    '/components/0/details',
    '/components/3/details',
    '/connections/0/details',
  ]) {
    assert.ok(report.error.includes(pointer), `rejects ${pointer}`);
  }
});

test('documents without the new fields render exactly as before: no new payloads, identical SVG', () => {
  const plain = run(baseSpec());
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(scriptJson(plain.html, 'archify-reader-details'), null);
  assert.equal(scriptJson(plain.html, 'archify-viewer-options'), null);
  assert.ok(!plain.html.includes('data-node-accent'));

  // Details and viewer options never touch the SVG; only accent does, and only
  // on the accented node's fill class, tag class and accent attribute.
  const withDetails = baseSpec();
  withDetails.meta.viewer = { click_zoom: true };
  withDetails.components[1].details = 'Notes';
  withDetails.connections[0].details = 'Edge notes';
  const detailed = run(withDetails);
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.equal(svgBlock(detailed.html), svgBlock(plain.html));
});

test('reader details travel as escaped JSON beside the SVG and never as markup', () => {
  const result = run(featureSpec());
  assert.equal(result.status, 0, result.stderr);
  const raw = scriptJson(result.html, 'archify-reader-details');
  assert.ok(raw, 'details payload present');
  assert.ok(!/<(?:b|script)\b/i.test(raw), 'no raw tags inside the JSON payload');
  const payload = JSON.parse(raw);
  assert.deepEqual(Object.keys(payload.nodes), ['api']);
  assert.match(payload.nodes.api, /Punkt <b>zwei<\/b>/);
  assert.deepEqual(payload.edges, { 2: 'Nur Lesezugriff.\n- Transaktion je Anfrage' });
  assert.ok(!svgBlock(result.html).includes('Erster Absatz'), 'notes are not drawn into the SVG');
  assert.deepEqual(JSON.parse(scriptJson(result.html, 'archify-viewer-options')), { click_zoom: false, detail_placement: 'anchored' });

  // The viewer must render notes through textContent only.
  const focusSource = fs.readFileSync(path.resolve(skillRoot, '../viewer/focus.js'), 'utf8');
  const renderNotes = focusSource.slice(focusSource.indexOf('function renderNotes('), focusSource.indexOf('function nodeLabel('));
  assert.ok(renderNotes.length > 100);
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(renderNotes));
});

test('accent recolors box and tag but keeps the type sigil and passport kind', () => {
  const result = run(featureSpec());
  assert.equal(result.status, 0, result.stderr);
  const svg = svgBlock(result.html);
  const api = svg.match(/<g id="node-api"[\s\S]*?(?=\n\n)/)[0];
  assert.match(api, /data-node-accent="yellow"/);
  assert.match(api, /data-node-kind="backend"/);
  assert.match(api, /class="c-accent-yellow"/);
  assert.match(api, /class="t-accent-yellow"/);
  assert.match(api, /data-semantic-sigil="backend"/);
  assert.ok(!/class="c-backend"/.test(api));
  const guard = svg.match(/<g id="node-guard"[\s\S]*?(?=\n\n)/)[0];
  assert.match(guard, /class="c-accent-teal"/);
  assert.match(guard, /data-semantic-sigil="security"/);
});

test('every accent token has classes and keeps contrast in dark and light themes', () => {
  const template = fs.readFileSync(templatePath, 'utf8');
  const darkBlock = template.match(/:root,\n\s*\[data-theme="dark"\] \{\n(\s*--accent-[\s\S]*?)\n\s*\}/)[1];
  const lightBlock = template.match(/\[data-theme="light"\] \{\n(\s*--accent-[\s\S]*?)\n\s*\}/)[1];
  const read = (block, name) => {
    const match = block.match(new RegExp(`--accent-${name}: (#[0-9a-f]{6});`));
    assert.ok(match, `token ${name}`);
    return match[1];
  };
  const accents = commonSchema.$defs.accent.enum;
  assert.ok(accents.includes('red') && accents.includes('yellow') && accents.includes('teal'));
  for (const accent of accents) {
    assert.ok(template.includes(`.c-accent-${accent} { fill: var(--accent-${accent}-fill); stroke: var(--accent-${accent}-stroke); }`), `${accent} box class`);
    assert.ok(template.includes(`.t-accent-${accent} { fill: var(--accent-${accent}-text); }`), `${accent} text class`);
    // Dark: against the opaque node mask. Light: against canvas and node mask.
    assert.ok(contrast(read(darkBlock, `${accent}-stroke`), '#0f172a') >= 4.5, `${accent} dark stroke`);
    assert.ok(contrast(read(lightBlock, `${accent}-stroke`), '#f8fafc') >= 3, `${accent} light stroke`);
    assert.ok(contrast(read(lightBlock, `${accent}-stroke`), '#ffffff') >= 3, `${accent} light stroke on mask`);
    assert.ok(contrast(read(lightBlock, `${accent}-text`), '#ffffff') >= 4.5, `${accent} light text`);
  }
});

test('German catalog keys exist in the shared catalog, keep their variables and reach the viewer', () => {
  const variables = (value) => [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]).sort();
  for (const key of germanCatalogKeys()) {
    assert.deepEqual(variables(translateMessage('de', key)), variables(translateMessage('en', key)), key);
  }
  assert.equal(translateMessage('de', 'viewer.nav.zoomIn'), 'Vergrößern');
  assert.equal(translateMessage('de', 'viewer.passport.notes'), 'Hinweise');
  // Keys without a German entry fall back to English instead of failing.
  assert.equal(translateMessage('de', 'viewer.export.raster'), translateMessage('en', 'viewer.export.raster'));
  assert.equal(viewerCatalog('de')['viewer.passport.close'], 'Details schließen');

  const result = run(featureSpec());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.html, /<html lang="de" /);
  assert.match(result.html, /aria-label="Vergrößern"/);
  assert.match(result.html, />Legende</);
});

async function evaluate(browser, sessionId, expression, awaitPromise = false) {
  const response = await browser.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'browser evaluation failed');
  }
  return response.result?.value;
}

const settle = `new Promise(function (resolve) {
  setTimeout(function () { requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(true); }); }); }, 650);
})`;

async function loadArtifact(browser, artifactPath, width = 1440, height = 900) {
  const sessionId = await browser.sessionPromise;
  await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  const loaded = browser.cdp.waitFor('Page.loadEventFired', sessionId);
  const navigation = await browser.cdp.send('Page.navigate', { url: pathToFileURL(artifactPath).href }, sessionId);
  if (navigation.errorText) throw new Error(`Chrome navigation failed: ${navigation.errorText}`);
  await loaded;
  await evaluate(browser, sessionId, settle, true);
  return sessionId;
}

async function click(browser, sessionId, point) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await browser.cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId);
  }
  await evaluate(browser, sessionId, settle, true);
}

const nodeCenter = (id) => `(function () {
  var box = document.querySelector('[data-node-id="${id}"] rect:not(.c-mask)').getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
})()`;

const edgePoint = (key) => `(function () {
  var path = document.querySelector('path[data-edge-key="${key}"]');
  var length = path.getTotalLength();
  var point = path.getPointAtLength(length * 0.5);
  var matrix = path.getScreenCTM();
  return { x: matrix.a * point.x + matrix.c * point.y + matrix.e, y: matrix.b * point.x + matrix.d * point.y + matrix.f };
})()`;

const popoverState = (id) => `(function () {
  var chip = document.getElementById('focus-chip');
  var notes = document.getElementById('focus-notes');
  var node = document.querySelector('[data-node-id="${id}"]').getBoundingClientRect();
  var box = chip.getBoundingClientRect();
  var overlap = Math.max(0, Math.min(box.right, node.right) - Math.max(box.left, node.left)) *
    Math.max(0, Math.min(box.bottom, node.bottom) - Math.max(box.top, node.top));
  return {
    hidden: chip.hidden,
    side: chip.getAttribute('data-placement-side'),
    overlap: overlap,
    gap: Math.min(Math.abs(box.left - node.right), Math.abs(node.left - box.right), Math.abs(box.top - node.bottom), Math.abs(node.top - box.bottom)),
    notesHidden: notes.hidden,
    paragraphs: Array.prototype.map.call(notes.querySelectorAll('p'), function (p) { return p.textContent; }),
    items: Array.prototype.map.call(notes.querySelectorAll('li'), function (li) { return li.textContent; }),
    heading: (notes.querySelector('.semantic-passport-notes-heading') || {}).textContent || '',
    injected: notes.querySelectorAll('b, script').length,
    sublabel: document.getElementById('focus-detail').textContent,
    kind: document.getElementById('focus-kind').textContent,
    scale: document.querySelector('.diagram-container svg').getAttribute('data-view-scale'),
    transform: document.querySelector('.diagram-container svg').style.transform
  };
})()`;

test('a click opens the anchored popover beside the element, without camera movement', {
  skip: chromePath ? false : 'Set ARCHIFY_CHROME to run the real browser reader-details checks.',
}, async () => {
  const browser = new ChromeVisualBrowser(chromePath);
  try {
    const result = run(featureSpec());
    assert.equal(result.status, 0, result.stderr);
    const sessionId = await loadArtifact(browser, result.output);
    const before = await evaluate(browser, sessionId, popoverState('api'));

    await click(browser, sessionId, await evaluate(browser, sessionId, nodeCenter('api')));
    const opened = await evaluate(browser, sessionId, popoverState('api'));
    assert.equal(opened.hidden, false);
    assert.equal(opened.overlap, 0, 'popover does not cover the clicked node');
    assert.ok(opened.gap <= 16, `popover sits next to the node (gap ${opened.gap})`);
    assert.ok(['right', 'left', 'bottom', 'top'].includes(opened.side));
    assert.equal(opened.notesHidden, false);
    assert.deepEqual(opened.paragraphs, ['Erster Absatz.\nZweite Zeile.', '<script>alert(1)</script> bleibt Text']);
    assert.deepEqual(opened.items, ['Punkt eins', 'Punkt <b>zwei</b>']);
    assert.equal(opened.injected, 0, 'authored markup stays text');
    assert.equal(opened.sublabel, 'Service', 'previous passport info stays below the notes');
    assert.equal(opened.kind, 'Backend');
    assert.equal(opened.scale, before.scale, 'no zoom on click');
    assert.equal(opened.transform, before.transform, 'no camera movement on click');

    // Escape closes and keeps the view.
    await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
    await evaluate(browser, sessionId, settle, true);
    assert.equal((await evaluate(browser, sessionId, popoverState('api'))).hidden, true);

    // Zoom controls still zoom, and the popover follows the zoomed node.
    await evaluate(browser, sessionId, `document.querySelector('.diagram-nav [data-view="in"]').click()`);
    await evaluate(browser, sessionId, settle, true);
    const zoomed = await evaluate(browser, sessionId, popoverState('api'));
    assert.notEqual(zoomed.scale, before.scale, 'zoom control still zooms');
    await click(browser, sessionId, await evaluate(browser, sessionId, nodeCenter('api')));
    const zoomedOpen = await evaluate(browser, sessionId, popoverState('api'));
    assert.equal(zoomedOpen.hidden, false);
    assert.equal(zoomedOpen.scale, zoomed.scale, 'click keeps the reader zoom');
    assert.equal(zoomedOpen.overlap, 0);

    // Click beside closes, still without resetting the reader zoom.
    await click(browser, sessionId, { x: 8, y: 8 });
    const closed = await evaluate(browser, sessionId, popoverState('api'));
    assert.equal(closed.hidden, true);
    assert.equal(closed.scale, zoomed.scale, 'closing keeps the reader zoom');

    // Relationship notes appear for a clicked connection.
    const fresh = await loadArtifact(browser, result.output);
    await click(browser, fresh, await evaluate(browser, fresh, edgePoint('2')));
    const edge = await evaluate(browser, fresh, popoverState('api'));
    assert.equal(edge.hidden, false);
    assert.match(edge.heading, /Hinweise zur Verbindung · API → Store/);
    assert.deepEqual(edge.paragraphs, ['Nur Lesezugriff.']);
    assert.deepEqual(edge.items, ['Transaktion je Anfrage']);
    assert.equal(edge.scale, before.scale);

    // The x button closes too.
    await evaluate(browser, fresh, `document.getElementById('btn-focus-clear').click()`);
    await evaluate(browser, fresh, settle, true);
    assert.equal((await evaluate(browser, fresh, popoverState('api'))).hidden, true);

    // Accent colors follow the theme.
    const colors = await evaluate(browser, fresh, `(function () {
      var rect = document.querySelector('[data-node-id="api"] .c-accent-yellow');
      var dark = getComputedStyle(rect).stroke;
      document.documentElement.setAttribute('data-theme', 'light');
      var light = getComputedStyle(rect).stroke;
      document.documentElement.setAttribute('data-theme', 'dark');
      return { dark: dark, light: light };
    })()`);
    assert.equal(colors.dark, 'rgb(250, 204, 21)');
    assert.equal(colors.light, 'rgb(168, 127, 0)');

    // Opting back into click zoom restores the camera framing.
    const legacy = featureSpec();
    legacy.meta.viewer = { click_zoom: true, detail_placement: 'docked' };
    const legacyResult = run(legacy);
    assert.equal(legacyResult.status, 0, legacyResult.stderr);
    const legacySession = await loadArtifact(browser, legacyResult.output);
    const legacyBefore = await evaluate(browser, legacySession, popoverState('guard'));
    await click(browser, legacySession, await evaluate(browser, legacySession, nodeCenter('guard')));
    const legacyAfter = await evaluate(browser, legacySession, popoverState('guard'));
    assert.equal(legacyAfter.hidden, false);
    assert.equal(legacyAfter.side, null, 'docked placement keeps the upstream position');
    assert.notEqual(legacyAfter.transform, legacyBefore.transform, 'click zoom moves the camera when enabled');
  } finally {
    await browser.close();
  }
});

// Point 6: back-and-forth relationships.
function pairSpec() {
  const spec = baseSpec();
  spec.meta.locale = 'de';
  spec.components[2].pos = [300, 40];
  spec.connections = [
    { id: 'call', from: 'client', to: 'api', label: 'HTTPS', direction: 'both',
      details: { forward: 'Anfrage als JSON.', back: 'Antwort mit Quellen.\n- je Aussage eine Quelle' } },
    { id: 'ask', from: 'api', to: 'guard', label: 'Rolle prüfen', fromSide: 'top', toSide: 'bottom', labelPlacement: 'beside', details: 'Frage an die Rollenprüfung.' },
    { id: 'grant', from: 'guard', to: 'api', label: 'Freigabe', fromSide: 'bottom', toSide: 'top', labelPlacement: 'beside', details: 'Freigabe oder Ablehnung.' },
    { id: 'write', from: 'api', to: 'store', label: 'SQL' },
  ];
  return spec;
}

test('direction both draws arrowheads at both ends; start markers exist only when used', () => {
  const plain = run(baseSpec());
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(!plain.html.includes('-start"'), 'no start markers in documents without direction both');

  const result = run(pairSpec());
  assert.equal(result.status, 0, result.stderr);
  const svg = svgBlock(result.html);
  const call = svg.match(/<path [^>]*data-edge-id="call"[^>]*>/)[0];
  assert.match(call, /data-edge-direction="both"/);
  assert.match(call, /marker-start="url\(#arrowhead-start\)"/);
  assert.match(call, /marker-end="url\(#arrowhead\)"/);
  assert.match(svg, /<marker id="arrowhead-start"[^>]*orient="auto-start-reverse"/);
  const write = svg.match(/<path [^>]*data-edge-id="write"[^>]*>/)[0];
  assert.ok(!/marker-start/.test(write), 'forward edges keep one arrowhead');

  const bad = pairSpec();
  bad.connections[0].direction = 'backward';
  bad.connections[1].labelPlacement = 'left';
  bad.connections[2].details = { sideways: 'x' };
  const rejected = run(bad, 'validate');
  assert.notEqual(rejected.status, 0);
  for (const pointer of ['/connections/0/direction', '/connections/1/labelPlacement', '/connections/2/details']) {
    assert.ok(JSON.parse(rejected.stdout).error.includes(pointer), `rejects ${pointer}`);
  }
});

test('a request/response pair renders as two offset arrows with labels beside, not on a stub', () => {
  const result = run(pairSpec());
  assert.equal(result.status, 0, result.stderr);
  const svg = svgBlock(result.html);
  const routeX = (id) => Number(svg.match(new RegExp(`data-edge-id="${id}"[^>]*d="M ([0-9.]+) `))[1]);
  const labelRect = (id) => {
    const group = svg.match(new RegExp(`<g data-detail="context" [^>]*data-edge-id="${id}">\\s*<rect x="([0-9.-]+)" y="([0-9.-]+)" width="([0-9.]+)" height="([0-9.]+)"`));
    return { x: Number(group[1]), y: Number(group[2]), width: Number(group[3]), height: Number(group[4]) };
  };
  const ask = labelRect('ask');
  const grant = labelRect('grant');
  assert.notEqual(routeX('ask'), routeX('grant'), 'the two directions use separate offset routes');
  const leftRoute = Math.min(routeX('ask'), routeX('grant'));
  const rightRoute = Math.max(routeX('ask'), routeX('grant'));
  const [leftLabel, rightLabel] = routeX('ask') < routeX('grant') ? [ask, grant] : [grant, ask];
  assert.ok(leftLabel.x + leftLabel.width <= leftRoute, 'left label sits beside the left arrow');
  assert.ok(rightLabel.x >= rightRoute, 'right label sits beside the right arrow');
  // Both labels sit in the gap between guard (bottom 100) and api (top 200).
  for (const rect of [ask, grant]) {
    assert.ok(rect.y >= 100 && rect.y + rect.height <= 200, `label inside the gap: ${JSON.stringify(rect)}`);
  }
});

test('the popover shows forward and back sections for pairs and two-way relationships', {
  skip: chromePath ? false : 'Set ARCHIFY_CHROME to run the real browser reader-details checks.',
}, async () => {
  const browser = new ChromeVisualBrowser(chromePath);
  const sections = `(function () {
    var notes = document.getElementById('focus-notes');
    return Array.prototype.map.call(notes.querySelectorAll('.semantic-passport-notes-heading'), function (heading) {
      var texts = [];
      for (var next = heading.nextElementSibling; next && !next.classList.contains('semantic-passport-notes-heading'); next = next.nextElementSibling) {
        texts.push(next.textContent);
      }
      return { heading: heading.textContent, text: texts.join(' | ') };
    });
  })()`;
  try {
    const result = run(pairSpec());
    assert.equal(result.status, 0, result.stderr);
    const sessionId = await loadArtifact(browser, result.output);
    await click(browser, sessionId, await evaluate(browser, sessionId, edgePoint('1')));
    assert.deepEqual(await evaluate(browser, sessionId, sections), [
      { heading: 'Hin · API → Guard', text: 'Frage an die Rollenprüfung.' },
      { heading: 'Zurück · Guard → API', text: 'Freigabe oder Ablehnung.' },
    ]);
    const pairState = await evaluate(browser, sessionId, popoverState('api'));
    assert.equal(pairState.overlap, 0, 'popover keeps the endpoint free');

    await evaluate(browser, sessionId, `document.getElementById('btn-focus-clear').click()`);
    await evaluate(browser, sessionId, settle, true);
    await click(browser, sessionId, await evaluate(browser, sessionId, edgePoint('0')));
    assert.deepEqual(await evaluate(browser, sessionId, sections), [
      { heading: 'Hin · Client → API', text: 'Anfrage als JSON.' },
      { heading: 'Zurück · API → Client', text: 'Antwort mit Quellen. | je Aussage eine Quelle' },
    ]);
  } finally {
    await browser.close();
  }
});
