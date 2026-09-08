/* ============================================================
   KARTOPU — Temettü Takip
   Vanilla JS PWA. No build step, no framework, no backend.
   All data lives in localStorage on the device.
   ============================================================ */

const STORAGE_KEY = 'kartopu_v1';

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

const DEFAULT_STATE = {
  holdings: [],
  transactions: [],
  dividends: [],
  settings: {
    usdTryRate: 48.10,
    fxUpdated: null,
    bistWithholding: 0.15,
    globalWithholding: 0.15,
    theme: 'light',
    autoPriceRefresh: true,
    priceRefreshMinutes: 15,
    pricesUpdated: null,
    dividendGoalAnnual: 0,
    snowball: { years: 10, growthRate: 0.08, reinvest: true, monthlyAdd: 0 },
  },
  activeTab: 'dashboard',
  holdingsSort: 'value',
};

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return deepClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    return Object.assign(
      {},
      deepClone(DEFAULT_STATE),
      parsed,
      { settings: Object.assign({}, deepClone(DEFAULT_STATE.settings), parsed.settings || {}) }
    );
  } catch (e) {
    console.error('State load failed, resetting.', e);
    return deepClone(DEFAULT_STATE);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function qsaEach(root, selector, fn) {
  const list = root.querySelectorAll(selector);
  for (let i = 0; i < list.length; i++) fn(list[i], i);
}

/* ---------------- Money / formatting helpers ---------------- */

function fmtMoney(amount, currency, opts) {
  currency = currency || 'TRY';
  opts = opts || {};
  const symbol = currency === 'USD' ? '$' : '₺';
  const n = Number(amount) || 0;
  const decimals = opts.decimals !== undefined ? opts.decimals : (Math.abs(n) >= 1000 ? 0 : 2);
  const factor = Math.pow(10, decimals);
  const rounded = Math.round(n * factor) / factor;
  const formatted = rounded.toLocaleString('tr-TR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return symbol + formatted;
}

function fmtPct(x, decimals) {
  decimals = decimals === undefined ? 1 : decimals;
  return (x * 100).toFixed(decimals) + '%';
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' });
}

function toTRY(amount, currency) {
  if (currency === 'USD') return amount * state.settings.usdTryRate;
  return amount;
}

function withholdingRateFor(market) {
  return market === 'BIST' ? state.settings.bistWithholding : state.settings.globalWithholding;
}

/* ---------------- Derived data ---------------- */

function holdingCurrentValueNative(h) {
  const price = (h.currentPrice !== null && h.currentPrice !== undefined && h.currentPrice !== '') ? Number(h.currentPrice) : Number(h.avgCost);
  return price * Number(h.shares);
}
function holdingCostNative(h) {
  return Number(h.avgCost) * Number(h.shares);
}
function holdingValueTRY(h) {
  return toTRY(holdingCurrentValueNative(h), h.currency);
}
function holdingCostTRY(h) {
  return toTRY(holdingCostNative(h), h.currency);
}

function totalPortfolioValueTRY() {
  return state.holdings.reduce(function(sum, h) { return sum + holdingValueTRY(h); }, 0);
}
function totalPortfolioCostTRY() {
  return state.holdings.reduce(function(sum, h) { return sum + holdingCostTRY(h); }, 0);
}

function dividendGrossTRY(d) {
  return toTRY(Number(d.perShare) * Number(d.shares), d.currency);
}
function dividendNetTRY(d) {
  const rate = withholdingRateFor(d.market);
  return dividendGrossTRY(d) * (1 - rate);
}

function thisYearNetDividendTRY() {
  const y = new Date().getFullYear();
  return state.dividends
    .filter(function(d) { return new Date(d.date + 'T00:00:00').getFullYear() === y; })
    .reduce(function(sum, d) { return sum + dividendNetTRY(d); }, 0);
}

function last12MonthsNetDividendTRY() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 12);
  return state.dividends
    .filter(function(d) { return new Date(d.date + 'T00:00:00') >= cutoff; })
    .reduce(function(sum, d) { return sum + dividendNetTRY(d); }, 0);
}

function marketAllocation() {
  const byMarket = { BIST: 0, GLOBAL: 0 };
  state.holdings.forEach(function(h) { byMarket[h.market] += holdingValueTRY(h); });
  return byMarket;
}

function upcomingReminders() {
  const bySymbol = {};
  state.dividends.forEach(function(d) {
    if (!bySymbol[d.symbol] || d.date > bySymbol[d.symbol].date) bySymbol[d.symbol] = d;
  });
  return Object.keys(bySymbol).map(function(k) { return bySymbol[k]; })
    .sort(function(a, b) { return a.date < b.date ? 1 : -1; })
    .slice(0, 5);
}

/* ---------------- Snowball projection ---------------- */

function computeSnowball(opts) {
  const startValue = opts.startValue, startAnnualDividend = opts.startAnnualDividend,
        years = opts.years, growthRate = opts.growthRate, reinvest = opts.reinvest, annualAdd = opts.annualAdd;
  const rows = [];
  let value = startValue;
  let yieldPct = startValue > 0 ? startAnnualDividend / startValue : 0;
  let dividend = startAnnualDividend;

  for (let y = 1; y <= years; y++) {
    dividend = reinvest ? value * yieldPct : dividend * (1 + growthRate);
    if (reinvest) {
      value = value + dividend + annualAdd;
      yieldPct = yieldPct * (1 + growthRate);
    } else {
      value = value + annualAdd;
    }
    rows.push({ year: y, dividend: dividend, value: value });
  }
  return rows;
}

/* ---------------- Dividend frequency detection & projection ---------------- */

function symbolDividendHistory(symbol) {
  return state.dividends
    .filter(function(d) { return d.symbol === symbol; })
    .sort(function(a, b) { return a.date < b.date ? -1 : 1; });
}

function detectFrequencyDays(symbol) {
  const entries = symbolDividendHistory(symbol);
  if (entries.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < entries.length; i++) {
    const d1 = new Date(entries[i-1].date + 'T00:00:00');
    const d2 = new Date(entries[i].date + 'T00:00:00');
    gaps.push((d2 - d1) / 86400000);
  }
  return gaps.reduce(function(a,b) { return a+b; }, 0) / gaps.length;
}

function defaultFrequencyDays(market) {
  return market === 'BIST' ? 365 : 91;
}

function annualNetDividendForHolding(h) {
  const entries = symbolDividendHistory(h.symbol);
  if (entries.length === 0) return 0;
  const last = entries[entries.length - 1];
  const freqDays = entries.length >= 2 ? detectFrequencyDays(h.symbol) : defaultFrequencyDays(h.market);
  const paymentsPerYear = 365 / freqDays;
  const netPerPayment = dividendNetTRY(last) * (Number(h.shares) / Number(last.shares || h.shares));
  return netPerPayment * paymentsPerYear;
}

function projectHoldingPayments(h, monthsAhead) {
  const entries = symbolDividendHistory(h.symbol);
  const results = [];
  const horizon = new Date();
  horizon.setMonth(horizon.getMonth() + monthsAhead);

  if (entries.length === 0) return results;
  const last = entries[entries.length - 1];
  const freqDays = entries.length >= 2 ? detectFrequencyDays(h.symbol) : defaultFrequencyDays(h.market);
  let cursor = new Date(last.date + 'T00:00:00');
  const basedOnYear = cursor.getFullYear();
  let guard = 0;
  while (guard < 40) {
    cursor = new Date(cursor.getTime() + Math.round(freqDays) * 86400000);
    if (cursor > horizon) break;
    if (cursor > new Date()) {
      results.push({
        symbol: h.symbol, market: h.market, date: cursor.toISOString().slice(0,10),
        perShare: last.perShare, shares: h.shares, currency: h.currency,
        estimate: true, basedOnYear: basedOnYear,
      });
    }
    guard++;
  }
  return results;
}

function allProjectedPayments(monthsAhead) {
  let out = [];
  state.holdings.forEach(function(h) {
    out = out.concat(projectHoldingPayments(h, monthsAhead));
  });
  return out.sort(function(a,b) { return a.date < b.date ? -1 : 1; });
}

