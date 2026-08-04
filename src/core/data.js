/**
 * Core data access logic.
 */
import { evaluate, evaluateAsync, KNOWN_PATHS } from '../connection.js';

const MAX_OHLCV_BARS = 500;
const MAX_TRADES = 20;
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

function buildGraphicsJS(collectionName, mapKey, filter) {
  return `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      var filter = '${filter}';
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.indexOf(filter) === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var items = [];
          try {
            var outer = pc.${collectionName};
            if (outer) {
              var inner = outer.get('${mapKey}');
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                  coll._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            }
          } catch(e) {}
          if (items.length === 0 && '${collectionName}' === 'dwgtablecells') {
            try {
              var tcOuter = pc.dwgtablecells;
              if (tcOuter) {
                var tcColl = tcOuter.get('tableCells');
                if (tcColl && tcColl._primitivesDataById && tcColl._primitivesDataById.size > 0) {
                  tcColl._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            } catch(e) {}
          }
          if (items.length > 0) results.push({name: name, count: items.length, items: items});
        } catch(e) {}
      }
      return results;
    })()
  `;
}

export async function getOhlcv({ count, summary } = {}) {
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  let data;
  try {
    data = await evaluate(`
      (function() {
        var bars = ${BARS_PATH};
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var result = [];
        var end = bars.lastIndex();
        var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
        }
        return {bars: result, total_bars: bars.size(), source: 'direct_bars'};
      })()
    `);
  } catch { data = null; }

  if (!data || !data.bars || data.bars.length === 0) {
    throw new Error('Could not extract OHLCV data. The chart may still be loading.');
  }

  if (summary) {
    const bars = data.bars;
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const volumes = bars.map(b => b.volume);
    const first = bars[0];
    const last = bars[bars.length - 1];
    return {
      success: true, bar_count: bars.length,
      period: { from: first.time, to: last.time },
      open: first.open, close: last.close,
      high: Math.max(...highs), low: Math.min(...lows),
      range: Math.round((Math.max(...highs) - Math.min(...lows)) * 100) / 100,
      change: Math.round((last.close - first.open) * 100) / 100,
      change_pct: Math.round(((last.close - first.open) / first.open) * 10000) / 100 + '%',
      avg_volume: Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length),
      last_5_bars: bars.slice(-5),
    };
  }

  return { success: true, bar_count: data.bars.length, total_available: data.total_bars, source: data.source, bars: data.bars };
}

export async function getIndicator({ entity_id }) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var study = api.getStudyById('${entity_id}');
      if (!study) return { error: 'Study not found: ${entity_id}' };
      var result = { name: null, inputs: null, visible: null };
      try { result.visible = study.isVisible(); } catch(e) {}
      try { result.inputs = study.getInputValues(); } catch(e) { result.inputs_error = e.message; }
      return result;
    })()
  `);

  if (data?.error) throw new Error(data.error);

  let inputs = data?.inputs;
  if (Array.isArray(inputs)) {
    inputs = inputs.filter(inp => {
      if (inp.id === 'text' && typeof inp.value === 'string' && inp.value.length > 200) return false;
      if (typeof inp.value === 'string' && inp.value.length > 500) return false;
      return true;
    });
  }
  return { success: true, entity_id, visible: data?.visible, inputs };
}

export async function getStrategyResults() {
  const results = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          if (s.metaInfo && s.metaInfo().is_price_study === false && (s.reportData || s.performance)) { strat = s; break; }
        }
        if (!strat) return {metrics: {}, source: 'internal_api', error: 'No strategy found on chart. Add a strategy indicator first.'};
        var metrics = {};
        if (strat.reportData) {
          var rd = typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData;
          if (rd && typeof rd === 'object') {
            if (typeof rd.value === 'function') rd = rd.value();
            if (rd) { var keys = Object.keys(rd); for (var k = 0; k < keys.length; k++) { var val = rd[keys[k]]; if (val !== null && val !== undefined && typeof val !== 'function') metrics[keys[k]] = val; } }
          }
        }
        if (Object.keys(metrics).length === 0 && strat.performance) {
          var perf = strat.performance();
          if (perf && typeof perf.value === 'function') perf = perf.value();
          if (perf && typeof perf === 'object') { var pkeys = Object.keys(perf); for (var p = 0; p < pkeys.length; p++) { var pval = perf[pkeys[p]]; if (pval !== null && pval !== undefined && typeof pval !== 'function') metrics[pkeys[p]] = pval; } }
        }
        return {metrics: metrics, source: 'internal_api'};
      } catch(e) { return {metrics: {}, source: 'internal_api', error: e.message}; }
    })()
  `);
  return { success: true, metric_count: Object.keys(results?.metrics || {}).length, source: results?.source, metrics: results?.metrics || {}, error: results?.error };
}

