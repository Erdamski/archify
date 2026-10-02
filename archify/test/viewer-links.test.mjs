import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ChromeVisualBrowser, findChrome } from '../bin/visual-check.mjs';
import { architecture as validateArchitecture } from '../renderers/shared/generated-validators.mjs';
import { applyTemplate } from '../renderers/shared/utils.mjs';

// Fork features: toolbar links to sibling documents (`meta.viewer.links`) and a
// per-node reference into such a document (`components[].resourceRef`). Both
// are opt-in; without them the output must stay byte-identical.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');
const cli = path.join(skillRoot, 'bin/archify.mjs');
const template = fs.readFileSync(path.join(skillRoot, 'assets/template.html'), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-viewer-links-'));
const chromePath = process.env.ARCHIFY_CHROME ? findChrome() : null;
let sequence = 0;

function baseSpec() {
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { title: 'Viewer links' },
    components: [
      { id: 'client', type: 'frontend', label: 'Client', sublabel: 'Browser', pos: [40, 200], size: [140, 60] },
      { id: 'api', type: 'backend', label: 'API', sublabel: 'Service', pos: [300, 200], size: [140, 60] },
      { id: 'store', type: 'database', label: 'Store', sublabel: 'Rows', pos: [560, 200], size: [140, 60] },
    ],
    connections: [
      { id: 'call', from: 'client', to: 'api', label: 'HTTPS' },
      { id: 'write', from: 'api', to: 'store', label: 'SQL', details: 'Edge notes' },
    ],
  };
}

