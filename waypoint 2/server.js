import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(express.json({ limit: "200kb" }));

/* ---------- like / dislike vote store ---------- */
/* Persisted to votes.json on disk. Shape:
   { "<hotelId>": { up: <count>, down: <count>, voters: { "<voterId>": "up"|"down" } } }
   voters lets a browser change its mind without double-counting. */
const VOTES_FILE = path.join(__dirname, "votes.json");
let VOTES = {};
try {
  if (fs.existsSync(VOTES_FILE)) VOTES = JSON.parse(fs.readFileSync(VOTES_FILE, "utf8"));
} catch (e) {
  console.error("Could not read votes.json, starting fresh:", e.message);
}
let saveTimer = null;
function persistVotes() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(VOTES_FILE, JSON.stringify(VOTES), (err) => {
      if (err) console.error("Failed to write votes.json:", err.message);
    });
  }, 300);
}

// public tallies only (no voter ids leaked to the client)
function publicTallies() {
  const out = {};
  for (const [id, v] of Object.entries(VOTES)) out[id] = { up: v.up || 0, down: v.down || 0 };
  return out;
}

app.get("/api/votes", (_req, res) => res.json(publicTallies()));

app.post("/api/vote", (req, res) => {
  const { hotelId, voterId, choice } = req.body || {};
  if (!hotelId || !voterId || !["up", "down"].includes(choice)) {
    return res.status(400).json({ error: "hotelId, voterId and choice ('up'|'down') are required" });
  }
  const entry = VOTES[hotelId] || { up: 0, down: 0, voters: {} };
  entry.voters = entry.voters || {};
  const prev = entry.voters[voterId];

  if (prev === choice) {
    // toggle off (un-vote)
    entry[choice] = Math.max(0, (entry[choice] || 0) - 1);
    delete entry.voters[voterId];
  } else {
    if (prev) entry[prev] = Math.max(0, (entry[prev] || 0) - 1); // remove old vote
    entry[choice] = (entry[choice] || 0) + 1;
    entry.voters[voterId] = choice;
  }
  VOTES[hotelId] = entry;
  persistVotes();
  res.json({ hotelId, up: entry.up, down: entry.down, your: entry.voters[voterId] || null });
});