export async function getTrades({ max_trades } = {}) {
  const limit = Math.min(max_trades || 20, MAX_TRADES);
  const trades = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          if (s.metaInfo && s.metaInfo().is_price_study === false && (s.ordersData || s.reportData)) { strat = s; break; }
        }
        if (!strat) return {trades: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var orders = null;
        if (strat.ordersData) { orders = typeof strat.ordersData === 'function' ? strat.ordersData() : strat.ordersData; if (orders && typeof orders.value === 'function') orders = orders.value(); }
        if (!orders || !Array.isArray(orders)) {
          if (strat._orders) orders = strat._orders;
          else if (strat.tradesData) { orders = typeof strat.tradesData === 'function' ? strat.tradesData() : strat.tradesData; if (orders && typeof orders.value === 'function') orders = orders.value(); }
        }
        if (!orders || !Array.isArray(orders)) return {trades: [], source: 'internal_api', error: 'ordersData() returned non-array.'};
        var result = [];
        for (var t = 0; t < Math.min(orders.length, ${limit}); t++) {
          var o = orders[t];
          if (typeof o === 'object' && o !== null) {
            var trade = {};
            var okeys = Object.keys(o);
            for (var k = 0; k < okeys.length; k++) { var v = o[okeys[k]]; if (v !== null && v !== undefined && typeof v !== 'function' && typeof v !== 'object') trade[okeys[k]] = v; }
            result.push(trade);
          }
        }
        return {trades: result, source: 'internal_api'};
      } catch(e) { return {trades: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  return { success: true, trade_count: trades?.trades?.length || 0, source: trades?.source, trades: trades?.trades || [], error: trades?.error };
}

export async function getEquity() {
  const equity = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          if (s.metaInfo && s.metaInfo().is_price_study === false && (s.reportData || s.performance)) { strat = s; break; }
        }
        if (!strat) return {data: [], source: 'internal_api', error: 'No strategy found on chart.'};
        var data = [];
        if (strat.equityData) {
          var eq = typeof strat.equityData === 'function' ? strat.equityData() : strat.equityData;
          if (eq && typeof eq.value === 'function') eq = eq.value();
          if (Array.isArray(eq)) data = eq;
        }
        if (data.length === 0 && strat.bars) {
          var bars = typeof strat.bars === 'function' ? strat.bars() : strat.bars;
          if (bars && typeof bars.lastIndex === 'function') {
            var end = bars.lastIndex(); var start = bars.firstIndex();
            for (var i = start; i <= end; i++) { var v = bars.valueAt(i); if (v) data.push({time: v[0], equity: v[1], drawdown: v[2] || null}); }
          }
        }
        if (data.length === 0) {
          var perfData = {};
          if (strat.performance) {
            var perf = strat.performance();
            if (perf && typeof perf.value === 'function') perf = perf.value();
            if (perf && typeof perf === 'object') { var pkeys = Object.keys(perf); for (var p = 0; p < pkeys.length; p++) { if (/equity|drawdown|profit|net/i.test(pkeys[p])) perfData[pkeys[p]] = perf[pkeys[p]]; } }
          }
          if (Object.keys(perfData).length > 0) return {data: [], equity_summary: perfData, source: 'internal_api', note: 'Full equity curve not available via API; equity summary metrics returned instead.'};
        }
        return {data: data, source: 'internal_api'};
      } catch(e) { return {data: [], source: 'internal_api', error: e.message}; }
    })()
  `);
  return { success: true, data_points: equity?.data?.length || 0, source: equity?.source, data: equity?.data || [], equity_summary: equity?.equity_summary, note: equity?.note, error: equity?.error };
}

// Fields the scanner exposes per symbol. `change` is a percentage and
// `change_abs` the price move — they are not interchangeable.
const SCANNER_FIELDS = [
  'close', 'open', 'high', 'low', 'volume',
  'change', 'change_abs', 'description', 'type', 'exchange',
].join(',');

// Cap on scanner lookups per unresolved symbol. Each is a network round trip
// and search returns unrelated tail matches — NQ1! pulls up Nordic warrants —
// so trying every hit costs time without improving the odds.
const MAX_QUOTE_CANDIDATES = 6;

// The saved watchlists change on human timescales, and a quote should not pay
// for a refetch. Short enough that an edit shows up within a minute.
const WATCHLIST_TTL_MS = 60_000;
let watchlistCache = { at: 0, index: null };

/**
 * Map bare ticker -> the fully qualified names the user actually follows.
 *
 * Every symbol saved in a watchlist carries its exchange, so the account is a
 * complete statement of which listing is meant by a bare ticker — NASDAQ:PLTR
 * rather than the TSX, BMV or BYMA lines that a search also returns. That is
 * recorded intent, not a guess, which is why it is consulted before search.
 */
async function watchlistIndex() {
  if (watchlistCache.index && Date.now() - watchlistCache.at < WATCHLIST_TTL_MS) {
    return watchlistCache.index;
  }
  let symbols = [];
  try {
    symbols = await evaluateAsync(`
      fetch('/api/v1/symbols_list/all/', { credentials: 'include' })
        .then(function(r) { return r.ok ? r.json() : []; })
        .then(function(lists) {
          var out = [];
          (lists || []).forEach(function(w) {
            (w.symbols || []).forEach(function(s) {
              // '###SECTION' rows are headers, not instruments.
              if (typeof s === 'string' && s.indexOf('###') !== 0 && s.indexOf(':') > 0) out.push(s);
            });
          });
          return out;
        })
        .catch(function() { return []; })
    `) || [];
  } catch {
    symbols = [];
  }

  const index = new Map();
  for (const full of symbols) {
    const bare = full.split(':').pop();
    const seen = index.get(bare);
    if (!seen) index.set(bare, [full]);
    else if (!seen.includes(full)) seen.push(full);
  }
  // An empty result means the fetch failed, not that the account is empty —
  // don't cache that or every later quote inherits the outage.
  if (index.size) watchlistCache = { at: Date.now(), index };
  return index;
}

/**
 * Quote a symbol that is not on the chart.
 *
 * The chart's bar series only ever holds the symbol currently displayed, so a
 * requested symbol has to come from elsewhere: TradingView's scanner, which
 * every watchlist row already uses. The scanner indexes by EXCHANGE:SYMBOL and
 * returns null for a bare ticker or the wrong exchange — BATS:PLTR is null even
 * though the chart displays exactly that.
 *
 * Resolution is tried in descending order of certainty:
 *   1. the name as given
 *   2. the user's own watchlists — recorded intent, no guessing
 *   3. symbol search, but only hits whose ticker is the one asked for
 *
 * There is deliberately no looser fourth pass. Search ranks unrelated tail
 * matches, so one would answer a question nobody asked — BOGUS9 reaches Oslo's
 * BOHUS — and an unknown ticker is better refused than approximated. Both the
 * requested and the resolved name are returned; a caller must never be left
 * assuming it got the symbol it asked for.
 */
async function quoteBySymbol(symbol) {
  const requested = JSON.stringify(symbol);

  const bare = symbol.includes(':') ? symbol.split(':').pop() : symbol;
  const index = await watchlistIndex();
  const fromWatchlist = (index.get(bare) || []).filter(n => n !== symbol);

  // The same ticker on two exchanges is a question only the caller can settle.
  // Picking one would be a coin flip dressed up as an answer.
  if (fromWatchlist.length > 1) {
    throw new Error(
      `"${symbol}" is ambiguous — your watchlists hold it on more than one exchange: `
      + `${fromWatchlist.join(', ')}. Ask for the one you want by its full name.`
    );
  }

  const data = await evaluateAsync(`
    (function() {
      var FIELDS = ${JSON.stringify(SCANNER_FIELDS)};
      var requested = ${requested};
      var MAX_CANDIDATES = ${MAX_QUOTE_CANDIDATES};
      var FROM_WATCHLIST = ${JSON.stringify(fromWatchlist)};

      function scan(sym) {
        return fetch('https://scanner.tradingview.com/symbol?symbol=' + encodeURIComponent(sym)
                     + '&fields=' + encodeURIComponent(FIELDS) + '&no_404=true',
                     { credentials: 'include' })
          .then(function(r) { return r.ok ? r.json() : null; })
          .catch(function() { return null; });
      }

      // Search on the bare ticker: the prefix is what failed, so keeping it
      // would just reproduce the miss.
      function bareOf(sym) { return sym.indexOf(':') >= 0 ? sym.split(':').pop() : sym; }

      // "NQ1!" -> "NQ". Search strips the continuous-contract suffix, returning
      // the root, so the root is what a hit has to be matched against.
      function rootOf(ticker) { return ticker.replace(/\\d+!$/, ''); }

      // Names to try against the scanner, best first.
      //
      // source_id, not exchange, is the prefix the scanner files a symbol
      // under. They agree for equities and for COMEX/NYMEX/CBOT futures, and
      // disagree exactly where it bites: E-mini contracts come back as
      // exchange CME but live under CME_MINI, so CME:NQ1! is null while
      // CME_MINI:NQ1! resolves. The suffix is re-attached because the scanner
      // has no entry for a bare root - CME:NQ is null too.
      function candidatesFor(hits, bare) {
        var root = rootOf(bare);
        // Only hits whose ticker is the one asked for. A looser match is not a
        // weaker answer to the same question, it is an answer to a different
        // one, so it is dropped rather than ranked lower.
        var out = [];
        hits.filter(function(h) { return h.symbol === root; }).forEach(function(h) {
          [h.source_id, h.exchange].forEach(function(prefix) {
            if (prefix) out.push(prefix + ':' + bare);
          });
        });
        return out.filter(function(v, i) { return out.indexOf(v) === i; }).slice(0, MAX_CANDIDATES);
      }

      function firstThatScans(names, tried) {
        if (!names.length) return Promise.resolve({ ok: false, tried: tried });
        var head = names[0];
        tried.push(head);
        return scan(head).then(function(q) {
          if (q && q.close != null) return { ok: true, resolved: head, q: q };
          return firstThatScans(names.slice(1), tried);
        });
      }

      var bare = bareOf(requested);

      // Tier 1 as given, then tier 2 from the watchlists. Search is a network
      // call, so it is only reached once both have missed.
      return firstThatScans([requested].concat(FROM_WATCHLIST), []).then(function(hit) {
        if (hit.ok) return hit;
        return Promise.resolve(window.TradingViewApi.searchSymbols({ text: bare }))
          .then(function(res) { return (res && res.symbols) || []; })
          .catch(function() { return []; })
          .then(function(hits) {
            var names = candidatesFor(hits, bare).filter(function(n) {
              return hit.tried.indexOf(n) < 0;
            });
            return firstThatScans(names, hit.tried);
          });
      });
    })()
  `);

  if (!data || !data.ok) {
    const tried = (data?.tried || [symbol]).map(t => `"${t}"`).join(', ');
    throw new Error(
      `Could not resolve a quote for "${symbol}". Tried ${tried}. `
      + `The scanner indexes by EXCHANGE:SYMBOL — a bare ticker or the wrong exchange returns nothing. `
      + `Use symbol_search to find the exact name.`
    );
  }

  const q = data.q;
  return {
    success: true,
    symbol: data.resolved,
    requested_symbol: symbol,
    // Surfaced so a caller can see the exchange was substituted rather than
    // silently reading one listing's prices under another's name.
    resolved_from: data.resolved === symbol ? undefined : symbol,
    source: 'scanner',
    open: q.open,
    high: q.high,
    low: q.low,
    close: q.close,
    last: q.close,
    volume: q.volume,
    change: q.change_abs,
    change_percent: q.change,
    description: q.description,
    exchange: q.exchange,
    type: q.type,
  };
}

export async function getQuote({ symbol } = {}) {
  // A requested symbol cannot be served from the chart's bar series; only the
  // symbol on screen can. Route it to the scanner instead of relabelling.
  if (symbol) return quoteBySymbol(symbol);

  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var sym = '';
      if (!sym) { try { sym = api.symbol(); } catch(e) {} }
      if (!sym) { try { sym = api.symbolExt().symbol; } catch(e) {} }
      var ext = {};
      try { ext = api.symbolExt() || {}; } catch(e) {}
      var bars = ${BARS_PATH};
      var quote = { symbol: sym };
      if (bars && typeof bars.lastIndex === 'function') {
        var last = bars.valueAt(bars.lastIndex());
        if (last) { quote.time = last[0]; quote.open = last[1]; quote.high = last[2]; quote.low = last[3]; quote.close = last[4]; quote.last = last[4]; quote.volume = last[5] || 0; }
      }
      try {
        var bidEl = document.querySelector('[class*="bid"] [class*="price"], [class*="dom-"] [class*="bid"]');
        var askEl = document.querySelector('[class*="ask"] [class*="price"], [class*="dom-"] [class*="ask"]');
        if (bidEl) quote.bid = parseFloat(bidEl.textContent.replace(/[^0-9.\\-]/g, ''));
        if (askEl) quote.ask = parseFloat(askEl.textContent.replace(/[^0-9.\\-]/g, ''));
      } catch(e) {}
      try {
        var hdr = document.querySelector('[class*="headerRow"] [class*="last-"]');
        if (hdr) { var hdrPrice = parseFloat(hdr.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(hdrPrice)) quote.header_price = hdrPrice; }
      } catch(e) {}
      if (ext.description) quote.description = ext.description;
      if (ext.exchange) quote.exchange = ext.exchange;
      if (ext.type) quote.type = ext.type;
      return quote;
    })()
  `);
  if (!data || (!data.last && !data.close)) throw new Error('Could not retrieve quote. The chart may still be loading.');
  return { success: true, source: 'chart', ...data };
}

