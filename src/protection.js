// Injected into the panel shell. Two very different things live here, and it
// matters which is which:
//
//   Watermarking  — works. It cannot stop a screenshot (nothing in a browser
//                   can; the OS takes those) but it makes any capture carry the
//                   viewer's identity, which is what makes leaking traceable.
//
//   Input blocking — friction only. Copy, selection, right-click and the
//                   devtools shortcuts are all blockable, and all bypassable by
//                   the browser's own menus, view-source, or disabling JS. It
//                   raises the effort of a casual copy-paste. It does not stop
//                   anyone who means it. The controls that actually hold are on
//                   the server: see policy.js and leak-guard.js.

function jsString(value) {
  // < keeps a stray "</script>" inside a name from closing the tag early.
  return JSON.stringify(String(value ?? '')).replace(/</g, '\\u003c');
}

export function protectionScript({ user, panel, watermark, friction, brand, opacity = 0.17 }) {
  if (!watermark && !friction) return '';

  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

  return `<script>(function(){
"use strict";
var BRAND = ${jsString(brand)};
var WHO = ${jsString(user.email)};
var WHEN = ${jsString(stamp + ' UTC')};
var PANEL = ${jsString(panel.label)};
var WATERMARK = ${watermark ? 'true' : 'false'};
var FRICTION = ${friction ? 'true' : 'false'};
var O = ${Number(opacity).toFixed(3)};
var ID = 'kagw-wm';

/* ── watermark ──────────────────────────────────────────────────────── */

function tile() {
  // One SVG tile repeated as a background: crisp at any zoom, costs nothing to
  // scroll, and survives the app re-rendering its own DOM.
  // Tile is deliberately small: a cropped screenshot of a few rows still has to
  // contain one whole mark, identity line included. The email is the forensic
  // payload, so it is sized and weighted to survive the downscaling and JPEG
  // compression of a screenshot forwarded through a messaging app — the brand
  // being legible is of no use if the name attached to it is not.
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="168">' +
    '<g transform="rotate(-28 150 84)" text-anchor="middle" ' +
    'font-family="-apple-system,Segoe UI,Roboto,Helvetica,sans-serif">' +
    '<text x="50%" y="44%" font-size="20" font-weight="600" ' +
    'fill="rgba(120,120,120,' + O.toFixed(3) + ')">' + esc(BRAND) + '</text>' +
    /* The identity line carries a little more weight than the rest: it is the
       part that has to survive a screenshot being downscaled and recompressed. */
    '<text x="50%" y="60%" font-size="13" font-weight="600" ' +
    'fill="rgba(120,120,120,' + (O * 1.25).toFixed(3) + ')">' + esc(WHO) + '</text>' +
    '<text x="50%" y="72%" font-size="10.5" ' +
    'fill="rgba(120,120,120,' + (O * 0.9).toFixed(3) + ')">' + esc(WHEN) + ' &#183; ' + esc(PANEL) + '</text>' +
    '</g></svg>';
  return 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
}

function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

var CSS = [
  '#' + ID + '{position:fixed;inset:0;z-index:2147483647;pointer-events:none;',
  'background-repeat:repeat;background-position:0 0;mix-blend-mode:multiply;}',
  '@media print{#' + ID + '{display:block !important;}}',
  FRICTION ? [
    /* Selection off everywhere except inputs, which still have to be typeable. */
    'body,body *{-webkit-user-select:none !important;-moz-user-select:none !important;user-select:none !important;}',
    'input,textarea,[contenteditable="true"]{-webkit-user-select:text !important;user-select:text !important;}',
    'img,a{-webkit-user-drag:none !important;user-drag:none;}',
    /* Printing and print-to-PDF would otherwise be a clean export route. */
    '@media print{html{display:none !important;}}',
  ].join('') : '',
].join('');

function paint() {
  var style = document.getElementById(ID + '-style');
  if (!style) {
    style = document.createElement('style');
    style.id = ID + '-style';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  if (!WATERMARK) return;
  var layer = document.getElementById(ID);
  if (!layer) {
    layer = document.createElement('div');
    layer.id = ID;
    (document.body || document.documentElement).appendChild(layer);
  }
  // Re-asserted every pass: the cheapest tamper is editing this inline style.
  layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
    'background-image:' + tile() + ';background-repeat:repeat;mix-blend-mode:multiply;';
}

/* ── keeping it there ───────────────────────────────────────────────── */
// The panel is a single-page app that rebuilds its own DOM, so the overlay has
// to be re-attached rather than set once. The same loop undoes a casual
// "delete node" in the inspector. It does not survive JavaScript being turned
// off — nothing injected into a page does.

function guard() {
  paint();
  if (window.MutationObserver) {
    new MutationObserver(function () {
      if (!document.getElementById(ID) || !document.getElementById(ID + '-style')) paint();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  setInterval(paint, 2000);
}

if (document.body) guard();
else document.addEventListener('DOMContentLoaded', guard);

/* ── friction ───────────────────────────────────────────────────────── */

if (FRICTION) {
  function stop(event) {
    // Typing in a field still has to work, including paste into a search box.
    var tag = (event.target && event.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (event.target && event.target.isContentEditable)) return;
    event.preventDefault();
    event.stopPropagation();
    return false;
  }

  ['copy', 'cut', 'contextmenu', 'dragstart', 'selectstart'].forEach(function (name) {
    document.addEventListener(name, stop, true);
  });

  document.addEventListener('keydown', function (event) {
    var key = (event.key || '').toLowerCase();
    var mod = event.ctrlKey || event.metaKey;

    // Save, print and view-source are all one-keystroke exports.
    if (mod && !event.shiftKey && ['s', 'p', 'u'].indexOf(key) !== -1) return stop(event);
    // Copy outside a field.
    if (mod && !event.shiftKey && ['c', 'x'].indexOf(key) !== -1) return stop(event);
    // The devtools shortcuts. The browser menu still opens them — this only
    // stops the reflex, which is all a keybinding can do.
    if (key === 'f12') return stop(event);
    if (mod && event.shiftKey && ['i', 'j', 'c', 'e'].indexOf(key) !== -1) return stop(event);
    if (mod && event.altKey && ['i', 'j', 'c'].indexOf(key) !== -1) return stop(event);
    return undefined;
  }, true);
}
})();</script>`;
}
