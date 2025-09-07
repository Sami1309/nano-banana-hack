// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { fal } from '@fal-ai/client';
import fetch, { FormData, Blob } from 'node-fetch';
import { load as loadHTML } from 'cheerio';
import pLimit from 'p-limit';
import robotsParser from 'robots-parser';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// serve static frontend
app.use('/', express.static('web'));

// --- fal.ai setup ---
fal.config({ credentials: process.env.FAL_KEY });

// --- uploads (memory) ---
const upload = multer({ storage: multer.memoryStorage() });

// --- request logging ---
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// --- Programmable Search + Gemini ---
const CSE_API_KEY = process.env.CSE_API_KEY;
const CSE_CX = process.env.CSE_CX;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const USER_AGENT = 'Mozilla/5.0 (compatible; RoomShopBot/1.0)';
const ENABLE_3D = String(process.env.ENABLE_3D || '').toLowerCase() === 'true';

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

function priceBands(budget) {
  const b = Math.max(5, Number(budget || 150));
  return {
    low: { min: Math.max(5, Math.round(b * 0.25)), max: Math.round(b * 0.6) },
    mid: { min: Math.round(b * 0.6), max: Math.round(b * 1.1) },
    high: { min: Math.round(b * 1.1), max: Math.round(b * 1.8) },
  };
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 10000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ac.signal, headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) } });
    return res;
  } finally { clearTimeout(id); }
}

async function robotsAllowed(url) {
  try {
    const u = new URL(url);
    const robotsUrl = `${u.origin}/robots.txt`;
    const r = await fetchWithTimeout(robotsUrl, {}, 4000);
    if (!r.ok) return true;
    const txt = await r.text();
    const robots = robotsParser(robotsUrl, txt);
    return robots.isAllowed(url, USER_AGENT);
  } catch {
    return true;
  }
}

function extractProductFromJSONLD(html, pageUrl) {
  const $ = loadHTML(html);
  const scripts = Array.from($('script[type="application/ld+json"]')).map(s => $(s).contents().text()).filter(Boolean);
  const jsons = [];
  for (const raw of scripts) {
    try { jsons.push(JSON.parse(raw)); } catch {}
  }
  const abs = (u) => {
    try { return new URL(u, pageUrl).toString(); } catch { return u; }
  };
  const flat = [];
  const flatten = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(flatten);
    if (typeof node === 'object') {
      flat.push(node);
      if (node['@graph']) flatten(node['@graph']);
      if (node.mainEntity) flatten(node.mainEntity);
    }
  };
  jsons.forEach(flatten);
  const product = flat.find(n => {
    const t = n['@type'];
    return t && (Array.isArray(t) ? t.includes('Product') : t === 'Product');
  });
  if (!product) return null;
  const offers = Array.isArray(product.offers) ? product.offers[0] : product.offers;
  const price = offers?.price ?? offers?.priceSpecification?.price ?? offers?.lowPrice;
  const priceCurrency = offers?.priceCurrency ?? offers?.priceSpecification?.priceCurrency;
  let images = [];
  if (product.image) {
    if (typeof product.image === 'string') images = [product.image];
    else if (Array.isArray(product.image)) images = product.image.map(i => typeof i === 'string' ? i : i?.url).filter(Boolean);
    else if (typeof product.image === 'object' && product.image.url) images = [product.image.url];
  }
  images = images.map(abs);
  const url = product.url || offers?.url || pageUrl;
  return {
    isProduct: true,
    name: product.name || null,
    description: product.description || null,
    images,
    price: price != null ? Number(price) : null,
    currency: priceCurrency || null,
    url,
  };
}

