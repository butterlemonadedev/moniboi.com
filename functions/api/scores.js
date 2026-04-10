const API_KEY = 'AIzaSyCXTt1LA7Ni1J2ngF7LN_BKXUmhpCV6ceU';
const PROJECT_ID = 'moniboi';
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery?key=${API_KEY}`;
const CACHE_TTL = 300;
const STALE_TTL = 86400; // 24 hours stale fallback

function getCacheKeys(url) {
  const base = new URL(url);
  base.search = '';
  return {
    fresh: new Request(base.toString()),
    stale: new Request(base.toString() + '?_stale=1')
  };
}

function jsonResponse(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...extra
    }
  });
}

function parseFirestoreScores(results) {
  return results
    .filter(r => r.document)
    .map(r => {
      const f = r.document.fields || {};
      return {
        money: parseInt(f.money?.integerValue || '0'),
        displayName: f.displayName?.stringValue || 'Anonymous',
        age: parseInt(f.age?.integerValue || '0'),
        turns: parseInt(f.turns?.integerValue || '0'),
        deathCause: f.deathCause?.stringValue || 'Unknown'
      };
    });
}

async function cacheScores(cache, keys, scores) {
  const body = JSON.stringify(scores);
  const fresh = new Response(body, {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': `public, max-age=${CACHE_TTL}`,
      'X-Cache': 'miss'
    }
  });
  const stale = new Response(body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${STALE_TTL}`
    }
  });
  await Promise.all([
    cache.put(keys.fresh, fresh),
    cache.put(keys.stale, stale)
  ]);
}

// GET /api/scores — serve cached or fetch from Firestore
export async function onRequestGet(context) {
  const cache = caches.default;
  const keys = getCacheKeys(context.request.url);

  // Try fresh cache
  const cached = await cache.match(keys.fresh);
  if (cached) {
    const resp = new Response(cached.body, cached);
    resp.headers.set('X-Cache', 'hit');
    return resp;
  }

  // Fetch from Firestore
  try {
    const res = await fetch(FIRESTORE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'scores' }],
          orderBy: [{ field: { fieldPath: 'money' }, direction: 'DESCENDING' }],
          limit: 100
        }
      })
    });

    if (!res.ok) {
      // Firestore down — try stale
      const stale = await cache.match(keys.stale);
      if (stale) {
        return jsonResponse(JSON.parse(await stale.text()), 200, { 'X-Cache': 'stale' });
      }
      return jsonResponse({ error: `Upstream ${res.status}` }, 502);
    }

    const results = await res.json();
    const scores = parseFirestoreScores(results);

    context.waitUntil(cacheScores(cache, keys, scores));

    return jsonResponse(scores, 200, { 'X-Cache': 'miss' });
  } catch (err) {
    const stale = await cache.match(keys.stale);
    if (stale) {
      return jsonResponse(JSON.parse(await stale.text()), 200, { 'X-Cache': 'stale' });
    }
    return jsonResponse({ error: err.message }, 500);
  }
}

// POST /api/scores — seed the cache manually (for when Firestore is down)
export async function onRequestPost(context) {
  try {
    const body = await context.request.json();

    // Expect { secret: "...", scores: [...] }
    if (body.secret !== 'moniboi-seed-2026') {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    if (!Array.isArray(body.scores)) {
      return jsonResponse({ error: 'scores must be an array' }, 400);
    }

    const cache = caches.default;
    const keys = getCacheKeys(context.request.url);
    await cacheScores(cache, keys, body.scores);

    return jsonResponse({ ok: true, cached: body.scores.length });
  } catch (err) {
    return jsonResponse({ error: err.message }, 400);
  }
}
