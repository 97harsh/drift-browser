// JavaScript snippets injected into pages (run in the page's main world via
// webContents.executeJavaScript). Each builder returns a self-contained IIFE.

/** Picture-in-picture on the most prominent <video>. Toggles off if already in PiP. */
const PIP = `(async () => {
  if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return 'exited'; }
  const vids = [...document.querySelectorAll('video')].filter(v => v.readyState > 0 && !v.disablePictureInPicture);
  if (!vids.length) return 'no-video';
  const area = v => { const r = v.getBoundingClientRect(); return r.width * r.height; };
  const playing = vids.filter(v => !v.paused);
  const v = (playing.length ? playing : vids).sort((a, b) => area(b) - area(a))[0];
  await v.requestPictureInPicture();
  return 'entered';
})()`;

/** Is a video playing (used for auto-PiP when switching away). */
const HAS_PLAYING_VIDEO = `[...document.querySelectorAll('video')].some(v => !v.paused && !v.ended && v.readyState > 2 && v.getBoundingClientRect().width > 150)`;

const MEDIA_TOGGLE = `(() => { const m = [...document.querySelectorAll('video,audio')].find(m => !m.paused) || document.querySelector('video,audio');
  if (!m) return null; if (m.paused) { m.play(); return 'playing'; } m.pause(); return 'paused'; })()`;

/**
 * Snapshot a page for an agent: readable text + numbered interactive elements.
 * Elements get a data-drift-id attribute so later click/type calls can find them.
 */
function readPage(maxChars = 20000) {
  return `(() => {
  const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=""],[contenteditable=true],summary';
  document.querySelectorAll('[data-drift-id]').forEach(e => e.removeAttribute('data-drift-id'));
  const els = [...document.querySelectorAll(sel)].filter(visible).slice(0, 400);
  const label = el => (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || el.name || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
  const elements = els.map((el, i) => {
    el.setAttribute('data-drift-id', String(i));
    const r = el.getBoundingClientRect();
    const o = { i, tag: el.tagName.toLowerCase(), text: label(el) };
    if (el.type && el.tagName !== 'BUTTON') o.type = el.type;
    if (el.href) o.href = el.href.slice(0, 200);
    if (r.bottom < 0 || r.top > innerHeight) o.offscreen = true;
    return o;
  });
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n');
  return { url: location.href, title: document.title, scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight,
    viewport: { w: innerWidth, h: innerHeight }, text: text.slice(0, ${Number(maxChars) | 0}), truncated: text.length > ${Number(maxChars) | 0}, elements };
})()`;
}

/** Locate an element by drift id or CSS selector, scroll it into view, return its center. */
function locate(target) {
  return `(() => {
  const t = ${JSON.stringify(target)};
  const el = t.index != null ? document.querySelector('[data-drift-id="' + t.index + '"]') : document.querySelector(t.selector);
  if (!el) return { error: 'element not found — call read_page again to refresh element indexes' };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').slice(0, 60) };
})()`;
}

function jsClick(target) {
  return `(() => { const t = ${JSON.stringify(target)};
  const el = t.index != null ? document.querySelector('[data-drift-id="' + t.index + '"]') : document.querySelector(t.selector);
  if (!el) return false; el.click(); return true; })()`;
}

function focusForTyping(target, clear) {
  return `(() => { const t = ${JSON.stringify(target)};
  const el = t.index != null ? document.querySelector('[data-drift-id="' + t.index + '"]') : document.querySelector(t.selector);
  if (!el) return { error: 'element not found' };
  el.scrollIntoView({ block: 'center' }); el.focus();
  if (${clear ? 'true' : 'false'}) {
    if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    else if (el.isContentEditable) { el.textContent = ''; }
  }
  return { ok: true };
})()`;
}

function scroll(direction, amount) {
  const amt = Number(amount) || 0;
  return `(() => {
  const d = ${JSON.stringify(direction)}; const a = ${amt} || innerHeight * 0.8;
  if (d === 'top') scrollTo(0, 0); else if (d === 'bottom') scrollTo(0, document.documentElement.scrollHeight);
  else scrollBy(0, d === 'up' ? -a : a);
  return { scrollY: Math.round(scrollY), scrollHeight: document.documentElement.scrollHeight };
})()`;
}

function waitFor(selector, timeoutMs) {
  return `new Promise(res => { const t0 = Date.now(); const s = ${JSON.stringify(selector)};
  (function tick(){ if (document.querySelector(s)) return res(true); if (Date.now() - t0 > ${Number(timeoutMs) || 5000}) return res(false); setTimeout(tick, 100); })(); })`;
}

/** Short text describing an element (or the focused one) — used by the purchase guard. */
function describe(target) {
  return `(() => { const t = ${JSON.stringify(target)};
  const el = t.active ? document.activeElement : t.index != null ? document.querySelector('[data-drift-id="' + t.index + '"]') : document.querySelector(t.selector);
  if (!el) return '';
  const f = el.closest('form');
  return [el.innerText, el.value, el.getAttribute('aria-label'), el.title, el.name, el.id, f && f.action].filter(Boolean).join(' | ').replace(/\\s+/g, ' ').slice(0, 300);
})()`;
}