/* ---------- AI review summary endpoint ---------- */
app.post("/api/summarize", async (req, res) => {
  const { name, place, reviews } = req.body || {};
  if (!Array.isArray(reviews) || reviews.length === 0 || !name) {
    return res.status(400).json({ error: "name and reviews[] are required" });
  }

  // Fallback when no API key is configured (still works as a demo)
  if (!API_KEY) {
    const avg = reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length;
    return res.json({
      live: false,
      summary: `Guests give ${name} an average of ${avg.toFixed(1)}/5 across ${reviews.length} reviews. Opinions are mostly positive about the core experience, with some recurring notes on value. Set ANTHROPIC_API_KEY on the server to enable live AI summaries.`,
      pros: ["Location & setting", "Cleanliness", "Breakfast / core experience"],
      cons: ["Value for money on extras"],
      bestFor: "Travellers seeking a relaxed stay",
    });
  }

  const corpus = reviews
    .slice(0, 40)
    .map((r) => `[${r.rating}/5, ${r.tripType || "guest"}, ${r.month || ""}] ${r.title || ""}: ${r.text || ""}`)
    .join("\n\n");

  const prompt = `You are the review-summary engine for a travel site. Based ONLY on the guest reviews below for "${name}" (${place || ""}), respond with ONLY a JSON object (no markdown fences, no preamble) with this shape:
{"summary": "3-4 sentence balanced overview in a warm, neutral voice",
 "pros": ["3-5 short phrases guests consistently praise"],
 "cons": ["2-4 short phrases guests consistently criticise"],
 "bestFor": "one short phrase: who this place suits best"}

Reviews:
${corpus}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error("Anthropic API error:", r.status, errText);
      return res.status(502).json({ error: "AI service error" });
    }
    const data = await r.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    return res.json({ live: true, ...parsed });
  } catch (e) {
    console.error("Summarize failed:", e);
    return res.status(500).json({ error: "Failed to generate summary" });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true, ai: Boolean(API_KEY) }));

/* ---------- lightweight admin view of vote tallies ---------- */
app.get("/admin", (_req, res) => {
  const rows = Object.entries(VOTES)
    .map(([id, v]) => ({ id, up: v.up || 0, down: v.down || 0, net: (v.up || 0) - (v.down || 0) }))
    .sort((a, b) => b.net - a.net);
  const totalUp = rows.reduce((s, r) => s + r.up, 0);
  const totalDown = rows.reduce((s, r) => s + r.down, 0);
  const body = rows.map(r => `
    <tr>
      <td>${r.id}</td>
      <td class="n up">▲ ${r.up}</td>
      <td class="n down">▼ ${r.down}</td>
      <td class="n net">${r.net >= 0 ? "+" : ""}${r.net}</td>
    </tr>`).join("");
  res.set("Content-Type", "text/html").send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Waypoint · vote admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root{--ink:#122B33;--soft:#3D5860;--paper:#F7F9F8;--line:#E2EAE8;--up:#2E7D5B;--down:#E8542F;}
  body{font-family:system-ui,-apple-system,'Archivo',sans-serif;background:var(--paper);color:var(--ink);margin:0;padding:32px 20px;}
  .wrap{max-width:760px;margin:0 auto;}
  h1{font-size:22px;margin:0 0 4px;}
  p{color:var(--soft);font-size:14px;margin:0 0 20px;}
  .cards{display:flex;gap:12px;margin-bottom:24px;}
  .card{flex:1;background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px;}
  .card .k{font-size:12px;color:var(--soft);letter-spacing:.06em;text-transform:uppercase;}
  .card .v{font-size:26px;font-weight:700;}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden;}
  th,td{padding:10px 14px;text-align:left;font-size:14px;border-bottom:1px solid var(--line);}
  th{background:#eef4f2;font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:var(--soft);}
  td.n{text-align:right;font-variant-numeric:tabular-nums;font-weight:600;width:90px;}
  td.up{color:var(--up);} td.down{color:var(--down);} td.net{color:var(--ink);}
  tr:last-child td{border-bottom:none;}
  .empty{padding:40px;text-align:center;color:var(--soft);}
  code{background:#eef4f2;padding:2px 6px;border-radius:4px;font-size:13px;}
</style></head>
<body><div class="wrap">
  <h1>Vote tallies</h1>
  <p>Likes &amp; dislikes collected per hotel. Auto-refreshes every 15s. Raw JSON at <code>/api/votes</code>.</p>
  <div class="cards">
    <div class="card"><div class="k">Hotels voted on</div><div class="v">${rows.length}</div></div>
    <div class="card"><div class="k">Total likes</div><div class="v" style="color:var(--up)">${totalUp}</div></div>
    <div class="card"><div class="k">Total dislikes</div><div class="v" style="color:var(--down)">${totalDown}</div></div>
  </div>
  ${rows.length ? `<table><thead><tr><th>Hotel ID</th><th style="text-align:right">Likes</th><th style="text-align:right">Dislikes</th><th style="text-align:right">Net</th></tr></thead><tbody>${body}</tbody></table>`
    : `<div class="empty">No votes yet. Open the site and tap a like or dislike.</div>`}
</div>
<script>setTimeout(()=>location.reload(),15000)</script>
</body></html>`);
});

/* ---------- static frontend ---------- */
const dist = path.join(__dirname, "dist");
app.use(express.static(dist));
app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));

app.listen(PORT, () => {
  console.log(`Waypoint running on port ${PORT} (AI ${API_KEY ? "enabled" : "fallback mode — set ANTHROPIC_API_KEY"})`);
});