function avatarColor(symbol) {
  const palette = ['#1D4536', '#C9A24B', '#2C6349', '#A0483F', '#7A6A2E', '#3C7A5A'];
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) hash = (hash * 31 + symbol.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

/* ---------------- Logos (falls back to colored initial when no logo exists) ---------------- */

const LOGOS = {
  'DOAS': 'logos/doas.png',
  'TUPRS': 'logos/tuprs.png',
  'AKSA': 'logos/aksa.png',
  'SCHD': 'logos/schd.png',
};

function avatarHtml(symbol) {
  const logo = LOGOS[symbol];
  if (logo) {
    return `<div class="avatar avatar-logo"><img src="${logo}" alt="${symbol}" loading="lazy"></div>`;
  }
  return `<div class="avatar" style="background:${avatarColor(symbol)}">${symbol.charAt(0)}</div>`;
}

function fetchLiveFX() {
  return fetch('https://api.frankfurter.app/latest?from=USD&to=TRY')
    .then(function(res) {
      if (!res.ok) throw new Error('FX fetch failed');
      return res.json();
    })
    .then(function(data) {
      const rate = data.rates && data.rates.TRY;
      if (!rate) throw new Error('No rate in response');
      state.settings.usdTryRate = rate;
      state.settings.fxUpdated = new Date().toISOString();
      saveState();
      return rate;
    });
}

/* ---------------- Market prices ---------------- */

let priceRefreshInFlight = false;

function marketDataAgeMinutes() {
  if (!state.settings.pricesUpdated) return Infinity;
  const t = new Date(state.settings.pricesUpdated).getTime();
  if (!isFinite(t)) return Infinity;
  return (Date.now() - t) / 60000;
}

function priceStatusText() {
  if (!state.settings.pricesUpdated) return 'Henüz otomatik fiyat güncellemesi yapılmadı.';
  const d = new Date(state.settings.pricesUpdated);
  const age = marketDataAgeMinutes();
  const when = d.toLocaleString('tr-TR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
  if (age < 2) return 'Fiyatlar az önce güncellendi · ' + when;
  if (age < 60) return 'Son fiyat güncellemesi ' + Math.round(age) + ' dk önce · ' + when;
  return 'Son fiyat güncellemesi · ' + when;
}

function fetchPortfolioQuotes() {
  if (!state.holdings.length) return Promise.resolve({ quotes: [], errors: [] });
  const positions = state.holdings.map(function(h) {
    return { symbol: h.symbol, market: h.market };
  });
  return fetch('/api/quotes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ positions: positions }),
    cache: 'no-store',
  }).then(function(res) {
    if (!res.ok) return res.json().catch(function(){ return {}; }).then(function(body) {
      throw new Error(body.error || 'Fiyat servisine ulaşılamadı (' + res.status + ')');
    });
    return res.json();
  });
}

function applyQuotes(payload) {
  const quotes = (payload && payload.quotes) || [];
  let updated = 0;
  quotes.forEach(function(q) {
    const h = state.holdings.find(function(x) {
      return x.symbol === q.symbol && x.market === q.market;
    });
    if (!h || q.price === null || q.price === undefined || !isFinite(Number(q.price))) return;
    h.currentPrice = Number(q.price);
    h.previousClose = (q.previousClose !== null && q.previousClose !== undefined && isFinite(Number(q.previousClose))) ? Number(q.previousClose) : null;
    h.priceUpdatedAt = q.updatedAt || new Date().toISOString();
    h.priceSource = q.source || 'Piyasa verisi';
    h.priceAuto = true;
    if (q.currency && (q.currency === 'TRY' || q.currency === 'USD')) h.currency = q.currency;
    updated++;
  });
  if (updated > 0) state.settings.pricesUpdated = new Date().toISOString();
  saveState();
  return updated;
}

function refreshAllMarketData(options) {
  options = options || {};
  if (priceRefreshInFlight) return Promise.reject(new Error('Fiyat güncellemesi zaten devam ediyor.'));
  priceRefreshInFlight = true;
  const needsFx = state.holdings.some(function(h) { return h.currency === 'USD' || h.market === 'GLOBAL'; });
  const quotePromise = fetchPortfolioQuotes();
  const fxPromise = needsFx ? fetchLiveFX().catch(function(){ return null; }) : Promise.resolve(null);
  return Promise.all([quotePromise, fxPromise]).then(function(results) {
    const payload = results[0] || {};
    const updated = applyQuotes(payload);
    return { updated: updated, errors: payload.errors || [], fx: results[1] };
  }).finally(function() {
    priceRefreshInFlight = false;
  });
}

function maybeAutoRefreshPrices() {
  if (!state.settings.autoPriceRefresh || !state.holdings.length || !navigator.onLine) return;
  const minutes = Number(state.settings.priceRefreshMinutes) || 15;
  const hasMissingPrice = state.holdings.some(function(h) { return h.currentPrice === null || h.currentPrice === undefined || h.currentPrice === ''; });
  if (!hasMissingPrice && marketDataAgeMinutes() < minutes) return;
  refreshAllMarketData().then(function(result) {
    if (result.updated > 0) render();
  }).catch(function(err) {
    console.warn('Automatic market refresh failed:', err);
  });
}

/* ============================================================
   RENDERING
   ============================================================ */

const appRoot = document.getElementById('app');

function applyTheme() {
  const dark = state.settings.theme === 'dark';
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', dark ? '#0A140F' : '#12281F');
}

function render() {
  applyTheme();
  appRoot.innerHTML = `
    ${renderTopbar()}
    <div class="screen" id="screen"></div>
    ${renderTabbar()}
    ${renderFab()}
  `;
  const screen = document.getElementById('screen');
  if (state.activeTab === 'dashboard') screen.innerHTML = renderDashboard();
  else if (state.activeTab === 'holdings') screen.innerHTML = renderHoldings();
  else if (state.activeTab === 'dividends') screen.innerHTML = renderDividends();
  else if (state.activeTab === 'calendar') screen.innerHTML = renderCalendar();
  else if (state.activeTab === 'snowball') screen.innerHTML = renderSnowball();
  else if (state.activeTab === 'settings') screen.innerHTML = renderSettings();

  attachGlobalHandlers();
  if (state.activeTab === 'snowball') attachSnowballHandlers();
  if (state.activeTab === 'settings') attachSettingsHandlers();
}

function renderTopbar() {
  const fx = state.settings.usdTryRate;
  return `
    <div class="topbar">
      <div class="brand">
        <div class="ring"></div>
        <h1>Kartopu</h1>
      </div>
      <div class="fx-pill">$1 = ₺${fx.toFixed(2)}</div>
    </div>
  `;
}

const TAB_ICONS = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="12.5" width="4.5" height="8" rx="1.2"/><rect x="9.75" y="8" width="4.5" height="12.5" rx="1.2"/><rect x="16" y="4.5" width="4.5" height="16" rx="1.2"/></svg>',
  holdings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2.2"/><path d="M8 7V5.6C8 4.7 8.7 4 9.6 4h4.8c.9 0 1.6.7 1.6 1.6V7"/><path d="M3 12h18"/></svg>',
  dividends: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9.5" cy="9.5" r="6"/><circle cx="15.2" cy="15.2" r="6" opacity="0.55"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.2"/><path d="M3.5 9.8h17"/><path d="M8 3v3.2"/><path d="M16 3v3.2"/><circle cx="8.2" cy="13.6" r="1"/><circle cx="12" cy="13.6" r="1"/><circle cx="15.8" cy="13.6" r="1"/><circle cx="8.2" cy="17" r="1"/><circle cx="12" cy="17" r="1"/></svg>',
  snowball: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8.3"/><circle cx="12" cy="12" r="5.4"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M12 3.6v2.1M12 18.3v2.1M20.4 12h-2.1M5.7 12H3.6M17.6 6.4l-1.5 1.5M7.9 16.1l-1.5 1.5M17.6 17.6l-1.5-1.5M7.9 7.9L6.4 6.4"/></svg>',
};

function renderTabbar() {
  const tabs = [
    { id: 'dashboard', label: 'Özet' },
    { id: 'holdings', label: 'Portföy' },
    { id: 'dividends', label: 'Temettü' },
    { id: 'calendar', label: 'Takvim' },
    { id: 'snowball', label: 'Kartopu' },
    { id: 'settings', label: 'Ayarlar' },
  ];
  return `
    <div class="tabbar">
      ${tabs.map(function(t) {
        return `
        <button data-tab="${t.id}" class="${state.activeTab === t.id ? 'active' : ''}">
          <span class="ic">${TAB_ICONS[t.id]}</span>
          <span>${t.label}</span>
        </button>`;
      }).join('')}
    </div>
  `;
}