export async function getDepth() {
  const data = await evaluate(`
    (function() {
      var domPanel = document.querySelector('[class*="depth"]')
        || document.querySelector('[class*="orderBook"]')
        || document.querySelector('[class*="dom-"]')
        || document.querySelector('[class*="DOM"]')
        || document.querySelector('[data-name="dom"]');
      if (!domPanel) return { found: false, error: 'DOM / Depth of Market panel not found.' };
      var bids = [], asks = [];
      var rows = domPanel.querySelectorAll('[class*="row"], tr');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var priceEl = row.querySelector('[class*="price"]');
        var sizeEl = row.querySelector('[class*="size"], [class*="volume"], [class*="qty"]');
        if (!priceEl) continue;
        var price = parseFloat(priceEl.textContent.replace(/[^0-9.\\-]/g, ''));
        var size = sizeEl ? parseFloat(sizeEl.textContent.replace(/[^0-9.\\-]/g, '')) : 0;
        if (isNaN(price)) continue;
        var rowClass = row.className || '';
        var rowHTML = row.innerHTML || '';
        if (/bid|buy/i.test(rowClass) || /bid|buy/i.test(rowHTML)) bids.push({ price, size });
        else if (/ask|sell/i.test(rowClass) || /ask|sell/i.test(rowHTML)) asks.push({ price, size });
        else if (i < rows.length / 2) asks.push({ price, size });
        else bids.push({ price, size });
      }
      if (bids.length === 0 && asks.length === 0) {
        var cells = domPanel.querySelectorAll('[class*="cell"], td');
        var prices = [];
        cells.forEach(function(c) { var val = parseFloat(c.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(val) && val > 0) prices.push(val); });
        if (prices.length > 0) return { found: true, raw_values: prices.slice(0, 50), bids: [], asks: [], note: 'Could not classify bid/ask levels.' };
      }
      bids.sort(function(a, b) { return b.price - a.price; });
      asks.sort(function(a, b) { return a.price - b.price; });
      var spread = null;
      if (asks.length > 0 && bids.length > 0) spread = +(asks[0].price - bids[0].price).toFixed(6);
      return { found: true, bids: bids, asks: asks, spread: spread };
    })()
  `);

  if (!data || !data.found) throw new Error(data?.error || 'DOM panel not found.');
  return { success: true, bid_levels: data.bids?.length || 0, ask_levels: data.asks?.length || 0, spread: data.spread, bids: data.bids || [], asks: data.asks || [], raw_values: data.raw_values, note: data.note };
}