function extractFallbackMeta(html, pageUrl) {
  const $ = loadHTML(html);
  const pick = (sel) => $(sel).attr('content') || null;
  const name = pick('meta[property="og:title"]') || $('title').text() || null;
  const description = pick('meta[property="og:description"]') || $('meta[name="description"]').attr('content') || null;
  const image = pick('meta[property="og:image"]');
  const abs = (u) => {
    try { return new URL(u, pageUrl).toString(); } catch { return u; }
  };
  const price = pick('meta[property="product:price:amount"]') || pick('meta[itemprop="price"]');
  const currency = pick('meta[property="product:price:currency"]') || pick('meta[itemprop="priceCurrency"]');
  // Weak regex fallback for embedded JSON; try to catch first numeric price
  let priceNum = price != null ? Number(price) : null;
  if (priceNum == null) {
    const body = $.html();
    const m = body && body.match(/\bprice\b\s*[:=]\s*"?(\d{1,5}(?:\.\d{1,2})?)"?/i);
    if (m) {
      const n = Number(m[1]);
      if (!Number.isNaN(n)) priceNum = n;
    }
  }
  return {
    isProduct: false,
    name,
    description,
    images: image ? [abs(image)] : [],
    price: priceNum,
    currency: currency || null,
    url: pageUrl,
  };
}

function prefer(primary, fallback) {
  if (!primary) return fallback;
  return {
    isProduct: true,
    name: primary.name || fallback.name,
    description: primary.description || fallback.description,
    images: (primary.images && primary.images.length ? primary.images : fallback.images) || [],
    price: primary.price ?? fallback.price ?? null,
    currency: primary.currency || fallback.currency || null,
    url: primary.url || fallback.url,
  };
}

function isIkeaProductUrl(u) {
  try {
    const url = new URL(u);
    if (!/ikea\.com$/i.test(url.hostname)) return false;
    // Require product path like /au/en/p/<slug>/...
    return /^\/[a-z]{2}\/en\/p\//i.test(url.pathname);
  } catch { return false; }
}

function isWestElmProductUrl(u) {
  try {
    const url = new URL(u);
    if (!/westelm\.com$/i.test(url.hostname)) return false;
    // West Elm product pages contain /products/
    return url.pathname.toLowerCase().includes('/products/');
  } catch { return false; }
}

function looksLikeCategoryUrl(u) {
  try {
    const { pathname, search } = new URL(u);
    const path = pathname.toLowerCase();
    const q = search.toLowerCase();
    const categoryHints = [
      '/s/', '/search', '/category', '/collections', '/browse', '/catalog', '/list', '/plp', '/shop/all', '/c/', '/dept/'
    ];
    if (categoryHints.some(h => path.includes(h))) return true;
    const queryHints = ['?q=', 'search=', 'k=', 'keyword=', 'keywords=', 'refinements=', 'N=', 'Ns='];
    if (queryHints.some(h => q.includes(h))) return true;
    return false;
  } catch { return false; }
}

async function geminiQueries(idea, budget, opts = {}) {
  const { ikeaOnly = true } = opts;
  const fallback = [
    `${idea} buy online`,
    `${idea} price`,
    `${idea} best budget`,
    `${idea} premium`,
    `${idea} sale`,
    `${idea} product page`,
  ];
  if (!genAI) return fallback;
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `You are generating shopping search queries that land on specific product detail pages.
User request: "${idea}". Budget: ${budget}.
Unifying style: choose one cohesive style direction (e.g., Scandinavian minimal, mid-century warm wood, Japandi neutral) and weave that into the queries so the products mesh together.
${ikeaOnly ? 'Retailer constraint: ONLY generate queries that fit IKEA products and naming.' : ''}
Rules:
- If the request is for a single product type (e.g., "floor lamp"), produce queries tightly focused on that product.
- If the request is a general room improvement (e.g., "make my living room cozy"), include different product categories such as couch/sofa, floor lamp, side table, area rug, wall art, indoor plant, shelving
- Prefer queries that land on specific product pages with prices.
 - Keep them diverse but cohesive (share style/material/finish keywords).
Return ONLY a JSON array of 8-10 query strings.`;
    const resp = await model.generateContent(prompt);
    const text = resp.response.text();
    const jsonText = (text.match(/\[([\s\S]*)\]/) || [])[0] || text;
    const arr = JSON.parse(jsonText);
    return Array.isArray(arr) && arr.length ? arr.map(String) : fallback;
  } catch {
    return fallback;
  }
}