function renderFab() {
  if (state.activeTab === 'holdings') return `<button class="fab" id="fab-add-holding">+</button>`;
  if (state.activeTab === 'dividends') return `<button class="fab" id="fab-add-dividend">+</button>`;
  return '';
}

function attachGlobalHandlers() {
  qsaEach(document, '.tabbar button', function(btn) {
    btn.addEventListener('click', function() {
      state.activeTab = btn.dataset.tab;
      render();
    });
  });
  const fabH = document.getElementById('fab-add-holding');
  if (fabH) fabH.addEventListener('click', function() { openHoldingForm(); });
  const fabD = document.getElementById('fab-add-dividend');
  if (fabD) fabD.addEventListener('click', function() { openDividendForm(); });
  const refreshBtn = document.getElementById('refresh-prices');
  if (refreshBtn) refreshBtn.addEventListener('click', function() {
    const status = document.getElementById('price-refresh-status');
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Güncelleniyor…';
    if (status) status.textContent = 'BIST ve ABD fiyatları alınıyor…';
    refreshAllMarketData({ force: true }).then(function(result) {
      render();
      setTimeout(function() {
        const el = document.getElementById('price-refresh-status');
        if (!el) return;
        el.textContent = result.updated + ' pozisyon güncellendi' + (result.errors.length ? ' · ' + result.errors.length + ' sembol alınamadı' : '') + '.';
      }, 0);
    }).catch(function(err) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '↻ Fiyatları Güncelle';
      if (status) status.textContent = 'Güncellenemedi: ' + err.message + ' Manuel fiyat girişi kullanılabilir.';
    });
  });

  qsaEach(document, '[data-holding-id]', function(row) {
    row.addEventListener('click', function() {
      const h = state.holdings.find(function(x) { return x.id === row.dataset.holdingId; });
     if (h) openHoldingDetail(h);
    });
  });
  qsaEach(document, '[data-dividend-id]', function(row) {
    row.addEventListener('click', function() {
      const d = state.dividends.find(function(x) { return x.id === row.dataset.dividendId; });
      if (d) openDividendForm(d);
    });
  });
  qsaEach(document, '.sort-tabs button', function(btn) {
    btn.addEventListener('click', function() {
      state.holdingsSort = btn.dataset.sort;
      render();
    });
  });
}

/* ---------------- Dashboard ---------------- */

function renderDashboard() {
  const totalValue = totalPortfolioValueTRY();
  const totalCost = totalPortfolioCostTRY();
  const pnl = totalValue - totalCost;
  const pnlPct = totalCost > 0 ? pnl / totalCost : 0;
  const yearDividend = thisYearNetDividendTRY();
  const dividendGoal = Number(state.settings.dividendGoalAnnual || 0);
  const dividendGoalPct = dividendGoal > 0 ? Math.min(yearDividend / dividendGoal, 1) : 0;
  const yieldOnCost = totalCost > 0 ? last12MonthsNetDividendTRY() / totalCost : 0;
  const alloc = marketAllocation();
  const allocTotal = (alloc.BIST + alloc.GLOBAL) || 1;
  const bistPct = alloc.BIST / allocTotal;
  const reminders = upcomingReminders();

  if (state.holdings.length === 0 && state.dividends.length === 0) {
    return `
      <div class="empty">
        <div class="ic ic-lg">${TAB_ICONS.dashboard}</div>
        <h3 style="margin:0 0 4px;">Henüz veri yok</h3>
        <p>Portföy sekmesinden ilk pozisyonunu ekleyerek başla.</p>
        <button class="btn btn-primary" style="width:auto; padding:11px 22px;" onclick="state.activeTab='holdings'; render();">Portföy Ekle</button>
      </div>
    `;
  }

  return `
    <div class="kpi-grid">
      <div class="kpi">
        <div class="lbl">Toplam Değer</div>
        <div class="val">${fmtMoney(totalValue, 'TRY')}</div>
        <div class="sub" style="color:${pnl >= 0 ? 'var(--green)' : 'var(--red)'}">${pnl >= 0 ? '▲' : '▼'} ${fmtMoney(Math.abs(pnl),'TRY')} (${fmtPct(pnlPct)})</div>
      </div>
      <div class="kpi">
        <div class="lbl">Bu Yıl Net Temettü</div>
        <div class="val gold">${fmtMoney(yearDividend, 'TRY')}</div>
        <div class="sub">stopaj sonrası</div>
      </div>
      <div class="kpi">
        <div class="lbl">Net Verim (12 ay)</div>
        <div class="val">${fmtPct(yieldOnCost)}</div>
        <div class="sub">maliyete göre</div>
      </div>
      <div class="kpi">
        <div class="lbl">Pozisyon</div>
        <div class="val">${state.holdings.length}</div>
        <div class="sub">${state.dividends.length} temettü kaydı</div>
      </div>
    </div>
        ${dividendGoal > 0 ? `
    <div class="card">
      <div class="card-title">Yıllık Temettü Hedefi</div>

      <div style="display:flex; justify-content:space-between; align-items:flex-end; gap:12px;">
        <div>
          <div class="meta">Bu yıl</div>
          <div style="font-family:'IBM Plex Mono',monospace; font-size:22px; font-weight:600; color:#9C7A2E;">
            ${fmtMoney(yearDividend, 'TRY')}
          </div>
        </div>

        <div style="text-align:right;">
          <div class="meta">Hedef</div>
          <strong>${fmtMoney(dividendGoal, 'TRY')}</strong>
        </div>
      </div>

      <div style="height:9px; background:var(--paper-line); border-radius:999px; overflow:hidden; margin-top:12px;">
        <div style="height:100%; width:${Math.round(dividendGoalPct * 100)}%; background:#9C7A2E; border-radius:999px;"></div>
      </div>

      <div class="meta" style="margin-top:7px;">
        %${Math.round(dividendGoalPct * 100)} tamamlandı
      </div>
    </div>
    ` : ''}

    <div class="card">
      <div class="card-title">Piyasa Dağılımı</div>
      <div style="display:flex; height:10px; border-radius:8px; overflow:hidden; margin-bottom:10px;">
        <div style="width:${bistPct*100}%; background:var(--gold);"></div>
        <div style="width:${(1-bistPct)*100}%; background:var(--pine-light);"></div>
      </div>
      <div style="display:flex; justify-content:space-between; font-size:12.5px;">
        <span><span class="tag bist">BIST</span>${fmtMoney(alloc.BIST,'TRY')} · ${fmtPct(bistPct)}</span>
        <span><span class="tag global">Global</span>${fmtMoney(alloc.GLOBAL,'TRY')} · ${fmtPct(1-bistPct)}</span>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Son Temettüler</div>
      ${reminders.length === 0 ? '<p class="helper-text">Henüz temettü kaydı yok.</p>' : reminders.map(function(d) {
        return `
        <div class="row">
          <div style="display:flex; align-items:center; flex:1; min-width:0;">
            ${avatarHtml(d.symbol)}
            <div class="left">
              <span class="symbol">${d.symbol}</span>
              <span class="meta">${fmtDate(d.date)}</span>
            </div>
          </div>
          <div class="right">
            <div>${fmtMoney(dividendNetTRY(d),'TRY')}</div>
          </div>
        </div>`;
      }).join('')}
    </div>
  `;
}

/* ---------------- Holdings ---------------- */

