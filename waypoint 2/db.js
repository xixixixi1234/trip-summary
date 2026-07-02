/* ============================================================
   Waypoint data layer.

   Uses Postgres when DATABASE_URL is set (Railway one-click Postgres).
   Falls back to an in-memory store seeded from src/cities.js when it is
   not, so the app still runs locally / in demo mode with zero setup.

   Public API (all async):
     init()                         -> prepare schema + seed if empty
     listCities()                   -> [{key,name,country,emoji,gradient}]
     listHotels({city})             -> [hotel...]
     getHotel(id)                   -> hotel | null
     getReviews(hotelId)            -> [review...]
     importHotels(rows)             -> { inserted, updated } (upsert)
     vote({hotelId, voterId, choice}) -> {hotelId, up, down, your}
     tallies()                      -> { hotelId: {up,down} }
     voteStats()                    -> aggregate participation stats
     allVotes()                     -> raw per-voter rows (admin)
   ============================================================ */

import pg from "pg";
import { CITIES, CITY_LISTINGS, CITY_REVIEWS } from "./src/cities.js";

const { Pool } = pg;
const HAS_DB = Boolean(process.env.DATABASE_URL);

let pool = null;

/* ---------------- in-memory fallback store ---------------- */
const mem = {
  cities: [...CITIES],
  hotels: [...CITY_LISTINGS],
  reviews: { ...CITY_REVIEWS },
  // votes[hotelId] = { up, down, voters: { voterId: 'up'|'down' } }
  votes: {},
};

/* ---------------- schema ---------------- */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cities (
  key      TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  country  TEXT,
  emoji    TEXT,
  gradient JSONB
);
CREATE TABLE IF NOT EXISTS hotels (
  id           TEXT PRIMARY KEY,
  city         TEXT REFERENCES cities(key) ON DELETE CASCADE,
  city_name    TEXT,
  name         TEXT NOT NULL,
  place        TEXT,
  rating       REAL,
  review_count INTEGER,
  rank         TEXT,
  price        TEXT,
  tags         JSONB,
  gradient     JSONB,
  tc           BOOLEAN,
  lat          REAL,
  lng          REAL,
  seo          TEXT,
  about        TEXT,
  amenities    JSONB,
  sub_ratings  JSONB,
  sort_order   INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reviews (
  id        BIGSERIAL PRIMARY KEY,
  hotel_id  TEXT REFERENCES hotels(id) ON DELETE CASCADE,
  author    TEXT,
  origin    TEXT,           -- the "from" field (reserved word, renamed)
  rating    INTEGER,
  month     TEXT,
  trip_type TEXT,
  title     TEXT,
  body      TEXT,
  helpful   INTEGER DEFAULT 0,
  verified  BOOLEAN DEFAULT false,
  source    TEXT            -- 'quote' | 'ai'
);
CREATE TABLE IF NOT EXISTS votes (
  hotel_id  TEXT,
  voter_id  TEXT,
  choice    TEXT CHECK (choice IN ('up','down')),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (hotel_id, voter_id)
);
CREATE INDEX IF NOT EXISTS idx_hotels_city ON hotels(city);
CREATE INDEX IF NOT EXISTS idx_reviews_hotel ON reviews(hotel_id);
CREATE INDEX IF NOT EXISTS idx_votes_hotel ON votes(hotel_id);
`;

/* ---------------- init & seed ---------------- */
export async function init() {
  if (!HAS_DB) {
    console.log("[db] No DATABASE_URL — using in-memory store (data resets on restart).");
    return;
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await pool.query(SCHEMA);
  // migration for databases created before sort_order existed
  await pool.query("ALTER TABLE hotels ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0");

  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM hotels");
  if (rows[0].n === 0) {
    console.log("[db] Empty database — seeding from src/cities.js …");
    await seed();
  }
  console.log("[db] Postgres ready.");
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const c of CITIES) {
      await client.query(
        `INSERT INTO cities(key,name,country,emoji,gradient)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT (key) DO NOTHING`,
        [c.key, c.name, c.country, c.emoji, JSON.stringify(c.gradient)]
      );
    }
    for (const h of CITY_LISTINGS) {
      await upsertHotelClient(client, h);
      const revs = CITY_REVIEWS[h.id] || [];
      for (const r of revs) await insertReviewClient(client, h.id, r);
    }
    await client.query("COMMIT");
    console.log(`[db] Seeded ${CITY_LISTINGS.length} hotels.`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function upsertHotelClient(client, h) {
  await client.query(
    `INSERT INTO hotels
       (id,city,city_name,name,place,rating,review_count,rank,price,tags,gradient,tc,lat,lng,seo,about,amenities,sub_ratings,sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (id) DO UPDATE SET
       city=EXCLUDED.city, city_name=EXCLUDED.city_name, name=EXCLUDED.name, place=EXCLUDED.place,
       rating=EXCLUDED.rating, review_count=EXCLUDED.review_count, rank=EXCLUDED.rank, price=EXCLUDED.price,
       tags=EXCLUDED.tags, gradient=EXCLUDED.gradient, tc=EXCLUDED.tc, lat=EXCLUDED.lat, lng=EXCLUDED.lng,
       seo=EXCLUDED.seo, about=EXCLUDED.about, amenities=EXCLUDED.amenities, sub_ratings=EXCLUDED.sub_ratings`,
    [
      h.id, h.city, h.cityName || h.city_name, h.name, h.place, h.rating,
      h.reviewCount ?? h.review_count, h.rank, h.price,
      JSON.stringify(h.tags || []), JSON.stringify(h.gradient || []),
      Boolean(h.tc), h.lat ?? null, h.lng ?? null, h.seo || null, h.about || null,
      JSON.stringify(h.amenities || []), JSON.stringify(h.subRatings || h.sub_ratings || {}),
      h.sortOrder ?? h.sort_order ?? 0,
    ]
  );
}

async function insertReviewClient(client, hotelId, r) {
  await client.query(
    `INSERT INTO reviews(hotel_id,author,origin,rating,month,trip_type,title,body,helpful,verified,source)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [hotelId, r.author, r.from || r.origin, r.rating, r.month, r.tripType || r.trip_type,
     r.title, r.text || r.body, r.helpful || 0, Boolean(r.verified), r.source || "quote"]
  );
}

