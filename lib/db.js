/**
 * Database layer: `node:sqlite` when the runtime provides it, otherwise a
 * pure-JS JSON store with the same collection API. Both backends persist
 * ticks, news, trades, and key/value state.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function hashUrl(url) {
  return createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
}

/**
 * News identity is per product: two products sharing a feed (or the same
 * search URL) must each keep the story. Gold keeps the legacy URL-only hash so
 * rows written before the product dimension still dedupe correctly.
 */
function newsHash(item) {
  const product = item?.product ?? 'gold';
  return product === 'gold' ? hashUrl(item?.url) : hashUrl(`${product}|${item?.url}`);
}

/* ------------------------------- JSON backend ------------------------------ */

function openJson(path) {
  mkdirSync(dirname(path), { recursive: true });
  // Never write JSON over a file that is not JSON (e.g. an existing SQLite DB):
  // a sidecar path is used instead.
  let storePath = path;
  if (existsSync(path)) {
    const head = readFileSync(path, 'utf8').slice(0, 1);
    if (head !== '{') storePath = `${path}.json`;
  }
  let data = { ticks: [], news: [], trades: [], state: {} };
  if (existsSync(storePath)) {
    const raw = readFileSync(storePath, 'utf8');
    try {
      data = JSON.parse(raw);
    } catch {
      // keep the corrupt file for forensics instead of discarding it
      try { renameSync(storePath, `${storePath}.corrupt-${Date.now()}`); } catch { /* best effort */ }
      data = { ticks: [], news: [], trades: [], state: {} };
    }
  }
  data.ticks ??= [];
  data.news ??= [];
  data.trades ??= [];
  data.state ??= {};

  const save = () => {
    const tmp = `${storePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), 'utf8');
    renameSync(tmp, storePath);
  };

  return {
    kind: 'json',
    insertTick(t) { data.ticks.push({ product: 'gold', ...t }); save(); },
    latestTicks(limit) { return data.ticks.slice(-limit); },
    latestTicksByProduct(product, limit) {
      return data.ticks
        .filter(t => (t.product ?? 'gold') === product)
        .slice(-limit)
        .map(t => ({ ts: t.ts, price: t.price ?? t.mid, buy: t.buy, sell: t.sell }));
    },
    insertPoint(p) {
      data.series ??= [];
      data.series.push({ ...p });
      if (data.series.length > 40000) data.series.splice(0, data.series.length - 40000);
      save();
    },
    listPoints(product, symbol, limit) {
      const rows = (data.series ?? []).filter(p => p.product === product && p.symbol === symbol);
      return rows.slice(-limit);
    },
    pruneTicks(maxRows) {
      if (data.ticks.length <= maxRows) return 0;
      const removed = data.ticks.length - maxRows;
      data.ticks.splice(0, removed);
      save();
      return removed;
    },
    upsertNews(item) {
      const h = newsHash(item);
      const existing = data.news.find(n => n.hash === h);
      if (existing) {
        // A later occurrence with a real publish date upgrades a first-seen
        // estimate (undated index items are stamped with crawl time).
        if (existing.tsEstimated && item.tsEstimated === false) {
          existing.ts = item.ts;
          existing.tsEstimated = false;
          save();
        }
        return false;
      }
      data.news.push({ tsEstimated: false, product: 'gold', ...item, hash: h });
      if (data.news.length > 5000) data.news.splice(0, 1000);
      save();
      return true;
    },
    removeNews(hash) {
      const before = data.news.length;
      data.news = data.news.filter(n => n.hash !== hash);
      if (data.news.length !== before) save();
      return before - data.news.length;
    },
    latestNews(limit, product = null) {
      // Same contract as SQLite: ts DESC, then newest-inserted first on ties.
      const n = Number.isFinite(limit) && limit > 0 ? limit : 0;
      return [...data.news]
        .filter(v => product == null || (v.product ?? 'gold') === product)
        .map((v, i) => ({ v, i }))
        .sort((a, b) => ((b.v.ts ?? 0) - (a.v.ts ?? 0)) || (b.i - a.i))
        .slice(0, n)
        .map(({ v }) => ({ ...v, tsEstimated: v.tsEstimated === true }));
    },
    insertTrade(t) { data.trades.push({ product: 'gold', ...t }); save(); },
    pruneSeries(maxPerSymbol = 3000) {
      data.series ??= [];
      const groups = new Map();
      for (const row of data.series) {
        const k = `${row.product}\u0000${row.symbol}`;
        (groups.get(k) ?? groups.set(k, []).get(k)).push(row);
      }
      let removed = 0;
      for (const rows of groups.values()) {
        if (rows.length <= maxPerSymbol) continue;
        const drop = rows.length - maxPerSymbol;
        removed += drop;
        const set = new Set(rows.slice(0, drop));
        data.series = data.series.filter(r => !set.has(r));
      }
      if (removed) save();
      return removed;
    },
    listTrades(limit) { return data.trades.slice(-limit).reverse(); },
    listTradesByProduct(product, limit) {
      return data.trades.filter(t => (t.product ?? 'gold') === product).slice(-limit).reverse();
    },
    putState(key, value) { data.state[key] = value; save(); },
    getState(key) { return data.state[key] ?? null; },
    close() { save(); },
  };
}

/* ------------------------------ SQLite backend ----------------------------- */

function openSqlite(path) {
  mkdirSync(dirname(path), { recursive: true });
  // node:sqlite is unflagged from Node 23.4 / 22.13; createRequire loads it
  // synchronously so both backends share one interface.
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticks (ts INTEGER, xauUsd REAL, usdCny REAL, mid REAL, buy REAL, sell REAL);
    CREATE TABLE IF NOT EXISTS news (hash TEXT PRIMARY KEY, ts INTEGER, source TEXT, title TEXT, url TEXT, summary TEXT);
    CREATE TABLE IF NOT EXISTS trades (ts INTEGER, side TEXT, grams REAL, price REAL, rmb REAL, note TEXT);
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
    CREATE INDEX IF NOT EXISTS ticks_ts ON ticks(ts);
    CREATE INDEX IF NOT EXISTS news_ts ON news(ts);
    CREATE INDEX IF NOT EXISTS trades_ts ON trades(ts);
  `);
  // Migration: undated items get ts = crawl time; flag them so ranking can
  // avoid treating an estimate as fresh news.
  const newsCols = db.prepare('PRAGMA table_info(news)').all().map(c => c.name);
  if (!newsCols.includes('ts_estimated')) db.exec('ALTER TABLE news ADD COLUMN ts_estimated INTEGER DEFAULT 0');
  if (!newsCols.includes('product')) db.exec('ALTER TABLE news ADD COLUMN product TEXT');
  // Multi-product migration: ticks/trades gain a product dimension and trades a
  // symbol; existing rows predate both and belong to gold.
  const tickCols = db.prepare('PRAGMA table_info(ticks)').all().map(c => c.name);
  if (!tickCols.includes('product')) db.exec('ALTER TABLE ticks ADD COLUMN product TEXT');
  const tradeCols = db.prepare('PRAGMA table_info(trades)').all().map(c => c.name);
  if (!tradeCols.includes('product')) db.exec('ALTER TABLE trades ADD COLUMN product TEXT');
  if (!tradeCols.includes('symbol')) db.exec('ALTER TABLE trades ADD COLUMN symbol TEXT');
  if (!tradeCols.includes('realized')) db.exec('ALTER TABLE trades ADD COLUMN realized REAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS series (ts INTEGER, product TEXT, symbol TEXT, price REAL, open REAL, high REAL, low REAL, volume REAL);
    CREATE INDEX IF NOT EXISTS series_idx ON series(product, symbol, ts);
  `);
  // Drop misparsed ancient bars that would otherwise distort indicators.
  db.prepare('DELETE FROM series WHERE ts < ?').run(Date.now() - 2 * 365 * 86_400_000);

  let insertsSincePrune = 0;

  return {
    kind: 'sqlite',
    insertTick(t) {
      db.prepare('INSERT INTO ticks (ts, xauUsd, usdCny, mid, buy, sell, product) VALUES (?,?,?,?,?,?,?)')
        .run(t.ts, t.xauUsd ?? null, t.usdCny ?? null, t.mid ?? t.price ?? null, t.buy ?? null, t.sell ?? null, t.product ?? 'gold');
      insertsSincePrune += 1;
      if (insertsSincePrune >= 500) { insertsSincePrune = 0; this.pruneTicks(20000); }
    },
    latestTicks(limit) {
      return db.prepare('SELECT ts, xauUsd, usdCny, mid, buy, sell FROM ticks ORDER BY ts DESC LIMIT ?')
        .all(limit).reverse();
    },
    latestTicksByProduct(product, limit) {
      return db.prepare("SELECT ts, mid AS price, buy, sell FROM ticks WHERE COALESCE(product,'gold') = ? ORDER BY ts DESC LIMIT ?")
        .all(product, limit).reverse();
    },
    insertPoint(p) {
      db.prepare('INSERT INTO series (ts, product, symbol, price, open, high, low, volume) VALUES (?,?,?,?,?,?,?,?)')
        .run(p.ts, p.product, p.symbol, p.price, p.open ?? null, p.high ?? null, p.low ?? null, p.volume ?? null);
    },
    listPoints(product, symbol, limit) {
      return db.prepare('SELECT ts, price, open, high, low, volume FROM series WHERE product = ? AND symbol = ? ORDER BY ts DESC LIMIT ?')
        .all(product, symbol, limit).reverse();
    },
    pruneTicks(maxRows) {
      const { c } = db.prepare('SELECT COUNT(*) AS c FROM ticks').get();
      if (c <= maxRows) return 0;
      const cutoff = db.prepare('SELECT ts FROM ticks ORDER BY ts DESC LIMIT 1 OFFSET ?').get(maxRows - 1);
      if (!cutoff) return 0;
      const res = db.prepare('DELETE FROM ticks WHERE ts < ?').run(cutoff.ts);
      return Number(res.changes ?? 0);
    },
    upsertNews(item) {
      const h = newsHash(item);
      const exists = db.prepare('SELECT ts_estimated FROM news WHERE hash = ?').get(h);
      if (exists) {
        if (exists.ts_estimated && item.tsEstimated === false) {
          db.prepare('UPDATE news SET ts = ?, ts_estimated = 0 WHERE hash = ?').run(item.ts ?? 0, h);
        }
        return false;
      }
      db.prepare('INSERT INTO news (hash, ts, source, title, url, summary, ts_estimated, product) VALUES (?,?,?,?,?,?,?,?)')
        .run(h, item.ts ?? 0, item.source ?? '', item.title ?? '', item.url ?? '', item.summary ?? '', item.tsEstimated ? 1 : 0, item.product ?? 'gold');
      return true;
    },
    removeNews(hash) {
      const res = db.prepare('DELETE FROM news WHERE hash = ?').run(hash);
      return Number(res.changes ?? 0);
    },
    latestNews(limit, product = null) {
      if (product == null) {
        return db.prepare('SELECT hash, ts, source, title, url, summary, ts_estimated FROM news ORDER BY ts DESC, rowid DESC LIMIT ?')
          .all(limit)
          .map((r) => ({ ...r, tsEstimated: r.ts_estimated === 1 }));
      }
      return db.prepare("SELECT hash, ts, source, title, url, summary, ts_estimated FROM news WHERE COALESCE(product,'gold') = ? ORDER BY ts DESC, rowid DESC LIMIT ?")
        .all(product, limit)
        .map((r) => ({ ...r, tsEstimated: r.ts_estimated === 1 }));
    },
    insertTrade(t) {
      db.prepare('INSERT INTO trades (ts, side, grams, price, rmb, note, product, symbol, realized) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(t.ts, t.side, t.grams, t.price, t.rmb, t.note ?? '', t.product ?? 'gold', t.symbol ?? null, t.realized ?? null);
    },
    listTrades(limit) {
      return db.prepare('SELECT ts, side, grams, price, rmb, note FROM trades ORDER BY ts DESC LIMIT ?').all(limit);
    },
    pruneSeries(maxPerSymbol = 3000) {
      let removed = 0;
      const pairs = db.prepare('SELECT DISTINCT product, symbol FROM series').all();
      for (const { product, symbol } of pairs) {
        const cut = db.prepare('SELECT ts FROM series WHERE product = ? AND symbol = ? ORDER BY ts DESC LIMIT 1 OFFSET ?')
          .get(product, symbol, maxPerSymbol - 1);
        if (!cut) continue;
        const res = db.prepare('DELETE FROM series WHERE product = ? AND symbol = ? AND ts < ?').run(product, symbol, cut.ts);
        removed += Number(res.changes ?? 0);
      }
      return removed;
    },
    listTradesByProduct(product, limit) {
      return db.prepare(`SELECT ts, side, COALESCE(grams, 0) AS grams, price, rmb, note, symbol, realized
        FROM trades WHERE COALESCE(product,'gold') = ? ORDER BY ts DESC LIMIT ?`).all(product, limit);
    },
    putState(key, value) {
      db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, JSON.stringify(value));
    },
    getState(key) {
      const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key);
      return row ? JSON.parse(row.value) : null;
    },
    close() { db.close(); },
  };
}

/**
 * Open the store. `options.backend` forces 'json' | 'sqlite'; default tries
 * sqlite and falls back to json when `node:sqlite` is unavailable in-process.
 */
export function openDb(path, options = {}) {
  const want = options.backend;
  if (want === 'json') return openJson(path);
  if (want === 'sqlite') return openSqlite(path);
  try {
    return openSqlite(path);
  } catch {
    // Fallback must never touch the SQLite file.
    return openJson(`${path}.fallback.json`);
  }
}

export { hashUrl };