/**
 * Read current values for every study on the chart.
 *
 * The data window alone leaves two blind spots:
 *  - Studies that express state as colour rather than a number — GoNoGo
 *    Trend's bar colouring, Volume's up/down bars — put nothing in
 *    `dataWindowView()`. That state is a palette index on a `colorer` or
 *    `bar_colorer` plot, which has to be read off the study's own series.
 *  - A study switched off on the chart computes no data at all, so it used to
 *    drop out of the output and look no different from one that simply has no
 *    numbers. Those are now listed separately, with the reason.
 */
export async function getStudyValues() {
  const data = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var studies = [];
      var inactive = [];

      function paletteColors(source, paletteId) {
        try { return source.properties().state().palettes[paletteId].colors; }
        catch(e) { return null; }
      }

      // A study row is [time, plots[0], plots[1], ...], so plots[i] is at i + 1.
      // The newest bar can still be forming, so fall back a few bars.
      function lastRow(source) {
        try {
          var rows = source.data()._items;
          for (var i = rows.length - 1; i >= 0 && i > rows.length - 6; i--) {
            if (rows[i] && rows[i].value) return rows[i].value;
          }
        } catch(e) {}
        return null;
      }

      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;

          var values = {};
          try {
            var dwv = s.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._value && item._value !== '∅' && item._title) values[item._title] = item._value;
                }
              }
            }
          } catch(e) {}

          var colors = {};
          var plots = meta.plots || [];
          // Assign, don't just declare — var is function-scoped, so a bare
          // declaration would carry the previous study's row into this one.
          var row = undefined;
          for (var pi = 0; pi < plots.length; pi++) {
            var plot = plots[pi];
            if (!plot.palette) continue;
            if (plot.type !== 'colorer' && plot.type !== 'bar_colorer') continue;
            if (row === undefined) row = lastRow(s);
            if (!row) break;
            var idx = row[pi + 1];
            if (idx === null || idx === undefined) continue;
            var swatch = paletteColors(s, plot.palette);
            // No resolvable colour means the plot is a colorer for something
            // the study is not drawing — an index on its own says nothing.
            if (!swatch || !swatch[idx]) continue;
            var title = (meta.styles && meta.styles[plot.id] && meta.styles[plot.id].title) || plot.id;
            var entry = { index: idx, color: swatch[idx].color };
            var named = meta.palettes && meta.palettes[plot.palette] && meta.palettes[plot.palette].colors[idx];
            if (named && named.name && !/^Color \\d+$/.test(named.name)) entry.name = named.name;
            if (plot.target) entry.applies_to = plot.target;
            colors[title] = entry;
          }

          if (Object.keys(values).length > 0 || Object.keys(colors).length > 0) {
            var out = { name: name, values: values };
            if (Object.keys(colors).length > 0) out.colors = colors;
            studies.push(out);
          } else if (plots.length > 0 && !meta.is_hidden_study) {
            // is_hidden_study covers the sources the chart adds for itself —
            // Dividends, Splits, Earnings, continuous-contract roll dates.
            var reason = 'no values in the data window';
            try {
              if (s.isFailed()) reason = 'failed to load';
              else if (s.isLoading()) reason = 'still loading';
              else if (!s.isVisible()) reason = 'switched off on the chart, so nothing is computed';
            } catch(e) {}
            inactive.push({ name: name, reason: reason });
          }
        } catch(e) {}
      }
      return { studies: studies, inactive: inactive };
    })()
  `);

  const studies = data?.studies || [];
  const result = { success: true, study_count: studies.length, studies };
  if (data?.inactive?.length) result.inactive_studies = data.inactive;
  return result;
}

export async function getPineLines({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglines', 'lines', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const hLevels = [];
    const seen = {};
    const allLines = [];
    for (const item of s.items) {
      const v = item.raw;
      const y1 = v.y1 != null ? Math.round(v.y1 * 100) / 100 : null;
      const y2 = v.y2 != null ? Math.round(v.y2 * 100) / 100 : null;
      if (verbose) allLines.push({ id: item.id, y1, y2, x1: v.x1, x2: v.x2, horizontal: v.y1 === v.y2, style: v.st, width: v.w, color: v.ci });
      if (y1 != null && v.y1 === v.y2 && !seen[y1]) { hLevels.push(y1); seen[y1] = true; }
    }
    hLevels.sort((a, b) => b - a);
    const result = { name: s.name, total_lines: s.count, horizontal_levels: hLevels };
    if (verbose) result.all_lines = allLines;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineLabels({ study_filter, max_labels, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglabels', 'labels', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const limit = max_labels || 50;
  const studies = raw.map(s => {
    let labels = s.items.map(item => {
      const v = item.raw;
      const text = v.t || '';
      const price = v.y != null ? Math.round(v.y * 100) / 100 : null;
      if (verbose) return { id: item.id, text, price, x: v.x, yloc: v.yl, size: v.sz, textColor: v.tci, color: v.ci };
      return { text, price };
    }).filter(l => l.text || l.price != null);
    if (labels.length > limit) labels = labels.slice(-limit);
    return { name: s.name, total_labels: s.count, showing: labels.length, labels };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineTables({ study_filter } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgtablecells', 'tableCells', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const tables = {};
    for (const item of s.items) {
      const v = item.raw;
      const tid = v.tid || 0;
      if (!tables[tid]) tables[tid] = {};
      if (!tables[tid][v.row]) tables[tid][v.row] = {};
      tables[tid][v.row][v.col] = v.t || '';
    }
    const tableList = Object.entries(tables).map(([tid, rows]) => {
      const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
      const formatted = rowNums.map(rn => {
        const cols = rows[rn];
        const colNums = Object.keys(cols).map(Number).sort((a, b) => a - b);
        return colNums.map(cn => cols[cn]).filter(Boolean).join(' | ');
      }).filter(Boolean);
      return { rows: formatted };
    });
    return { name: s.name, tables: tableList };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineBoxes({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgboxes', 'boxes', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const zones = [];
    const seen = {};
    const allBoxes = [];
    for (const item of s.items) {
      const v = item.raw;
      const high = v.y1 != null && v.y2 != null ? Math.round(Math.max(v.y1, v.y2) * 100) / 100 : null;
      const low = v.y1 != null && v.y2 != null ? Math.round(Math.min(v.y1, v.y2) * 100) / 100 : null;
      if (verbose) allBoxes.push({ id: item.id, high, low, x1: v.x1, x2: v.x2, borderColor: v.c, bgColor: v.bc });
      if (high != null && low != null) { const key = high + ':' + low; if (!seen[key]) { zones.push({ high, low }); seen[key] = true; } }
    }
    zones.sort((a, b) => b.high - a.high);
    const result = { name: s.name, total_boxes: s.count, zones };
    if (verbose) result.all_boxes = allBoxes;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}