/* ---------------- reads ---------------- */
export async function listCities() {
  if (!HAS_DB) return mem.cities;
  const { rows } = await pool.query("SELECT key,name,country,emoji,gradient FROM cities ORDER BY name");
  return rows.map(r => ({ ...r, gradient: r.gradient }));
}

function hotelRowToApi(r) {
  return {
    id: r.id, type: "Hotel", city: r.city, cityName: r.city_name, name: r.name,
    place: r.place, rating: r.rating, reviewCount: r.review_count, rank: r.rank,
    price: r.price, tags: r.tags || [], gradient: r.gradient || [], tc: r.tc,
    lat: r.lat, lng: r.lng, seo: r.seo || "", about: r.about || "",
    amenities: r.amenities || [], subRatings: r.sub_ratings || {},
    sortOrder: r.sort_order ?? 0,
  };
}

/* Default display order (used front-of-house AND in admin):
   1) hotels that HAVE an AI review (seo) come first
   2) then the manual sort_order (ascending; 0 = untouched)
   3) then a deterministic pseudo-random order (stable per hotel id),
      so ratings look mixed rather than all the 5.0s bunched at the top  */
function hasSeo(h) { return Boolean((h.seo || "").trim()); }
// stable hash → number in [0,1) from the hotel id
function idRand(id) {
  let h = 2166136261;
  const s = String(id);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}
export function defaultSort(a, b) {
  const sa = hasSeo(a) ? 0 : 1, sb = hasSeo(b) ? 0 : 1;
  if (sa !== sb) return sa - sb;
  const oa = a.sortOrder ?? a.sort_order ?? 0, ob = b.sortOrder ?? b.sort_order ?? 0;
  if (oa !== ob) return oa - ob;
  return idRand(a.id) - idRand(b.id);   // stable "random" mix
}