function renderHoldings() {
  if (state.holdings.length === 0) {
    return `
      <div class="empty">
        <div class="ic ic-lg">${TAB_ICONS.holdings}</div>
        <h3 style="margin:0 0 4px;">Portföyün boş</h3>
        <p>Sağ alttaki + tuşuyla ilk pozisyonunu ekle — BIST hissesi veya global ETF/hisse olabilir.</p>
      </div>
    `;
  }
  if (!state.holdingsSort) state.holdingsSort = 'value';
  const sortMode = state.holdingsSort;

  const enriched = state.holdings.map(function(h) {
    const value = holdingValueTRY(h);
    const cost = holdingCostTRY(h);
    const pnl = value - cost;
    const pnlPct = cost > 0 ? pnl/cost : 0;
    const previousClose = Number(h.previousClose);
    const dayPct = previousClose > 0 ? (Number(h.currentPrice) - previousClose) / previousClose : null;
    return { h: h, value: value, cost: cost, pnl: pnl, pnlPct: pnlPct, dayPct: dayPct, annualNet: annualNetDividendForHolding(h) };
  });

  let sorted;
  if (sortMode === 'name') sorted = enriched.slice().sort(function(a,b) { return a.h.symbol < b.h.symbol ? -1 : 1; });
  else if (sortMode === 'return') sorted = enriched.slice().sort(function(a,b) { return b.pnlPct - a.pnlPct; });
  else sorted = enriched.slice().sort(function(a,b) { return b.value - a.value; });

  const totalValue = totalPortfolioValueTRY();
  const totalCost = totalPortfolioCostTRY();
  const totalPnl = totalValue - totalCost;
  const totalPnlPct = totalCost > 0 ? totalPnl/totalCost : 0;
   let dayChangeTRY = 0;
let previousValueTRY = 0;

state.holdings.forEach(function(h) {
  if (h.currentPrice === null || h.currentPrice === undefined ||
      h.previousClose === null || h.previousClose === undefined) return;

  const currentPrice = Number(h.currentPrice);
  const previousClose = Number(h.previousClose);
  const shares = Number(h.shares);

  if (!isFinite(currentPrice) || !isFinite(previousClose) || previousClose <= 0) return;

  dayChangeTRY += toTRY((currentPrice - previousClose) * shares, h.currency);
  previousValueTRY += toTRY(previousClose * shares, h.currency);
});

const dayChangePct = previousValueTRY > 0 ? dayChangeTRY / previousValueTRY : null;

  return `
    <div class="card" style="text-align:center;">
      <div class="card-title" style="text-align:left;">Toplam Portföy</div>
      <div style="font-family:'IBM Plex Mono',monospace; font-size:26px; font-weight:600;">${fmtMoney(totalValue,'TRY')}</div>
      <div style="color:${totalPnl>=0?'var(--green)':'var(--red)'}; font-size:13px; margin-top:4px;">${totalPnl>=0?'▲':'▼'} ${fmtMoney(Math.abs(totalPnl),'TRY')} (${fmtPct(totalPnlPct)})</div>
      ${dayChangePct !== null ? `<div style="color:${dayChangeTRY>=0?'var(--green)':'var(--red)'}; font-size:13px; margin-top:5px;">Bugün ${dayChangeTRY>=0?'▲':'▼'} ${fmtMoney(Math.abs(dayChangeTRY),'TRY')} (${fmtPct(Math.abs(dayChangePct))})</div>` : ''}
      <button class="btn btn-gold" id="refresh-prices" style="width:100%; margin-top:14px;">↻ Fiyatları Güncelle</button>
      <p class="helper-text" id="price-refresh-status" style="margin-bottom:0;">${priceStatusText()}</p>
    </div>

    <div class="sort-tabs">
      <button data-sort="value" class="${sortMode==='value'?'active':''}">Değere göre</button>
      <button data-sort="name" class="${sortMode==='name'?'active':''}">İsme göre</button>
      <button data-sort="return" class="${sortMode==='return'?'active':''}">Getiriye göre</button>
    </div>

    <div class="card">
      ${sorted.map(function(item) {
        const h = item.h;
        return `
        <div class="row holding-row" data-holding-id="${h.id}">
          <div style="display:flex; align-items:center; flex:1; min-width:0;">
            ${avatarHtml(h.symbol)}
            <div class="left">
              <span class="symbol">${h.symbol} <span class="tag ${h.market==='BIST'?'bist':'global'}">${h.market==='BIST'?'BIST':'Global'}</span></span>
              <span class="meta">${h.shares} adet · Güncel ${fmtMoney((h.currentPrice!==null && h.currentPrice!==undefined)?h.currentPrice:h.avgCost, h.currency)} · ${fmtPct(Math.abs(item.pnlPct))} getiri</span>
${item.dayPct !== null ? `<span class="meta" style="color:${item.dayPct >= 0 ? 'var(--green)' : 'var(--red)'};">Bugün ${item.dayPct >= 0 ? '▲' : '▼'} ${fmtPct(Math.abs(item.dayPct))}</span>` : ''}
<span class="meta" style="color:#9C7A2E;">Yıllık: ${fmtMoney(item.annualNet,'TRY')} net</span>
              ${h.priceAuto && h.priceUpdatedAt ? '<span class="meta market-source">Otomatik · ' + new Date(h.priceUpdatedAt).toLocaleTimeString('tr-TR',{hour:'2-digit',minute:'2-digit'}) + '</span>' : ''}
            </div>
          </div>
          <div class="right">
            <div>${fmtMoney(item.value, 'TRY')}</div>
            <div class="${item.pnl>=0?'pnl-pos':'pnl-neg'}">${item.pnl>=0?'▲':'▼'} ${fmtMoney(Math.abs(item.pnl),'TRY')}</div>
          </div>
        </div>`;
      }).join('')}
    </div>
    <p class="helper-text">Bir pozisyona dokunarak detaylarını görüntüleyebilirsin.</p>
  `;
}
function openHoldingDetail(h) {
  if (!h) return;

  const value = holdingValueTRY(h);
  const cost = holdingCostTRY(h);
  const pnl = value - cost;
  const pnlPct = cost > 0 ? pnl / cost : 0;

  const currentPrice =
    (h.currentPrice !== null && h.currentPrice !== undefined && h.currentPrice !== '')
      ? Number(h.currentPrice)
      : Number(h.avgCost);

  const previousClose =
    (h.previousClose !== null && h.previousClose !== undefined && h.previousClose !== '')
      ? Number(h.previousClose)
      : null;

  const dayPct =
    previousClose !== null && previousClose > 0
      ? (currentPrice - previousClose) / previousClose
      : null;

  const dayChange =
    previousClose !== null && previousClose > 0
      ? (currentPrice - previousClose) * Number(h.shares)
      : null;

  const annualNet = annualNetDividendForHolding(h);
  const dividendHistory = state.dividends
  .filter(function(d) {
    return d.symbol.toUpperCase() === h.symbol.toUpperCase();
  })
  .sort(function(a, b) {
    return new Date(b.date) - new Date(a.date);
  });
   
  const overlay = document.createElement('div');
  overlay.className = 'overlay';

  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-head">
        <h2>${h.symbol} Detay</h2>
        <button class="close-x">✕</button>
      </div>

      <div class="card">
        <div class="card-title">Pozisyon Özeti</div>

        <p><strong>${h.shares} adet</strong></p>

        <p>
          Ortalama Maliyet:
          <strong>${fmtMoney(h.avgCost, h.currency)}</strong>
        </p>

        <p>
          Güncel Fiyat:
          <strong>${fmtMoney(currentPrice, h.currency)}</strong>
        </p>

        <p>
          Pozisyon Değeri:
          <strong>${fmtMoney(value, 'TRY')}</strong>
        </p>

        <p>
          Toplam Getiri:
          <strong style="color:${pnl >= 0 ? 'var(--green)' : 'var(--red)'};">
            ${pnl >= 0 ? '▲' : '▼'} ${fmtMoney(Math.abs(pnl), 'TRY')}
            (${fmtPct(Math.abs(pnlPct))})
          </strong>
        </p>

        ${dayPct !== null ? `
          <p>
            Bugün:
            <strong style="color:${dayPct >= 0 ? 'var(--green)' : 'var(--red)'};">
              ${dayPct >= 0 ? '▲' : '▼'}
              ${fmtMoney(Math.abs(dayChange), h.currency)}
              (${fmtPct(Math.abs(dayPct))})
            </strong>
          </p>
        ` : ''}

        <p>
          Yıllık Net Temettü:
          <strong style="color:#9C7A2E;">
            ${fmtMoney(annualNet, 'TRY')}
          </strong>
                </p>

        <div style="margin-top:20px; padding-top:16px; border-top:1px solid var(--paper-line);">
          <div class="card-title" style="margin-bottom:10px;">Temettü Geçmişi</div>

          ${dividendHistory.length === 0 ? `
            <p class="helper-text" style="margin:0;">
              Henüz temettü kaydı yok.
            </p>
          ` : dividendHistory.map(function(d) {
            return `
              <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid var(--paper-line);">
                <div>
                  <strong>${fmtDate(d.date)}</strong>
                  <div class="meta">
                    ${fmtMoney(d.perShare, d.currency)} / adet · ${d.shares} adet
                  </div>
                </div>

                <strong style="color:#9C7A2E;">
                  ${fmtMoney(dividendNetTRY(d), 'TRY')}
                </strong>
              </div>
            `;
          }).join('')}
        </div>

        <div style="display:flex; gap:10px; margin-top:18px;">
  <button class="btn btn-primary" id="add-buy-detail" style="flex:1;">
    Alış Ekle
  </button>

  <button class="btn" id="edit-holding-detail" style="flex:1;">
    Düzenle
  </button>
</div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
   overlay.querySelector('#add-buy-detail').addEventListener('click', function() {
  overlay.remove();
  openBuyForm(h);
});
     overlay.querySelector('#edit-holding-detail').addEventListener('click', function() {
     overlay.remove();
     openHoldingForm(h);
  });

  overlay.querySelector('.close-x').addEventListener('click', function() {
    overlay.remove();
  });
}