function classifyIntent(idea) {
  const s = (idea || '').toLowerCase();
  const dict = {
    lamp: ['floor lamp','table lamp','lamp','lighting','light'],
    couch: ['sofa','couch','sectional'],
    table: ['coffee table','side table','end table','console table','table'],
    rug: ['rug','area rug','carpet'],
    art: ['wall art','art','poster','print','painting'],
    plant: ['indoor plant','plant','planter'],
    shelf: ['shelf','shelving','bookcase','bookshelf'],
    chair: ['chair','accent chair','armchair','dining chair'],
    desk: ['desk'],
    bed: ['bed','bed frame','headboard'],
    dresser: ['dresser'],
    mirror: ['mirror']
  };
  const hits = [];
  for (const [type, words] of Object.entries(dict)) {
    if (words.some(w => s.includes(w))) hits.push(type);
  }
  const uniq = [...new Set(hits)];
  if (uniq.length === 1) return { specific: uniq[0], general: false };
  return { specific: null, general: true };
}

async function searchProductsWithPSE({ query, limit = 6, sites = [], imageSearch = true, start = 1 }) {
  const params = new URLSearchParams({
    key: CSE_API_KEY,
    cx: CSE_CX,
    q: query,
    num: String(Math.min(limit, 10)),
    safe: 'active',
  });
  if (imageSearch) params.set('searchType', 'image');
  if (start && Number(start) > 1) params.set('start', String(start));
  if (sites.length === 1) {
    params.set('siteSearch', sites[0]);
    params.set('siteSearchFilter', 'i');
  } else if (sites.length > 1) {
    params.set('q', `${query} ${sites.map(s => `site:${s}`).join(' OR ')}`);
  }
  const apiUrl = `https://www.googleapis.com/customsearch/v1?${params.toString()}`;
  const safeParams = new URLSearchParams(params);
  safeParams.delete('key');
  console.log('[CSE] request:', { imageSearch, url: `https://www.googleapis.com/customsearch/v1?${safeParams.toString()}` });
  const apiResp = await fetchWithTimeout(apiUrl);
  if (!apiResp.ok) {
    const t = await apiResp.text();
    throw new Error(`Custom Search API error: ${apiResp.status} ${t}`);
  }
  const data = await apiResp.json();
  console.log('[CSE] query ok:', { query, count: Array.isArray(data.items) ? data.items.length : 0 });
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map(it => ({
    title: it.title,
    imageUrl: imageSearch ? it.link : null,
    pageUrl: imageSearch ? (it.image?.contextLink || it.link) : it.link,
  }));
}