export async function listHotels({ city } = {}) {
  if (!HAS_DB) {
    let list = [...mem.hotels];
    if (city) list = list.filter(h => h.city === city);
    return list.sort(defaultSort);
  }
  // SQL mirror of defaultSort: SEO group, then manual order, then stable hash of id
  const orderSql = `ORDER BY
      (CASE WHEN COALESCE(NULLIF(TRIM(seo),''),'') = '' THEN 1 ELSE 0 END),
      sort_order ASC, hashtext(id)`;
  const q = city
    ? await pool.query(`SELECT * FROM hotels WHERE city=$1 ${orderSql}`, [city])
    : await pool.query(`SELECT * FROM hotels ${orderSql}`);
  return q.rows.map(hotelRowToApi);
}

/* Persist a new manual order for a city. `orderedIds` is the full list of
   hotel ids in the desired display order; index becomes sort_order. */
export async function reorderHotels(city, orderedIds) {
  if (!Array.isArray(orderedIds)) throw new Error("orderedIds must be an array");
  if (!HAS_DB) {
    const pos = new Map(orderedIds.map((id, i) => [id, i]));
    for (const h of mem.hotels) if (h.city === city && pos.has(h.id)) h.sortOrder = pos.get(h.id);
    return { updated: orderedIds.length };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query("UPDATE hotels SET sort_order=$1 WHERE id=$2 AND city=$3", [i, orderedIds[i], city]);
    }
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
  return { updated: orderedIds.length };
}

export async function getReviews(hotelId) {
  if (!HAS_DB) return mem.reviews[hotelId] || [];
  const { rows } = await pool.query(
    "SELECT * FROM reviews WHERE hotel_id=$1 ORDER BY source, id", [hotelId]
  );
  return rows.map(r => ({
    id: r.id, author: r.author, from: r.origin, rating: r.rating, month: r.month,
    tripType: r.trip_type, title: r.title, text: r.body, helpful: r.helpful,
    verified: r.verified, source: r.source,
  }));
}

/* ---------------- import (upsert hotels + their reviews) ---------------- */
export async function importHotels(rows) {
  let inserted = 0, updated = 0;
  // give each imported hotel an incremental sort_order so the import order is preserved
  rows.forEach((h, i) => { if (h.sortOrder == null) h.sortOrder = i; });
  if (!HAS_DB) {
    for (const h of rows) {
      const idx = mem.hotels.findIndex(x => x.id === h.id);
      if (idx >= 0) { mem.hotels[idx] = h; updated++; }
      else { mem.hotels.push(h); inserted++; }
      if (!mem.cities.find(c => c.key === h.city)) {
        mem.cities.push({ key: h.city, name: h.cityName, country: h.country || "", emoji: "🏨", gradient: h.gradient });
      }
      mem.reviews[h.id] = h._reviews || [];
    }
    return { inserted, updated };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const h of rows) {
      // ensure the city exists
      await client.query(
        `INSERT INTO cities(key,name,country,emoji,gradient)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT (key) DO NOTHING`,
        [h.city, h.cityName, h.country || "", "🏨", JSON.stringify(h.gradient || [])]
      );
      const before = await client.query("SELECT 1 FROM hotels WHERE id=$1", [h.id]);
      await upsertHotelClient(client, h);
      if (before.rowCount) updated++; else inserted++;
      // replace reviews for this hotel
      await client.query("DELETE FROM reviews WHERE hotel_id=$1", [h.id]);
      for (const r of (h._reviews || [])) await insertReviewClient(client, h.id, r);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { inserted, updated };
}

/* ---------------- votes ---------------- */
export async function vote({ hotelId, voterId, choice }) {
  if (!HAS_DB) {
    const e = mem.votes[hotelId] || { up: 0, down: 0, voters: {} };
    const prev = e.voters[voterId];
    if (prev === choice) { e[choice] = Math.max(0, e[choice] - 1); delete e.voters[voterId]; }
    else { if (prev) e[prev] = Math.max(0, e[prev] - 1); e[choice] = (e[choice] || 0) + 1; e.voters[voterId] = choice; }
    mem.votes[hotelId] = e;
    return { hotelId, up: e.up, down: e.down, your: e.voters[voterId] || null };
  }
  const cur = await pool.query("SELECT choice FROM votes WHERE hotel_id=$1 AND voter_id=$2", [hotelId, voterId]);
  const prev = cur.rows[0]?.choice;
  if (prev === choice) {
    await pool.query("DELETE FROM votes WHERE hotel_id=$1 AND voter_id=$2", [hotelId, voterId]);
  } else {
    await pool.query(
      `INSERT INTO votes(hotel_id,voter_id,choice,updated_at) VALUES($1,$2,$3,now())
       ON CONFLICT (hotel_id,voter_id) DO UPDATE SET choice=EXCLUDED.choice, updated_at=now()`,
      [hotelId, voterId, choice]
    );
  }
  const agg = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE choice='up')::int   AS up,
       COUNT(*) FILTER (WHERE choice='down')::int AS down
     FROM votes WHERE hotel_id=$1`, [hotelId]
  );
  const mine = await pool.query("SELECT choice FROM votes WHERE hotel_id=$1 AND voter_id=$2", [hotelId, voterId]);
  return { hotelId, up: agg.rows[0].up, down: agg.rows[0].down, your: mine.rows[0]?.choice || null };
}

export async function tallies() {
  if (!HAS_DB) {
    const out = {};
    for (const [id, v] of Object.entries(mem.votes)) out[id] = { up: v.up || 0, down: v.down || 0 };
    return out;
  }
  const { rows } = await pool.query(
    `SELECT hotel_id,
       COUNT(*) FILTER (WHERE choice='up')::int   AS up,
       COUNT(*) FILTER (WHERE choice='down')::int AS down
     FROM votes GROUP BY hotel_id`
  );
  const out = {};
  for (const r of rows) out[r.hotel_id] = { up: r.up, down: r.down };
  return out;
}

/* aggregate participation stats for the admin dashboard */
export async function voteStats() {
  if (!HAS_DB) {
    const voters = new Set();
    let up = 0, down = 0, hotels = 0;
    for (const v of Object.values(mem.votes)) {
      if ((v.up || 0) + (v.down || 0) > 0) hotels++;
      up += v.up || 0; down += v.down || 0;
      for (const id of Object.keys(v.voters || {})) voters.add(id);
    }
    return { totalUp: up, totalDown: down, totalVotes: up + down, uniqueVoters: voters.size, hotelsVoted: hotels };
  }
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE choice='up')::int   AS "totalUp",
       COUNT(*) FILTER (WHERE choice='down')::int AS "totalDown",
       COUNT(*)::int                              AS "totalVotes",
       COUNT(DISTINCT voter_id)::int              AS "uniqueVoters",
       COUNT(DISTINCT hotel_id)::int              AS "hotelsVoted"
     FROM votes`
  );
  return rows[0];
}

