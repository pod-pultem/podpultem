// /api/scrape.js
// Stáhne HTML z produktu (1688/Weidian), vytáhne obrázky, varianty/velikosti
// a zkusí najít nákupní cenu v CNY. Rovnou spočítá prodejní CZK podle env.

export default async function handler(req, res) {
  try {
    const { url = "", token = "" } = req.query;
    if (!url) return res.status(400).json({ error: "Missing url" });

    const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
    if (ACCESS_TOKEN && token !== ACCESS_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const html = await fetchHtml(url);
    const { title, images } = extractBasic(html, url);
    const { variants, sizes } = extractVariants(html) || { variants: [], sizes: [] };
    const buyCNY = extractPriceCNY(html);
    const priceCZK = buyCNY ? priceCnyToCzk(buyCNY) : null;
    const sizeChartImage = extractSizeChart(html);

    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate");
    res.json({ title, images, variants, sizes, sizeChartImage, buyPriceCNY: buyCNY, priceCZK });
  } catch (e) {
    res.status(500).json({ error: e.message || "Unknown error" });
  }
}

async function fetchHtml(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("Fetch failed " + r.status);
  return await r.text();
}

function extractBasic(html, baseUrl) {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1];
  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
  const title = (ogTitle || titleTag || "").trim();

  const imgs = new Set();
  const ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1];
  if (ogImg) imgs.add(abs(baseUrl, ogImg));
  const imgRegex = /<img[^>]+(?:data-src|src)=["']([^"']+)["']/gi;
  let m;
  while ((m = imgRegex.exec(html))) {
    const src = m[1];
    if (!src.startsWith("data:")) imgs.add(abs(baseUrl, src));
    if (imgs.size > 12) break;
  }
  return { title, images: Array.from(imgs) };
}

function extractVariants(html) {
  const scripts = Array.from(html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)).map(m => m[1] || "");
  let variants = [];
  let sizes = [];

  for (const sc of scripts) {
    if (/skuProps|skuMap|skuList|skuModel/i.test(sc)) {
      try {
        const json = firstJson(sc);
        if (json.skuProps && Array.isArray(json.skuProps)) {
          variants = json.skuProps.flatMap(p => (p.value||p.values||[]).map(v => ({
            id: v.skuId || v.valueId || v.id || String(v.valueName || v.name || "Variant"),
            name: v.valueName || v.name || "Variant",
            available: true
          })));
        }
        if (json.skuList && Array.isArray(json.skuList)) {
          const sizeKeys = ["size","Size","尺码","サイズ"];
          const found = json.skuList.flatMap(x => Object.keys(x).filter(k => sizeKeys.some(sk => k.includes(sk))).map(k => x[k]));
          sizes = dedup(found.map(String).filter(Boolean));
        }
        if (json.skuMap && typeof json.skuMap === "object") {
          const keys = Object.keys(json.skuMap);
          const possible = keys.flatMap(k => k.split(";")).filter(x => /S|M|L|XL|XXL|尺|码|碼/i.test(x)).map(s => s.replace(/[{}"']/g,"").trim());
          if (!sizes.length) sizes = dedup(possible);
        }
      } catch {}
    }
    if (!variants.length && /variants/i.test(sc)) {
      try {
        const json = firstJson(sc);
        if (Array.isArray(json.variants)) {
          variants = json.variants.map(v => ({ id: v.id || v.value || v.name, name: v.name || v.value, available: v.stock>0 || v.available!==false }));
        }
      } catch {}
    }
    if (!sizes.length && /sizes?/i.test(sc)) {
      try {
        const json = firstJson(sc);
        if (Array.isArray(json.sizes)) sizes = dedup(json.sizes.map(String));
      } catch {}
    }
  }
  return { variants: dedupVariants(variants), sizes };
}

function extractSizeChart(html) {
  const urls = html.match(/https?:[^"'<>]+?\.(?:png|jpe?g|webp)/gi) || [];
  return urls.find(u => /size.?chart|size-?table|velikost/i.test(u)) || null;
}

function extractPriceCNY(html) {
  const hints = [];
  let m;
  const reY = /[¥￥]\s?(\d+(?:\.\d+)?)/g;
  while ((m = reY.exec(html))) hints.push(parseFloat(m[1]));
  const reJson = /"price"\s*:\s*"?(\d+(?:\.\d+)?)"?/gi;
  while ((m = reJson.exec(html))) hints.push(parseFloat(m[1]));
  return hints.length ? Math.min(...hints) : null; // ber nejnižší "od" cenu
}

function priceCnyToCzk(cny) {
  const FX = num(process.env.FX_RATE_CNY, 3.5);
  const MULT = num(process.env.MULTIPLIER, 1.8);
  const SHIP = num(process.env.SHIPPING_FEE, 89);
  const HAND = num(process.env.HANDLING_FEE, 0);
  const MINP = num(process.env.MIN_PRICE, 249);
  const ROUND= num(process.env.ROUND_TO, 10);
  const CAP  = num(process.env.PRICE_CAP, 0);

  let czk = (cny * FX) * MULT + SHIP + HAND;
  if (CAP > 0) czk = Math.min(czk, CAP);
  if (czk < MINP) czk = MINP;
  if (ROUND > 0) czk = Math.ceil(czk / ROUND) * ROUND;
  return Math.round(czk);
}

function abs(base, s){ try { return new URL(s, base).href; } catch { return s; } }
function dedup(arr){ return Array.from(new Set(arr.filter(Boolean))); }
function dedupVariants(vs){ const seen=new Set(); return vs.filter(v=>{ const k=(v.name||"").toLowerCase(); if(seen.has(k)) return false; seen.add(k); return true; }); }
function num(v, def){ const n=parseFloat(v); return Number.isFinite(n)?n:def; }
function firstJson(txt){ const cands = txt.match(/\{[\s\S]*\}/g) || []; for (const c of cands){ try { return JSON.parse(c); } catch {} } return {}; }
