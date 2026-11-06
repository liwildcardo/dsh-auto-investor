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
    insertTick(t) { data.ticks.push({ ...t }); save(); },
    latestTicks(limit) { return data.ticks.slice(-limit); },
    pruneTicks(maxRows) {
      if (data.ticks.length <= maxRows) return 0;
      const removed = data.ticks.length - maxRows;
      data.ticks.splice(0, removed);
      save();
      return removed;
    },
    upsertNews(item) {
      const h = hashUrl(item.url);
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
      data.news.push({ tsEstimated: false, ...item, hash: h });
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
    latestNews(limit) {
      // Same contract as SQLite: ts DESC, then newest-inserted first on ties.
      const n = Number.isFinite(limit) && limit > 0 ? limit : 0;
      return [...data.news]
        .map((v, i) => ({ v, i }))
        .sort((a, b) => ((b.v.ts ?? 0) - (a.v.ts ?? 0)) || (b.i - a.i))
        .slice(0, n)
        .map(({ v }) => ({ ...v, tsEstimated: v.tsEstimated === true }));
    },
    insertTrade(t) { data.trades.push({ ...t }); save(); },
    listTrades(limit) { return data.trades.slice(-limit).reverse(); },
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

  let insertsSincePrune = 0;

  return {
    kind: 'sqlite',
    insertTick(t) {
      db.prepare('INSERT INTO ticks VALUES (?,?,?,?,?,?)').run(t.ts, t.xauUsd, t.usdCny, t.mid, t.buy, t.sell);
      insertsSincePrune += 1;
      if (insertsSincePrune >= 500) { insertsSincePrune = 0; this.pruneTicks(20000); }
    },
    latestTicks(limit) {
      return db.prepare('SELECT ts, xauUsd, usdCny, mid, buy, sell FROM ticks ORDER BY ts DESC LIMIT ?')
        .all(limit).reverse();
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
      const h = hashUrl(item.url);
      const exists = db.prepare('SELECT ts_estimated FROM news WHERE hash = ?').get(h);
      if (exists) {
        if (exists.ts_estimated && item.tsEstimated === false) {
          db.prepare('UPDATE news SET ts = ?, ts_estimated = 0 WHERE hash = ?').run(item.ts ?? 0, h);
        }
        return false;
      }
      db.prepare('INSERT INTO news (hash, ts, source, title, url, summary, ts_estimated) VALUES (?,?,?,?,?,?,?)')
        .run(h, item.ts ?? 0, item.source ?? '', item.title ?? '', item.url ?? '', item.summary ?? '', item.tsEstimated ? 1 : 0);
      return true;
    },
    removeNews(hash) {
      const res = db.prepare('DELETE FROM news WHERE hash = ?').run(hash);
      return Number(res.changes ?? 0);
    },
    latestNews(limit) {
      return db.prepare('SELECT hash, ts, source, title, url, summary, ts_estimated FROM news ORDER BY ts DESC, rowid DESC LIMIT ?')
        .all(limit)
        .map((r) => ({ ...r, tsEstimated: r.ts_estimated === 1 }));
    },
    insertTrade(t) {
      db.prepare('INSERT INTO trades VALUES (?,?,?,?,?,?)').run(t.ts, t.side, t.grams, t.price, t.rmb, t.note ?? '');
    },
    listTrades(limit) {
      return db.prepare('SELECT ts, side, grams, price, rmb, note FROM trades ORDER BY ts DESC LIMIT ?').all(limit);
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
