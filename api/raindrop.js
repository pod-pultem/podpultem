// /api/raindrop.js
// Vytáhne odkazy z tvých Raindrop kolekcí a pošle je jako JSON

export default async function handler(req, res) {
  try {
    const { collections = "", token = "" } = req.query;

    // kontrola hesla
    const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "";
    if (ACCESS_TOKEN && token !== ACCESS_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const RAINDROP_TOKEN = process.env.RAINDROP_TOKEN;
    if (!RAINDROP_TOKEN) {
      return res.status(500).json({ error: "Missing RAINDROP_TOKEN" });
    }

    const ids = String(collections).split(",").map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: "Provide ?collections=<id>[,<id>...]" });

    const headers = { Authorization: `Bearer ${RAINDROP_TOKEN}` };
    const products = [];

    for (const id of ids) {
      const url = `https://api.raindrop.io/rest/v1/raindrops/${id}?perpage=200`;
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(`Raindrop fetch ${id} failed: ${r.status}`);
      const data = await r.json();

      for (const it of (data.items || [])) {
        const cover = it.cover || (it.media && it.media[0]?.link) || "";
        products.push({
          id: `rd-${it._id}`,
          name: it.title || "Produkt",
          brand: guessBrand(it.title || "", it.tags || []),
          priceCZK: null, // dopočítáme až ve scrape
          image: cover,
          tags: (it.tags || []).map(String),
          url: it.link,
          _collection: Number(id),
        });
      }
    }

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate");
    res.json({ products });

  } catch (e) {
    res.status(500).json({ error: e.message || "Unknown error" });
  }
}

function guessBrand(title, tags) {
  const BRANDS = ["Calvin Klein","CK","Guess","Armani","Emporio Armani","EA","Michael Kors","MK","Versace","Nike","Adidas","Puma","Levi's"];
  const t = String(title).toLowerCase();
  for (const b of BRANDS) if (t.includes(b.toLowerCase())) return b;
  for (const tag of (tags||[])) if (BRANDS.includes(tag)) return tag;
  return "";
}
