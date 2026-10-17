// TaknaPay.in loading screen: plays the brand animation while a page (or the checkout order) loads.
// Auto-hides after the page has loaded. On pages that load data themselves, add data-manual to the
// <script> tag and call GWLoader.hide() once the data is ready. GWLoader.show() can be used any time.
(function () {
  var MIN_MS = 1200, MAX_MS = 9000, shownAt = Date.now(), el = null, hidden = false;
  var me = document.currentScript, manual = !!(me && me.hasAttribute('data-manual'));
  // Safari / iPhone cannot play WebM with transparency -> use the white-background MP4 there
  var ua = navigator.userAgent || '';
  var useMp4 = /iPad|iPhone|iPod/.test(ua) || (/Safari/.test(ua) && !/Chrome|Chromium|Android|Edg|OPR/.test(ua));
  var SRC = useMp4 ? '/assets/loader.mp4' : '/assets/loader.webm';
  var css = '#gw-loader{position:fixed;inset:0;z-index:2147483647;background:#fff;display:flex;align-items:center;justify-content:center;transition:opacity .35s ease;opacity:1}' +
    '#gw-loader.out{opacity:0;pointer-events:none}' +
    '#gw-loader video,#gw-loader img{width:min(380px,72vw);height:auto;display:block}' +
    '#gw-loader img{animation:gwp 1.2s ease-in-out infinite alternate}@keyframes gwp{to{opacity:.55}}';
  function build() {
    if (el) return;
    var st = document.createElement('style'); st.textContent = css;
    el = document.createElement('div'); el.id = 'gw-loader'; el.setAttribute('role', 'status'); el.setAttribute('aria-label', 'Loading');
    var v = document.createElement('video');
    v.muted = true; v.defaultMuted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.preload = 'auto'; v.poster = '/assets/logo.png';
    v.src = SRC;
    v.onerror = function () { if (!el) return; var i = document.createElement('img'); i.src = '/assets/logo.png'; i.alt = 'TaknaPay.in'; if (v.parentNode) el.replaceChild(i, v); };
    el.appendChild(v);
    (document.head || document.documentElement).appendChild(st);
    (document.body || document.documentElement).appendChild(el);
    var p = v.play && v.play(); if (p && p.catch) p.catch(function () {});
  }
  function show() {
    hidden = false; shownAt = Date.now();
    if (!el) { build(); } else { el.classList.remove('out'); }
    clearTimeout(show.t); show.t = setTimeout(hide, MAX_MS);
  }
  function hide() {
    if (hidden || !el) return;
    var wait = Math.max(0, MIN_MS - (Date.now() - shownAt));
    setTimeout(function () { hidden = true; if (el) el.classList.add('out'); }, wait);
  }
  // small in-page animation (replaces spinners): any <video data-gwv> gets the right source
  function attach() {
    var list = document.querySelectorAll('video[data-gwv]');
    for (var i = 0; i < list.length; i++) {
      var v = list[i]; if (v.getAttribute('src')) continue;
      v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true; v.src = SRC;
      var p = v.play && v.play(); if (p && p.catch) p.catch(function () {});
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach); else attach();
  window.GWLoader = { show: show, hide: hide, attach: attach };
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
  if (!manual) {
    if (document.readyState === 'complete') hide(); else window.addEventListener('load', hide);
  }
})();