async function hydrateProducts(targets) {
  const limit = pLimit(4);
  const out = [];
  await Promise.all(targets.map(t => limit(async () => {
    if (!t.pageUrl) return;
    try {
      const host = new URL(t.pageUrl).hostname;
      if (/ikea\.com$/i.test(host) && !isIkeaProductUrl(t.pageUrl)) {
        return; // skip non-product ikea URLs
      }
      if (/westelm\.com$/i.test(host) && !isWestElmProductUrl(t.pageUrl)) {
        return; // skip West Elm non-product pages
      }
    } catch {}
    const allowed = await robotsAllowed(t.pageUrl);
    if (!allowed) return;
    try {
      const r = await fetchWithTimeout(t.pageUrl, {}, 8000);
      const ct = r.headers.get('content-type') || '';
      if (!r.ok || !ct.includes('text/html')) return;
      const html = await r.text();
      const product = extractProductFromJSONLD(html, t.pageUrl);
      const fallback = extractFallbackMeta(html, t.pageUrl);
      const merged = prefer(product, fallback);
      // Skip obvious category/listing pages unless we positively detected a Product
      if (!merged.isProduct && looksLikeCategoryUrl(t.pageUrl)) return;
      // Require price if no Product type (to avoid category pages with OG tags only)
      if (!merged.isProduct && merged.price == null) return;
      const productOut = {
        source: new URL(t.pageUrl).hostname,
        title: merged.name || t.title || null,
        description: merged.description || null,
        price: merged.price,
        currency: merged.currency,
        images: merged.images && merged.images.length ? merged.images : (t.imageUrl ? [t.imageUrl] : []),
        url: merged.url || t.pageUrl,
        isProduct: !!merged.isProduct,
      };
      if (!productOut.title || productOut.price == null || !productOut.images?.length) return;
      out.push(productOut);
    } catch {}
  })));
  // de-dupe by url
  const seen = new Set();
  return out.filter(p => {
    if (!p.url) return false;
    if (seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });
}

// POST /api/products { description, budget }
app.post('/api/products', async (req, res) => {
  try {
    if (!CSE_API_KEY || !CSE_CX) throw new Error('Missing CSE_API_KEY or CSE_CX');
    const { description, budget, image, ikeaOnly: ikeaOnlyInput, retailers: retailersInput } = req.body || {};
    const ikeaOnly = ikeaOnlyInput !== false; // default true
    const idea = (description || '').trim();
    if (!idea) return res.status(400).json({ error: 'Missing description' });

    // start with fallback bands from provided budget; may override after hydration
    let bands = priceBands(budget);
    const intent = classifyIntent(idea);
    let queries = await geminiQueries(idea, budget, { ikeaOnly });
    // If general and image mode, ensure multi-category coverage
    if (intent.general && image !== false) {
      const extra = [
        `${idea} modern couch`,
        `${idea} floor lamp`,
        `${idea} side table`,
        `${idea} area rug`,
        `${idea} wall art`,
        `${idea} indoor plant`,
        `${idea} shelving`,
        `${idea} cute decor etsy`
      ];
      const set = new Set(queries.concat(extra));
      queries = Array.from(set).slice(0, 12);
    }
    console.log('[PRODUCTS] request:', { idea, budget, queries: queries.length, imageSearch: image !== false, intent });

    // Retailers: default is IKEA-only; caller can override
    let retailers = Array.isArray(retailersInput) && retailersInput.length
      ? retailersInput
      : (ikeaOnly ? ['ikea.com'] : ['wayfair.com','westelm.com','cb2.com','crateandbarrel.com','ikea.com','article.com','target.com','etsy.com']);

    const allTargets = [];
    const seenTarget = new Set();
    const pushTargets = (arr) => {
      for (const t of arr) {
        const u = t.pageUrl || t.imageUrl;
        if (!u || seenTarget.has(u)) continue;
        seenTarget.add(u);
        allTargets.push(t);
      }
    };
    const initialTasks = queries.map(q => async () => {
      const targets = await searchProductsWithPSE({ query: q, limit: 10, sites: retailers, imageSearch: image !== false, start: 1 });
      pushTargets(targets);
      console.log('[CSE] targets appended:', { q, targets: targets.length });
    });
    const limitInit = pLimit(6);
    await Promise.all(initialTasks.map(t => limitInit(async () => { try { await t(); } catch (e) { console.warn('[CSE] initial task error', e?.message || e); } })));
    // Hydrate targets into products
    const products = await hydrateProducts(allTargets);
    console.log('[HYDRATE] hydrated products:', products.length);
    console.log('products are', products);

    // De-duplicate across all hydrated batches (by URL)
    const seenProductUrl = new Set();
    const productsDeduped = products.filter(p => {
      const u = p?.url;
      if (!u || seenProductUrl.has(u)) return false;
      seenProductUrl.add(u);
      return true;
    });

    // Normalize (keep items even if price is null)
    const all = productsDeduped.map(p => ({
      title: p.title,
      description: p.description,
      price: typeof p.price === 'number' ? p.price : null,
      currency: p.currency || 'USD',
      image: p.images?.[0] || null,
      url: p.url,
      source: p.source,
    }));

    // Final defensive de-duplication on normalized records by URL (and image as fallback)
    const seenAll = new Set();
    const allUnique = all.filter(p => {
      const key = p.url || `img:${p.image}`;
      if (!key || seenAll.has(key)) return false;
      seenAll.add(key);
      return true;
    });

    // Derive bands from returned products' prices
    let priced = allUnique.filter(p => p.price != null).sort((a,b) => a.price - b.price);
    let avg = null, p25 = null, p75 = null;
    if (priced.length >= 1) {
      avg = priced.reduce((s, p) => s + p.price, 0) / priced.length;
      const atPct = (arr, pct) => {
        if (!arr.length) return null;
        const idx = Math.max(0, Math.min(arr.length - 1, Math.floor((arr.length - 1) * pct)));
        return arr[idx].price;
      };
      p25 = atPct(priced, 0.25);
      p75 = atPct(priced, 0.75);
      bands = {
        low: { min: 0, max: p25 },
        mid: { min: p25, max: p75 },
        high: { min: p75, max: Number.POSITIVE_INFINITY },
      };
    }

    // Build tiers from priced items only; ensure in-range
    const inRange = (p, range) => p.price != null && p.price >= range.min && p.price < range.max;
    let low = priced.filter(p => inRange(p, bands.low)).slice(0, 5);
    let mid = priced.filter(p => inRange(p, bands.mid)).slice(0, 5);
    let high = priced.filter(p => inRange(p, bands.high)).slice(0, 5);

    // Ensure minimum total priced results (>= 6). If fewer, broaden search.
    const minTotal = 6;
    if ((low.length + mid.length + high.length) < minTotal) {
      console.log('[PRODUCTS] insufficient priced results, expanding search in parallel');
      const sitePriority = ikeaOnly ? ['ikea.com'] : ['ikea.com','article.com','cb2.com','crateandbarrel.com','westelm.com','wayfair.com','target.com','etsy.com'];
      const startPages = [1, 11, 21];
      const expandTasks = [];
      for (const site of sitePriority) {
        for (const s of startPages) {
          for (const q of queries.slice(0, 8)) {
            expandTasks.push(async () => {
              const more = await searchProductsWithPSE({ query: q, limit: 10, sites: [site], imageSearch: image !== false, start: s });
              pushTargets(more);
              const newProducts = await hydrateProducts(more);
              products.push(...newProducts);
              const all2 = products.map(p => ({
                title: p.title,
                description: p.description,
                price: typeof p.price === 'number' ? p.price : null,
                currency: p.currency || 'USD',
                image: p.images?.[0] || null,
                url: p.url,
                source: p.source,
              }));
              // de-dup all2 then recalc priced
              const seen2 = new Set();
              const all2u = all2.filter(p => {
                const key = p.url || `img:${p.image}`;
                if (!key || seen2.has(key)) return false;
                seen2.add(key);
                return true;
              });
              priced = all2u.filter(p => p.price != null).sort((a,b) => a.price - b.price);
              if (priced.length >= 1) {
                avg = priced.reduce((s, p) => s + p.price, 0) / priced.length;
                const atPct = (arr, pct) => {
                  if (!arr.length) return null;
                  const idx = Math.max(0, Math.min(arr.length - 1, Math.floor((arr.length - 1) * pct)));
                  return arr[idx].price;
                };
                p25 = atPct(priced, 0.25);
                p75 = atPct(priced, 0.75);
                bands = { low: { min: 0, max: p25 }, mid: { min: p25, max: p75 }, high: { min: p75, max: Number.POSITIVE_INFINITY } };
              }
              low = priced.filter(p => inRange(p, bands.low)).slice(0, 5);
              mid = priced.filter(p => inRange(p, bands.mid)).slice(0, 5);
              high = priced.filter(p => inRange(p, bands.high)).slice(0, 5);
            });
          }
        }
      }
      const limitExpand = pLimit(6);
      let stop = false;
      await Promise.all(expandTasks.map(task => limitExpand(async () => {
        if (stop) return;
        try { await task(); } catch (e) { console.warn('[EXPAND] task error', e?.message || e); }
        if ((low.length + mid.length + high.length) >= minTotal) stop = true;
      })));
    }

    res.json({ bands: { ...bands, avg }, low, mid, high, allCount: productsDeduped.length, pricedCount: priced.length, intent, ikeaOnly, retailers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// --- API: Gemini philosophy for tiers ---
app.post('/api/philosophy', async (req, res) => {
  try {
    const { description = '', budget = null, tiers = {} } = req.body || {};
    const low = Array.isArray(tiers.low) ? tiers.low : [];
    const mid = Array.isArray(tiers.mid) ? tiers.mid : [];
    const high = Array.isArray(tiers.high) ? tiers.high : [];
    if (!genAI) {
      const brief = (arr, label) => arr.length ? `${label}: focuses on ${arr[0]?.title || 'cohesive items'} within budget.` : `${label}: no picks.`;
      return res.json({
        low: brief(low, 'Low'),
        mid: brief(mid, 'Mid'),
        high: brief(high, 'High'),
      });
    }
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const fmt = (arr) => arr.map(p => `- ${p.title || 'Product'} | ${p.source || ''} | ${p.currency || 'USD'} ${p.price ?? ''}`).join('\n');
    const prompt = `You are a product design assistant. The user said: "${description}". Budget (approx): ${budget ?? 'n/a'}.
We have three tiers of cohesive product options chosen to work well together in a single room.

Low tier:\n${fmt(low)}
Mid tier:\n${fmt(mid)}
High tier:\n${fmt(high)}

For each tier, write 2 concise sentences that explain the philosophy behind the choices (materials, forms, palette, and how they mesh together). Avoid marketing fluff. Return strict JSON with keys low, mid, high, each a short string.`;
    const resp = await model.generateContent(prompt);
    const text = resp.response.text();
    let json = null;
    try {
      const body = (text.match(/\{[\s\S]*\}$/) || [])[0] || text;
      json = JSON.parse(body);
    } catch {
      json = { low: 'Balanced and minimal.', mid: 'Comfort and durability.', high: 'Premium materials and detail.' };
    }
    res.json({
      low: String(json.low || 'Cohesive, budget-friendly essentials.'),
      mid: String(json.mid || 'Comfort-driven, durable selections.'),
      high: String(json.high || 'Premium textures and finishes.'),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// --- API: Compose L/M/H images with fal nano-banana/edit ---
app.post('/api/fal/compose', upload.single('space'), async (req, res) => {
  try {
    const { prompt, productsJson, baseImageUrl, baseImageDataUrl } = req.body;
    const tiers = JSON.parse(productsJson || '{}');
    let baseImage = null;
    if (typeof baseImageDataUrl === 'string' && baseImageDataUrl.startsWith('data:')) {
      baseImage = baseImageDataUrl.trim();
      console.log('[FAL:compose] baseImageDataUrl used (len=%d)', baseImage.length);
    } else if (req.file) {
      baseImage = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
      console.log('[FAL:compose] file:', { type: req.file.mimetype, size: req.file.size });
    } else if (typeof baseImageUrl === 'string' && baseImageUrl.trim()) {
      baseImage = String(baseImageUrl).trim();
      console.log('[FAL:compose] baseImageUrl used');
    } else {
      throw new Error('Missing base image (upload file as "space" or provide baseImageUrl/baseImageDataUrl)');
    }
    console.log('[FAL:compose] tiers:', {
      low: (tiers.low || []).length,
      mid: (tiers.mid || []).length,
      high: (tiers.high || []).length,
    });

    async function renderTier(name, productUrls = []) {
      const input = {
        prompt:
          (prompt && String(prompt)) ||
          'Add only the referenced products to this exact room without changing the background or existing elements. Do not modify or remove any existing furniture, decor, walls, windows, floor, ceiling, or lighting. Preserve the original style, layout, colors, materials, geometry, perspective, and camera angle. Maintain natural lighting and shadows consistent with the room. Include every provided product exactly once; no duplicates, no substitutions, no omissions.',
        image_urls: [baseImage, ...productUrls].filter(Boolean),
        num_images: 1,
      };
      const out = await fal.subscribe('fal-ai/nano-banana/edit', { input });
      const url = out?.data?.images?.[0]?.url;
      if (!url) throw new Error(`fal edit returned no image for ${name}`);
      return url;
    }

    const [lowUrl, midUrl, highUrl] = await Promise.all([
      renderTier('low', tiers.low || []),
      renderTier('mid', tiers.mid || []),
      renderTier('high', tiers.high || []),
    ]);

    res.json({ lowUrl, midUrl, highUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// --- API: Reorganize room layout to fit selected tier ---
app.post('/api/fal/reorganize', upload.single('space'), async (req, res) => {
  try {
    const { productsJson, tier, prompt } = req.body || {};
    if (!req.file) throw new Error('Missing space image');
    const tiers = JSON.parse(productsJson || '{}');
    const chosen = Array.isArray(tiers?.[tier]) ? tiers[tier] : [];
    if (!chosen.length) throw new Error('No products provided for the selected tier');

    const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const basePrompt =
      'Preserve all existing furniture and decor in this exact room; do not remove or restyle them. Reorganize and reposition the existing furniture layout to accommodate the referenced new products, creating a cohesive arrangement. Maintain the room’s original materials, colors, geometry, and camera perspective. Keep natural lighting and realistic shadows. Include every referenced product exactly once; no duplicates, no omissions. Avoid adding or deleting elements beyond positioning.';
    const input = {
      prompt: (prompt && String(prompt)) || basePrompt,
      image_urls: [dataUri, ...chosen].filter(Boolean),
      num_images: 1,
    };
    const out = await fal.subscribe('fal-ai/nano-banana/edit', { input });
    const url = out?.data?.images?.[0]?.url;
    if (!url) throw new Error('fal edit returned no image for reorganize');
    res.json({ reorgUrl: url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// --- API: Finalize -> isometric edit, then 3D with Hunyuan3D v2.1 ---
app.post('/api/fal/finalize', async (req, res) => {
  try {
    const { selectedImageUrl, selectedImageDataUrl, selectedTier, tierTitles } = req.body;
    const img = (typeof selectedImageDataUrl === 'string' && selectedImageDataUrl.startsWith('data:'))
      ? selectedImageDataUrl
      : selectedImageUrl;
    if (!img) throw new Error('Missing selected image');
    console.log('[FAL:finalize] input image len:', img.length);

    // Step 1: make an isometric-style view
    const isoPrompt = [
      'Reframe this exact room as a clean isometric view (30–40°), orthographic feel.',
      'The perspective should be isometric, looking down into the room from a diagonal angle.',
      'Override any previous instruction that preserves the original background or camera perspective — change the viewpoint to isometric.',
      selectedTier ? `Reflect arrangement consistent with the selected tier: ${String(selectedTier).toUpperCase()}.` : '',
      Array.isArray(tierTitles) && tierTitles.length ? `Clearly depict: ${tierTitles.slice(0,8).join(', ')}.` : '',
      'Maintain the room’s materials and objects; do not add or remove items beyond the selection. Preserve geometry and realistic lighting.'
    ].filter(Boolean).join(' ');

    const iso = await fal.subscribe('fal-ai/nano-banana/edit', {
      input: {
        prompt: isoPrompt,
        image_urls: [img],
        num_images: 1,
      },
    });
    const isoUrl = iso?.data?.images?.[0]?.url;
    if (!isoUrl) throw new Error('No isometric image from nano-banana');

    // Step 2 (optional): 3D generation — disabled unless ENABLE_3D=true
    if (!ENABLE_3D) {
      return res.json({ isoImageUrl: isoUrl, glbUrl: null, threeDDisabled: true });
    }

    // 3D via fal-ai/trellis (logs enabled)
    function findFirstGlbUrl(obj) {
      try {
        const stack = [obj];
        while (stack.length) {
          const cur = stack.pop();
          if (!cur) continue;
          if (typeof cur === 'string' && /\.glb(\?.*)?$/i.test(cur)) return cur;
          if (Array.isArray(cur)) { for (const v of cur) stack.push(v); continue; }
          if (typeof cur === 'object') {
            for (const k of Object.keys(cur)) stack.push(cur[k]);
          }
        }
      } catch {}
      return null;
    }
    function findFirstAbsoluteUrl(obj) {
      try {
        const stack = [obj];
        while (stack.length) {
          const cur = stack.pop();
          if (!cur) continue;
          if (typeof cur === 'string' && /^https?:\/\//i.test(cur)) return cur;
          if (Array.isArray(cur)) { for (const v of cur) stack.push(v); continue; }
          if (typeof cur === 'object') { for (const k of Object.keys(cur)) stack.push(cur[k]); }
        }
      } catch {}
      return null;
    }

    const threeD = await fal.subscribe('fal-ai/trellis', {
      input: { image_url: isoUrl },
      logs: true,
      onQueueUpdate: (update) => {
        if (update?.status === 'IN_PROGRESS' && Array.isArray(update.logs)) {
          update.logs.map((l) => l.message).forEach((m) => console.log('[TRELLIS]', m));
        }
      },
    });

    const glb = findFirstGlbUrl(threeD?.data);
    if (!glb) throw new Error('Trellis did not return a GLB url');

    res.json({ isoImageUrl: isoUrl, glbUrl: glb });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// --- API: Generate 3D GLB from an image (isometric or any) ---
app.post('/api/fal/3d', async (req, res) => {
  try {
    const { imageUrl, imageDataUrl } = req.body || {};
    const imgArg = (typeof imageDataUrl === 'string' && imageDataUrl.startsWith('data:'))
      ? imageDataUrl
      : imageUrl;
    if (!imgArg) throw new Error('Missing imageUrl');
    console.log('[3D] input image:', (imgArg || '').slice(0, 64));

    function findFirstGlbUrl(obj) {
      try {
        const stack = [obj];
        while (stack.length) {
          const cur = stack.pop();
          if (!cur) continue;
          if (typeof cur === 'string' && /\.glb(\?.*)?$/i.test(cur)) return cur;
          if (Array.isArray(cur)) { for (const v of cur) stack.push(v); continue; }
          if (typeof cur === 'object') {
            for (const k of Object.keys(cur)) stack.push(cur[k]);
          }
        }
      } catch {}
      return null;
    }

    // helper to find first absolute URL in nested data
    function findFirstAbsoluteUrl(obj) {
      try {
        const stack = [obj];
        while (stack.length) {
          const cur = stack.pop();
          if (!cur) continue;
          if (typeof cur === 'string' && /^https?:\/\//i.test(cur)) return cur;
          if (Array.isArray(cur)) { for (const v of cur) stack.push(v); continue; }
          if (typeof cur === 'object') { for (const k of Object.keys(cur)) stack.push(cur[k]); }
        }
      } catch {}
      return null;
    }

    // Reject blob: URLs early; they are not fetchable from server
    if (typeof imgArg === 'string' && /^blob:/i.test(imgArg)) {
      return res.status(422).json({ error: 'Unprocessable Entity: blob URL not fetchable; send an absolute URL or data URI' });
    }

    const threeD = await fal.subscribe('fal-ai/trellis', {
      input: { image_url: imgArg },
      logs: true,
      onQueueUpdate: (update) => {
        if (update?.status === 'IN_PROGRESS' && Array.isArray(update.logs)) {
          update.logs.map((l) => l.message).forEach((m) => console.log('[TRELLIS]', m));
        }
      },
    });

    console.log('[3D] requestId:', threeD?.request_id || threeD?.requestId);
    try {
      console.log('[3D] data keys:', Object.keys(threeD?.data || {}));
    } catch {}
    let glb = findFirstGlbUrl(threeD?.data);
    if (!glb) throw new Error('Trellis did not return a GLB url');
    const baseAbs = findFirstAbsoluteUrl(threeD?.data);
    if (glb.startsWith('/') && baseAbs) {
      try { const o = new URL(baseAbs); glb = `${o.origin}${glb}`; } catch {}
    }
    console.log('[3D] GLB URL:', glb);
    const proxyUrl = /^https?:\/\//i.test(glb) ? `/api/proxy?u=${encodeURIComponent(glb)}` : null;
    res.json({ glbUrl: glb, proxyUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// simple proxy for remote assets (e.g., GLB) with logging
app.get('/api/proxy', async (req, res) => {
  try {
    const u = req.query.u;
    if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) return res.status(400).send('Invalid url');
    console.log('[PROXY] GET', u);
    const r = await fetchWithTimeout(u, {}, 20000);
    if (!r.ok) return res.status(r.status).send('Upstream error');
    // pass through headers
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    const disp = r.headers.get('content-disposition');
    if (disp) res.setHeader('Content-Disposition', disp);
    const buf = Buffer.from(await r.arrayBuffer());
    res.end(buf);
  } catch (e) {
    console.error('[PROXY] error', e?.message || e);
    res.status(500).send('Proxy error');
  }
});

// --- API: ElevenLabs speech-to-text ---
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) throw new Error('No audio uploaded');
    console.log('[STT] file:', { type: req.file.mimetype, size: req.file.size });

    const form = new FormData();
    form.append('model_id', 'scribe_v1');
    const mt = req.file.mimetype || 'audio/webm';
    let ext = 'webm';
    if (/mp4/i.test(mt)) ext = 'mp4';
    else if (/ogg/i.test(mt)) ext = 'ogg';
    form.append('file', new Blob([req.file.buffer], { type: mt }), `audio.${ext}`);

    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVEN_API_KEY },
      body: form,
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`ElevenLabs STT error: ${r.status} ${t}`);
    }
    const j = await r.json();
    console.log('[STT] text len:', (j.text || '').length);
    res.json({ text: j.text || '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// --- health ---
app.get('/health', (req, res) => res.json({ ok: true }));

// --- start ---
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`RoomShop server on http://localhost:${PORT}`));
