// Toggle Color Theme - ページ内スクリプト (v27 / パリティ管理版)
//
// 原理: html に invert(1) hue-rotate(180deg) を1回適用してページ全体を補色化する。
//        その上で各要素に「必要な反転回数の偶奇」を保証する。
//          - 画像・動画・canvas・SVG・背景画像 … 偶数回 → 元の色（保護）
//          - テキスト・テーマ背景 … 奇数回 → 補色（テーマ反転）
//        祖先に補正 filter が乗ると子が奇数/偶数を逆転するため、
//        祖先の状態を見てから付与する（入れ子反転の防止）。
//
// 背景画像を持つ「子を持つ要素」は、可能なら擬似要素レイヤー
// (::before に背景を移して擬似側だけ補正) にすることで、
// 要素自身へ filter を付けずに済み、子孫の偶奇もレイアウトも壊れない。
(() => {
  'use strict';
  const VERSION = 27;
  if (window.__tct && window.__tct.version === VERSION) return; // 二重読込防止
  if (window.__tct) { try { window.__tct.disable(); } catch (e) {} }

  const CLS = '__toggle_color_theme_active';   // html に付与（Filter.css と連動）
  const ON = 'data-tct-on';                    // 有効フラグ（html・Filter.css のキーにも使用）
  // マーカーは data 属性で持つ（サイト側 JS が className を書き換えても消えないように）
  const MARK = 'data-tct-f';                   // 拡張が counter-filter を適用した要素
  const MARK_PSEUDO = 'data-tct-pseudo';       // 擬似要素を補正する要素
  const MARK_LAYER = 'data-tct-layer';         // 背景を擬似要素へ移した要素 ("before"|"after")
  const SHADOW_STYLE_ID = '__tct_shadow_css';
  const LEGACY = ['__preserve-img', '__preserve-iframe', '__has-bg-img'];
  const MEDIA_SEL = 'img, video, canvas, svg, object, embed, iframe, input[type="image"]';
  const INVERSE = 'invert(1) hue-rotate(180deg)';
  const SKIP_TAGS = ['STYLE', 'SCRIPT', 'LINK', 'META', 'TITLE', 'BASE', 'TEMPLATE', 'NOSCRIPT'];
  const ATTR_WATCH = ['style', 'class', 'src', 'srcset', 'poster', 'data-src', 'data-bg', 'data-lazy-src', 'content'];

  let mo = null, hookInstalled = false, origAttachShadow = null;
  let flushTimer = null, fullTimer = null, periodicTimer = null;
  let settleTimers = [];
  let running = false;
  let listeners = [];
  const dirty = new Set();
  const shadows = []; // {host, root} (closed shadow root 対応)

  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  const hasMark = (el, name) => !!(el && el.hasAttribute && el.hasAttribute(name));
  const setMark = (el, name, value) => { try { if (value === null) el.removeAttribute(name); else el.setAttribute(name, value === undefined ? '1' : value); } catch (e) {} };
  const parentOf = el => {
    const root = (el.getRootNode && el.getRootNode()) || null;
    return el.parentElement || (root && root.host) || null;
  };

  // ---- 判定ヘルパ ----
  const readInlineFilter = el => {
    try {
      const s = el.style;
      if (!s) return '';
      if (typeof s.getPropertyValue === 'function') return norm(s.getPropertyValue('filter')) || norm(s.getPropertyValue('-webkit-filter'));
      return norm(s.filter); // style が通常の CSSStyleDeclaration でない要素への対策
    } catch (e) { return ''; }
  };
  const hasOurFilter = el => {
    if (!el) return false;
    if (hasMark(el, MARK)) return true;
    const f = readInlineFilter(el);
    if (f.includes('invert(1)')) return true;
    if (el.classList) for (const c of LEGACY) if (el.classList.contains(c)) return true;
    return false;
  };
  // html に1回適用済みか（CSS の実測値で判定。CSS 未適用時のズレを防ぐ）
  const htmlParity = () => {
    try { if (getComputedStyle(document.documentElement).filter.includes('invert(1)')) return 1; } catch (e) {}
    return 0;
  };
  // html(1回) 〜 el(自身) までの拡張フィルタ数
  const chainParity = el => {
    let n = htmlParity();
    for (let x = el; x && x !== document.documentElement; x = parentOf(x)) if (hasOurFilter(x)) n++;
    return n;
  };
  const isMedia = el => { try { return el.matches(MEDIA_SEL); } catch (e) { return false; } };
  const bgUrl = el => {
    try {
      const v = getComputedStyle(el).backgroundImage;
      return !!v && v !== 'none' && v.includes('url(');
    } catch (e) { return false; }
  };
  const pseudoHasImage = (el, p) => {
    try {
      const cs = getComputedStyle(el, p);
      return (cs.backgroundImage && cs.backgroundImage.includes('url(')) || (cs.content && cs.content.includes('url('));
    } catch (e) { return false; }
  };
  const pseudoFree = (el, p) => {
    try {
      const cs = getComputedStyle(el, p);
      const c = norm(cs.content);
      const free = !c || c === 'none' || c === 'normal' || c === '""' || c === "''";
      return free && !(cs.backgroundImage && cs.backgroundImage.includes('url('));
    } catch (e) { return false; }
  };
  const hasText = el => { for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true; return false; };
  // position:relative を足す変更リスク判定（原点が変わらない/影響が無ければ安全）
  const absShiftRisk = el => {
    try {
      const cs = getComputedStyle(el);
      if (cs.position !== 'static') return false;   // position を変更しない
      if ((parseFloat(cs.marginTop) || 0) === 0 && (parseFloat(cs.marginLeft) || 0) === 0) return false; // 原点同一
      const list = el.querySelectorAll('*');
      for (let i = 0; i < list.length; i++) {
        const c = getComputedStyle(list[i]);
        if (c.position !== 'absolute') continue;    // fixed は position:relative で影響を受けない
        let anchored = false;
        for (let p = list[i].parentElement; p && p !== el; p = p.parentElement) {
          if (getComputedStyle(p).position !== 'static') { anchored = true; break; }
        }
        if (!anchored) return true;                 // ICB 基準の絶対配置 → 変動リスク
      }
    } catch (e) {}
    return false;
  };

  // ---- filter の付与 / 解除 ----
  const applyFilter = el => {
    if (el.__tct_orig === undefined) {
      let v = '', p = '';
      try { v = el.style.getPropertyValue('filter'); p = el.style.getPropertyPriority('filter'); } catch (e) {}
      el.__tct_orig = (v && !norm(v).includes('invert(1)')) ? { v, p } : null;
    }
    try {
      el.style.setProperty('filter', INVERSE, 'important');
      el.style.setProperty('-webkit-filter', INVERSE, 'important');
    } catch (e) {}
    setMark(el, MARK);
    for (const c of LEGACY) el.classList.remove(c);
  };
  const removeFilter = el => {
    try { el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); } catch (e) {}
    const orig = el.__tct_orig;
    if (orig && orig.v) { try { el.style.setProperty('filter', orig.v, orig.p || ''); } catch (e) {} }
    el.__tct_orig = undefined;
    setMark(el, MARK, null);
    for (const c of LEGACY) el.classList.remove(c);
  };

  // ---- 背景画像の擬似要素レイヤー（子を持つ要素用・子孫に影響しない） ----
  const layerOK = el => {
    if (isMedia(el)) return false;                     // メディアは自身の filter で保護済み
    if (el.children.length === 0 && !hasText(el)) return false; // 葉は素直に自身へ
    try {
      const cs = getComputedStyle(el);
      const disp = cs.display;
      if (disp === 'none' || disp === 'inline' || disp === 'contents') return false;
      // 適用済みレイヤーは position の確認だけで判定を再利用（毎回の全孫走査を避ける）
      if (hasMark(el, MARK_LAYER)) return cs.position !== 'static';
      if (!(pseudoFree(el, '::before') || pseudoFree(el, '::after'))) return false;
      return !absShiftRisk(el);                       // static なら position:relative を足す（リスク判定）
    } catch (e) {}
    return false;
  };

  // ---- 擬似要素の画像補正 ----
  const reconcilePseudo = (el, parity) => {
    let need = false;
    if (parity === 1) { // 元のまま（偶数になっていない）時だけ擬似側に1回重ねる
      try { need = pseudoHasImage(el, '::before') || pseudoHasImage(el, '::after'); } catch (e) {}
    }
    if (need) setMark(el, MARK_PSEUDO);
    else if (hasMark(el, MARK_PSEUDO)) setMark(el, MARK_PSEUDO, null);
  };

  // ---- 中核: 要素とその子孫の偶奇を整合させる ----
  const reconcile = (el, parentParity) => {
    if (!el || el.nodeType !== 1 || SKIP_TAGS.indexOf(el.tagName) >= 0) return;
    if (el === document.documentElement) { for (const c of el.children) reconcile(c, chainParity(el)); return; }

    // 注意: レイヤー適用中は自分の CSS で background-image:none になっているため、
    // getComputedStyle では bg が「無かった」ように見える。そこでレイヤーの
    // マーカーがある場合は bg ありと信任し、自己誘発の剥がれ(振動)を防ぐ。
    const hasBg = bgUrl(el) || hasMark(el, MARK_LAYER);
    // 背景画像を持つ子孫あり要素 → 擬似レイヤーを優先（自身には filter を付けない）
    let asLayer = false;
    if (hasBg && layerOK(el)) {
      // position:relative は Filter.css / Shadow 用スタイルが !important で適用する
      // (サイトがインライン style を書き換えても剥がれないようにするため)
      if (!hasMark(el, MARK_LAYER)) setMark(el, MARK_LAYER, pseudoFree(el, '::before') ? 'before' : 'after');
      asLayer = true;
    } else if (hasMark(el, MARK_LAYER)) {
      setMark(el, MARK_LAYER, null);
    }

    // 必要な偶奇 (0=偶数=保護対象 / 1=奇数=テーマ反転)
    const want = (asLayer ? false : (isMedia(el) || hasBg)) ? 0 : 1;
    const shouldFilter = parentParity !== want;
    if (shouldFilter && !hasOurFilter(el)) applyFilter(el);
    else if (!shouldFilter && hasOurFilter(el)) removeFilter(el);
    const cur = want;

    reconcilePseudo(el, cur);

    const kids = el.children;
    for (let i = 0; i < kids.length; i++) reconcile(kids[i], cur);
    if (el.shadowRoot) reconcileShadow(el.shadowRoot, cur);
  };

  // ---- Shadow DOM ----
  const ensureShadowStyle = sr => {
    try {
      if (sr.getElementById && sr.getElementById(SHADOW_STYLE_ID)) return;
      if (sr.querySelector && sr.querySelector('style#' + SHADOW_STYLE_ID)) return;
      const st = document.createElement('style');
      st.id = SHADOW_STYLE_ID;
      const layerRule = sel =>
        sel + '{background-image:none !important;isolation:isolate !important;position:relative !important;}';
      st.textContent =
        '[' + MARK + ']{filter:' + INVERSE + ' !important;-webkit-filter:' + INVERSE + ' !important;}' +
        '[' + MARK_PSEUDO + ']::before,[' + MARK_PSEUDO + ']::after{filter:' + INVERSE + ' !important;-webkit-filter:' + INVERSE + ' !important;}' +
        layerRule('[' + MARK_LAYER + ']') +
        '[' + MARK_LAYER + '="before"]::before,[' + MARK_LAYER + '="after"]::after{' +
        'content:\'\' !important;position:absolute !important;inset:0 !important;z-index:-1 !important;pointer-events:none !important;' +
        'background-image:inherit !important;background-size:inherit !important;background-position:inherit !important;' +
        'background-position-x:inherit !important;background-position-y:inherit !important;background-repeat:inherit !important;' +
        'background-origin:inherit !important;background-clip:inherit !important;background-attachment:inherit !important;' +
        'background-blend-mode:inherit !important;' +
        'filter:' + INVERSE + ' !important;-webkit-filter:' + INVERSE + ' !important;}';
      sr.appendChild(st);
    } catch (e) {}
  };
  const reconcileShadow = (sr, parity) => {
    ensureShadowStyle(sr);
    observeShadow(sr);
    const kids = sr.children;
    for (let i = 0; i < kids.length; i++) reconcile(kids[i], parity);
  };
  const installHook = () => {
    if (hookInstalled) return;
    origAttachShadow = Element.prototype.attachShadow;
    hookInstalled = true;
    const orig = origAttachShadow;
    Element.prototype.attachShadow = function () {
      const sr = orig.apply(this, arguments);
      try {
        shadows.push({ host: this, root: sr });
        scheduleFull(60);
      } catch (e) {}
      return sr;
    };
  };
  const uninstallHook = () => {
    if (hookInstalled && origAttachShadow) Element.prototype.attachShadow = origAttachShadow;
    hookInstalled = false; origAttachShadow = null;
  };

  // ---- 全走査 / 差分走査 ----
  const reconcileAll = () => {
    if (!running) return;
    const html = document.documentElement;
    // サイト側 JS にフラグを消されていた場合は付け直す
    if (!hasMark(html, ON)) setMark(html, ON);
    if (!html.classList.contains(CLS)) html.classList.add(CLS);
    for (const c of html.children) reconcile(c, chainParity(html));
    for (const s of shadows) {
      try { if (s.root) reconcileShadow(s.root, chainParity(s.host)); } catch (e) {}
    }
  };
  const flush = () => {
    const list = Array.from(dirty);
    dirty.clear();
    if (list.some(el => el === document.documentElement)) { try { reconcileAll(); } catch (e) {} return; }
    for (const el of list) {
      if (!el || !el.isConnected || el === document.documentElement) continue;
      const p = parentOf(el);
      reconcile(el, p ? chainParity(p) : (hasMark(document.documentElement, ON) ? 1 : 0));
    }
  };

  // ---- スケジューリング ----
  const scheduleFlush = delay => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; try { flush(); } catch (e) {} }, delay || 200);
  };
  const scheduleFull = delay => {
    if (fullTimer) return;
    fullTimer = setTimeout(() => { fullTimer = null; try { reconcileAll(); } catch (e) {} }, delay || 350);
  };

  // ---- 監視 ----
  const observedShadows = new Set();
  const observerOpts = {
    childList: true, subtree: true, attributes: true, attributeFilter: ATTR_WATCH
  };
  const observeShadow = sr => {
    if (!mo || observedShadows.has(sr)) return;
    try { mo.observe(sr, observerOpts); observedShadows.add(sr); } catch (e) {}
  };
  const installObserver = () => {
    if (mo) return;
    try {
      mo = new MutationObserver(muts => {
        for (const m of muts) {
          if (m.type === 'childList') {
            let needFull = false;
            for (const n of m.addedNodes) {
              if (n.nodeType !== 1) continue;
              dirty.add(n);
              // スタイルシートの追加は全要素の背景に影響するため全体再走査
              if (n.tagName === 'STYLE' || n.tagName === 'LINK') needFull = true;
            }
            if (needFull) scheduleFull(200); else scheduleFlush(200);
          } else if (m.type === 'attributes') {
            dirty.add(m.target);
            scheduleFlush(250);
          }
        }
      });
      mo.observe(document.documentElement, observerOpts);
    } catch (e) { mo = null; }
  };
  const onShow = () => scheduleFull(100);
  // <link>/<style> の読み込み完了を捉えて、その直後に再走査する
  const onAssetLoad = ev => {
    const t = ev && ev.target;
    if (t && (t.tagName === 'LINK' || t.tagName === 'STYLE')) scheduleFull(200);
  };
  const installListeners = () => {
    if (listeners.length) return;
    for (const ev of ['pageshow', 'load']) {
      const h = onShow;
      window.addEventListener(ev, h);
      listeners.push([ev, h]);
    }
    window.addEventListener('load', onAssetLoad, true);
    listeners.push(['load', onAssetLoad, true]);
  };
  const removeListeners = () => {
    for (const [ev, h, cap] of listeners) try { window.removeEventListener(ev, h, cap); } catch (e) {}
    listeners = [];
  };
  const startPeriodic = () => {
    stopPeriodic();
    // 読み込み直後はサイト側のスタイルが後から入ることが多いため短間隔、
    // その後は負荷を抑えて長間隔に切り替える
    let cycles = 0;
    const tick = () => {
      periodicTimer = setTimeout(() => {
        periodicTimer = null;
        try { reconcileAll(); } catch (e) {}
        cycles++;
        tick();
      }, cycles < 4 ? 5000 : 15000);
    };
    tick();
  };
  const stopPeriodic = () => { if (periodicTimer) { clearTimeout(periodicTimer); periodicTimer = null; } };

  // ---- 診断ヘルパ (開発用): 画像が常に偶数・通常要素が常に奇数であることを検査 ----
  const audit = () => {
    const res = { version: VERSION, checked: 0, mediaBad: [], normalBad: 0, pseudoBad: 0, shadowRoots: shadows.length };
    const visit = (el, parentParity) => {
      if (!el || el.nodeType !== 1 || SKIP_TAGS.indexOf(el.tagName) >= 0) return;
      const isDoc = el === document.documentElement;
      // 実際に適用されている filter 数 = 親までの数 + 自分
      const parity = isDoc
        ? (htmlParity() + (hasOurFilter(el) ? 1 : 0))
        : parentParity + (hasOurFilter(el) ? 1 : 0);
      const layer = hasMark(el, MARK_LAYER);
      // 保護対象(偶数が必要) : 画像・メディア・背景画像(ただし擬似レイヤー移管分を除く)
      const wantEven = !isDoc && !layer && (isMedia(el) || bgUrl(el));
      const ok = wantEven ? (parity % 2 === 0) : (parity % 2 === 1);
      res.checked++;
      if (!ok) {
        if (wantEven) { if (res.mediaBad.length < 8) res.mediaBad.push(el.tagName.toLowerCase() + '#' + String(el.id || '') + '.' + String(el.className).slice(0, 40)); }
        else res.normalBad++;
      }
      if (parity === 1 && !hasMark(el, MARK_PSEUDO)) {
        try { if (pseudoHasImage(el, '::before') || pseudoHasImage(el, '::after')) res.pseudoBad++; } catch (e) {}
      }
      const kids = el.children;
      for (let i = 0; i < kids.length; i++) visit(kids[i], parity);
      if (el.shadowRoot) { const sc = el.shadowRoot.children; for (let i = 0; i < sc.length; i++) visit(sc[i], parity); }
    };
    visit(document.documentElement, 0);
    res.ok = res.normalBad === 0 && res.mediaBad.length === 0 && res.pseudoBad === 0;
    return res;
  };

  // ---- 全解除 ----
  const clearTree = root => {
    let list = [];
    try { list = root.querySelectorAll('[' + MARK + '],[' + MARK_PSEUDO + '],[' + MARK_LAYER + '],' + LEGACY.map(c => '.' + c).join(',')); } catch (e) {}
    for (const el of list) {
      if (hasOurFilter(el)) removeFilter(el);
      setMark(el, MARK_PSEUDO, null);
      setMark(el, MARK_LAYER, null);
      for (const c of LEGACY) el.classList.remove(c);
    }
    try { root.querySelectorAll('style#' + SHADOW_STYLE_ID).forEach(s => s.remove()); } catch (e) {}
  };

  // ---- 公開 API ----
  function enable() {
    const html = document.documentElement;
    running = true;
    settleTimers.forEach(t => { try { clearTimeout(t); } catch (e) {} });
    settleTimers = [];
    setMark(html, ON);
    html.classList.add(CLS);
    delete html.dataset.__tct_enabled; // 旧バージョンのデータ属性
    // 旧バージョンの痕跡(クラス+インライン filter)を掃除
    try {
      document.querySelectorAll(LEGACY.map(c => '.' + c).join(',')).forEach(el => {
        if (hasOurFilter(el)) removeFilter(el);
        for (const c of LEGACY) el.classList.remove(c);
      });
    } catch (e) {}
    installHook();
    installObserver();
    installListeners();
    startPeriodic();
    try { reconcileAll(); } catch (e) {}
    // サイト側 CSS が遅れて読み込まれた背景画像などを拾うため、少し置いて再走査
    settleTimers = [800, 3000, 7000, 12000].map(d => setTimeout(() => {
      try { reconcileAll(); } catch (e) {}
    }, d));
    try { window.__tctAudit = audit; } catch (e) {}
  }
  function disable() {
    const html = document.documentElement;
    running = false;
    setMark(html, ON, null);
    html.classList.remove(CLS);
    delete html.dataset.__tct_enabled;
    if (mo) { try { mo.disconnect(); } catch (e) {} mo = null; }
    observedShadows.clear();
    uninstallHook();
    stopPeriodic();
    removeListeners();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (fullTimer) { clearTimeout(fullTimer); fullTimer = null; }
    settleTimers.forEach(t => { try { clearTimeout(t); } catch (e) {} });
    settleTimers = [];
    dirty.clear();
    try { clearTree(document); } catch (e) {}
    for (const s of shadows) try { if (s.root) clearTree(s.root); } catch (e) {}
    shadows.length = 0;
    try { delete window.__tctAudit; } catch (e) {}
  }

  window.__tct = { version: VERSION, enable, disable, audit, run: reconcileAll };
})();