function openBuyForm(h) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';

  const today = new Date().toISOString().slice(0, 10);

  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-head">
        <h2>${h.symbol} Alış Ekle</h2>
        <button class="close-x">✕</button>
      </div>

      <div class="field">
        <label>Alış Tarihi</label>
        <input type="date" id="buy-date" value="${today}">
      </div>

      <div class="field-row">
        <div class="field">
          <label>Adet</label>
          <input type="number" step="any" id="buy-shares" class="mono" placeholder="Örn. 50">
        </div>

        <div class="field">
          <label>Alış Fiyatı</label>
          <input type="number" step="any" id="buy-price" class="mono" placeholder="Örn. 200">
        </div>
      </div>

      <button class="btn btn-primary" id="save-buy" style="width:100%; margin-top:16px;">
        Alışı Kaydet
      </button>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('.close-x').addEventListener('click', function() {
    overlay.remove();
  });

  overlay.querySelector('#save-buy').addEventListener('click', function() {
    const shares = parseFloat(overlay.querySelector('#buy-shares').value);
    const price = parseFloat(overlay.querySelector('#buy-price').value);
    const date = overlay.querySelector('#buy-date').value;

    if (!shares || shares <= 0 || !price || price <= 0 || !date) {
      alert('Tarih, adet ve alış fiyatı zorunlu.');
      return;
    }

    const oldShares = Number(h.shares || 0);
    const oldAvgCost = Number(h.avgCost || 0);

    const newShares = oldShares + shares;
    const newAvgCost =
      ((oldShares * oldAvgCost) + (shares * price)) / newShares;

    h.shares = newShares;
    h.avgCost = newAvgCost;

    state.transactions.push({
      id: uid(),
      holdingId: h.id,
      type: 'BUY',
      market: h.market,
      symbol: h.symbol,
      shares: shares,
      price: price,
      currency: h.currency,
      date: date
    });

    saveState();
    overlay.remove();
    render();
  });
}

function openHoldingForm(existing) {
  const isEdit = !!existing;
  const h = existing || { market: 'BIST', symbol: '', shares: '', avgCost: '', currentPrice: '', currency: 'TRY' };
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-head">
        <h2>${isEdit ? 'Pozisyonu Düzenle' : 'Yeni Pozisyon'}</h2>
        <button class="close-x">✕</button>
      </div>
      <div class="field">
        <label>Piyasa</label>
        <div class="seg" id="seg-market">
          <button type="button" data-val="BIST" class="${h.market==='BIST'?'active':''}">BIST</button>
          <button type="button" data-val="GLOBAL" class="${h.market==='GLOBAL'?'active':''}">Global</button>
        </div>
      </div>
      <div class="field">
        <label>Sembol</label>
        <input type="text" id="f-symbol" placeholder="Örn. THYAO, SCHD" value="${h.symbol}" style="text-transform:uppercase;">
      </div>
      <div class="field-row">
        <div class="field">
          <label>Adet</label>
          <input type="number" step="any" id="f-shares" class="mono" value="${h.shares}">
        </div>
        <div class="field">
          <label>Ort. Maliyet (birim)</label>
          <input type="number" step="any" id="f-avgcost" class="mono" value="${h.avgCost}">
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Para Birimi</label>
          <div class="seg" id="seg-currency">
            <button type="button" data-val="TRY" class="${h.currency==='TRY'?'active':''}">₺ TRY</button>
            <button type="button" data-val="USD" class="${h.currency==='USD'?'active':''}">$ USD</button>
          </div>
        </div>
        <div class="field">
          <label>Güncel Fiyat (manuel / opsiyonel)</label>
          <input type="number" step="any" id="f-price" class="mono" placeholder="otomatik alınır; gerekirse elle gir" value="${(h.currentPrice !== null && h.currentPrice !== undefined) ? h.currentPrice : ''}">
        </div>
      </div>
      <button class="btn btn-primary" id="save-holding">${isEdit ? 'Kaydet' : 'Ekle'}</button>
      ${isEdit ? '<button class="btn btn-danger" id="delete-holding" style="width:100%; margin-top:8px;">Sil</button>' : ''}
    </div>
  `;
  document.body.appendChild(overlay);

  let market = h.market, currency = h.currency;
  overlay.querySelector('#seg-market').addEventListener('click', function(e) {
    if (e.target.tagName !== 'BUTTON') return;
    market = e.target.dataset.val;
    qsaEach(overlay, '#seg-market button', function(b) { b.classList.toggle('active', b.dataset.val === market); });
  });
  overlay.querySelector('#seg-currency').addEventListener('click', function(e) {
    if (e.target.tagName !== 'BUTTON') return;
    currency = e.target.dataset.val;
    qsaEach(overlay, '#seg-currency button', function(b) { b.classList.toggle('active', b.dataset.val === currency); });
  });
  overlay.querySelector('.close-x').addEventListener('click', function() { overlay.remove(); });
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('#save-holding').addEventListener('click', function() {
    const symbol = overlay.querySelector('#f-symbol').value.trim().toUpperCase();
    const shares = parseFloat(overlay.querySelector('#f-shares').value);
    const avgCost = parseFloat(overlay.querySelector('#f-avgcost').value);
    const priceRaw = overlay.querySelector('#f-price').value;
    if (!symbol || !shares || !avgCost) { alert('Sembol, adet ve maliyet zorunlu.'); return; }
    const record = Object.assign({}, isEdit ? h : {}, {
      id: isEdit ? h.id : uid(),
      market: market, symbol: symbol, shares: shares, avgCost: avgCost, currency: currency,
      currentPrice: priceRaw ? parseFloat(priceRaw) : (isEdit ? h.currentPrice : null),
    });
    if (priceRaw && (!isEdit || Number(priceRaw) !== Number(h.currentPrice))) {
      record.priceAuto = false;
      record.priceSource = 'Manuel';
      record.priceUpdatedAt = new Date().toISOString();
    }
 if (isEdit) {
   const idx = state.holdings.findIndex(function(x) { return x.id === h.id; });
   state.holdings[idx] = record;
   } else {
   state.holdings.push(record);
state.transactions.push({
   id: uid(),
   holdingId: record.id,
   type: 'BUY',
   market: record.market,
   symbol: record.symbol,
   shares: record.shares,
   price: record.avgCost,
   currency: record.currency,
   date: new Date().toISOString().slice(0, 10)
});
    }
    saveState();
    overlay.remove();
    render();
  });

  if (isEdit) {
    overlay.querySelector('#delete-holding').addEventListener('click', function() {
      if (!confirm(h.symbol + ' pozisyonunu silmek istediğine emin misin?')) return;
      state.holdings = state.holdings.filter(function(x) { return x.id !== h.id; });
      saveState();
      overlay.remove();
      render();
    });
  }
}

/* ---------------- Dividends ---------------- */

function renderDividends() {
  if (state.dividends.length === 0) {
    return `
      <div class="empty">
        <div class="ic ic-lg">${TAB_ICONS.dividends}</div>
        <h3 style="margin:0 0 4px;">Henüz temettü kaydı yok</h3>
        <p>Aldığın her temettü ödemesini + tuşuyla ekle. Stopaj sonrası net tutar otomatik hesaplanır.</p>
      </div>
    `;
  }
  const sorted = state.dividends.slice().sort(function(a,b) { return a.date < b.date ? 1 : -1; });
  return `
    <div class="card">
      ${sorted.map(function(d) {
        const gross = dividendGrossTRY(d);
        const net = dividendNetTRY(d);
        return `
        <div class="row" data-dividend-id="${d.id}">
          <div style="display:flex; align-items:center; flex:1; min-width:0;">
            ${avatarHtml(d.symbol)}
            <div class="left">
              <span class="symbol">${d.symbol} <span class="tag ${d.market==='BIST'?'bist':'global'}">${d.market==='BIST'?'BIST':'Global'}</span></span>
              <span class="meta">${fmtDate(d.date)} · ${d.shares} adet × ${fmtMoney(d.perShare, d.currency, {decimals:4})}</span>
            </div>
          </div>
          <div class="right">
            <div>${fmtMoney(net,'TRY')}</div>
            <div class="meta" style="font-size:10.5px;">brüt ${fmtMoney(gross,'TRY')}</div>
          </div>
        </div>`;
      }).join('')}
    </div>
    <p class="helper-text">Bir satıra dokunarak düzenleyebilir veya silebilirsin.</p>
  `;
}

function openDividendForm(existing) {
  const isEdit = !!existing;
  const d = existing || { market: 'BIST', symbol: '', date: new Date().toISOString().slice(0,10), perShare: '', shares: '', currency: 'TRY' };
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-head">
        <h2>${isEdit ? 'Temettüyü Düzenle' : 'Yeni Temettü'}</h2>
        <button class="close-x">✕</button>
      </div>
      <div class="field">
        <label>Piyasa</label>
        <div class="seg" id="seg-market">
          <button type="button" data-val="BIST" class="${d.market==='BIST'?'active':''}">BIST</button>
          <button type="button" data-val="GLOBAL" class="${d.market==='GLOBAL'?'active':''}">Global</button>
        </div>
      </div>
      <div class="field">
        <label>Sembol</label>
        <input type="text" id="f-symbol" placeholder="Örn. THYAO, SCHD" value="${d.symbol}" style="text-transform:uppercase;">
      </div>
      <div class="field">
        <label>Ödeme Tarihi</label>
        <input type="date" id="f-date" value="${d.date}">
      </div>
      <div class="field-row">
        <div class="field">
          <label>Hisse Başı Temettü</label>
          <input type="number" step="any" id="f-pershare" class="mono" value="${d.perShare}">
        </div>
        <div class="field">
          <label>Adet</label>
          <input type="number" step="any" id="f-shares" class="mono" value="${d.shares}">
        </div>
      </div>
      <div class="field">
        <label>Para Birimi</label>
        <div class="seg" id="seg-currency">
          <button type="button" data-val="TRY" class="${d.currency==='TRY'?'active':''}">₺ TRY</button>
          <button type="button" data-val="USD" class="${d.currency==='USD'?'active':''}">$ USD</button>
        </div>
      </div>
      <button class="btn btn-primary" id="save-dividend">${isEdit ? 'Kaydet' : 'Ekle'}</button>
      ${isEdit ? '<button class="btn btn-danger" id="delete-dividend" style="width:100%; margin-top:8px;">Sil</button>' : ''}
    </div>
  `;
  document.body.appendChild(overlay);

  let market = d.market, currency = d.currency;
  overlay.querySelector('#seg-market').addEventListener('click', function(e) {
    if (e.target.tagName !== 'BUTTON') return;
    market = e.target.dataset.val;
    qsaEach(overlay, '#seg-market button', function(b) { b.classList.toggle('active', b.dataset.val === market); });
  });
  overlay.querySelector('#seg-currency').addEventListener('click', function(e) {
    if (e.target.tagName !== 'BUTTON') return;
    currency = e.target.dataset.val;
    qsaEach(overlay, '#seg-currency button', function(b) { b.classList.toggle('active', b.dataset.val === currency); });
  });
  overlay.querySelector('.close-x').addEventListener('click', function() { overlay.remove(); });
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('#save-dividend').addEventListener('click', function() {
    const symbol = overlay.querySelector('#f-symbol').value.trim().toUpperCase();
    const date = overlay.querySelector('#f-date').value;
    const perShare = parseFloat(overlay.querySelector('#f-pershare').value);
    const shares = parseFloat(overlay.querySelector('#f-shares').value);
    if (!symbol || !date || !perShare || !shares) { alert('Tüm alanları doldur.'); return; }
    const record = { id: isEdit ? d.id : uid(), market: market, symbol: symbol, date: date, perShare: perShare, shares: shares, currency: currency };
    if (isEdit) {
      const idx = state.dividends.findIndex(function(x) { return x.id === d.id; });
      state.dividends[idx] = record;
    } else {
      state.dividends.push(record);
    }
    saveState();
    overlay.remove();
    render();
  });

  if (isEdit) {
    overlay.querySelector('#delete-dividend').addEventListener('click', function() {
      if (!confirm(d.symbol + ' — ' + fmtDate(d.date) + ' kaydını silmek istediğine emin misin?')) return;
      state.dividends = state.dividends.filter(function(x) { return x.id !== d.id; });
      saveState();
      overlay.remove();
      render();
    });
  }
}