/** Structured product listings. Precise on Amazon; JSON-LD / heuristics elsewhere. */
function extractProducts(limit = 30) {
  return `(() => {
  const L = ${Number(limit) | 0};
  const txt = el => el ? (el.innerText || el.textContent).trim().replace(/\\s+/g, ' ') : null;
  const num = s => { if (!s) return null; const m = String(s).replace(/,/g, '').match(/[\\d.]+/); return m ? parseFloat(m[0]) : null; };
  const abs = h => { try { return new URL(h, location.href).href.split('/ref=')[0]; } catch { return h; } };
  const host = location.hostname;
  const out = { url: location.href, site: host, kind: 'unknown', products: [] };
  if (/(^|\\.)amazon\\./.test(host)) {
    const cards = document.querySelectorAll('[data-component-type="s-search-result"][data-asin]');
    if (cards.length) {
      out.kind = 'amazon-search';
      out.query = new URLSearchParams(location.search).get('k');
      for (const c of [...cards].slice(0, L)) {
        const asin = c.getAttribute('data-asin'); if (!asin) continue;
        const link = c.querySelector('a.a-link-normal[href*="/dp/"], h2 a');
        out.products.push({
          asin,
          title: txt(c.querySelector('h2')) ,
          price: txt(c.querySelector('.a-price:not(.a-text-price) .a-offscreen')),
          listPrice: txt(c.querySelector('.a-price.a-text-price .a-offscreen')),
          rating: num(txt(c.querySelector('[aria-label*="out of 5"], .a-icon-alt'))),
          reviews: num(((c.querySelector('[aria-label$="ratings"], [aria-label$="rating"]') || { getAttribute: () => null }).getAttribute('aria-label'))),
          prime: !!c.querySelector('i.a-icon-prime, [aria-label="Amazon Prime"]'),
          sponsored: /Sponsored/i.test(txt(c.querySelector('.puis-sponsored-label-text, .s-label-popover-default')) || ''),
          delivery: txt(c.querySelector('[data-cy="delivery-recipe"]')),
          url: link ? abs(link.getAttribute('href')) : location.origin + '/dp/' + asin,
        });
      }
      return out;
    }
    const title = document.querySelector('#productTitle');
    if (title) {
      out.kind = 'amazon-product';
      const asin = (document.querySelector('input#ASIN, input[name="ASIN"]') || {}).value || (location.pathname.match(/\\/dp\\/([A-Z0-9]{10})/) || [])[1];
      out.products.push({
        asin, title: txt(title),
        price: txt(document.querySelector('#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, .a-price .a-offscreen')),
        rating: num(txt(document.querySelector('#acrPopover .a-icon-alt'))),
        reviews: num(txt(document.querySelector('#acrCustomerReviewText'))),
        prime: !!document.querySelector('#primeBadge, .a-icon-prime'),
        availability: txt(document.querySelector('#availability')),
        seller: txt(document.querySelector('#sellerProfileTriggerId, #merchantInfoFeature_feature_div .offer-display-feature-text')),
        bullets: [...document.querySelectorAll('#feature-bullets li')].map(txt).filter(Boolean).slice(0, 8),
        url: location.origin + '/dp/' + asin,
      });
      return out;
    }
  }
  // Generic: schema.org Product JSON-LD.
  const walk = (n, acc) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(x => walk(x, acc));
    const t = [].concat(n['@type'] || []); if (t.includes('Product')) acc.push(n); Object.values(n).forEach(v => typeof v === 'object' && walk(v, acc)); };
  const found = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach(s => { try { walk(JSON.parse(s.textContent), found); } catch {} });
  if (found.length) {
    out.kind = 'jsonld';
    out.products = found.slice(0, L).map(p => { const o = [].concat(p.offers || [])[0] || {}; const r = p.aggregateRating || {};
      return { title: p.name, price: o.price ? (o.priceCurrency || '') + ' ' + o.price : null, rating: num(r.ratingValue), reviews: num(r.reviewCount || r.ratingCount), brand: (p.brand && p.brand.name) || p.brand || null, url: abs(p.url || o.url || location.href) }; });
    return out;
  }
  // Heuristic: repeated cards that contain a price.
  const priceRe = /[$€£₹]\\s?\\d[\\d,]*(\\.\\d{2})?/;
  const cands = [...document.querySelectorAll('li, article, [class*="product" i], [class*="item" i]')].filter(el => priceRe.test(el.textContent) && el.querySelector('a[href]') && el.textContent.length < 800);
  const leaf = cands.filter(el => !cands.some(o => o !== el && el.contains(o)));
  out.kind = 'heuristic';
  out.products = leaf.slice(0, L).map(el => { const a = el.querySelector('a[href]'); return { title: txt(el.querySelector('h1,h2,h3,h4,[class*="title" i]')) || txt(a), price: (el.textContent.match(priceRe) || [])[0], url: abs(a.getAttribute('href')) }; });
  return out;
})()`;
}

module.exports = { describe, extractProducts, PIP, HAS_PLAYING_VIDEO, MEDIA_TOGGLE, readPage, locate, jsClick, focusForTyping, scroll, waitFor };
