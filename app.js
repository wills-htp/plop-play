// Bookends playtest: every phone on one page, sharing one host engine.
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// The host's clock. In online play a guest's clock is shifted to match the host's (online.js).
let clockOffset = 0;
const now = () => performance.now() / 1000 + clockOffset;
const cap = s => s.toUpperCase();

const store = {
  get(k, d) { try { const v = localStorage.getItem("bookends:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("bookends:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

function mergeRules(saved) {
  const d = defaultRules();
  if (!saved) return d;
  // speedWindow used to be a 3s "answered within" cutoff; it's now the clock the time bonus counts down from.
  // Settings saved before rulesVersion 2 had an older countdown default; take the current one.
  if ((saved.rulesVersion || 0) < 2) { saved = { ...saved, rulesVersion: d.rulesVersion }; delete saved.countdown; }
  if (saved.scoring?.speedWindow < 5) { saved = { ...saved, scoring: { ...saved.scoring } }; delete saved.scoring.speedBonus; delete saved.scoring.speedWindow; }
  return { ...d, ...saved, scoring: { ...d.scoring, ...(saved.scoring || {}) }, target: { ...d.target, ...(saved.target || {}) } };
}

// ENABLE plus the newer words and British spellings it lacks (data/more-words.js).
const lexicon = new Lexicon(window.BOOKENDS_WORDS + "\n" + (window.BOOKENDS_MORE_WORDS || ""));
const syllables = new Syllables(window.BOOKENDS_SYLLABLES);
let rules = mergeRules(store.get("rules", null));
const feel = Object.assign({ anim: true, speed: 1, sound: true, peek: false, scene: "park" }, store.get("feel", {}));
// ?scene=beach&theme=dark opens a particular look (handy for sharing a link or a screenshot).
const urlLook = new URLSearchParams(location.search);
if (SCENES[urlLook.get("scene")]) feel.scene = urlLook.get("scene");
if (["light", "dark"].includes(urlLook.get("theme"))) feel.theme = urlLook.get("theme");
const names = store.get("names", ["Alice", "Bob", "Cara", "Dev"]);
let phoneCount = Math.min(4, Math.max(2, store.get("phoneCount", 2)));
let botCount = Math.min(3, Math.max(0, store.get("botCount", 0)));

let engine;
let phones = [];          // [{ id, wrap, screen, key, ui }]
const uis = {};           // per-player phone-local state, by player id
let activeId = null;
let feedbackSeq = 0;
let lastLoggedResult = null;
let online = null;        // online play (online.js): { role: "host" | "guest", me, code, ... }; null in test mode
let lastPhase = "lobby";
const log = [];

// ---------- Game setup ----------

function newGame() {
  stopAllSpeech();
  engine = new GameEngine(lexicon, syllables, structuredClone(rules));
  for (let i = 0; i < phoneCount; i++) engine.addPlayer({ id: "p" + i, name: names[i] || "Player " + (i + 1) });
  for (let j = 0; j < botCount; j++) engine.addPlayer({ id: "bot" + j, name: "Bot " + (j + 1), isBot: true });
  lastPhase = "lobby";
  activeId = "p0";
  changed();
}

// Who runs the game: phone 1 in test mode; online, whoever's browser is hosting the room.
function hostID() { return online ? engine.state.host : "p0"; }

function ui(id) {
  return (uis[id] ||= { round: -1, phase: null, selected: null, myPick: null, myWords: [], feedback: null, peekUntil: 0, mode: "type", heard: [], seen: new Set(), listening: false, rec: null, speechProblem: null });
}

// Phone-local state resets when a new round starts, like GameController.apply in Swift.
function syncUI(id) {
  const st = engine.state, u = ui(id);
  if (st.round !== u.round || (st.phase.type === "picking" && u.phase !== "picking")) {
    u.round = st.round;
    u.selected = null; u.myPick = null; u.myWords = []; u.feedback = null; u.peekUntil = 0; u.heard = []; u.seen = new Set();
    stopSpeech(id);
  }
  u.phase = st.phase.type;
}

// ---------- Phones on the stage ----------

function humanPlayers() { return engine.state.players.filter(p => !p.isBot); }

// The phones drawn on this screen: every human in test mode, just your own in online play.
function localPlayers() { return online ? humanPlayers().filter(p => p.id === online.me) : humanPlayers(); }

function buildPhonesIfNeeded() {
  const sig = localPlayers().map(p => p.id).join(",");
  if (phones.sig === sig) return;
  const host = $("#phones");
  host.innerHTML = online && !sig ? `<div class="joining">Joining room ${esc(online.label)}…</div>` : "";
  phones = localPlayers().map(p => {
    const wrap = document.createElement("div");
    wrap.className = "phone-wrap";
    wrap.innerHTML = `<div class="phone-label"></div><div class="phone"><div class="notch"></div><div class="screen"></div></div>`;
    host.appendChild(wrap);
    const ph = { id: p.id, wrap, screen: $(".screen", wrap), key: null };
    wrap.addEventListener("pointerdown", () => setActive(p.id));
    wrap.addEventListener("focusin", () => setActive(p.id, false));
    ph.screen.addEventListener("click", e => onPhoneClick(ph, e));
    // Tapping Send would take focus from the word box, and on a phone that closes the keyboard.
    for (const type of ["pointerdown", "mousedown"]) ph.screen.addEventListener(type, e => { if (e.target.closest(".answer .send")) e.preventDefault(); });
    ph.screen.addEventListener("submit", e => { e.preventDefault(); onPhoneSubmit(ph, e.target); });
    return ph;
  });
  phones.sig = sig;
}

function setActive(id, focus = true) {
  activeId = id;
  for (const ph of phones) ph.wrap.classList.toggle("active", ph.id === id);
  if (focus) { const input = phoneByID(id)?.screen.querySelector(".answer input"); if (input && document.activeElement !== input) input.focus(); }
}
function phoneByID(id) { return phones.find(p => p.id === id); }

function labelPhones() {
  phones.forEach((ph, i) => {
    const p = engine.state.players.find(x => x.id === ph.id);
    const seat = engine.state.players.findIndex(x => x.id === ph.id);
    $(".phone-label", ph.wrap).innerHTML =
      `Phone ${i + 1} · <b>${esc(p.name)}</b> ${ph.id === hostID() ? '<span class="badge">host</span>' : ""} <span class="badge">seat ${seat + 1}</span> <kbd>${i + 1}</kbd>`;
    ph.wrap.classList.toggle("active", ph.id === activeId);
  });
}

// ---------- State changes & rendering ----------

function changed() {
  const st = engine.state;
  showScene();
  buildPhonesIfNeeded();
  labelPhones();
  phaseEffects(st);
  for (const ph of phones) {
    syncUI(ph.id);
    const key = screenKey(ph);
    // Same screen while the scoring show plays: leave it be (online, other players can change things then).
    const showing = key === ph.key && ph.screen.querySelector(".tally");
    if (key !== ph.key || (st.phase.type !== "answering" && !showing)) mount(ph, key !== ph.key);
    else patchAnswering(ph);
    ph.key = key;
  }
  renderPanel();
  if (online) onlineChanged();
}

function phaseEffects(st) {
  const t = st.phase.type;
  if (t !== lastPhase) {
    if (t === "answering") sound("reveal");
    if (t === "noWordFits") sound("bad");
    if (t === "roundOver") sound(st.lastResult?.winners.length ? "good" : "meh");
    if (t === "gameOver") { sound("win"); recordGame(st.champions); }
    lastPhase = t;
  }
  if (st.lastResult && st.lastResult.seq !== lastLoggedResult && (t === "roundOver" || t === "gameOver")) {
    lastLoggedResult = st.lastResult.seq;
    logRound(st.lastResult);
    collectRound(engine);
    recordStandings(st.lastResult);
  }
}

function screenKey(ph) {
  const st = engine.state, u = ui(ph.id), t = st.phase.type;
  if (t === "picking") return `pick:${st.round}:${st.locked.has(ph.id) ? 1 : 0}`;
  if (t === "answering") {
    const open = now() >= st.phase.opensAt ? "open" : "pre";
    const done = isRace(st.roundMode) && u.myWords.length ? "done" : u.mode;
    return `ans:${st.round}:${open}:${open === "open" ? done : ""}`;
  }
  return `${t}:${st.round}`;
}

function mount(ph, fresh) {
  const st = engine.state;
  const html = {
    lobby: viewLobby, picking: viewPicking, answering: viewAnswering,
    noWordFits: viewNoWordFits, roundOver: viewRoundOver, gameOver: viewGameOver,
  }[st.phase.type](ph, fresh);
  ph.screen.innerHTML = `<div class="view ${st.phase.type}">${html}</div>`;
  if (st.phase.type === "answering") patchAnswering(ph, true);
  if (fresh) afterMount(ph);
}

function afterMount(ph) {
  const st = engine.state, t = st.phase.type;
  if (t === "answering" && now() >= st.phase.opensAt && ph.id === activeId) {
    const input = ph.screen.querySelector(".answer input");
    if (input) input.focus();
  }
  if (t === "answering" && ui(ph.id).mode === "speak" && now() >= st.phase.opensAt && !ui(ph.id).listening && !(isRace(st.roundMode) && ui(ph.id).myWords.length)) {
    setTimeout(() => startSpeech(ph.id), 0);
  }
  if (t === "roundOver" || t === "gameOver") {
    const finish = () => {
      countUpScores(ph);
      if (t === "gameOver" && st.champions.includes(ph.id)) confetti(ph.screen);
    };
    if (st.lastResult?.winners.length && feel.anim) playTally(ph, finish); else finish();
  }
}

// ---------- Views ----------

function scoresBar(ph, { counting = false } = {}) {
  const st = engine.state, before = st.lastResult?.before || {};
  return `<div class="scores">${st.players.map(p => {
    const score = st.scores[p.id] || 0, from = counting ? (before[p.id] ?? score) : score;
    return `<div class="score-chip ${p.id === ph.id ? "me" : ""} ${p.isConnected ? "" : "away"}" data-player="${p.id}">
      ${esc(p.id === ph.id ? "You" : p.name)} <b data-from="${from}" data-to="${score}">${from}</b></div>`;
  }).join("")}</div>`;
}

function tile(letter, role, size = 64) {
  return `<div class="tile ${role}" style="--size:${size}px">${cap(letter)}</div>`;
}

// The round's twist, if it has one ("🎯 Hard: at least 8 letters").
function twistBadge(twist, level) { return twist ? `<div class="twist ${level || ""}">🎯 ${level ? DIFFICULTY[level].label + ": " : ""}${twistText(twist)}</div>` : ""; }
// The countdown spells the round's rule out big, so nobody misses it. With random difficulty on, an
// easy round says so too.
function countdownRule(st) {
  if (st.twist) return `<div class="twist big ${st.level || ""}"><small>${st.level ? DIFFICULTY[st.level].label + " round" : "This round"}</small>🎯 ${twistText(st.twist)}</div>`;
  if (isRace(st.roundMode) && st.rules.difficulty !== "easy") return `<div class="twist big easy"><small>Easy round</small>🙂 any word that fits</div>`;
  if (st.roundMode === "turn") return `<div class="twist big"><small>Turn round</small>💎 highest score wins</div>`;
  return "";
}

// Host picks a difficulty in the lobby; it holds for the whole game. Everyone else just sees it.
const DIFFICULTY_NOTE = {
  mixed: "Each round is Easy, Medium or Hard at random",
  easy: "Any word that fits",
  medium: "Mostly a Medium rule (6–7 letters or 2 syllables); some rounds have no rule, some a Hard one",
  hard: "Mostly a Hard rule (8–9 letters or 3–4 syllables); some rounds a Medium one",
};
function difficultyPicker(st, isHost) {
  const levels = [["mixed", "🎲 Mixed"], ["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"]];
  const now = st.rules.difficulty || "mixed";
  if (!isHost) return `<div class="center muted small">Difficulty: ${esc(levels.find(([k]) => k === now)[1])}</div>`;
  return `<div class="diff"><div class="muted small">Difficulty</div><div class="seg four">${levels.map(([k, label]) =>
    `<button class="${k === now ? "on" : ""}" data-action="difficulty" data-level="${k}">${label}</button>`).join("")}</div>
    <div class="muted small">${DIFFICULTY_NOTE[now]}</div></div>`;
}

// Online rooms hold 4 letters at most (past that hardly any word fits); the test table goes to 8.
const maxSeats = () => (online ? ROOM_SIZE : 8);

// Host adds or removes a bot and sets how well bots play. Bots answer Classic, Sandwich and Turn rounds.
function botControls(st, isHost) {
  const bots = st.players.filter(p => p.isBot).length, level = st.rules.botLevel || "medium";
  if (!isHost) return bots ? `<div class="center muted small">🤖 Bot skill: ${BOT_SKILL[level].label}</div>` : "";
  return `<div class="bots">
    <button class="btn small" data-action="botAdd" ${st.players.length >= maxSeats() ? "disabled" : ""}>🤖 +</button>
    ${bots ? `<button class="btn small ghost" data-action="botRemove">−</button><div class="seg three">${Object.entries(BOT_SKILL).map(([k, b]) =>
      `<button class="${k === level ? "on" : ""}" data-action="botLevel" data-level="${k}">${b.label}</button>`).join("")}</div>` : `<span class="muted small">Add a bot to play against</span>`}
  </div>`;
}

// `masked`: during the countdown you see only your own letter; everyone else's is a ? until the clock starts.
function patternView(ph, { size = 64, flip = false, shake = false, masked = false } = {}) {
  const st = engine.state;
  const seats = st.players.map((p, i) => ({ role: st.seatRoles[i], letter: st.revealed[p.id], name: p.id === ph.id ? "You" : p.name, mine: p.id === ph.id })).filter(s => s.letter);
  // A bot-supplied sandwich letter sits just before the "ends with" seat.
  if (st.sandwich) {
    const at = seats.findIndex(s => s.role === "endsWith");
    seats.splice(at < 0 ? seats.length : at, 0, { role: "contains", letter: st.sandwich, name: "🥪 Bot" });
  }
  // After a Frenzy SWAP the ends trade places, so draw the row backwards.
  if (st.swapped) {
    seats.reverse();
    for (const s of seats) s.role = { startsWith: "endsWith", endsWith: "startsWith" }[s.role] || s.role;
  }
  return `<div class="pattern ${flip ? "flip" : ""} ${shake ? "shake" : ""}">${seats.map((s, k) => `
    ${k ? '<div class="dots">…</div>' : ""}
    <div class="seat">
      <div class="tile ${s.role}" style="--size:${size}px;animation-delay:calc(${k * 0.22}s * var(--anim))">${masked && !s.mine ? "?" : cap(s.letter)}</div>
      <small>${esc(s.name)}</small>
    </div>`).join("")}</div>`;
}

function roleChip(role) { return `<span class="role ${role}">${ROLE_LABEL[role]}</span>`; }

const MODE_LABEL = { race: "Classic", list: "Frenzy", sandwich: "Sandwich", turn: "Turn" };
const MODE_ICON = { race: "🏁", list: "⚡️", sandwich: "🥪", turn: "💎" };
function modeBlurb(m, r) {
  if (m === "list") return `Frenzy: as many words as you can in ${r.listDuration}s${r.frenzySwap ? ". Watch out for the SWAP!" : ""}`;
  if (m === "turn") return `Turn: ${r.turnTime}s to find your highest-scoring word. Best word wins`;
  if (m === "sandwich") return `Sandwich: a middle letter goes inside the word too. First word wins (${r.raceTimeLimit}s limit)`;
  return `Classic: first word that fits wins (${r.raceTimeLimit}s limit)`;
}

function rulesSummary(r) {
  const parts = [r.rotation === "alternate" ? `Classic, Frenzy, Sandwich and Turn rounds take turns, starting with ${MODE_LABEL[r.mode]}`
    : r.rotation === "random" ? "Each round is Classic, Frenzy, Sandwich or Turn at random"
    : `${MODE_LABEL[r.mode]} rounds (host can switch any round)`];
  parts.push(r.target.kind === "ongoing" ? "keep playing, no end" : r.target.kind === "points" ? `first to ${r.target.n} points` : `${r.target.n} rounds`);
  const b = [];
  if (r.scoring.lengthBonus) b.push("length");
  if (r.scoring.syllableBonus) b.push("syllables");
  if (r.scoring.letterBonus) b.push("rare letters");
  if (r.scoring.speedBonus) b.push("time left");
  if (r.scoring.rareWord) b.push("rare words");
  if (r.scoring.rarityBonus) b.push("rare combos");
  parts.push(b.length ? "bonus for " + b.join(", ") : "no bonuses");
  if (r.cancelSharedWords) parts.push("Frenzy: shared words cancel out");
  return parts.join(" · ");
}

function viewLobby(ph) {
  const st = engine.state, isHost = ph.id === hostID();
  return `
    <div class="center" style="padding-top:18px">
      <div class="logo"><span class="s">P</span>..<span class="e">P</span></div>
      <div class="title">Plop</div>
      <div class="muted small">Say a letter together. Race to find a word that starts with one and ends with the other.</div>
    </div>
    <ol class="seat-list">${st.players.map((p, i) => `
      <li><span class="n">${i + 1}</span>${p.isBot ? "🤖" : "🙂"} ${esc(p.id === ph.id ? p.name + " (you)" : p.name)} ${roleChip(st.seatRoles[i])}</li>`).join("")}
    </ol>
    ${lobbyStandings(st)}
    <div class="rules-sum">${esc(rulesSummary(st.rules))}</div>
    ${difficultyPicker(st, isHost)}
    ${botControls(st, isHost)}
    <div class="grow"></div>
    ${isHost
      ? `<button class="btn primary block sticky-start" data-action="start" ${st.players.length < 2 ? "disabled" : ""}>Start game</button>`
      : `<div class="center muted">Waiting for the host to start…</div>`}`;
}

function lobbyStandings(st) {
  const rows = sortedStandings(st.players.filter(p => !p.isBot).map(p => p.name.trim().toLowerCase())).filter(s => s.rounds);
  if (!rows.length) return "";
  return `<div class="lobby-standings"><div class="muted small">All-time</div>${rows.map((s, i) =>
    `<div class="ls-row"><span>${i === 0 ? "👑" : `${i + 1}.`} ${esc(s.name)}</span><b>${s.points}</b></div>`).join("")}</div>`;
}

function readyList(ph) {
  const st = engine.state;
  return `<div class="ready">${st.players.filter(p => !p.isBot).map(p =>
    `<span class="r ${st.locked.has(p.id) ? "on" : ""}">${st.locked.has(p.id) ? "✓" : "…"} ${esc(p.id === ph.id ? "You" : p.name)}</span>`).join("")}</div>`;
}

function viewPicking(ph) {
  const st = engine.state, u = ui(ph.id), role = engine.roleOf(ph.id);
  const locked = st.locked.has(ph.id);
  const modeSwitch = ph.id === hostID()
    ? `<div class="seg four modes">${ROUND_MODES.map(m => `<button class="${st.roundMode === m ? "on" : ""}" data-action="roundMode" data-mode="${m}"><span>${MODE_ICON[m]}</span>${MODE_LABEL[m]}</button>`).join("")}</div>`
    : `<div class="center"><span class="round-type">${MODE_ICON[st.roundMode]} ${MODE_LABEL[st.roundMode]} round</span></div>`;
  const head = `${scoresBar(ph)}
    ${modeSwitch}
    <div class="muted small center">${esc(modeBlurb(st.roundMode, st.rules))}</div>
    <div class="center" style="gap:6px"><div class="muted small">Round ${st.round} · your letter is the word's</div>${role ? roleChip(role) : ""}</div>`;
  if (locked) {
    const waiting = st.players.filter(p => !p.isBot && !st.locked.has(p.id)).map(p => p.name);
    return `${head}
      <div class="grow center">
        ${u.myPick ? `<div class="locked-tile">${tile(u.myPick, role || "contains", 110)}</div>` : ""}
        <div style="font-weight:600">Locked in</div>
        <div class="muted small">${waiting.length ? "Waiting for " + esc(waiting.join(", ")) + "…" : "Revealing…"}</div>
      </div>${readyList(ph)}`;
  }
  return `${head}
    <div class="grid">${ALPHABET.map(l => `<button class="key ${u.selected === l ? "sel" : ""}" data-action="select" data-letter="${l}">${cap(l)}</button>`).join("")}</div>
    <button class="btn primary block" data-action="lock" ${u.selected ? "" : "disabled"}>${u.selected ? "Lock in " + cap(u.selected) : "Pick a letter"}</button>
    <div class="grow"></div>${readyList(ph)}`;
}

function viewAnswering(ph, fresh) {
  const st = engine.state, u = ui(ph.id);
  const open = now() >= st.phase.opensAt;
  if (!open) {
    return `${scoresBar(ph)}
      <div class="grow center">
        ${patternView(ph, { size: 80, flip: fresh, masked: true })}
        ${countdownRule(st)}
        <div class="countdown" data-count></div>
        <div class="muted small">Get ready… the other letters appear on Go</div>
      </div>`;
  }
  const raceDone = isRace(st.roundMode) && u.myWords.length;
  let input;
  if (raceDone) {
    input = `<div class="center" style="padding:14px 0"><div class="stamp">${cap(u.myWords[0].word)}</div><div class="muted small">Locked in! Waiting for the round to end…</div></div>`;
  } else if (u.mode === "type") {
    input = `<form class="answer" autocomplete="off"><input name="w" placeholder="${st.rules.hideLetters ? "your word" : esc(st.pattern.toString())}" spellcheck="false" autocapitalize="off" autocorrect="off"><button class="send" aria-label="Send">↑</button></form>`;
  } else {
    input = `<div class="center"><button class="mic" data-action="mic" aria-label="Microphone">🎤</button>
      <div class="muted small" data-mic-label></div><div class="heard" data-heard></div></div>`;
  }
  return `${scoresBar(ph)}
    <div class="letters" data-letters data-swapped="${st.swapped}">${patternView(ph, { size: 56 })}</div>
    ${twistBadge(st.twist, st.level)}
    ${st.rules.hideLetters && !raceDone ? `<button class="btn peek-btn" data-action="peek" data-peek></button>` : ""}
    <div class="timer"><div class="fill"></div></div><div class="timer-text"></div>
    ${isRace(st.roundMode) ? "" : `<div class="live" data-live></div>`}
    ${raceDone ? "" : `<div class="seg"><button class="${u.mode === "type" ? "on" : ""}" data-action="mode" data-mode="type">⌨️ Type</button><button class="${u.mode === "speak" ? "on" : ""}" data-action="mode" data-mode="speak">🎤 Speak</button></div>`}
    ${input}
    <div class="feedback" data-feedback></div>
    ${isRace(st.roundMode) ? `<div class="grow"></div>` : `<ul class="words grow" data-words></ul>`}`;
}

function viewNoWordFits(ph, fresh) {
  const st = engine.state;
  return `${scoresBar(ph)}
    <div class="grow center">
      ${patternView(ph, { shake: fresh })}
      <div class="title doh">Doh!</div>
      <div>No words work for this.</div>
      <div class="muted small">Back to picking in a moment…</div>
    </div>`;
}

// "+5", "−3", "+0": a round's points with their sign.
function signed(n) { return n < 0 ? "−" + -n : "+" + n; }

function nameOf(ph, id) { return id === ph.id ? "You" : engine.state.players.find(p => p.id === id)?.name || "?"; }

function breakdown(w) {
  const pills = [`<span class="pill">${w.base} pt</span>`];
  if (w.lengthBonus) pills.push(`<span class="pill len">+${w.lengthBonus} length</span>`);
  if (w.syllableBonus) pills.push(`<span class="pill syl">+${w.syllableBonus} syl</span>`);
  if (w.letterBonus) pills.push(`<span class="pill letters">+${w.letterBonus} letters</span>`);
  if (w.speedBonus) pills.push(`<span class="pill speed">⏱ +${w.speedBonus} time</span>`);
  if (w.rarityBonus) pills.push(`<span class="pill rare">+${w.rarityBonus} rare</span>`);
  if (w.echoBonus) pills.push(`<span class="pill echo">✨ +${w.echoBonus} echo</span>`);
  if (w.guestBonus) pills.push(`<span class="pill guest">💃 +${w.guestBonus} ${cap(w.guest)}</span>`);
  if (w.combo > 1) pills.push(`<span class="pill combo">🔥 ×${w.combo}</span>`);
  if (w.rareWordBonus) pills.push(`<span class="pill rare">🦄 +${w.rareWordBonus} ${w.rareWord}</span>`);
  if (w.secretBonus) pills.push(`<span class="pill secret">🤫 +${w.secretBonus} secret</span>`);
  return pills.join("");
}

function headline(ph, r) {
  const st = engine.state;
  if (!r.winners.length) return { text: "Time's up!", sub: r.examples.length ? "Nobody found one. You could have played:" : "Nobody scored." };
  const who = r.winners.map(id => nameOf(ph, id)).join(" & ");
  const me = r.winners.includes(ph.id);
  if (r.mode === "turn") {
    const e = r.entries.find(x => x.player === r.winners[0]);
    return { text: me ? "You won the round!" : `${who} won`, sub: `${cap(e.words[0].word)}, worth ${wordTotal(e.words[0])}`, me };
  }
  if (r.mode !== "list") {
    const e = r.entries.find(x => x.player === r.winners[0]);
    return { text: me ? "You won the round!" : `${who} won`, sub: `${cap(e.words[0].word)} in ${e.elapsed.toFixed(2)}s`, me };
  }
  const top = Math.max(...r.entries.map(e => e.points)), bonus = r.entries.find(e => e.winBonus)?.winBonus;
  const kept = r.entries.find(e => e.player === ph.id)?.points || 0;
  return { text: me ? "You won the round!" : `${who} won the round`, sub: me ? `${top} points${bonus ? `, with +${bonus} for winning` : ""}` : `${top} points · you keep ${signed(kept)}`, me };
}

function resultBody(ph, fresh) {
  const st = engine.state, r = st.lastResult, h = headline(ph, r);
  return `
    ${patternView(ph, { size: 44 })}
    <div class="banner ${h.me ? "me" : ""} ${fresh ? "in" : ""}"><b>${esc(h.text)}</b><span class="muted small">${esc(h.sub)}</span></div>
    ${!r.winners.length && r.examples.length ? `<div class="could ${fresh ? "in" : ""}">${r.examples.slice(0, 3).map(w => `<button type="button" data-define="${esc(w)}">${esc(cap(w))}</button>`).join("")}</div>` : ""}
    <div class="entries grow">
      ${r.entries.map((e, i) => `
        <div class="entry ${fresh ? "in" : ""}" style="animation-delay:calc(${0.15 + i * 0.12}s * var(--anim))">
          <header><span>${esc(nameOf(ph, e.player))}${e.elapsed != null ? ` <span class="muted small">${e.elapsed.toFixed(2)}s</span>` : ""}${e.peeks ? ` <span class="pill">👀×${e.peeks} −${e.peekCost}</span>` : ""}</span><span class="pts">${signed(e.points)}</span></header>
          ${e.words.length ? e.words.map(w => {
            const slow = r.mode !== "list" && !r.winners.includes(e.player);
            const lost = r.mode === "turn" ? "lower score" : "too slow";
            return `<div class="wordrow"><button type="button" class="w wordlink ${w.cancelled || slow ? "x" : ""}" data-define="${esc(w.word)}">${esc(w.word)}</button>
              ${w.cancelled ? `<span class="pill">shared → 0</span>` : slow ? `<span class="pill">${lost}</span>` : breakdown(w)}
              <span class="pill">${w.syllables} syl</span></div>`;
          }).join("") : `<div class="muted small">No word</div>`}
          ${e.winBonus ? `<div class="wordrow"><span class="pill combo">🏆 +${e.winBonus} for winning the Frenzy</span></div>` : ""}
        </div>`).join("")}
      <div class="examples">${r.matchCount.toLocaleString()} words fit${r.twist ? ` (${twistText(r.twist)})` : ""}. ${r.winners.length ? "Others" : "More"}: ${r.examples.slice(r.winners.length ? 0 : 3).map(w => `<button type="button" class="wordlink" data-define="${esc(w)}">${esc(w)}</button>`).join(", ")}<br>Tap a word to see what it means.</div>
    </div>`;
}

function viewRoundOver(ph, fresh) {
  return `${scoresBar(ph, { counting: fresh })}${resultBody(ph, fresh)}
    ${ph.id === hostID()
      ? `<div class="row"><button class="btn primary block" data-action="next">Next round</button><button class="btn block" data-action="endGame" style="width:auto">End game</button></div>`
      : `<div class="center muted small">Waiting for the host…</div>`}`;
}

function viewGameOver(ph, fresh) {
  const st = engine.state;
  const champs = st.champions.map(id => nameOf(ph, id));
  const iWon = st.champions.includes(ph.id);
  const standings = st.players.map(p => ({ p, s: st.scores[p.id] || 0 })).sort((a, b) => b.s - a.s);
  return `${scoresBar(ph, { counting: fresh })}
    <div class="center"><div class="trophy">${iWon ? "🏆" : "🎉"}</div>
      <div class="title">${esc(champs.join(" & "))} ${champs.length === 1 && champs[0] === "You" ? "win!" : champs.length > 1 ? "tie!" : "wins!"}</div></div>
    <ol class="standings grow">${standings.map(({ p, s }, i) =>
      `<li class="${st.champions.includes(p.id) ? "champ" : ""}"><span class="muted">${i + 1}.</span> ${esc(nameOf(ph, p.id))} <b>${s}</b></li>`).join("")}</ol>
    ${ph.id === hostID()
      ? `<div class="row"><button class="btn primary block" data-action="again">Play again</button><button class="btn block" data-action="lobby">Lobby</button></div>`
      : `<div class="center muted small">Waiting for the host…</div>`}`;
}

// ---------- Definitions ----------
// Tap a word to see what it means, from Wiktionary's free API (no key). Kept per word for the visit.

const definitions = new Map();

function lookUp(word) {
  if (!definitions.has(word)) {
    definitions.set(word, fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => (data?.en || []).filter(sense => sense.partOfSpeech !== "Symbol").flatMap(sense => sense.definitions
        .map(d => new DOMParser().parseFromString(d.definition || "", "text/html").body.textContent.trim())
        .filter(Boolean).map(text => ({ pos: sense.partOfSpeech, text }))).slice(0, 3))
      .catch(() => { definitions.delete(word); return null; }));
  }
  return definitions.get(word);
}

function showDefinition(ph, word) {
  ph.screen.querySelector(".define")?.remove();
  const el = document.createElement("div");
  el.className = "define";
  el.innerHTML = `<div class="define-card" role="dialog" aria-label="Definition">
    <div class="define-word"></div><div class="define-body muted">Looking it up…</div>
    <div class="define-foot"><a target="_blank" rel="noopener">Wiktionary ↗</a><button type="button" class="btn small">Close</button></div></div>`;
  $(".define-word", el).textContent = cap(word);
  $("a", el).href = `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`;
  el.addEventListener("click", e => { e.stopPropagation(); if (e.target === el || e.target.matches("button")) el.remove(); });
  ph.screen.appendChild(el);
  lookUp(word).then(senses => {
    const body = $(".define-body", el);
    if (!senses?.length) { body.textContent = senses ? "No definition found." : "Couldn't reach the dictionary. Try the link."; return; }
    body.classList.remove("muted");
    body.innerHTML = senses.map(() => `<div class="sense"><i></i><span></span></div>`).join("");
    body.querySelectorAll(".sense").forEach((row, i) => { $("i", row).textContent = senses[i].pos.toLowerCase(); $("span", row).textContent = senses[i].text; });
  });
}

// ---------- Live updates while answering ----------

function patchAnswering(ph, initial = false) {
  const st = engine.state, u = ui(ph.id);
  const fb = $("[data-feedback]", ph.screen);
  if (fb && u.feedback && (initial || fb.dataset.id !== String(u.feedback.id))) {
    const { kind, text } = feedbackText(u.feedback, st);
    fb.dataset.id = u.feedback.id;
    fb.className = `feedback ${kind} ${initial ? "" : "in"}`;
    fb.textContent = text;
  }
  const words = $("[data-words]", ph.screen);
  if (words && words.childElementCount !== u.myWords.length) {
    // Turn rounds: only your best word counts, so it gets the star.
    const best = st.roundMode === "turn" ? Math.max(...u.myWords.map(wordTotal)) : null;
    let starred = false;
    words.innerHTML = u.myWords.slice().reverse().map(w => {
      const star = best != null && !starred && wordTotal(w) === best && (starred = true);
      return `<li class="${best != null && !star ? "dim" : ""}"><button type="button" class="wordlink" data-define="${esc(w.word)}">${star ? "⭐️ " : ""}${esc(w.word)}</button> <span>+${wordTotal(w)}</span></li>`;
    }).join("");
  }
  // Frenzy: everyone's score, live, so you know whether you're ahead while the clock runs.
  const live = $("[data-live]", ph.screen);
  if (live) {
    const rows = st.players.filter(p => !p.isBot || st.listCounts[p.id])
      .map(p => ({ id: p.id, name: nameOf(ph, p.id), pts: st.listPoints[p.id] || 0 })).sort((a, b) => b.pts - a.pts);
    const sig = rows.map(r => r.id + ":" + r.pts).join();
    if (live.dataset.sig !== sig) {
      const prev = live.dataset.prev ? JSON.parse(live.dataset.prev) : {};
      const top = rows[0]?.pts || 0, mine = st.listPoints[ph.id] || 0;
      const rival = rows.find(r => r.id !== ph.id);
      const [cls, status] = !top ? ["", "Find words to score!"]
        : !rival || mine > rival.pts ? ["ahead", `You're ahead by ${mine - (rival?.pts || 0)}`]
        : mine < rival.pts ? ["behind", `${rival.pts - mine} behind ${rival.name}`]
        : ["tied", "Neck and neck!"];
      live.innerHTML = `<div class="live-status ${cls}">${esc(status)}</div>
        <div class="live-rows">${rows.map(r => {
          const lead = top > 0 && r.pts === top, up = prev[r.id] != null && r.pts > prev[r.id];
          return `<div class="live-row ${r.id === ph.id ? "me" : ""} ${lead ? "lead" : ""} ${up ? "up" : ""}"><span>${lead ? "👑 " : ""}${esc(r.name)}</span><b>${r.pts}</b></div>`;
        }).join("")}</div>`;
      live.dataset.prev = JSON.stringify(Object.fromEntries(rows.map(r => [r.id, r.pts])));
      live.dataset.sig = sig;
    }
  }
  const heard = $("[data-heard]", ph.screen);
  if (heard && heard.childElementCount !== Math.min(u.heard.length, 8)) {
    heard.innerHTML = u.heard.slice(-8).map(h => `<span class="${h.fits ? "fits" : ""}">${esc(h.word)}</span>`).join("");
  }
  const mic = $("[data-action=mic]", ph.screen);
  if (mic) {
    mic.classList.toggle("on", u.listening);
    $("[data-mic-label]", ph.screen).textContent = u.speechProblem || (u.listening ? "Listening… say your word!" : "Tap to start listening");
  }
}

function feedbackText(f, st) {
  switch (f.res.kind) {
    case "accepted": return f.res.better === false
      ? { kind: "meh", text: `${cap(f.word)} +${wordTotal(f.res.scored)} · your best is still worth more` }
      : { kind: "good", text: `✓ ${cap(f.word)}  +${wordTotal(f.res.scored)}${f.res.better ? " · your best so far" : ""}` };
    case "notAWord": return { kind: "bad", text: `“${f.word}” isn't in the dictionary` };
    case "doesNotFit": return { kind: "bad", text: `“${f.word}” doesn't fit ${st.rules.hideLetters ? "the letters" : st.pattern}` };
    case "twist": return { kind: "bad", text: `“${f.word}” needs ${st.twist ? twistText(st.twist) : "more"}` };
    case "alreadyUsed": return { kind: "meh", text: `Already used “${f.word}”` };
    default: return { kind: "meh", text: `Too late for “${f.word}”` };
  }
}

let lastCount = null;
function tickDynamic(ph, t) {
  const st = engine.state;
  if (st.phase.type !== "answering") return;
  const { opensAt, closesAt } = st.phase;
  const cd = $("[data-count]", ph.screen);
  if (cd) {
    const n = Math.max(1, Math.ceil(opensAt - t));
    if (cd.textContent !== String(n)) {
      cd.textContent = n;
      cd.classList.remove("pop"); void cd.offsetWidth; cd.classList.add("pop");
      if (ph === phones[0] && lastCount !== n) { sound("tick"); lastCount = n; }
    }
  }
  const u = ui(ph.id), peeking = t < u.peekUntil;
  const letters = $("[data-letters]", ph.screen);
  if (letters && letters.dataset.swapped !== String(st.swapped)) {
    if (letters.dataset.swapped === "false") swapFlash(ph);
    letters.dataset.swapped = st.swapped;
    letters.innerHTML = patternView(ph, { size: 56 });
  }
  if (letters) {
    const raceDone = isRace(st.roundMode) && u.myWords.length;
    letters.classList.toggle("covered", st.rules.hideLetters && !raceDone && !peeking && t >= opensAt + st.rules.revealFor);
  }
  // The guest letter dances across the answer screen while it's on stage.
  const guest = engine.guestAt(t), guestEl = $(".guest", ph.screen);
  if (guest && !guestEl && t >= opensAt) {
    const g = document.createElement("div");
    g.className = "guest";
    g.innerHTML = `${guestFigure(guest)}<div class="guest-tag">use me! +${st.rules.scoring.guestPoints}</div>`;
    ph.screen.appendChild(g);
    if (ph === phones[0]) sound([[784, .06], [988, .06], [1175, .06], [1568, .12]]);
  } else if (!guest && guestEl && !guestEl.classList.contains("leaving")) {
    guestEl.classList.add("leaving");
    setTimeout(() => guestEl.remove(), 600 * feel.speed);
  }
  const cost = engine.peekCostFor(ph.id);
  const peekBtn = $("[data-peek]", ph.screen);
  if (peekBtn) {
    const label = peeking ? "Memorize them!" : `👀 Show letters (−${st.rules.peekCost} pts)`;
    if (peekBtn.textContent !== label) peekBtn.textContent = label;
    peekBtn.disabled = peeking;
  }
  const timer = $(".timer", ph.screen);
  if (timer) {
    const end = engine.closesAtFor(ph.id), total = closesAt - opensAt, left = Math.max(0, end - t);
    $(".fill", timer).style.transform = `scaleX(${left / total})`;
    timer.classList.toggle("low", left < Math.min(5, total * 0.2));
    const note = cost ? ` · −${cost} pts for peeking` : "";
    $(".timer-text", ph.screen).textContent = `${Math.ceil(left)}s left${note}`;
  }
}

function swapFlash(ph) {
  if (ph === phones[0]) sound("swap");
  const el = document.createElement("div");
  el.className = "swap-flash";
  el.textContent = "SWAP!!!!";
  ph.screen.appendChild(el);
  setTimeout(() => el.remove(), 1400 * feel.speed);
}

function frame() {
  const t = now();
  if (online?.role !== "guest" && engine.tick(t)) changed(); // only the host runs the game
  if (engine.state.phase.type === "answering") {
    let opened = false;
    for (const ph of phones) {
      const key = screenKey(ph);
      if (key !== ph.key) {
        if (ph.key && ph.key.includes(":pre:") && key.includes(":open:")) opened = true;
        mount(ph, true);
        ph.key = key;
      }
      tickDynamic(ph, t);
    }
    if (opened) { sound("go"); lastCount = null; }
  }
  requestAnimationFrame(frame);
}

// ---------- Player input ----------

function onPhoneClick(ph, e) {
  const word = e.target.closest("[data-define]");
  if (word) return showDefinition(ph, word.dataset.define);
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const u = ui(ph.id);
  switch (el.dataset.action) {
    case "start": engine.startGame(); break;
    case "select": u.selected = el.dataset.letter; sound("tap"); break;
    case "lock": return lock(ph.id);
    case "repick": engine.repick(); break;
    case "next": engine.nextRound(); break;
    case "endGame": engine.endGame(); break;
    case "again": engine.startGame(); break;
    case "lobby": engine.backToLobby(); break;
    case "mode":
      u.mode = el.dataset.mode;
      if (u.mode === "type") stopSpeech(ph.id);
      break;
    case "mic": u.listening ? stopSpeech(ph.id) : startSpeech(ph.id); break;
    case "peek": return peek(ph);
    case "roundMode": engine.setRoundMode(el.dataset.mode); sound("tap"); break;
    case "botAdd": case "botRemove": case "botLevel": {
      const st = engine.state;
      if (ph.id !== hostID() || st.phase.type !== "lobby") return;
      if (el.dataset.action === "botLevel") {
        if (!(el.dataset.level in BOT_SKILL)) return;
        st.rules.botLevel = rules.botLevel = el.dataset.level;
        store.set("rules", rules);
      } else if (el.dataset.action === "botAdd") {
        if (st.players.length >= maxSeats()) return;
        const used = new Set(st.players.map(p => p.id));
        let j = 0; while (used.has("bot" + j)) j++;
        engine.addPlayer({ id: "bot" + j, name: "Bot " + (j + 1), isBot: true });
      } else {
        const bot = st.players.filter(p => p.isBot).pop();
        if (bot) engine.removePlayer(bot.id, now());
      }
      if (!online) { botCount = st.players.filter(p => p.isBot).length; store.set("botCount", botCount); }
      sound("tap");
      break;
    }
    case "difficulty":
      if (ph.id !== hostID() || engine.state.phase.type !== "lobby" || !(el.dataset.level in DIFFICULTY || el.dataset.level === "mixed")) return;
      engine.state.rules.difficulty = rules.difficulty = el.dataset.level;
      store.set("rules", rules);
      sound("tap");
      break;
  }
  changed();
}

function peek(ph) {
  const u = ui(ph.id), t = now();
  if (t < u.peekUntil || !engine.peek(ph.id, t)) return;
  u.peekUntil = t + engine.state.rules.peekDuration;
  sound("tap");
  pushLog(`${playerName(ph.id)} peeked at the letters`);
  tickDynamic(ph, t);
  ph.screen.querySelector(".answer input")?.focus();
}

function lock(id) {
  const u = ui(id);
  if (!u.selected) return;
  u.myPick = u.selected;
  sound("lock");
  engine.lockLetter(id, u.selected, now());
  // Hand the keyboard to the next phone still picking.
  const next = localPlayers().find(p => !engine.state.locked.has(p.id));
  if (next) activeId = next.id;
  changed();
}

function onPhoneSubmit(ph, form) {
  const input = form.querySelector("input");
  const res = submitWord(ph.id, input.value);
  if (!res) return;
  input.focus(); // still inside the tap, so a phone keeps its keyboard up
  if (res.kind === "sent") {
    input.value = "";
  } else if (res.kind === "accepted") {
    input.value = "";
    form.classList.remove("shake");
    const f = document.createElement("div");
    f.className = "floater";
    f.textContent = "+" + wordTotal(res.scored);
    form.appendChild(f);
    setTimeout(() => f.remove(), 1100);
  } else {
    form.classList.remove("shake"); void form.offsetWidth; form.classList.add("shake");
    input.select();
  }
}

function submitWord(id, raw, heardAt = null) {
  const st = engine.state, u = ui(id);
  if (st.phase.type !== "answering") return null;
  const word = cleanWord(raw);
  if (!word) return null;
  const t = now(), elapsed = online ? roundElapsed(st, (heardAt ?? t) - clockOffset) : (heardAt ?? t) - st.phase.opensAt;
  // An online guest checks what it can locally and sends the rest to the host; the answer comes back later.
  const via = heardAt != null ? "speak" : "type";
  const res = online?.role === "guest" ? guestSubmit(id, word, elapsed, via) : engine.submit(id, word, elapsed, t, via);
  if (!res) return { kind: "sent" };
  return applySubmit(id, word, res);
}

function applySubmit(id, word, res) {
  const st = engine.state, u = ui(id);
  u.feedback = { id: ++feedbackSeq, word, res };
  if (res.kind === "accepted") {
    u.myWords.push(res.scored);
    sound("good");
    if (st.roundMode === "list") pushLog(`${playerName(id)} found ${cap(word)} (+${wordTotal(res.scored)})`);
  } else {
    sound("bad");
  }
  changed();
  return res;
}

function playerName(id) { return engine.state.players.find(p => p.id === id)?.name || id; }

document.addEventListener("keydown", e => {
  const inField = e.target instanceof Element && e.target.matches("input, textarea, select");
  if (!inField && /^[1-4]$/.test(e.key) && phones[+e.key - 1]) {
    setActive(phones[+e.key - 1].id);
    e.preventDefault();
    return;
  }
  if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
  const st = engine.state, id = activeId;
  if (st.phase.type === "picking" && id && !st.locked.has(id)) {
    if (/^[a-z]$/i.test(e.key)) { ui(id).selected = e.key.toLowerCase(); sound("tap"); changed(); }
    else if (e.key === "Enter") lock(id);
    return;
  }
  if (e.key === "Enter") {
    const t = st.phase.type;
    if (t === "lobby" && st.players.length >= 2) engine.startGame();
    else if (t === "roundOver") engine.nextRound();
    else if (t === "noWordFits") engine.repick();
    else if (t === "gameOver") engine.startGame();
    else return;
    changed();
  }
});

// ---------- Speech (Web Speech API; Chrome or Safari) ----------

function startSpeech(id) {
  stopAllSpeech();
  const u = ui(id), SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { u.speechProblem = "This browser has no speech recognition. Try Chrome or Safari."; changed(); return; }
  const rec = new SR();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = e => {
    let text = "";
    for (let i = 0; i < e.results.length; i++) text += " " + e.results[i][0].transcript;
    heardWords(id, text);
  };
  rec.onerror = e => {
    u.speechProblem = e.error === "not-allowed" ? "Microphone blocked. Allow it in the browser (or serve the page over http://localhost)." : "Speech: " + e.error;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") u.listening = false;
    changed();
  };
  rec.onend = () => { if (u.listening && u.rec === rec) { try { rec.start(); } catch { /* already started */ } } };
  u.rec = rec; u.listening = true; u.speechProblem = null;
  try { rec.start(); } catch (err) { u.speechProblem = String(err); u.listening = false; }
  changed();
}

function heardWords(id, text) {
  const st = engine.state, u = ui(id);
  if (st.phase.type !== "answering" || !st.pattern) return;
  const t = now();
  for (const w of text.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    if (u.seen.has(w)) continue;
    u.seen.add(w);
    const fits = lexicon.contains(w) && st.pattern.matches(w);
    u.heard.push({ word: w, fits });
    if (fits) {
      submitWord(id, w, t);
      if (isRace(st.roundMode)) { stopSpeech(id); break; }
    }
  }
  const ph = phoneByID(id);
  if (ph) patchAnswering(ph);
}

function stopSpeech(id) {
  const u = uis[id];
  if (!u) return;
  u.listening = false;
  if (u.rec) { try { u.rec.abort(); } catch { /* ignore */ } u.rec = null; }
}
function stopAllSpeech() { for (const id in uis) stopSpeech(id); }

// ---------- Sound ----------

let actx = null;
const SOUNDS = {
  tap: [[880, .03]], lock: [[440, .05], [660, .07]], tick: [[660, .07]], go: [[988, .18]],
  reveal: [[523, .07], [659, .07], [784, .12]], good: [[784, .07], [1175, .14]], bad: [[196, .16]],
  meh: [[392, .1], [330, .16]], swap: [[1047, .06], [523, .06], [1047, .06], [523, .12]], win: [[523, .1], [659, .1], [784, .1], [1047, .3]],
};
// kind is a SOUNDS name or a list of [frequency, duration] notes.
function sound(kind) {
  const notes = Array.isArray(kind) ? kind : SOUNDS[kind];
  if (!feel.sound || !notes) return;
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    let t = actx.currentTime;
    for (const [f, d] of notes) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = kind === "bad" ? "square" : "triangle";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(kind === "bad" ? 0.06 : 0.16, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(actx.destination);
      o.start(t); o.stop(t + d + 0.02);
      t += d * 0.85;
    }
  } catch { /* no audio */ }
}

// ---------- Effects ----------


function countUpScores(ph) {
  const els = ph.screen.querySelectorAll(".score-chip b[data-from]");
  els.forEach(b => {
    const from = +b.dataset.from, to = +b.dataset.to;
    if (from === to) return;
    const dur = feel.anim ? 900 * feel.speed : 0, start = performance.now() + (feel.anim ? 350 * feel.speed : 0);
    const step = ts => {
      const k = Math.min(1, Math.max(0, (ts - start) / Math.max(dur, 1)));
      b.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
      else { const chip = b.parentElement; chip.classList.remove("bump"); void chip.offsetWidth; chip.classList.add("bump"); }
    };
    requestAnimationFrame(step);
  });
}

const FRUITS = ["🍉", "🍓", "🍋", "🍇", "🍒", "🍑", "🍍"];
// `pace` scales how long it falls: 0.5 is twice as fast and over in half the time.
function confetti(screen, count = 70, pace = 1) {
  if (!feel.anim) return;
  const colors = ["#2f9a3e", "#2f8ef0", "#9b5de5", "#ffc531", "#e2445c", "#7fd1f0"];
  for (let i = 0; i < count; i++) {
    const c = document.createElement("span");
    c.className = "confetti";
    c.style.left = Math.random() * 100 + "%";
    if (i % 3 === 0) { c.classList.add("fruit"); c.textContent = FRUITS[i % FRUITS.length]; }
    else c.style.background = colors[i % colors.length];
    c.style.setProperty("--x", (Math.random() * 160 - 80) + "px");
    c.style.setProperty("--r", (Math.random() * 900 - 450) + "deg");
    c.style.setProperty("--d", (1.6 + Math.random() * 1.6) * pace + "s");
    c.style.animationDelay = Math.random() * 0.4 * pace + "s";
    screen.appendChild(c);
    setTimeout(() => c.remove(), 4500 * pace * feel.speed);
  }
}

// ---------- Log ----------

function pushLog(text) {
  log.unshift(text);
  log.length = Math.min(log.length, 80);
  renderLog();
}

function logRound(r) {
  const st = engine.state;
  const parts = r.entries.filter(e => e.words.length).map(e => {
    const ws = e.words.map(w => `${w.word}${w.cancelled ? "×" : ""}`).join(", ");
    return `${playerName(e.player)} ${ws}${e.elapsed != null ? ` ${e.elapsed.toFixed(2)}s` : ""} +${e.points}`;
  });
  const winner = r.winners.length ? r.winners.map(playerName).join(" & ") + " won" : "nobody scored";
  pushLog(`R${r.round} ${r.pattern} (${r.matchCount} fit): ${winner}. ${parts.join(" · ") || "No answers."} Scores: ${st.players.map(p => `${p.name} ${st.scores[p.id]}`).join(", ")}`);
}

// ---------- All-time standings (kept across games, by player name) ----------

const standings = store.get("standings", {});

function standingFor(name) {
  return (standings[name.trim().toLowerCase()] ||= { name, points: 0, rounds: 0, roundsWon: 0, games: 0, gamesWon: 0, best: null });
}

function recordGame(champions) {
  for (const p of engine.state.players) {
    if (p.isBot) continue;
    const s = standingFor(p.name);
    s.games++;
    if (champions.includes(p.id)) s.gamesWon++;
  }
  store.set("standings", standings);
  renderStandings();
}

function recordStandings(r) {
  const st = engine.state;
  for (const e of r.entries) {
    const p = st.players.find(x => x.id === e.player);
    if (!p || p.isBot) continue;
    const s = standingFor(p.name);
    s.name = p.name;
    s.points += e.points;
    s.rounds++;
    if (r.winners.includes(p.id)) s.roundsWon++;
    for (const w of e.words) if (!w.cancelled && (!s.best || wordTotal(w) > s.best.points)) s.best = { word: w.word, points: wordTotal(w) };
  }
  store.set("standings", standings);
  renderStandings();
}

function sortedStandings(names = null) {
  return Object.values(standings).filter(s => !names || names.includes(s.name.trim().toLowerCase())).sort((a, b) => b.points - a.points);
}

function renderStandings() {
  const rows = sortedStandings();
  $("#standings").innerHTML = rows.length
    ? `<table class="alltime"><tr><th></th><th>Points</th><th>Rounds won</th><th>Games won</th><th>Best word</th></tr>${rows.map((s, i) => `
      <tr><td><span class="muted">${i + 1}.</span> <b>${esc(s.name)}</b></td><td>${s.points}</td><td>${s.roundsWon}/${s.rounds}</td><td>${s.gamesWon}/${s.games}</td><td>${s.best ? `${esc(s.best.word)} <span class="muted">+${s.best.points}</span>` : ""}</td></tr>`).join("")}</table>`
    : `<p class="muted small" style="margin:0">Scores add up here round after round, game after game, by player name.</p>`;
}

function renderLog() {
  $("#log").innerHTML = log.map(l => `<li>${esc(l)}</li>`).join("") || `<li class="muted">Rounds will show up here.</li>`;
}

// ---------- Panel ----------

const PHASE_LABEL = { lobby: "In the lobby", picking: "Picking letters", answering: "Answering", noWordFits: "No word fits", roundOver: "Round over", gameOver: "Game over" };

function renderPanel() {
  const st = engine.state, t = st.phase.type, inLobby = t === "lobby";
  $("#game-status").innerHTML = `<b>${PHASE_LABEL[t]}</b>${st.round ? ` · round ${st.round} (${MODE_LABEL[st.roundMode]})` : ""} · ${esc(rulesSummary(st.rules))}`;

  const btns = [];
  if (inLobby) btns.push(`<button class="btn small primary" data-panel="start" ${st.players.length < 2 ? "disabled" : ""}>Start</button>`);
  if (t === "picking") btns.push(`<button class="btn small" data-panel="autopick">Random picks for the rest</button>`);
  if (t === "answering") btns.push(`<button class="btn small" data-panel="endRound">End round now</button>`);
  if (t === "noWordFits") btns.push(`<button class="btn small primary" data-panel="repick">Pick again</button>`);
  if (t === "roundOver") btns.push(`<button class="btn small primary" data-panel="next">Next round</button>`, `<button class="btn small" data-panel="endGame">End game</button>`);
  if (t === "gameOver") btns.push(`<button class="btn small primary" data-panel="again">Play again</button>`);
  if (!inLobby) btns.push(`<button class="btn small ghost" data-panel="lobby">Back to lobby</button>`);
  btns.push(`<button class="btn small ghost" data-panel="reset">Reset everything</button>`);
  $("#game-buttons").innerHTML = btns.join("");

  if (st.pattern) {
    const sample = feel.peek ? lexicon.examples(st.pattern, 14) : [];
    $("#round-info").innerHTML = `<div class="peek"><b>${esc(st.pattern.toString())}</b>: ${st.matchCount.toLocaleString()} words fit${st.rules.scoring.rarityBonus ? ` (rare bonus +${rarityBonusFor(st.matchCount)})` : ""}.
      <label class="field" style="margin-top:6px"><span>Peek at answers</span><input type="checkbox" data-feel="peek" ${feel.peek ? "checked" : ""}></label>
      ${feel.peek ? esc(sample.join(", ")) : ""}</div>`;
  } else {
    $("#round-info").innerHTML = "";
  }

  // Seats (skip while someone is typing a name so focus isn't lost).
  if (!$("#seats").contains(document.activeElement)) {
    $("#seats").innerHTML = st.players.map((p, i) => `
      <div class="seat-edit">
        <span class="who">${p.isBot ? "🤖" : "🙂"}</span>
        <input value="${esc(p.name)}" data-name="${p.id}" ${p.isBot ? "disabled" : ""} aria-label="Name">
        <select data-role="${i}" ${inLobby ? "" : "disabled"}>${ROLES.map(r => `<option value="${r}" ${st.seatRoles[i] === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}</select>
        <span class="ctl">
          <button data-move="${i}" data-dir="-1" ${inLobby && i > 0 ? "" : "disabled"} aria-label="Move left">◀</button>
          <button data-move="${i}" data-dir="1" ${inLobby && i < st.players.length - 1 ? "" : "disabled"} aria-label="Move right">▶</button>
          <button data-remove="${p.id}" ${inLobby && (p.isBot || humanPlayers().length > 2) && p.id !== hostID() ? "" : "disabled"} aria-label="Remove">✕</button>
        </span>
      </div>`).join("");
  }
  $("#seats-note").textContent = inLobby
    ? "Phones line up in seat order. Bots pick letters (always ones that some word fits) but never answer."
    : "Seats can be changed in the lobby.";
  document.querySelectorAll("[data-panel=addPhone],[data-panel=addBot],[data-panel=resetRoles]").forEach(b => { b.disabled = !inLobby; });
  $("[data-panel=addPhone]").disabled = !inLobby || humanPlayers().length >= 4;
  $("[data-panel=addBot]").disabled = !inLobby || st.players.length >= 8;

  updatePreview();
}

function field(label, control) { return `<label class="field"><span>${label}</span>${control}</label>`; }
function num(path, v, min, max, step = 1) { return `<input type="number" data-rule="${path}" value="${v}" min="${min}" max="${max}" step="${step}">`; }
function check(path, v) { return `<input type="checkbox" data-rule="${path}" ${v ? "checked" : ""}>`; }

function buildRulesPanel() {
  const r = rules, s = r.scoring;
  $("#rules").innerHTML = `
    ${field("First round", `<select data-rule="mode"><option value="race" ${r.mode === "race" ? "selected" : ""}>🏁 Classic: first word wins</option><option value="list" ${r.mode === "list" ? "selected" : ""}>⚡️ Frenzy: list words</option><option value="sandwich" ${r.mode === "sandwich" ? "selected" : ""}>🥪 Sandwich: plus a middle letter</option><option value="turn" ${r.mode === "turn" ? "selected" : ""}>💎 Turn: best-scoring word wins</option></select>`)}
    ${field("Later rounds", `<select data-rule="rotation"><option value="same" ${r.rotation === "same" ? "selected" : ""}>Host switches by hand</option><option value="alternate" ${r.rotation === "alternate" ? "selected" : ""}>Take turns</option><option value="random" ${r.rotation === "random" ? "selected" : ""}>Random</option></select>`)}
    ${field("Classic / Sandwich time limit (s)", num("raceTimeLimit", r.raceTimeLimit, 5, 120, 5))}
    ${field("Turn round length (s)", num("turnTime", r.turnTime, 5, 60, 5))}
    ${field("Frenzy length (s)", num("listDuration", r.listDuration, 10, 180, 5))}
    ${field("Frenzy: shared words score 0", check("cancelSharedWords", r.cancelSharedWords))}
    ${field("Frenzy: letters SWAP once <span class='muted small'>(new idea)</span>", check("frenzySwap", r.frenzySwap))}
    ${field("Countdown (s)", num("countdown", r.countdown, 0, 5, 1))}
    ${field("Difficulty <span class='muted small'>(Classic, Sandwich)</span>", `<select data-rule="difficulty">${["mixed", "easy", "medium", "hard"].map(k => `<option value="${k}" ${r.difficulty === k ? "selected" : ""}>${k === "mixed" ? "Mixed (each round)" : DIFFICULTY[k].label}</option>`).join("")}</select>`)}
    ${field("Bot skill <span class='muted small'>(Classic, Sandwich, Turn)</span>", `<select data-rule="botLevel">${Object.entries(BOT_SKILL).map(([k, b]) => `<option value="${k}" ${r.botLevel === k ? "selected" : ""}>${b.label}</option>`).join("")}</select>`)}
    ${field("Hide letters after countdown <span class='muted small'>(new idea)</span>", check("hideLetters", r.hideLetters))}
    ${r.hideLetters ? `<div class="sub">${field("Each peek costs (points)", num("peekCost", r.peekCost, 0, 30))}${field("Peek shows letters for (s)", num("peekDuration", r.peekDuration, 0.5, 10, 0.5))}${field("Letters show after Go for (s)", num("revealFor", r.revealFor, 0, 10, 0.5))}</div>` : ""}
    ${field("Play to", `<select data-rule="target.kind"><option value="ongoing" ${r.target.kind === "ongoing" ? "selected" : ""}>Keep playing (no end)</option><option value="points" ${r.target.kind === "points" ? "selected" : ""}>Points</option><option value="rounds" ${r.target.kind === "rounds" ? "selected" : ""}>Rounds</option></select>`)}
    ${r.target.kind === "ongoing" ? "" : field(r.target.kind === "points" ? "Points to win" : "Number of rounds", num("target.n", r.target.n, 1, 100))}
    <p class="muted small" style="margin:0">Rule changes apply from the next reveal.</p>`;
  $("#scoring").innerHTML = `
    ${field("Points for winning (Classic, Sandwich)", num("scoring.winPoints", s.winPoints, 0, 50))}
    ${field("Points per word (Frenzy)", num("scoring.basePoints", s.basePoints, 0, 10))}
    ${field("Bonus for winning a Frenzy", num("scoring.frenzyWinBonus", s.frenzyWinBonus, 0, 50))}
    ${field("Length bonus", check("scoring.lengthBonus", s.lengthBonus))}
    ${s.lengthBonus ? `<div class="sub">${field("+1 per letter past", num("scoring.lengthThreshold", s.lengthThreshold, 1, 12))}</div>` : ""}
    ${field("Syllable bonus", check("scoring.syllableBonus", s.syllableBonus))}
    ${s.syllableBonus ? `<div class="sub">${field("Counting syllables past", num("scoring.syllableThreshold", s.syllableThreshold, 0, 6))}${field("Each extra syllable worth more (+1, +3, +6, +10)", check("scoring.syllableGrow", s.syllableGrow))}</div>` : ""}
    ${field("Letter bonus <span class='muted small'>(Scrabble values)</span>", check("scoring.letterBonus", s.letterBonus))}
    ${s.letterBonus ? `<div class="sub muted small">Half the Scrabble value, only for letters you chose (not the round's own): Q Z +5, X J +4, K F H V W Y +2, B C M P D G +1</div>` : ""}
    ${field("Combo multiplier", check("scoring.combo", s.combo))}
    ${field("Secret words <span class='muted small'>(hidden bonus words)</span>", check("scoring.secretWords", s.secretWords))}
    ${s.secretWords ? `<div class="sub">${field("Points for a secret word", num("scoring.secretPoints", s.secretPoints, 1, 100))}</div>` : ""}
    ${s.combo ? `<div class="sub muted small">4 kinds of bonus in one word → ×1.5, 5 or more → ×2</div>` : ""}
    ${field("Dancing guest letter <span class='muted small'>(new idea)</span>", check("scoring.guest", s.guest))}
    ${s.guest ? `<div class="sub">${field("Points for using it", num("scoring.guestPoints", s.guestPoints, 0, 20))}${field("Chance per round", num("scoring.guestChance", s.guestChance, 0, 1, 0.1))}</div>` : ""}
    ${field("Time bonus <span class='muted small'>(Classic, Sandwich)</span>", check("scoring.speedBonus", s.speedBonus))}
    ${s.speedBonus ? `<div class="sub">${field("+1 per second left under (s)", num("scoring.speedWindow", s.speedWindow, 5, 120, 5))}</div>` : ""}
    ${field("Rare word bonus <span class='muted small'>(by how common it is)</span>", check("scoring.rareWord", s.rareWord))}
    ${s.rareWord ? `<div class="sub muted small">Everyday words +0, less common +5, uncommon +8, rare +10, very rare +12, by which public-domain word lists include the word.</div>` : ""}
    ${field("Rare combo bonus <span class='muted small'>(new idea)</span>", check("scoring.rarityBonus", s.rarityBonus))}
    ${s.rarityBonus ? `<div class="sub muted small">+1 if fewer than 200 words fit, +2 under 50, +3 under 10</div>` : ""}
    ${field("Echo bonus <span class='muted small'>(in the rules, never pointed out)</span>", check("scoring.echoBonus", s.echoBonus))}
    ${s.echoBonus ? `<div class="sub">${field("Uses one of an old round's end letters", num("scoring.echoOne", s.echoOne, 0, 10))}${field("Uses both", num("scoring.echoBoth", s.echoBoth, 0, 10))}${field("Looks back (rounds)", num("scoring.echoRounds", s.echoRounds, 1, 5))}<div class="muted small">Older rounds pay more: × how many rounds ago. Only extra letters count, not ones this round already needs.</div></div>` : ""}`;
  $("#feel").innerHTML = `
    ${field("Animations", `<input type="checkbox" data-feel="anim" ${feel.anim ? "checked" : ""}>`)}
    ${field("Animation speed", `<input type="range" data-feel="speed" min="0.4" max="2" step="0.1" value="${feel.speed}" aria-label="Animation speed (slower to the right)">`)}
    ${field("Sound", `<input type="checkbox" data-feel="sound" ${feel.sound ? "checked" : ""}>`)}
    ${field("Scene", `<select data-feel="scene">${Object.entries(SCENES).map(([k, s]) => `<option value="${k}" ${feel.scene === k ? "selected" : ""}>${s.label}</option>`).join("")}</select>`)}
    ${field("Time of day", `<select data-feel="theme"><option value="">Follow system</option><option value="light" ${feel.theme === "light" ? "selected" : ""}>☀️ Daytime</option><option value="dark" ${feel.theme === "dark" ? "selected" : ""}>🌙 Evening</option></select>`)}`;
}

function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  while (keys.length > 1) o = o[keys.shift()];
  o[keys[0]] = value;
}

function applyRules(rebuild) {
  store.set("rules", rules);
  engine.setRules(structuredClone(rules));
  if (rebuild) buildRulesPanel();
  changed();
}

function applyFeel() {
  store.set("feel", feel);
  document.body.classList.toggle("no-anim", !feel.anim);
  document.documentElement.style.setProperty("--anim", feel.speed);
  if (feel.theme) document.documentElement.dataset.theme = feel.theme; else delete document.documentElement.dataset.theme;
  if (online?.role === "host") engine.state.scene = feel.scene;
  showScene();
}

// Online, everyone sees the theme of whoever opened the room (it travels in the game state).
let sceneShown = null;
function showScene() {
  const scene = (online && engine.state.scene) || feel.scene;
  if (scene !== sceneShown) { sceneShown = scene; applyScene(scene); }
}

function updatePreview() {
  const w = $("#preview-word").value.trim().toLowerCase(), out = $("#preview-out");
  if (!w) { out.innerHTML = `<span class="muted">Shows how a word would score under the current rules.</span>`; return; }
  const st = engine.state;
  const inDict = lexicon.contains(w);
  const fits = st.pattern ? st.pattern.matches(w) : null;
  const s = scoreWord(w, { scoring: rules.scoring, syllables, mode: rules.mode, elapsed: 10, matchCount: st.pattern ? st.matchCount : 1000, pattern: st.pattern, recent: st.recentPatterns });
  out.innerHTML = `<div class="wordrow"><span class="w">${esc(w)}</span>${breakdown(s)}<span class="pill">${s.syllables} syl</span> = <b>${wordTotal(s)}</b></div>
    <div class="muted">${inDict ? "In the dictionary" : "⚠️ Not in the dictionary"}${fits == null ? "" : fits ? ` · fits ${st.pattern}` : ` · doesn't fit ${st.pattern}`}${rules.scoring.speedBonus ? " · time bonus assumes a 10s answer" : ""}</div>`;
}

$("#panel").addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b || b.disabled) return;
  const st = engine.state, t = now();
  if (b.dataset.preset) { rules = mergeRules(PRESETS[b.dataset.preset]()); applyRules(true); return; }
  if (b.dataset.move != null) { const i = +b.dataset.move; engine.moveSeat(i, i + +b.dataset.dir); return changed(); }
  if (b.dataset.remove) {
    const id = b.dataset.remove;
    engine.removePlayer(id, t);
    if (id.startsWith("bot")) botCount = Math.max(0, botCount - 1); else phoneCount = humanPlayers().length;
    store.set("botCount", botCount); store.set("phoneCount", phoneCount);
    return changed();
  }
  switch (b.dataset.panel) {
    case "start": engine.startGame(); break;
    case "exportData": return exportCollected();
    case "addPhone": {
      const used = new Set(st.players.map(p => p.id));
      let i = 0; while (used.has("p" + i)) i++;
      engine.addPlayer({ id: "p" + i, name: names[i] || "Player " + (i + 1) });
      phoneCount = humanPlayers().length; store.set("phoneCount", phoneCount);
      break;
    }
    case "addBot": {
      const used = new Set(st.players.map(p => p.id));
      let j = 0; while (used.has("bot" + j)) j++;
      engine.addPlayer({ id: "bot" + j, name: "Bot " + (j + 1), isBot: true });
      botCount = st.players.filter(p => p.isBot).length; store.set("botCount", botCount);
      break;
    }
    case "resetRoles": engine.resetRoles(); break;
    case "autopick":
      for (const p of humanPlayers()) if (!engine.state.locked.has(p.id)) {
        ui(p.id).myPick = ALPHABET[Math.floor(Math.random() * 26)];
        engine.lockLetter(p.id, ui(p.id).myPick, t);
      }
      break;
    case "endRound": if (st.phase.type === "answering") { st.phase.closesAt = t - 1; engine.tick(t); } break;
    case "repick": engine.repick(); break;
    case "next": engine.nextRound(); break;
    case "endGame": engine.endGame(); break;
    case "again": engine.startGame(); break;
    case "lobby": engine.backToLobby(); break;
    case "reset": log.length = 0; renderLog(); newGame(); return;
    case "clearStandings":
      if (!confirm("Clear all-time standings for everyone?")) return;
      for (const k in standings) delete standings[k];
      store.set("standings", standings); renderStandings(); break;
  }
  changed();
});

$("#panel").addEventListener("change", e => {
  const el = e.target;
  if (el.dataset.rule) {
    const path = el.dataset.rule;
    const v = el.type === "checkbox" ? el.checked : el.type === "number" ? Number(el.value) : el.value;
    if (path === "target.kind") rules.target = { kind: v, n: v === "points" ? 10 : 5 };
    else setPath(rules, path, v);
    applyRules(el.type !== "number");
  } else if (el.dataset.feel) {
    const k = el.dataset.feel;
    feel[k] = el.type === "checkbox" ? el.checked : el.type === "range" ? Number(el.value) : el.value;
    applyFeel();
    if (k === "peek") renderPanel();
  } else if (el.dataset.name) {
    const p = engine.state.players.find(x => x.id === el.dataset.name);
    if (p) {
      p.name = el.value.trim() || p.name;
      const i = +p.id.slice(1);
      if (!Number.isNaN(i)) { names[i] = p.name; store.set("names", names); }
    }
    el.blur();
    changed();
  } else if (el.dataset.role != null) {
    engine.setRole(el.value, +el.dataset.role);
    changed();
  }
});
$("#panel").addEventListener("input", e => {
  if (e.target.id === "preview-word") updatePreview();
  if (e.target.dataset.feel === "speed") { feel.speed = Number(e.target.value); applyFeel(); }
});

// ---------- Go ----------

applyFeel();
buildRulesPanel();
renderLog();
renderStandings();
newGame();
requestAnimationFrame(frame);