/* per-hotel tally joined with hotel names, for the admin table */
export async function voteBreakdown() {
  if (!HAS_DB) {
    const byId = Object.fromEntries(mem.hotels.map(h => [h.id, h.name]));
    return Object.entries(mem.votes)
      .map(([id, v]) => ({ id, name: byId[id] || id, up: v.up || 0, down: v.down || 0, net: (v.up || 0) - (v.down || 0) }))
      .sort((a, b) => b.net - a.net);
  }
  const { rows } = await pool.query(
    `SELECT v.hotel_id AS id, h.name,
       COUNT(*) FILTER (WHERE choice='up')::int   AS up,
       COUNT(*) FILTER (WHERE choice='down')::int AS down
     FROM votes v LEFT JOIN hotels h ON h.id=v.hotel_id
     GROUP BY v.hotel_id, h.name`
  );
  return rows.map(r => ({ ...r, net: r.up - r.down })).sort((a, b) => b.net - a.net);
}

/* raw recent vote events (admin "all user data") */
export async function recentVotes(limit = 200) {
  if (!HAS_DB) {
    const events = [];
    for (const [hid, v] of Object.entries(mem.votes)) {
      for (const [voter, choice] of Object.entries(v.voters || {})) {
        events.push({ voter_id: voter, hotel_id: hid, choice, updated_at: null });
      }
    }
    return events.slice(0, limit);
  }
  const { rows } = await pool.query(
    `SELECT v.voter_id, v.hotel_id, h.name AS hotel_name, v.choice, v.updated_at
     FROM votes v LEFT JOIN hotels h ON h.id=v.hotel_id
     ORDER BY v.updated_at DESC NULLS LAST LIMIT $1`, [limit]
  );
  return rows;
}

export function usingDb() { return HAS_DB; }
