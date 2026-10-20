// Online play: one phone per person, over the published page's `room` (claude.ai artifacts).
// You type a room name, then your name and a theme; your partner types the same room name and you're
// in the same room. No accounts. A room holds 2 to 4 players (everyone's letter goes in the word),
// and there's space for 100 rooms at once.
//
// Rooms come from claude.ai on the published artifact and from PeerJS (peerroom.js) on the public site.
// One browser in each room quietly runs the game (the "host": whoever got there first). It runs the
// same GameEngine as test mode and sends snapshots of its state to everyone; the others send back what
// they do: lock a letter, peek, submit a word. If the host leaves, the next person takes over from the
// last snapshot, scores and all.
//
// Everything else (rules, scoring, screens, the show) is the same code as test mode, so changes to the
// game carry over by themselves.
//
// Races are fair across phones because nobody's answer is judged by when it reaches the host:
// - Clocks: each guest pings the host and keeps the round trip that came back quickest, which pins down
//   the host's clock to within a few milliseconds (half that round trip at worst).
// - Each phone times its own answer, from when the letters actually showed on it (Go, or later if the
//   round reached it late), and sends how many seconds it took.
// - While the clock runs, each guest also sends "nothing yet at 3.2s" a few times a second. The host ends a
//   race as soon as every player without an answer has passed the best time, so it waits exactly as
//   long as a slow connection needs and no longer (MAX_WAIT at most, for a phone that has gone quiet).
//   Those reports also keep anyone from later claiming a time earlier than one they already passed.
// The one thing to wire up here: a NEW kind of player action that changes the game (today: lock, peek,
// submit) needs forwarding in guestEngine() and handling in onAct().
"use strict";

const ROOM_PREFIX = "plop-";
const CHUNK = 2800;          // base64 characters per message; the room caps a message at 4 KiB
const HEARTBEAT_MS = 2500;   // the host re-sends the whole state this often, for anyone who missed some
const SEND_GAP_MS = 120;     // and never more than one snapshot this often
const SETTLE_MS = 1500;      // after joining, how long to listen for a host before becoming one
const TAKEOVER_MS = 4000;    // how long a room can go without a host before someone takes over
const MAX_WAIT = 5;          // the longest a round waits on a phone that has stopped reporting in
const MAX_LAG = 4;           // how far a reported answer time may be behind when the answer got here
const TICK_MS = 300;         // how often a guest reports its progress while the clock runs
const PING_MS = 2000;        // how often a guest re-checks the host's clock (faster just after joining)
const ROOM_SIZE = 4;         // past 4 letters, hardly any word fits
const MAX_ROOMS = 100;
const THEMES = [["park", "🧺 Picnic"], ["pub", "🍺 Bar"], ["beach", "🏖️ Beach"], ["recess", "🛝 Recess"]];

// The room namespace: claude.ai's own on the published artifact, PeerJS (peerroom.js) on the public web
// site, and null where neither can run (a local file, a signed-out viewer), which means test mode.
const roomReady = (window.claude?.use ? window.claude.use("room")
  : Promise.resolve(location.protocol.startsWith("http") && window.Peer ? peerLobby() : null)).catch(() => null);

// ---------- State on the wire ----------
// Sets and letter patterns don't survive JSON, so they travel tagged. Non-ASCII is escaped so the
// text can be base64'd, and base64 never needs escaping, so a chunk's size is predictable.

