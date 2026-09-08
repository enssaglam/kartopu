const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36';

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
    }, extraHeaders || {}),
    body: JSON.stringify(body),
  };
}

function cleanSymbol(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9.\-^=]/g, '');
}

function yahooSymbol(symbol, market) {
  const s = cleanSymbol(symbol);
  if (!s) return '';
  if (market === 'BIST' && !s.endsWith('.IS')) return s + '.IS';
  return s;
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchYahooQuote(position) {
  const market = position.market === 'BIST' ? 'BIST' : 'GLOBAL';
  const original = cleanSymbol(position.symbol);
  const ys = yahooSymbol(original, market);
  if (!ys) throw new Error('Geçersiz sembol');

  const url = YAHOO_BASE + encodeURIComponent(ys) + '?range=1d&interval=1d&includePrePost=false&events=div%2Csplits';
  const res = await fetchWithTimeout(url, 9000);
  if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
  const data = await res.json();
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  const meta = result && result.meta;
  if (!meta || meta.regularMarketPrice === null || meta.regularMarketPrice === undefined) {
    throw new Error('Fiyat bulunamadı');
  }
  const ts = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : new Date().toISOString();
  return {
    symbol: original,
    providerSymbol: ys,
    market,
    price: Number(meta.regularMarketPrice),
    previousClose: meta.chartPreviousClose !== undefined ? Number(meta.chartPreviousClose) : (meta.previousClose !== undefined ? Number(meta.previousClose) : null),
    currency: meta.currency === 'TRY' ? 'TRY' : (meta.currency === 'USD' ? 'USD' : (market === 'BIST' ? 'TRY' : 'USD')),
    exchange: meta.exchangeName || meta.fullExchangeName || null,
    updatedAt: ts,
    source: 'Yahoo Finance',
    delayed: true,
  };
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Yalnızca POST desteklenir.' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return json(400, { error: 'Geçersiz istek.' }); }

  const incoming = Array.isArray(body.positions) ? body.positions : [];
  const seen = new Set();
  const positions = [];
  for (const p of incoming) {
    const symbol = cleanSymbol(p && p.symbol);
    const market = p && p.market === 'BIST' ? 'BIST' : 'GLOBAL';
    const key = market + ':' + symbol;
    if (!symbol || seen.has(key)) continue;
    seen.add(key);
    positions.push({ symbol, market });
    if (positions.length >= 40) break;
  }
  if (!positions.length) return json(200, { quotes: [], errors: [], fetchedAt: new Date().toISOString() });

  const settled = await Promise.allSettled(positions.map(fetchYahooQuote));
  const quotes = [];
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') quotes.push(r.value);
    else errors.push({ symbol: positions[i].symbol, market: positions[i].market, error: (r.reason && r.reason.message) || 'Fiyat alınamadı' });
  });

  return json(200, {
    quotes,
    errors,
    fetchedAt: new Date().toISOString(),
    note: 'Piyasa verileri gecikmeli olabilir.',
  }, { 'Access-Control-Allow-Origin': '*' });
};