function featureSpec() {
  const spec = baseSpec();
  spec.meta.locale = 'de';
  spec.meta.viewer = {
    click_zoom: false,
    links: [{ label: 'Ressourcenliste <&>', href: 'it-briefing.html' }],
  };
  spec.components[1].details = 'API notes';
  spec.components[1].resourceRef = 'it-briefing.html#res-api';
  spec.components[2].resourceRef = 'it-briefing.html#res-store';
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

function scriptJson(html, id) {
  const match = html.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`));
  return match ? match[1] : null;
}

function withViewer(viewer) {
  const spec = baseSpec();
  spec.meta.viewer = viewer;
  return spec;
}

function withResourceRef(ref) {
  const spec = baseSpec();
  spec.components[0].resourceRef = ref;
  return spec;
}

const REJECTED_REFS = [
  '',
  'https://example.com/x.html',
  'http:x.html',
  'javascript:alert(1)',
  'data:text/html,x',
  'file:///etc/passwd',
  '//example.com/x.html',
  '/abs.html',
  '../up.html',
  'a/../b.html',
  'sub/page.html',
  'sub\\page.html',
  '..',
  'it..html',
  '.hidden.html',
  '-flag.html',
  'x.html?query=1',
  'x.html#',
  'x.html#1abc',
  'x.html#a#b',
  'x.html#a b',
  ' x.html',
  'x.html ',
  '%2e%2e/x.html',
  'x.html\n',
  'x'.repeat(201),
];

const ACCEPTED_REFS = ['it-briefing.html', 'it-briefing.html#res-4', 'a', 'Resources_v2.html#Node_1', 'x.html#res-blob'];

test('schema accepts sibling file names with an optional fragment and rejects everything else', () => {
  for (const href of ACCEPTED_REFS) {
    assert.equal(validateArchitecture(withViewer({ links: [{ label: 'List', href }] })), true, `link accepts ${href}`);
    assert.equal(validateArchitecture(withResourceRef(href)), true, `resourceRef accepts ${href}`);
  }
  for (const href of REJECTED_REFS) {
    assert.equal(validateArchitecture(withViewer({ links: [{ label: 'List', href }] })), false, `link rejects ${JSON.stringify(href)}`);
    assert.equal(validateArchitecture(withResourceRef(href)), false, `resourceRef rejects ${JSON.stringify(href)}`);
  }
});

test('schema bounds the link list and its labels', () => {
  const link = { label: 'List', href: 'list.html' };
  assert.equal(validateArchitecture(withViewer({ links: [] })), false, 'empty list');
  assert.equal(validateArchitecture(withViewer({ links: Array(5).fill(link) })), false, 'more than four links');
  assert.equal(validateArchitecture(withViewer({ links: Array(4).fill(link) })), true, 'four links');
  assert.equal(validateArchitecture(withViewer({ links: [{ href: 'list.html' }] })), false, 'label required');
  assert.equal(validateArchitecture(withViewer({ links: [{ label: 'List' }] })), false, 'href required');
  assert.equal(validateArchitecture(withViewer({ links: [{ ...link, target: '_blank' }] })), false, 'no extra properties');
  assert.equal(validateArchitecture(withViewer({ links: [{ ...link, label: '' }] })), false, 'empty label');
  assert.equal(validateArchitecture(withViewer({ links: [{ ...link, label: '   ' }] })), false, 'blank label');
  assert.equal(validateArchitecture(withViewer({ links: [{ ...link, label: 'two\nlines' }] })), false, 'line break');
  assert.equal(validateArchitecture(withViewer({ links: [{ ...link, label: 'x'.repeat(41) }] })), false, 'label over 40');
  assert.equal(validateArchitecture(withViewer({ links: 'list.html' })), false, 'links must be a list');
});

test('the CLI validator reports a bad link and a bad resource reference by path', () => {
  const ok = run(featureSpec(), 'validate');
  assert.equal(ok.status, 0, ok.stdout || ok.stderr);
  const bad = featureSpec();
  bad.meta.viewer.links[0].href = 'https://example.com/';
  bad.components[0].resourceRef = '../secret.html';
  const rejected = run(bad, 'validate');
  assert.notEqual(rejected.status, 0);
  const report = JSON.parse(rejected.stdout);
  for (const pointer of ['/meta/viewer/links/0/href', '/components/0/resourceRef']) {
    assert.ok(report.error.includes(pointer), `rejects ${pointer}`);
  }
});

test('without links or resource references the slot leaves no trace: output is byte-identical', () => {
  const slotLine = /^[ \t]*<!-- ARCHIFY:VIEWER_LINKS_SLOT -->[ \t]*\r?\n/m;
  assert.ok(slotLine.test(template), 'template carries the slot line');
  const previousTemplate = template.replace(slotLine, '');
  const args = {
    title: 'T', subtitle: 'S', svg: '<svg viewBox="0 0 10 10"></svg>', cards: '', locale: 'de',
  };
  for (const extra of [
    {},
    { viewerOptions: { click_zoom: true } },
    { viewerOptions: {} },
    { readerDetails: { nodes: { a: 'x' }, edges: {} }, viewerOptions: { detail_placement: 'docked' } },
  ]) {
    assert.equal(applyTemplate(template, { ...args, ...extra }), applyTemplate(previousTemplate, { ...args, ...extra }));
  }

  const plain = run(baseSpec());
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(!plain.html.includes('ARCHIFY:VIEWER_LINKS_SLOT'));
  assert.ok(!plain.html.includes('archify-viewer-link'));
  assert.ok(!plain.html.includes('archify-resource-ref'));
  assert.ok(!plain.html.includes('archify-viewer-links-style'));
});

test('links render as same-tab anchors in the toolbar, escaped, and leave the viewer options payload', () => {
  const result = run(featureSpec());
  assert.equal(result.status, 0, result.stderr);
  const toolbar = result.html.match(/<div class="toolbar"[\s\S]*?<div class="export-wrap">/)[0];
  const anchors = toolbar.match(/<a [^>]*>[^<]*<\/a>/g);
  assert.deepEqual(anchors, ['<a class="archify-viewer-link" href="it-briefing.html">Ressourcenliste &lt;&amp;&gt;</a>']);
  assert.ok(toolbar.indexOf('archify-viewer-link') < toolbar.indexOf('id="btn-present"'), 'link sits before Present');
  assert.ok(!/target=|onclick|javascript:/i.test(toolbar));
  assert.deepEqual(JSON.parse(scriptJson(result.html, 'archify-viewer-options')), { click_zoom: false });
  assert.match(result.html, /<style id="archify-viewer-links-style">[\s\S]*?\.toolbar a\.archify-viewer-link \{[\s\S]*?<\/style>\n<\/head>/);

  const onlyLinks = baseSpec();
  onlyLinks.meta.viewer = { links: [{ label: 'List', href: 'list.html' }] };
  const linksOnly = run(onlyLinks);
  assert.equal(linksOnly.status, 0, linksOnly.stderr);
  assert.equal(scriptJson(linksOnly.html, 'archify-viewer-options'), null, 'options that held only links emit nothing');
  assert.ok(!linksOnly.html.includes('archify-resource-refs'), 'no resource script without references');
});

test('resource references travel as escaped JSON with a script before </body>', () => {
  const result = run(featureSpec());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(scriptJson(result.html, 'archify-resource-refs')), {
    nodes: { api: 'it-briefing.html#res-api', store: 'it-briefing.html#res-store' },
  });
  assert.match(result.html, /<script id="archify-resource-ref-script">[\s\S]*?In der Ressourcenliste ansehen[\s\S]*?<\/script>\n<\/body>/);
  const script = result.html.match(/<script id="archify-resource-ref-script">([\s\S]*?)<\/script>/)[1];
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(|fetch\(|XMLHttpRequest/.test(script));

  const refsOnly = baseSpec();
  refsOnly.components[0].resourceRef = 'list.html';
  const onlyRefs = run(refsOnly);
  assert.equal(onlyRefs.status, 0, onlyRefs.stderr);
  assert.ok(!onlyRefs.html.includes('class="archify-viewer-link"'), 'no toolbar link without meta.viewer.links');
  assert.ok(onlyRefs.html.includes('id="archify-resource-refs"'));
});

test('applyTemplate rejects unsafe references even when schema validation was skipped', () => {
  const args = { title: 'T', subtitle: '', svg: '<svg viewBox="0 0 10 10"></svg>', cards: '' };
  for (const href of ['https://example.com', '../x.html', 'a/b.html', 'javascript:x']) {
    assert.throws(() => applyTemplate(template, { ...args, viewerOptions: { links: [{ label: 'x', href }] } }), /sibling file name/);
    assert.throws(() => applyTemplate(template, { ...args, resourceRefs: { nodes: { a: href } } }), /sibling file name/);
  }
  const custom = template.replace(/^[ \t]*<!-- ARCHIFY:VIEWER_LINKS_SLOT -->[ \t]*\r?\n/m, '');
  assert.throws(() => applyTemplate(custom, { ...args, viewerOptions: { links: [{ label: 'x', href: 'x.html' }] } }), /VIEWER_LINKS_SLOT/);
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

async function loadArtifact(browser, url, width = 1440, height = 900) {
  const sessionId = await browser.sessionPromise;
  await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  // A hash-only change does not fire a load event; reset through a blank page.
  const blank = browser.cdp.waitFor('Page.loadEventFired', sessionId);
  await browser.cdp.send('Page.navigate', { url: 'about:blank' }, sessionId);
  await blank;
  const loaded = browser.cdp.waitFor('Page.loadEventFired', sessionId);
  const navigation = await browser.cdp.send('Page.navigate', { url }, sessionId);
  if (navigation.errorText) throw new Error(`Chrome navigation failed: ${navigation.errorText}`);
  await loaded;
  await evaluate(browser, sessionId, settle, true);
  return sessionId;
}

async function press(browser, sessionId, key, code, keyCode) {
  for (const type of ['keyDown', 'keyUp']) {
    await browser.cdp.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode }, sessionId);
  }
  await evaluate(browser, sessionId, settle, true);
}

const toolbarParity = `(function () {
  var link = document.querySelector('.toolbar a.archify-viewer-link');
  var present = document.getElementById('btn-present');
  var a = getComputedStyle(link);
  var b = getComputedStyle(present);
  var props = ['backgroundColor', 'color', 'borderTopColor', 'borderTopWidth', 'borderTopLeftRadius', 'paddingTop',
    'paddingLeft', 'fontFamily', 'fontSize', 'fontWeight', 'minHeight', 'height', 'boxShadow', 'display', 'alignItems'];
  var range = document.createRange();
  range.selectNodeContents(document.querySelector('.header h1'));
  return {
    differences: props.filter(function (p) { return a[p] !== b[p]; }),
    underline: a.textDecorationLine,
    titleRight: range.getBoundingClientRect().right,
    toolbarLeft: document.querySelector('.toolbar').getBoundingClientRect().left
  };
})()`;

const referenceState = `(function () {
  var wrap = document.querySelector('.archify-resource-ref-wrap');
  var link = wrap && wrap.querySelector('a');
  return {
    chipHidden: document.getElementById('focus-chip').hidden,
    shown: !!wrap && !wrap.hidden && wrap.getBoundingClientRect().height > 0,
    href: link ? link.getAttribute('href') : null,
    text: link ? link.textContent : null
  };
})()`;

test('the toolbar link looks and tabs like the other toolbar controls', {
  skip: chromePath ? false : 'Set ARCHIFY_CHROME to run the real browser viewer-link checks.',
}, async () => {
  const browser = new ChromeVisualBrowser(chromePath);
  try {
    const result = run(featureSpec());
    assert.equal(result.status, 0, result.stderr);
    const url = pathToFileURL(result.output).href;
    for (const [width, preset] of [[1440, null], [1100, null], [1440, 'editorial'], [1440, 'blueprint']]) {
      const sessionId = await loadArtifact(browser, url, width);
      if (preset) {
        await evaluate(browser, sessionId, `document.documentElement.setAttribute('data-preset', '${preset}')`);
        await evaluate(browser, sessionId, settle, true);
      }
      const parity = await evaluate(browser, sessionId, toolbarParity);
      assert.deepEqual(parity.differences, [], `link matches Present at ${width} ${preset || 'classic'}`);
      assert.equal(parity.underline, 'none');
      assert.ok(parity.titleRight <= parity.toolbarLeft, `title stays clear of the toolbar at ${width}`);
    }

    const sessionId = await loadArtifact(browser, url);
    const order = [];
    for (let index = 0; index < 8; index += 1) {
      await press(browser, sessionId, 'Tab', 'Tab', 9);
      const focused = await evaluate(browser, sessionId, `(function () { var e = document.activeElement; return { id: e.id || e.className, outline: getComputedStyle(e).outlineStyle }; })()`);
      order.push(focused.id);
      if (focused.id === 'archify-viewer-link') {
        assert.equal(focused.outline, 'solid', 'visible focus ring');
        break;
      }
    }
    assert.equal(order.at(-1), 'archify-viewer-link', `link is reachable by Tab (${order.join(' > ')})`);
    assert.ok(order.indexOf('archify-viewer-link') < order.length && !order.includes('btn-present'), 'link comes before Present');
  } finally {
    await browser.close();
  }
});

test('a node with a resource reference shows the link in its popover, only for that node', {
  skip: chromePath ? false : 'Set ARCHIFY_CHROME to run the real browser viewer-link checks.',
}, async () => {
  const browser = new ChromeVisualBrowser(chromePath);
  try {
    const result = run(featureSpec());
    assert.equal(result.status, 0, result.stderr);
    const url = pathToFileURL(result.output).href;

    let sessionId = await loadArtifact(browser, `${url}#focus=api`);
    let state = await evaluate(browser, sessionId, referenceState);
    assert.equal(state.chipHidden, false, '#focus deep link opens the popover');
    assert.equal(state.shown, true);
    assert.equal(state.href, 'it-briefing.html#res-api');
    assert.equal(state.text, 'In der Ressourcenliste ansehen');

    sessionId = await loadArtifact(browser, `${url}#focus=client`);
    state = await evaluate(browser, sessionId, referenceState);
    assert.equal(state.chipHidden, false);
    assert.equal(state.shown, false, 'no link for a node without reference');

    sessionId = await loadArtifact(browser, `${url}#focus=missing`);
    state = await evaluate(browser, sessionId, referenceState);
    assert.equal(state.chipHidden, true, 'unknown ids are ignored');
    assert.equal(state.shown, false);

    sessionId = await loadArtifact(browser, `${url}#relation=write`);
    state = await evaluate(browser, sessionId, referenceState);
    assert.equal(state.chipHidden, false, 'relationship popover is open');
    assert.equal(state.shown, false, 'a pinned relationship does not show its source node reference');

    sessionId = await loadArtifact(browser, `${url}#focus=store`);
    state = await evaluate(browser, sessionId, referenceState);
    assert.equal(state.href, 'it-briefing.html#res-store');
    await press(browser, sessionId, 'Escape', 'Escape', 27);
    state = await evaluate(browser, sessionId, referenceState);
    assert.equal(state.chipHidden, true);
    assert.equal(state.shown, false, 'closing hides the link');
  } finally {
    await browser.close();
  }
});