function encodeState(st) {
  const json = JSON.stringify(st, (k, v) =>
    v instanceof Set ? { $set: [...v] } : v instanceof WordPattern ? { $pattern: v.constraints } : v);
  return btoa(json.replace(/[\u0080-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")));
}

function decodeState(b64) {
  return JSON.parse(atob(b64), (k, v) =>
    v && typeof v === "object" ? (v.$set ? new Set(v.$set) : v.$pattern ? new WordPattern(v.$pattern) : v) : v);
}

// ---------- Joining ----------

// Room names become platform room names: lowercase letters, digits and dashes.
function roomSlug(label) {
  return label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

// You keep the same id across reloads, so rejoining puts you back in your seat.
function playerId() {
  let id = store.get("onlineId", null);
  if (!/^u[a-z0-9]{6}$/.test(id || "")) { id = "u" + Math.random().toString(36).slice(2, 8).padEnd(6, "0"); store.set("onlineId", id); }
  return id;
}

async function enterRoom(label, name) {
  const lobby = await roomReady;
  if (!lobby) throw new Error("Online play isn't available here.");
  // Everyone on the page says which room they're in, so the rooms in use can be counted.
  await new Promise(done => { const off = lobby.onPeers(() => { off(); done(); }); setTimeout(done, 1500); });
  const slug = roomSlug(label);
  const inUse = new Set(lobby.peers().filter(p => !p.sameTab && typeof p.presence?.room === "string").map(p => p.presence.room));
  if (!inUse.has(slug) && inUse.size >= MAX_ROOMS) throw Object.assign(new Error(`All ${MAX_ROOMS} rooms are in use right now. Try again soon.`), { plain: true });
  lobby.presence({ room: slug }).catch(() => {});
  const room = await lobby.join(ROOM_PREFIX + slug);
  stopAllSpeech();
  online = {
    room, label, name, me: playerId(), role: "joining", myPeer: null, hostPeer: null, noHostSince: performance.now(),
    seats: {}, session: null, applied: 0, lastBody: "", lastState: null, lastSnap: 0, offsets: [], parts: {},
    pings: [], pingsSent: 0, seen: null, progress: {},
  };
  document.body.classList.add("online");
  engine = guestEngine();
  activeId = online.me;
  room.on("act", onAct);
  room.on("state", onState);
  room.on("reply", onReply);
  room.onPeers(onPeers);
  room.presence({ pid: online.me, name, role: "joining" }).catch(() => {});
  setTimeout(() => {
    if (online.role !== "joining") return;
    const others = room.peers().filter(p => !p.sameTab && ["host", "guest"].includes(p.presence?.role) && p.presence?.pid !== online.me);
    if (others.length >= ROOM_SIZE) return roomFull();
    if (online.hostPeer) becomeGuest(); else becomeHost(null);
  }, SETTLE_MS);
  $("#landing").hidden = true;
  phones.sig = null;
  changed();
}

// The room has as many players as it can take: back to the start, with a note.
function roomFull() {
  try { sessionStorage.setItem("plop:note", `“${online.label}” is full. Pick another room name.`); } catch { /* storage unavailable */ }
  location.reload();
}

function setRole(role) {
  online.role = role;
  // A host says when it started, so if two end up running (someone on a slow connection didn't hear the
  // host in time and started their own), the room's real one keeps it.
  online.room.presence({ role, since: role === "host" ? Date.now() : null }).catch(() => {});
  document.body.classList.toggle("online-host", role === "host");
  lastPhase = engine.state.phase.type;
  phones.sig = null;
  changed();
}

// Run the game: a fresh one, or (taking over) the last state the old host sent.
function becomeHost(from) {
  const e = new GameEngine(lexicon, syllables, structuredClone(rules));
  if (from) {
    e.state = from;
    e.resultSeq = from.lastResult?.seq || 0;
    const old = from.host;
    if (old && old !== online.me) e.removePlayer(old, now());
    // The old host took everyone's secret picks and answers with it, so a round in play starts over.
    if (["picking", "answering", "noWordFits"].includes(from.phase.type)) { from.round--; e.beginRound(); }
  } else {
    e.addPlayer({ id: online.me, name: online.name });
    e.state.scene = feel.scene; // the room's theme is its creator's
  }
  engine = e;
  engine.maxWait = MAX_WAIT;
  engine.progressFor = (id, t) => {
    if (id === online.me) return t - engine.state.phase.opensAt;
    const p = online.progress[id];
    return p && p.round === engine.state.round ? p.e : 0;
  };
  engine.state.host = online.me;
  online.session = Math.random().toString(36).slice(2, 8);
  online.seats = {};
  for (const p of online.room.peers()) seatPeer(p);
  setRole("host");
  sendSnapshot(true);
}

function becomeGuest() {
  engine = guestEngine();
  Object.assign(online, { session: null, applied: 0, lastBody: "", parts: {} });
  setRole("guest");
}

// ---------- Who's here ----------

function onPeers(ch) {
  const mine = ch.peers.find(p => p.sameTab);
  if (mine) online.myPeer = mine.peer;
  const hosts = ch.peers.filter(p => !p.sameTab && p.presence?.role === "host").sort(hostOrder);
  online.hostPeer = hosts[0]?.peer || null;
  if (online.hostPeer) online.noHostSince = null; else online.noHostSince ??= performance.now();

  if (online.role === "host") {
    // Two hosts before the game begins (two people arrived at once, or a slow connection didn't hear the
    // host in time): the one that started first keeps it.
    if (hosts.length && mine && hostOrder(hosts[0], mine) < 0 && engine.state.phase.type === "lobby") return becomeGuest();
    let moved = false;
    for (const p of [...ch.joined, ...ch.updated]) moved = seatPeer(p) || moved;
    for (const p of ch.left) {
      const pid = online.seats[p.peer];
      if (!pid) continue;
      delete online.seats[p.peer];
      if (!Object.values(online.seats).includes(pid)) { engine.removePlayer(pid, now()); moved = true; }
    }
    if (moved) changed();
    if (ch.joined.length) sendSnapshot(true);
  }
  renderOnlineBar();
}

// Which of two hosts keeps the room: the earlier start, then the earlier peer label.
function hostOrder(a, b) {
  const sa = a.presence?.since ?? Infinity, sb = b.presence?.since ?? Infinity;
  return sa !== sb ? sa - sb : a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0;
}

function seatPeer(p) {
  const pr = p.presence || {};
  if (p.sameTab || pr.role !== "guest" || typeof pr.pid !== "string" || !/^u[a-z0-9]{6}$/.test(pr.pid)) return false;
  if (online.seats[p.peer] === pr.pid) return false;
  const st = engine.state;
  if (!st.players.some(x => x.id === pr.pid) && st.players.filter(x => !x.isBot).length >= ROOM_SIZE) return false;
  online.seats[p.peer] = pr.pid;
  engine.addPlayer({ id: pr.pid, name: String(pr.name || "").trim().slice(0, 16) || "Friend" });
  return true;
}

// Nobody running the game for a while: the guest with the earliest peer label takes over.
setInterval(() => {
  if (online?.role !== "guest" || online.noHostSince == null || performance.now() - online.noHostSince < TAKEOVER_MS) return;
  const guests = online.room.peers().filter(p => p.presence?.role === "guest").map(p => p.peer).sort();
  if (guests[0] === online.myPeer) becomeHost(online.lastState);
}, 1000);

// ---------- Host: actions in, snapshots out ----------

function onAct(msg) {
  if (online.role !== "host") return;
  const d = msg.data, pid = online.seats[msg.peer];
  if (!pid || !d || typeof d !== "object" || d.pid !== pid) return; // only a seated player, only as itself
  const st = engine.state, t = now();
  if (d.a === "lock" && typeof d.letter === "string" && /^[a-z]$/.test(d.letter)) engine.lockLetter(pid, d.letter, t);
  else if (d.a === "peek") engine.peek(pid, t);
  else if (d.a === "ping" && Number.isFinite(d.c)) { online.room.emit("reply", { to: pid, pong: d.c, h: now() }).catch(() => {}); return; }
  else if (d.a === "tick") { if (d.r === st.round && st.phase.type === "answering") noteProgress(pid, Number(d.e), t); return; }
  else if (d.a === "submit" && typeof d.word === "string" && st.phase.type === "answering") {
    // Trust the player's own timing, within limits: no earlier than a time they already reported passing
    // with nothing, no later than when it got here, and at most MAX_LAG behind that.
    const real = t - st.phase.opensAt, p = online.progress[pid];
    const passed = p && p.round === st.round ? p.e - 0.05 : 0;
    const lo = Math.max(0, real - MAX_LAG, passed), hi = Math.max(lo, real + 0.1);
    const elapsed = Math.min(hi, Math.max(lo, Number(d.elapsed) || 0));
    noteProgress(pid, elapsed, t);
    const word = cleanWord(d.word.slice(0, 40));
    const res = engine.submit(pid, word, elapsed, st.phase.opensAt + elapsed, d.via);
    if (res.kind === "accepted" && st.roundMode === "list") pushLog(`${playerName(pid)} found ${cap(word)} (+${wordTotal(res.scored)})`);
    online.room.emit("reply", { to: pid, word, res }).catch(() => {});
  } else return;
  changed();
}

// How far into this round a guest has got, by its own report (never ahead of the host's clock).
function noteProgress(pid, e, t) {
  const st = engine.state;
  if (!Number.isFinite(e)) return;
  e = Math.min(e, t - st.phase.opensAt + 0.1);
  const p = online.progress[pid];
  if (!p || p.round !== st.round) online.progress[pid] = { round: st.round, e };
  else p.e = Math.max(p.e, e);
}

// The game moves on even while the host's page is in the background, where animation frames stop.
setInterval(() => { if (online?.role === "host" && engine.tick(now())) changed(); }, 250);

let snapTimer = null, lastSentAt = 0, lastSent = "", snapVersion = 0;

function onlineChanged() {
  renderOnlineBar();
  if (online.role !== "host" || snapTimer) return;
  snapTimer = setTimeout(() => { snapTimer = null; sendSnapshot(false); }, Math.max(0, SEND_GAP_MS - (performance.now() - lastSentAt)));
}

function sendSnapshot(force) {
  if (online?.role !== "host") return;
  const body = encodeState(engine.state);
  if (body === lastSent && !force) return;
  lastSent = body;
  lastSentAt = performance.now();
  const v = ++snapVersion, n = Math.ceil(body.length / CHUNK);
  for (let i = 0; i < n; i++) {
    online.room.emit("state", { h: online.session, v, i, n, t: now(), s: body.slice(i * CHUNK, (i + 1) * CHUNK) }).catch(() => {});
  }
}
setInterval(() => sendSnapshot(true), HEARTBEAT_MS);

// ---------- Guest: snapshots in, actions out ----------

// A guest's engine only holds the host's latest state; anything that would change it goes to the host.
function guestEngine() {
  const e = new GameEngine(lexicon, syllables, structuredClone(rules));
  const send = (a, data = {}) => online?.room.emit("act", { a, pid: online.me, ...data }).catch(() => {});
  e.lockLetter = (id, letter) => send("lock", { letter });
  e.peek = () => { send("peek"); return true; };
  for (const m of ["startGame", "nextRound", "endGame", "repick", "backToLobby", "setRoundMode", "addPlayer", "removePlayer", "moveSeat", "setRole", "resetRoles", "setRules"]) e[m] = () => {};
  e.tick = () => false;
  return e;
}

// What a guest can check by itself it answers at once; a word that might score goes to the host.
function guestSubmit(id, word, elapsed, via) {
  const st = engine.state, u = ui(id);
  if (now() > engine.closesAtFor(id)) return { kind: "closed" };
  if (!lexicon.contains(word)) return { kind: "notAWord" };
  if (!st.pattern?.matches(word)) return { kind: "doesNotFit" };
  if (!meetsTwist(word, st.twist, syllables)) return { kind: "twist" };
  if (u.myWords.some(w => w.word === word)) return { kind: "alreadyUsed" };
  online.room.emit("act", { a: "submit", pid: online.me, word, elapsed, via }).catch(() => {});
  return null;
}

function onState(msg) {
  const d = msg.data;
  if (online.role === "host") return;
  if (!d || typeof d.s !== "string" || !Number.isInteger(d.v) || !Number.isInteger(d.i) || !Number.isInteger(d.n) || d.n > 400) return;
  if (msg.peer !== online.hostPeer) return;
  if (online.role === "joining") becomeGuest();
  if (d.h !== online.session) { Object.assign(online, { session: d.h, applied: 0, offsets: [], parts: {}, pings: [], pingsSent: 0 }); sendPing(); }
  // Until a ping comes back, the host's clock from its sends: the newest seen, minus as little delay as
  // recent sends show.
  online.offsets.push(d.t - performance.now() / 1000);
  if (online.offsets.length > 30) online.offsets.shift();
  if (!online.pings.length) clockOffset = Math.max(...online.offsets);
  if (d.v <= online.applied) return;
  const buf = (online.parts[d.v] ||= { n: d.n, got: 0, s: [] });
  if (buf.s[d.i] == null) { buf.s[d.i] = d.s; buf.got++; }
  if (buf.got < buf.n) return;
  for (const k in online.parts) if (+k <= d.v) delete online.parts[k];
  online.applied = d.v;
  online.lastSnap = performance.now();
  const body = buf.s.join("");
  if (body === online.lastBody) return;
  let st;
  try { st = decodeState(body); } catch { return; }
  online.lastBody = body;
  online.lastState = decodeState(body); // a spare copy, in case this browser has to take over
  engine.state = st;
  // When this round first reached this phone: if that's after Go, its clock starts then.
  if (st.phase.type === "answering" && online.seen?.round !== st.round) online.seen = { round: st.round, at: now() };
  if (!st.players.some(p => p.id === online.me) && st.players.filter(p => !p.isBot).length >= ROOM_SIZE) return roomFull();
  changed();
}

function onReply(msg) {
  const d = msg.data;
  if (online.role === "host" || msg.peer !== online.hostPeer) return;
  if (d && d.to === online.me && Number.isFinite(d.pong) && Number.isFinite(d.h)) return onPong(d);
  if (!d || d.to !== online.me || !d.res || typeof d.res.kind !== "string") return;
  applySubmit(online.me, String(d.word || ""), d.res);
}

// ---------- Guest: the host's clock, and progress reports ----------

function sendPing() {
  if (online?.role !== "guest" && online?.role !== "joining") return;
  online.pingsSent++;
  online.room.emit("act", { a: "ping", pid: online.me, c: performance.now() / 1000 }).catch(() => {});
}

// The host's time was read somewhere in the round trip; the quickest trips pin it down best.
function onPong(d) {
  const back = performance.now() / 1000, rtt = back - d.pong;
  if (rtt < 0 || rtt > 10) return;
  online.pings.push({ rtt, off: d.h - (d.pong + back) / 2 });
  if (online.pings.length > 20) online.pings.shift();
  clockOffset = online.pings.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off;
}

// Quick pings just after joining a host, then every PING_MS.
(function pingLoop() {
  setTimeout(() => { sendPing(); pingLoop(); }, online && online.pingsSent < 8 ? 250 : PING_MS);
})();

// When this phone's clock for the round started.
function roundStart(st) {
  return Math.max(st.phase.opensAt, online?.seen?.round === st.round ? online.seen.at : -Infinity);
}

// Seconds into the round at a moment on this phone's own clock (performance.now() seconds). The start is
// fixed the first time it's asked for, so a clock correction from a ping mid-round doesn't move it.
function roundElapsed(st, at = performance.now() / 1000) {
  if (online.start?.round !== st.round) online.start = { round: st.round, at: roundStart(st) - clockOffset };
  return at - online.start.at;
}

setInterval(() => {
  if (online?.role !== "guest") return;
  const st = engine.state, t = now();
  if (st.phase.type !== "answering" || t < st.phase.opensAt) return;
  if (isRace(st.roundMode) && ui(online.me).myWords.length) return;
  online.room.emit("act", { a: "tick", pid: online.me, r: st.round, e: roundElapsed(st) }).catch(() => {});
}, TICK_MS);

// ---------- The room bar and the landing screen ----------

function renderOnlineBar() {
  const bar = $("#online-bar");
  if (!online) { bar.hidden = true; return; }
  bar.hidden = false;
  const humans = engine.state.players.filter(p => !p.isBot);
  const lost = online.role !== "host" && online.role !== "joining" && (!online.hostPeer || performance.now() - online.lastSnap > 7000);
  const html = `<span class="code">Room <b>${esc(online.label)}</b></span>
    ${lost ? `<span class="muted small">Reconnecting…</span>` : ""}
    <span class="who">${humans.map(p => `<span class="${p.isConnected ? "" : "away"}">${esc(p.id === online.me ? "You" : p.name)}</span>`).join("")}</span>
    <button class="btn small ghost" id="leave-room">Leave</button>`;
  if (bar.dataset.html !== html) { bar.innerHTML = html; bar.dataset.html = html; }
}
setInterval(() => online && renderOnlineBar(), 2000);

document.addEventListener("click", e => {
  if (e.target.id === "leave-room") location.reload();
});

(function landing() {
  const el = $("#landing"), note = $("#online-note"), roomIn = $("#room-name"), nameIn = $("#online-name");
  if (new URLSearchParams(location.search).has("test")) { el.hidden = true; return; }
  const stepRoom = $("#step-room"), stepYou = $("#step-you");
  roomIn.value = store.get("onlineRoom", "");
  nameIn.value = store.get("onlineName", "");

  // Theme: whoever opens the room picks it; people joining see theirs.
  const themes = $("#theme-pick");
  themes.innerHTML = THEMES.map(([k, label]) => `<button type="button" class="theme ${feel.scene === k ? "on" : ""}" data-scene="${k}">${label}</button>`).join("");
  if (!store.get("feel", null)?.scene) { feel.scene = "park"; applyFeel(); }
  themes.addEventListener("click", e => {
    const b = e.target.closest("[data-scene]");
    if (!b) return;
    feel.scene = b.dataset.scene;
    applyFeel();
    themes.querySelectorAll(".theme").forEach(t => t.classList.toggle("on", t === b));
  });

  const nextBtn = $("#room-next"), enterBtn = $("#enter-room");
  nextBtn.disabled = true;
  note.textContent = "Connecting…";
  // The published page is just the room. Where rooms can't run (a local copy), it opens test mode instead.
  roomReady.then(room => {
    if (!room) { el.hidden = true; return; }
    nextBtn.disabled = false;
    let left = null;
    try { left = sessionStorage.getItem("plop:note"); sessionStorage.removeItem("plop:note"); } catch { /* storage unavailable */ }
    note.textContent = left || "Pick a room name and tell your friends. They type the same name to join you (up to 4 players).";
  });
  const shake = input => { input.focus(); input.classList.add("shake"); setTimeout(() => input.classList.remove("shake"), 400); };
  const toYou = () => {
    if (!roomSlug(roomIn.value)) return shake(roomIn);
    store.set("onlineRoom", roomIn.value.trim());
    stepRoom.hidden = true; stepYou.hidden = false;
    $("#room-label").textContent = roomIn.value.trim();
    note.textContent = "";
    nameIn.focus();
  };
  const enter = async () => {
    const n = nameIn.value.trim().slice(0, 16);
    if (!n) return shake(nameIn);
    store.set("onlineName", n);
    enterBtn.disabled = true;
    note.textContent = "Joining…";
    try { await enterRoom(roomIn.value.trim().slice(0, 40), n); }
    catch (err) { note.textContent = err?.plain ? err.message : `Couldn't connect (${err?.code || err?.message || "unknown"}). Try again.`; enterBtn.disabled = false; }
  };
  nextBtn.addEventListener("click", toYou);
  roomIn.addEventListener("keydown", e => { if (e.key === "Enter" && !nextBtn.disabled) toYou(); });
  nameIn.addEventListener("keydown", e => { if (e.key === "Enter") enter(); });
  enterBtn.addEventListener("click", enter);
  $("#room-back").addEventListener("click", () => { stepYou.hidden = true; stepRoom.hidden = false; roomIn.focus(); });
})();