/* ---------------- Calendar (Takvim) ---------------- */

const AY_ISIMLERI = ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'];
const AY_KISA = ['O','Ş','M','N','M','H','T','A','E','E','K','A'];

function renderCalendar() {
  if (state.holdings.length === 0) {
    return `
      <div class="empty">
        <div class="ic ic-lg">${TAB_ICONS.calendar}</div>
        <h3 style="margin:0 0 4px;">Takvim için pozisyon gerekli</h3>
        <p>Portföyüne en az bir pozisyon ekle, geçmiş temettü kaydı girdikçe gelecek ödemeler burada tahmin edilir.</p>
      </div>
    `;
  }

  const projected = allProjectedPayments(12);
  const now = new Date();
  const thisMonthPayments = projected.filter(function(p) {
    const d = new Date(p.date + 'T00:00:00');
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const thisMonthTotal = thisMonthPayments.reduce(function(sum, p) { return sum + toTRY(p.perShare * p.shares, p.currency) * (1 - withholdingRateFor(p.market)); }, 0);
  const thisMonthSymbols = thisMonthPayments.map(function(p){ return p.symbol; });

  // yearly distribution (current calendar year, Jan-Dec) combining actual + projected
  const year = now.getFullYear();
  const monthTotals = new Array(12).fill(0);
  state.dividends.filter(function(d) { return new Date(d.date+'T00:00:00').getFullYear() === year; })
    .forEach(function(d) { monthTotals[new Date(d.date+'T00:00:00').getMonth()] += dividendNetTRY(d); });
  projected.filter(function(p) { return new Date(p.date+'T00:00:00').getFullYear() === year; })
    .forEach(function(p) { monthTotals[new Date(p.date+'T00:00:00').getMonth()] += toTRY(p.perShare*p.shares, p.currency) * (1 - withholdingRateFor(p.market)); });

  const maxMonth = Math.max.apply(null, monthTotals.concat([1]));
  const maxIdx = monthTotals.indexOf(maxMonth);

  // group projected by month label for the list
  const groups = {};
  projected.forEach(function(p) {
    const d = new Date(p.date + 'T00:00:00');
    const key = AY_ISIMLERI[d.getMonth()] + ' ' + d.getFullYear();
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  });
  const groupKeys = Object.keys(groups);

  return `
    <div class="card dark-card">
      <div class="dark-row">
        <span class="dark-ic">${TAB_ICONS.calendar}</span>
        <span class="dark-lbl">BU AY</span>
      </div>
      <div class="dark-big">${fmtMoney(thisMonthTotal,'TRY')}</div>
      <div class="dark-sub">${thisMonthPayments.length} ödeme${thisMonthSymbols.length ? ' · ' + thisMonthSymbols.join(', ') : ''}</div>
    </div>

    <div class="card dark-card">
      <div class="dark-row">
        <span class="dark-ic">${TAB_ICONS.dashboard}</span>
        <span class="dark-lbl">YILLIK DAĞILIM</span>
        <span class="dark-year">${year}</span>
      </div>
      ${renderYearBars(monthTotals)}
      <div class="dark-sub" style="margin-top:8px;">En yüksek: ${AY_ISIMLERI[maxIdx]} · ${fmtMoney(maxMonth,'TRY')}</div>
    </div>

    ${groupKeys.length === 0 ? `
      <div class="empty">
        <p>Önümüzdeki 12 ay için tahmini ödeme yok. Temettü sekmesinden en az bir ödeme kaydettikçe buradaki tahminler oluşur.</p>
      </div>
    ` : groupKeys.map(function(key) {
      const items = groups[key];
      const groupTotal = items.reduce(function(sum,p){ return sum + toTRY(p.perShare*p.shares,p.currency)*(1-withholdingRateFor(p.market)); }, 0);
      return `
      <div class="month-group-head">
        <span>${key.toUpperCase()}</span>
        <span>${fmtMoney(groupTotal,'TRY')}</span>
      </div>
      ${items.map(function(p) {
        const net = toTRY(p.perShare*p.shares,p.currency) * (1-withholdingRateFor(p.market));
        return `
        <div class="card cal-item">
          ${avatarHtml(p.symbol)}
          <div class="left" style="flex:1;">
            <span class="symbol">${p.symbol} <span class="tag ${p.market==='BIST'?'bist':'global'}">${p.market==='BIST'?'BIST':'NYSE'}</span></span>
            <span class="meta">Tahmini · ${fmtMoney(p.perShare, p.currency, {decimals:2})}/adet · ${p.basedOnYear} baz alınarak</span>
          </div>
          <div class="right">
            <div>${fmtMoney(net,'TRY')}</div>
            <div class="meta">${fmtDate(p.date)}</div>
          </div>
        </div>`;
      }).join('')}
    `;
    }).join('')}
    <p class="helper-text">Tahminler, geçmiş temettü kayıtlarındaki ödeme sıklığı ve son bilinen tutara göre hesaplanır. Gerçek ödemeler farklı olabilir — kesinleştiğinde Temettü sekmesinden gerçek kaydı gir.</p>
  `;
}

function renderYearBars(monthTotals) {
  const max = Math.max.apply(null, monthTotals.concat([1]));
  const W = 340, H = 130, gap = 6;
  const barW = (W / 12) - gap;
  const bars = monthTotals.map(function(v, i) {
    const h = max > 0 ? (v / max) * (H - 20) : 0;
    const x = i * (barW + gap);
    const y = H - 20 - h;
    return `<rect x="${x}" y="${y}" width="${barW}" height="${Math.max(h,2)}" rx="3" fill="${v>0 ? '#3C7A5A' : '#E3DDC8'}"></rect>
            <text x="${x + barW/2}" y="${H-6}" font-size="9" fill="#4A5D53" text-anchor="middle" font-family="Inter">${AY_KISA[i]}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${bars}</svg>`;
}

function renderSnowball() {
  const s = state.settings.snowball;
  const cost = totalPortfolioCostTRY();
  const startValue = cost > 0 ? cost : 100000;
  const startDividend = last12MonthsNetDividendTRY() > 0 ? last12MonthsNetDividendTRY() : startValue * 0.04;

  const rows = computeSnowball({
    startValue: startValue, startAnnualDividend: startDividend,
    years: s.years, growthRate: s.growthRate, reinvest: s.reinvest, annualAdd: s.monthlyAdd * 12,
  });
  const finalRow = rows[rows.length - 1];
  const totalDividendsCollected = rows.reduce(function(sum, r) { return sum + r.dividend; }, 0);

  return `
    <div class="card">
      <div class="card-title">Varsayımlar</div>
      <div class="field">
        <label>Başlangıç Portföy Değeri</label>
        <input type="number" id="sb-start" class="mono" value="${Math.round(startValue)}">
        <p class="helper-text">${cost > 0 ? 'Portföy sayfandaki toplam maliyetten alındı, istersen değiştir.' : 'Henüz pozisyon eklemedin — istediğin bir başlangıç değeri gir.'}</p>
      </div>
      <div class="field">
        <label>Yıllık Net Temettü (başlangıç)</label>
        <input type="number" id="sb-div" class="mono" value="${Math.round(startDividend)}">
      </div>
      <div class="field-row">
        <div class="field">
          <label>Yıl Sayısı</label>
          <input type="number" id="sb-years" class="mono" value="${s.years}" min="1" max="40">
        </div>
        <div class="field">
          <label>Yıllık Temettü Büyümesi %</label>
          <input type="number" id="sb-growth" class="mono" value="${(s.growthRate*100).toFixed(1)}" step="0.5">
        </div>
      </div>
      <div class="field">
        <label>Yıllık Ek Katkı (₺)</label>
        <input type="number" id="sb-add" class="mono" value="${s.monthlyAdd*12}">
      </div>
      <div class="switch-row">
        <span style="font-size:13.5px; font-weight:600;">Temettüleri yeniden yatır</span>
        <button class="switch ${s.reinvest ? 'on' : ''}" id="sb-reinvest"></button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">${s.years} Yıl Sonra</div>
      <div class="kpi-grid" style="margin-bottom:12px;">
        <div class="kpi">
          <div class="lbl">Tahmini Değer</div>
          <div class="val">${fmtMoney(finalRow.value,'TRY')}</div>
        </div>
        <div class="kpi">
          <div class="lbl">Yıllık Temettü</div>
          <div class="val gold">${fmtMoney(finalRow.dividend,'TRY')}</div>
        </div>
      </div>
      <div class="rings-wrap">${renderSnowballChart(rows)}</div>
      <div class="snowball-legend">
        <span><span class="dot" style="background:var(--pine-light);"></span>Portföy Değeri</span>
        <span><span class="dot" style="background:var(--gold);"></span>Yıllık Temettü</span>
      </div>
      <p class="helper-text">Toplam ${s.years} yılda tahmini birikmiş net temettü: <strong>${fmtMoney(totalDividendsCollected,'TRY')}</strong>. Bu bir projeksiyondur, gerçek getiriler piyasa koşullarına göre değişir.</p>
    </div>
  `;
}

function renderSnowballChart(rows) {
  const W = 480, H = 220, padL = 44, padB = 24, padT = 10;
  const plotW = W - padL - 10, plotH = H - padB - padT;
  const maxVal = Math.max.apply(null, rows.map(function(r) { return r.value; }));
  const barW = plotW / rows.length;
  const labelStep = Math.ceil(rows.length / 8) || 1;

  const bars = rows.map(function(r, i) {
    const barH = (r.value / maxVal) * plotH;
    const divH = (r.dividend / maxVal) * plotH;
    const x = padL + i * barW + barW * 0.15;
    const w = barW * 0.7;
    const yTop = padT + (plotH - barH);
    const yDivTop = padT + (plotH - divH);
    const showLabel = (i % labelStep === 0) || (i === rows.length - 1);
    return `
      <rect x="${x}" y="${yTop}" width="${w}" height="${barH}" rx="3" fill="url(#pineGrad)"></rect>
      <rect x="${x}" y="${yDivTop}" width="${w}" height="${Math.max(divH,2)}" rx="2" fill="#C9A24B" opacity="0.92"></rect>
      ${showLabel ? '<text x="' + (x+w/2) + '" y="' + (H-6) + '" font-size="9" fill="#4A5D53" text-anchor="middle" font-family="IBM Plex Mono, monospace">' + r.year + '</text>' : ''}
    `;
  }).join('');

  const gridLines = [0,0.25,0.5,0.75,1].map(function(f) {
    const y = padT + plotH*(1-f);
    return '<line x1="' + padL + '" x2="' + (W-10) + '" y1="' + y + '" y2="' + y + '" stroke="#E3DDC8" stroke-width="1"/>';
  }).join('');

  return `
    <svg class="rings-chart" viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
      <defs>
        <linearGradient id="pineGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2C6349"/>
          <stop offset="100%" stop-color="#1D4536"/>
        </linearGradient>
      </defs>
      ${gridLines}
      <text x="4" y="${padT+6}" font-size="9" fill="#4A5D53" font-family="IBM Plex Mono, monospace">${Math.round(maxVal/1000)}b</text>
      ${bars}
    </svg>
  `;
}

function attachSnowballHandlers() {
  const ids = ['sb-start','sb-div','sb-years','sb-growth','sb-add'];
  const recompute = function() {
    state.settings.snowball.years = Math.max(1, Math.min(40, parseInt(document.getElementById('sb-years').value, 10) || 10));
    state.settings.snowball.growthRate = (parseFloat(document.getElementById('sb-growth').value) || 0) / 100;
    state.settings.snowball.monthlyAdd = (parseFloat(document.getElementById('sb-add').value) || 0) / 12;
    saveState();
    render();
  };
  ids.forEach(function(id) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', recompute);
  });
  const reBtn = document.getElementById('sb-reinvest');
  if (reBtn) reBtn.addEventListener('click', function() {
    state.settings.snowball.reinvest = !state.settings.snowball.reinvest;
    saveState();
    render();
  });
}

/* ---------------- Settings ---------------- */

function renderSettings() {
  const s = state.settings;
  const fxDate = s.fxUpdated ? new Date(s.fxUpdated).toLocaleString('tr-TR') : 'hiç güncellenmedi';
  return `
    <div class="card">
      <div class="card-title">Görünüm</div>
      <div class="switch-row">
        <span style="font-size:13.5px; font-weight:600;">Koyu Tema</span>
        <button class="switch ${s.theme === 'dark' ? 'on' : ''}" id="theme-toggle"></button>
      </div>
    </div>

    <div class="card">
    <div class="card-title">Piyasa Verileri</div>
      <div class="switch-row">
        <div>
          <div style="font-size:13.5px; font-weight:600;">Otomatik fiyat güncelleme</div>
          <div class="helper-text" style="margin:3px 0 0;">Uygulama açıldığında fiyatları yeniler.</div>
        </div>
        <button class="switch ${s.autoPriceRefresh ? 'on' : ''}" id="auto-price-toggle"></button>
      </div>
      <div class="field" style="margin-top:8px;">
        <label>Yenileme aralığı</label>
        <select id="set-price-refresh">
          <option value="15" ${Number(s.priceRefreshMinutes)===15?'selected':''}>15 dakika</option>
          <option value="30" ${Number(s.priceRefreshMinutes)===30?'selected':''}>30 dakika</option>
          <option value="60" ${Number(s.priceRefreshMinutes)===60?'selected':''}>60 dakika</option>
        </select>
      </div>
      <p class="helper-text">BIST ve ABD fiyatları ücretsiz piyasa verisinden alınır ve gecikmeli olabilir. Otomatik veri alınamazsa manuel fiyat girişi her zaman kullanılabilir.</p>
      <button class="btn btn-gold" id="settings-refresh-prices" style="width:100%;">Şimdi Fiyatları Güncelle</button>
      <p class="helper-text" id="settings-price-status">${priceStatusText()}</p>
    </div>

    <div class="card">
      <div class="card-title">Kur (USD/TRY)</div>
      <div class="field">
        <label>Güncel Kur</label>
        <input type="number" step="any" id="set-fx" class="mono" value="${s.usdTryRate}">
        <p class="helper-text">Son güncelleme: ${fxDate}</p>
      </div>
      <button class="btn btn-gold" id="fx-fetch" style="width:100%;">Canlı Kuru Çek</button>
      <p class="helper-text" id="fx-status"></p>
    </div>

    <div class="card">
  <div class="card-title">Temettü Hedefi</div>
  <div class="field">
    <label>Yıllık Net Temettü Hedefi (₺)</label>
    <input type="number" step="1000" id="set-dividend-goal" class="mono" value="${s.dividendGoalAnnual || 0}">
    <p class="helper-text">Bu yıl ulaşmak istediğin net temettü gelirini belirle.</p>
  </div>
</div>
   <div class="card">
      <div class="card-title">Stopaj Oranları</div>
      <div class="field-row">
        <div class="field">
          <label>BIST</label>
          <input type="number" step="0.5" id="set-bist-tax" class="mono" value="${(s.bistWithholding*100).toFixed(1)}">
        </div>
        <div class="field">
          <label>Global</label>
          <input type="number" step="0.5" id="set-global-tax" class="mono" value="${(s.globalWithholding*100).toFixed(1)}">
        </div>
      </div>
      <p class="helper-text">Yüzde olarak girilir. Net temettü hesaplamaları bu oranları kullanır.</p>
    </div>

    <div class="card">
      <div class="card-title">Yedekleme</div>
      <p class="helper-text" style="margin-top:0;">Tüm verilerin sadece bu cihazda saklanır. Telefon değiştirirsen veya yedek almak istersen bu dosyayı indir.</p>
      <button class="btn btn-ghost" id="export-data" style="width:100%; margin-bottom:8px;">Verileri Dışa Aktar (.json)</button>
      <label class="btn btn-ghost" style="width:100%; display:flex; cursor:pointer;">
        Verileri İçe Aktar
        <input type="file" id="import-data" accept="application/json" style="display:none;">
      </label>
    </div>

    <div class="card">
      <div class="card-title">Sıfırla</div>
      <button class="btn btn-danger" id="reset-data" style="width:100%;">Tüm Verileri Sil</button>
    </div>

    <p class="helper-text" style="text-align:center;">Kartopu · verilerin sadece bu cihazda, hiçbir sunucuya gönderilmez.</p>
  `;
}

function attachSettingsHandlers() {
  document.getElementById('theme-toggle').addEventListener('click', function() {
    state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
    saveState();
    render();
  });
  document.getElementById('auto-price-toggle').addEventListener('click', function() {
    state.settings.autoPriceRefresh = !state.settings.autoPriceRefresh;
    saveState();
    render();
  });
  document.getElementById('set-price-refresh').addEventListener('change', function(e) {
    state.settings.priceRefreshMinutes = parseInt(e.target.value, 10) || 15;
    saveState();
  });
  document.getElementById('settings-refresh-prices').addEventListener('click', function() {
    const btn = this;
    const status = document.getElementById('settings-price-status');
    btn.disabled = true;
    btn.textContent = 'Güncelleniyor…';
    status.textContent = 'Fiyatlar ve kur alınıyor…';
    refreshAllMarketData({ force: true }).then(function(result) {
      render();
      setTimeout(function() {
        const el = document.getElementById('settings-price-status');
        if (el) el.textContent = result.updated + ' pozisyon güncellendi' + (result.errors.length ? ' · ' + result.errors.length + ' sembol alınamadı' : '') + '.';
      }, 0);
    }).catch(function(err) {
      btn.disabled = false;
      btn.textContent = 'Şimdi Fiyatları Güncelle';
      status.textContent = 'Güncellenemedi: ' + err.message;
    });
  });
  document.getElementById('set-fx').addEventListener('change', function(e) {
    state.settings.usdTryRate = parseFloat(e.target.value) || state.settings.usdTryRate;
    saveState();
  });
   document.getElementById('set-dividend-goal').addEventListener('change', function(e) {
  state.settings.dividendGoalAnnual = Math.max(0, parseFloat(e.target.value) || 0);
  saveState();
});
  document.getElementById('set-bist-tax').addEventListener('change', function(e) {
    state.settings.bistWithholding = (parseFloat(e.target.value) || 0) / 100;
    saveState();
  });
  document.getElementById('set-global-tax').addEventListener('change', function(e) {
    state.settings.globalWithholding = (parseFloat(e.target.value) || 0) / 100;
    saveState();
  });

  document.getElementById('fx-fetch').addEventListener('click', function() {
    const status = document.getElementById('fx-status');
    status.textContent = 'Çekiliyor...';
    fetchLiveFX().then(function(rate) {
      status.textContent = 'Güncellendi: $1 = ₺' + rate.toFixed(4);
      render();
    }).catch(function() {
      status.textContent = 'Çekilemedi — internet bağlantını kontrol et, kuru elle de girebilirsin.';
    });
  });

  document.getElementById('export-data').addEventListener('click', function() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kartopu-yedek-' + new Date().toISOString().slice(0,10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('import-data').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function() {
      try {
        const imported = JSON.parse(reader.result);
        if (!imported.holdings || !imported.dividends) throw new Error('invalid');
        if (!confirm('Mevcut veriler bu yedekle değiştirilecek. Emin misin?')) return;
        state = Object.assign({}, deepClone(DEFAULT_STATE), imported);
        saveState();
        render();
        alert('Veriler içe aktarıldı.');
      } catch (err) {
        alert('Dosya okunamadı. Geçerli bir Kartopu yedek dosyası seç.');
      }
    };
    reader.readAsText(file);
  });

  document.getElementById('reset-data').addEventListener('click', function() {
    if (!confirm('TÜM veriler kalıcı olarak silinecek. Emin misin?')) return;
    if (!confirm('Bu işlem geri alınamaz. Yine de devam et?')) return;
    state = deepClone(DEFAULT_STATE);
    saveState();
    render();
  });
}

/* ---------------- Boot ---------------- */

render();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('./sw.js').catch(function(e) { console.warn('SW register failed', e); });
    setTimeout(maybeAutoRefreshPrices, 350);
  });
} else {
  window.addEventListener('load', function() { setTimeout(maybeAutoRefreshPrices, 350); });
}

window.addEventListener('online', function() { setTimeout(maybeAutoRefreshPrices, 200); });
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible') setTimeout(maybeAutoRefreshPrices, 200);
});
