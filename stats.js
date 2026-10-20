// Collected play data: one record per finished round (GameEngine.roundRecord), kept to build bots from
// how real people play. Only the browser running the game records it, so each round is saved once.
//
// Where records go:
//   1. This browser, always (localStorage, the newest MAX_LOCAL). "Export data" in the panel downloads them.
//   2. The artifact's database, on the claude.ai page (collection "rounds", one document per round).
//   3. COLLECT_URL, if set: the collector (tools/collector, a Cloudflare Worker), where every place Plop
//      is played sends its rounds, the iPhone app too later. Unsent records wait and retry.
// No names are kept: players appear by their random online id (or p0, p1… in test mode).
// tools/percentiles.js turns exported records into per-scenario percentiles.
"use strict";

const COLLECT_URL = "https://plop-collect.willns.workers.dev/rounds"; // the collector's https://…workers.dev/rounds (see tools/collector/worker.js)
const MAX_LOCAL = 3000;
const collectDb = window.claude?.use ? window.claude.use("db").catch(() => null) : Promise.resolve(null);
let lastCollected = null;

function collectSource() {
  if (!online) return "test";
  return window.claude?.use ? "artifact" : "web";
}

function collectRound(eng) {
  const rec = eng.lastRecord;
  if (!rec || rec.id === lastCollected || (online && online.role !== "host")) return;
  lastCollected = rec.id;
  // The room's name and each player's name, so a night's games can be found again.
  const name = id => eng.state.players.find(p => p.id === id)?.name || null;
  const record = { ...rec, room: online?.label || null, answers: rec.answers.map(a => ({ ...a, name: name(a.p) })), source: collectSource(), platform: "web" };
  const local = store.get("collected", []);
  local.push(record);
  store.set("collected", local.slice(-MAX_LOCAL));
  const queue = store.get("collectQueue", []);
  queue.push(record);
  store.set("collectQueue", queue.slice(-MAX_LOCAL));
  flushCollected();
}

let flushing = false;
async function flushCollected() {
  if (flushing) return;
  flushing = true;
  try {
    const queue = store.get("collectQueue", []);
    if (!queue.length) return;
    const db = await collectDb;
    const sent = new Set();
    if (db) {
      for (const r of queue) {
        try { await db.collection("rounds").doc(r.id).set(r); sent.add(r.id); }
        catch (err) { if (err?.code === "quota_exceeded" || err?.code === "invalid_argument") sent.add(r.id); else break; }
      }
    } else if (COLLECT_URL) {
      // A plain-text body skips the cross-site preflight; the reply can't be read, so a request that
      // went out counts as sent. Only a network failure keeps the records queued.
      await fetch(COLLECT_URL, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(queue) });
      queue.forEach(r => sent.add(r.id));
    } else {
      return; // nowhere to send: they stay in this browser for export
    }
    store.set("collectQueue", store.get("collectQueue", []).filter(r => !sent.has(r.id)));
  } catch { /* offline: try again later */ } finally {
    flushing = false;
  }
}
setInterval(flushCollected, 60000);
setTimeout(flushCollected, 3000);

function exportCollected() {
  const blob = new Blob([JSON.stringify(store.get("collected", []), null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `plop-rounds-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
