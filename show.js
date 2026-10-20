// The scoring show: when a round is won, the winning word's score is built up on every phone,
// one rule at a time, so watching it teaches how scoring works. Each bonus has its own little
// animation and a rising musical phrase; a massive score ends with the letters doing Tecktonik.
"use strict";

// ---------- Synth ----------

let showAudio = null;
function audio() {
  if (!feel.sound) return null;
  try { return (showAudio ||= new (window.AudioContext || window.webkitAudioContext)()); } catch { return null; }
}

// Plays a note `at` seconds from now.
function tone(freq, at = 0, dur = 0.12, { type = "triangle", vol = 0.14, slide = 0 } = {}) {
  const ctx = audio();
  if (!ctx) return;
  const t = ctx.currentTime + at, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

function noise(at = 0, dur = 0.08, { vol = 0.12, high = true } = {}) {
  const ctx = audio();
  if (!ctx) return;
  const t = ctx.currentTime + at, len = Math.ceil(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate), data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = buf;
  f.type = high ? "highpass" : "bandpass";
  f.frequency.value = high ? 6000 : 1500;
  g.gain.value = vol;
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(t);
}

// A bright, rounded synth pluck: a sawtooth through a closing low-pass filter.
function pluck(freq, at = 0, dur = 0.18, vol = 0.07) {
  const ctx = audio();
  if (!ctx) return;
  const t = ctx.currentTime + at, o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  o.type = "sawtooth";
  o.frequency.value = freq;
  f.type = "lowpass";
  f.Q.value = 6;
  f.frequency.setValueAtTime(Math.min(9000, freq * 8), t);
  f.frequency.exponentialRampToValueAtTime(Math.max(300, freq * 1.5), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(f).connect(g).connect(ctx.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

// A bubbly "plop": a quick upward sine sweep with a soft thump under it.
function plopSound(at = 0, size = 1) {
  tone(220 / size, at, 0.11, { type: "sine", vol: 0.2, slide: 3.2 });
  tone(90, at, 0.08, { type: "sine", vol: 0.12 * size, slide: 0.6 });
}

// ---------- The groove ----------
// Friendly electro under the whole show: 124 BPM, C – Am – F – G. It builds as bonuses land:
// level 0 kick + bass, 1 adds open hats, 2 claps and ticking hats, 3 chord stabs, 4+ sparkly arps.
const BPM = 124, SIXTEENTH = 60 / BPM / 4;
const CHORDS = [[261.6, 329.6, 392.0], [220.0, 261.6, 329.6], [174.6, 220.0, 261.6], [196.0, 246.9, 293.7]];
let groove = null;

function startGroove() {
  const ctx = audio();
  if (!ctx) return null;
  stopGroove();
  const g = { level: 0, next: ctx.currentTime + 0.05, step: 0 };
  g.timer = setInterval(() => {
    while (g.next < ctx.currentTime + 0.12) { playStep(g, g.step, g.next - ctx.currentTime); g.step++; g.next += SIXTEENTH; }
  }, 25);
  return (groove = g);
}
function stopGroove() { if (groove) { clearInterval(groove.timer); groove = null; } }

function playStep(g, step, at) {
  const s = step % 16, chord = CHORDS[Math.floor(step / 16) % 4], root = chord[0] / 4;
  if (s % 4 === 0) tone(130, at, 0.16, { type: "sine", vol: 0.22, slide: 0.35 });                 // soft kick
  if (s % 4 === 2) pluck(s % 8 === 2 ? root : root * 2, at, 0.16, 0.09);                          // bouncy off-beat bass
  if (g.level >= 1 && s % 4 === 2) noise(at, 0.07, { vol: 0.05 });                                 // open hat
  if (g.level >= 2 && s % 2 === 1) noise(at, 0.02, { vol: 0.025 });                               // ticking hat
  if (g.level >= 2 && s % 8 === 4) noise(at, 0.09, { vol: 0.12, high: false });                    // clap
  if (g.level >= 3 && [3, 6, 11, 14].includes(s)) chord.forEach(f => pluck(f * 2, at, 0.12, 0.025)); // chord stabs
  if (g.level >= 4) pluck(chord[s % 3] * (s % 6 < 3 ? 4 : 2), at, 0.08, 0.02);                     // sparkle arps
}

// C major, climbing: each bonus row starts a step higher than the last.
const SCALE = [261.6, 293.7, 329.6, 392.0, 440.0, 523.3, 587.3, 659.3, 784.0, 880.0, 1046.5, 1174.7, 1318.5, 1568.0, 1760.0, 2093.0];
const note = i => SCALE[Math.min(i, SCALE.length - 1)];

// ---------- Helpers ----------

// Rough syllable split for show (e.g. ex·ag·ger·ate → e·xag·ge·rate). Falls back to even chunks
// when the guess doesn't match the dictionary's syllable count.
function syllableChunks(word, count) {
  const w = word.toLowerCase(), isV = c => "aeiouy".includes(c);
  const groups = [];
  for (let i = 0; i < w.length; i++) if (isV(w[i]) && (i === 0 || !isV(w[i - 1]))) groups.push(i);
  if (groups.length > 1 && /[^aeiouy]e$/.test(w) && !/[^aeiouy]le$/.test(w)) groups.pop();
  const cuts = [];
  for (let g = 1; g < groups.length; g++) {
    let end = groups[g - 1];
    while (end < w.length && isV(w[end])) end++;
    const cons = groups[g] - end;
    cuts.push(cons <= 1 ? end : end + 1);
  }
  let pieces = [], from = 0;
  for (const c of cuts) { pieces.push([from, c]); from = c; }
  pieces.push([from, w.length]);
  if (pieces.length !== count) {
    pieces = [];
    for (let i = 0; i < count; i++) pieces.push([Math.round(i * w.length / count), Math.round((i + 1) * w.length / count)]);
  }
  return pieces;
}

// Tile positions holding the echo letters: interior letters first, matching the scoring rule.
function echoTiles(word, letters, taken) {
  const out = [];
  for (const l of letters) {
    for (let i = 1; i < word.length - 1; i++) if (word[i] === l && !taken.has(i)) { taken.add(i); out.push(i); break; }
  }
  return out;
}

// Counts el up from `from` to `to`. A newer count on the same element takes over from an older one.
function countTo(el, from, to, ms, lead) {
  const start = performance.now(), steps = to - from, id = (el.countId = (el.countId || 0) + 1);
  let last = from;
  const step = () => {
    if (el.countId !== id) return;
    const k = Math.max(0, Math.min(1, (performance.now() - start) / ms)), v = Math.round(from + steps * k);
    if (v !== last) { if (lead) tone(1800 + v * 12, 0, 0.025, { type: "square", vol: 0.03 }); last = v; }
    el.textContent = v;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- The dancing guest letter ----------
// Each guest is its own letter shape, drawn as limbs around joints so the strokes can dance:
// [class, x1, y1, x2, y2] with the joint at (x1, y1). Eyes sit where a face would be.
const GUEST_FIGURES = {
  x: { limbs: [["armL", 50, 58, 16, 14], ["armR", 50, 58, 84, 14], ["legL", 50, 58, 18, 110], ["legR", 50, 58, 82, 110]], eyes: [43, 48, 57, 48] },
  y: { limbs: [["armL", 50, 56, 16, 12], ["armR", 50, 56, 84, 12], ["legL", 50, 56, 50, 112]], eyes: [43, 46, 57, 46] },
  t: { limbs: [["armL", 50, 18, 12, 18], ["armR", 50, 18, 88, 18], ["legL", 50, 18, 50, 112]], eyes: [43, 36, 57, 36] },
  a: { limbs: [["legL", 50, 12, 16, 112], ["legR", 50, 12, 84, 112], ["armL", 50, 74, 31, 74], ["armR", 50, 74, 69, 74]], eyes: [45, 40, 55, 40] },
  i: { limbs: [["body", 50, 16, 50, 108], ["armL", 50, 16, 28, 16], ["armR", 50, 16, 72, 16], ["legL", 50, 108, 28, 108], ["legR", 50, 108, 72, 108]], eyes: [43, 36, 57, 36] },
  k: { limbs: [["body", 30, 62, 30, 12], ["legL", 30, 62, 30, 112], ["armR", 30, 62, 82, 12], ["legR", 30, 62, 82, 112]], eyes: [23, 36, 37, 36] },
};

function guestFigure(letter) {
  const f = GUEST_FIGURES[letter];
  if (!f) return `<div class="guest-plain">${cap(letter)}</div>`;
  const [ex1, ey1, ex2, ey2] = f.eyes;
  return `<svg class="guest-fig" viewBox="-10 -10 120 135" aria-label="${cap(letter)}">
    ${f.limbs.map(([cls, x1, y1, x2, y2]) => `<line class="limb ${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" style="transform-origin:${x1}px ${y1}px"/>`).join("")}
    <g class="eyes"><circle cx="${ex1}" cy="${ey1}" r="5"/><circle cx="${ex2}" cy="${ey2}" r="5"/><circle class="shine" cx="${ex1 + 1.5}" cy="${ey1 - 1.5}" r="1.6"/><circle class="shine" cx="${ex2 + 1.5}" cy="${ey2 - 1.5}" r="1.6"/></g>
  </svg>`;
}

// ---------- The secret-word philosopher ----------
// A modern philosopher: tweed blazer over a black turtleneck, messy hair, short beard, sunglasses.
// Arms and legs are groups around a joint so they can strike Tecktonik poses (same keyframes as the guest letter).
const PHILOSOPHER_SVG = `<svg class="philo-fig" viewBox="0 0 100 150" aria-label="A philosopher in sunglasses, dancing">
  <g class="p-leg legL" style="transform-origin:44px 100px"><line x1="44" y1="100" x2="39" y2="138"/><ellipse class="p-shoe" cx="36" cy="140" rx="7" ry="3.5"/></g>
  <g class="p-leg legR" style="transform-origin:56px 100px"><line x1="56" y1="100" x2="61" y2="138"/><ellipse class="p-shoe" cx="64" cy="140" rx="7" ry="3.5"/></g>
  <path class="p-turtle" d="M41 58 L59 58 L60 104 L40 104 Z"/>
  <path class="p-jacket" d="M36 60 Q38 57 44 57 L48 80 L46 106 L33 104 Z M64 60 Q62 57 56 57 L52 80 L54 106 L67 104 Z"/>
  <path class="p-lapel" d="M44 57 L41 70 L47 76 M56 57 L59 70 L53 76"/>
  <rect class="p-collar" x="43.5" y="49" width="13" height="9" rx="3"/>
  <g class="p-arm armL" style="transform-origin:39px 63px"><line x1="39" y1="63" x2="21" y2="90"/><circle class="p-hand" cx="20" cy="92" r="4"/></g>
  <g class="p-arm armR" style="transform-origin:61px 63px"><line x1="61" y1="63" x2="79" y2="90"/><circle class="p-hand" cx="80" cy="92" r="4"/></g>
  <circle class="p-skin" cx="50" cy="35" r="14"/>
  <path class="p-beard" d="M37 37 Q38 47 44 50 Q50 53 56 50 Q62 47 63 37 Q60 43 56 44 Q50 46 44 44 Q40 43 37 37 Z"/>
  <path class="p-hair" d="M35 34 Q33 19 44 18 Q47 12 53 16 Q60 13 63 20 Q68 25 65 34 Q63 26 58 25 Q55 21 50 24 Q44 21 41 26 Q36 27 35 34 Z"/>
  <rect class="p-shade" x="39" y="30" width="9.5" height="6" rx="2"/><rect class="p-shade" x="51.5" y="30" width="9.5" height="6" rx="2"/>
  <line class="p-bridge" x1="48.5" y1="32" x2="51.5" y2="32"/>
  <path class="p-glint" d="M41 32 L44 31 M53.5 32 L56.5 31"/>
</svg>`;

// He slides in, dances for a few seconds, and slides off.
function philosopherDance(host, ms) {
  const fig = document.createElement("div");
  fig.className = "philo";
  fig.innerHTML = PHILOSOPHER_SVG + `<div class="philo-tag">🤫 secret word!</div>`;
  host.appendChild(fig);
  setTimeout(() => fig.classList.add("leaving"), ms);
  setTimeout(() => fig.remove(), ms + 600 * feel.speed);
}

// ---------- The rows ----------

// Each row: what it's for, why (the rule in plain words), points, and its little act.
function showRows(entry, w, st, mine = true) {
  const s = st.rules.scoring, word = w.word, rows = [];
  const mode = st.lastResult.mode, race = isRace(mode);
  rows.push({ icon: "🏆", label: race ? "Won the round" : "Best word", why: race ? "first word that fits" : mode === "turn" ? "highest-scoring word" : `out of ${entry.words.length} ${mine ? "you" : "they"} found`, n: w.base, act: "win" });
  if (w.lengthBonus) rows.push({ icon: "📏", label: `${word.length} letters`, why: `+1 for each letter past ${s.lengthThreshold}`, n: w.lengthBonus, act: "length", cls: "len" });
  if (w.syllableBonus) rows.push({ icon: "👏", label: `${w.syllables} syllables`, why: s.syllableGrow ? "each extra syllable is worth more" : `+1 for each syllable past ${s.syllableThreshold}`, n: w.syllableBonus, act: "syllables", cls: "syl" });
  if (w.letterBonus) {
    const rare = [...new Set(spareLetters(word, st.lastResult.pattern).filter(c => letterPoints(c)))];
    rows.push({ icon: "💎", label: `Rare letters ${mine ? "you" : "they"} chose`, why: rare.map(c => `${cap(c)} +${letterPoints(c)}`).join(" · "), n: w.letterBonus, act: "rare", cls: "letters" });
  }
  if (w.rarityBonus) rows.push({ icon: "🧩", label: "Tough letters", why: `only ${st.lastResult.matchCount} words fit`, n: w.rarityBonus, act: "tough", cls: "rare" });
  const taken = new Set();
  for (const e of w.echoes || []) {
    rows.push({
      icon: "✨", label: `Echo · ${e.ago === 1 ? "last round" : `${e.ago} rounds ago`}`,
      why: `${e.pattern} · reused ${e.letters.map(cap).join(" & ")}${e.ago > 1 ? ` · ×${e.ago} for remembering` : ""}`,
      n: e.points, act: "echo", cls: "echo", tiles: echoTiles(word, e.letters, taken), ghost: e.pattern,
    });
  }
  if (w.guestBonus) rows.push({ icon: "💃", label: `Danced with ${cap(w.guest)}`, why: "used the guest letter while it danced", n: w.guestBonus, act: "guest", cls: "guest" });
  if (w.combo > 1) {
    const before = rows.reduce((t, r) => t + r.n, 0);
    rows.push({ icon: "🔥", label: `Combo ×${w.combo}`, why: `${w.comboKinds} kinds of bonus in one word`, n: wordTotal(w) - w.speedBonus - (w.rareWordBonus || 0) - w.secretBonus - before, act: "combo", cls: "combo" });
  }
  if (w.rareWordBonus) rows.push({ icon: "🦄", label: `Rare word`, why: `${w.rareWord} · fewer people would think of it`, n: w.rareWordBonus, act: "tough", cls: "rare" });
  if (w.secretBonus) rows.push({ icon: "🤫", label: "Secret word!", why: "one of the hidden words", n: w.secretBonus, act: "secret", cls: "secret" });
  // Time left goes last: the clock drains into the score a second at a time.
  if (w.speedBonus) rows.push({ icon: "⏱", label: "Time left on the clock", why: `${w.speedBonus}s to spare · +1 a second`, n: w.speedBonus, act: "clock", cls: "speed" });
  const rest = entry.points - wordTotal(w) - (entry.winBonus || 0) + (entry.peekCost || 0);
  if (rest > 0) rows.push({ icon: "📝", label: `${entry.words.length - 1} more words`, why: "every word in the list counts", n: rest, act: "more", cls: "more" });
  if (entry.winBonus) rows.push({ icon: "🏆", label: "Won the Frenzy", why: "top score · everyone keeps their own points", n: entry.winBonus, act: "win", cls: "combo" });
  if (entry.peekCost) rows.push({ icon: "👀", label: "Peeked at the letters", why: `${entry.peeks}× · −${st.rules.peekCost} each`, n: -entry.peekCost, act: "peek", cls: "peek" });
  return rows;
}

// ---------- The show ----------
// The winner's phone gets the party: points fly into the total, a sunburst grows behind the word as
// bonuses land, the leftover clock drains in a second at a time, and fireworks go off at the end.
// Everyone else just sees the result: the same rows, all at once, in a calm night-blue palette.

const FIREWORK_COLORS = ["#ff2bd6", "#22c3ff", "#7ddc1f", "#ffc531", "#e2445c", "#9b5de5"];

function playTally(ph, done) {
  const st = engine.state, r = st.lastResult;
  const entry = r.entries.find(e => e.player === r.winners[0]);
  const best = entry.words.filter(w => !w.cancelled).sort((a, b) => wordTotal(b) - wordTotal(a))[0];
  if (!best) return done();
  const mine = entry.player === ph.id; // other phones get a quick look at the winner's score
  const rows = showRows(entry, best, st, mine);
  const total = entry.points, word = best.word;
  // One phone plays the sound: the winner's, or the first phone when a bot won.
  const lead = mine || (ph === phones[0] && !phones.some(p => p.id === entry.player));
  const sp = feel.speed * 1.05; // the build-up's pacing; tap skips it
  const who = nameOf(ph, entry.player);
  const tier = total >= 55 ? "legend" : total >= 40 ? "huge" : total >= 25 ? "nice" : "";

  const el = document.createElement("div");
  el.className = mine ? "tally mine" : "tally theirs";
  el.innerHTML = `
    ${mine ? `<div class="tally-rays"></div>` : ""}
    <div class="tally-who">${esc(mine ? "You won!" : who + " won this round")}</div>
    <div class="tally-word">${word.split("").map((c, i) => `<span class="tl" style="--i:${i}">${cap(c)}</span>`).join("")}</div>
    <div class="tally-ghost"></div>
    <div class="tally-rows"></div>
    <div class="tally-total">${mine ? "" : `<small>${esc(who)}</small>`}<span>0</span></div>
    ${!mine && r.mode === "list" ? `<div class="tally-kept">You keep ${signed(r.entries.find(e => e.player === ph.id)?.points || 0)}</div>` : ""}
    <div class="tally-tier"></div>
    <div class="tally-skip muted small">tap to skip</div>`;
  ph.screen.appendChild(el);
  const tiles = [...el.querySelectorAll(".tl")];
  const totalEl = el.querySelector(".tally-total span"), rowsEl = el.querySelector(".tally-rows"), ghost = el.querySelector(".tally-ghost");
  const setHype = h => el.style.setProperty("--hype", Math.min(1, h));

  const timers = [];
  const at = (ms, fn) => timers.push(setTimeout(fn, ms * sp));
  const flash = (els, cls, ms = 700) => {
    for (const t of els) { t.classList.remove(cls); void t.offsetWidth; t.classList.add(cls); }
    timers.push(setTimeout(() => els.forEach(t => t.classList.remove(cls)), ms * sp));
  };
  const bump = () => { const tot = totalEl.parentElement; tot.classList.remove("bump"); void tot.offsetWidth; tot.classList.add("bump"); };
  // Where something sits inside the tally, so effects can be placed and aimed.
  const spot = node => {
    const a = node.getBoundingClientRect(), b = el.getBoundingClientRect();
    return { x: a.left - b.left + a.width / 2, y: a.top - b.top + a.height / 2 };
  };

  // A "+n" chip arcs from `from` into the total; the total counts up when it lands.
  let shown = 0;
  function fly(from, n, ms, onLand) {
    const land = () => {
      const was = shown;
      shown += n;
      countTo(totalEl, was, shown, Math.min(380, 60 + Math.abs(n) * 30) * sp, lead);
      bump();
      if (lead) plopSound(0, n > 1 ? 1.2 : 0.6);
      onLand?.();
    };
    if (!feel.anim) return land();
    const a = spot(from), b = spot(totalEl), chip = document.createElement("span");
    chip.className = n < 0 ? "fly minus" : "fly";
    chip.textContent = signed(n);
    chip.style.left = a.x + "px";
    chip.style.top = a.y + "px";
    el.appendChild(chip);
    const dx = b.x - a.x, dy = b.y - a.y, lift = Math.min(90, 30 + Math.abs(dy) * 0.3);
    chip.animate([
      { transform: "translate(-50%, -50%) scale(.6)", opacity: 0 },
      { transform: `translate(calc(-50% + ${dx * 0.4}px), calc(-50% + ${dy * 0.4 - lift}px)) scale(1.5) rotate(-8deg)`, opacity: 1, offset: 0.45 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.5)`, opacity: 0.3 },
    ], { duration: ms * sp, easing: "cubic-bezier(.3, .1, .5, 1)" });
    timers.push(setTimeout(() => { chip.remove(); if (!finished) land(); }, ms * sp));
  }

  // A firework: sparks burst out from (x, y), droop and fade. Only on the winner's phone.
  function firework(x, y, k = 0) {
    if (!feel.anim) return;
    const n = 22, hue = FIREWORK_COLORS[k % FIREWORK_COLORS.length], alt = FIREWORK_COLORS[(k + 2) % FIREWORK_COLORS.length];
    const ring = document.createElement("span");
    ring.className = "fw-ring";
    ring.style.cssText = `left:${x}px;top:${y}px;--c:${hue}`;
    el.appendChild(ring);
    timers.push(setTimeout(() => ring.remove(), 700 * sp));
    for (let i = 0; i < n; i++) {
      const p = document.createElement("span"), ang = (i / n) * Math.PI * 2 + Math.random() * 0.2, dist = 55 + Math.random() * 45;
      p.className = "fw";
      p.style.cssText = `left:${x}px;top:${y}px;background:${i % 3 ? hue : alt};box-shadow:0 0 8px ${hue}`;
      el.appendChild(p);
      const ex = Math.cos(ang) * dist, ey = Math.sin(ang) * dist;
      p.animate([
        { transform: "translate(-50%, -50%) scale(1.4)", opacity: 1 },
        { transform: `translate(calc(-50% + ${ex}px), calc(-50% + ${ey}px)) scale(1)`, opacity: 1, offset: 0.55 },
        { transform: `translate(calc(-50% + ${ex * 1.15}px), calc(-50% + ${ey * 1.15 + 40}px)) scale(.3)`, opacity: 0 },
      ], { duration: (900 + Math.random() * 300) * sp, easing: "cubic-bezier(.1, .8, .3, 1)" });
      timers.push(setTimeout(() => p.remove(), 1300 * sp));
    }
    if (lead) {
      noise(0, 0.25, { vol: 0.16, high: false }); // pop
      for (let j = 0; j < 6; j++) tone(2400 + Math.random() * 1800, 0.12 + j * 0.05, 0.05, { type: "sine", vol: 0.025 }); // crackle
    }
  }

  const g = lead && mine ? startGroove() : null;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    timers.forEach(clearTimeout);
    if (lead) stopGroove();
    totalEl.countId = -1;
    totalEl.textContent = total;
    el.classList.add("out");
    setTimeout(() => el.remove(), 400 * sp);
    done();
  };
  el.addEventListener("click", e => { e.stopPropagation(); finish(); });

  // Not your win: the result at a glance, no show.
  if (!mine) {
    tiles.forEach(tile => tile.classList.add("in"));
    rows.forEach((row, i) => {
      const div = document.createElement("div");
      div.className = `tally-row ${row.cls || ""}`;
      div.style.animationDelay = `calc(${i * 0.05}s * var(--anim))`;
      div.innerHTML = `<i>${row.icon}</i><span><b>${esc(row.label)}</b><small>${esc(row.why)}</small></span><em>${signed(row.n)}</em>`;
      rowsEl.appendChild(div);
    });
    rowsEl.scrollTop = rowsEl.scrollHeight;
    totalEl.textContent = total;
    el.querySelector(".tally-tier").textContent = { legend: "Legendary", huge: "Huge", nice: "Nice" }[tier] || "";
    el.classList.add("final", tier || "plain");
    if (lead) plopSound(0, 1);
    if (best.secretBonus) philosopherDance(el, 2600 * sp); // a secret word is worth a look even when you lost
    at(best.secretBonus ? 3400 : 3000, finish);
    return;
  }

  // 1. The word drops in, letter by letter.
  let t = 200;
  tiles.forEach((tile, i) => {
    at(t + i * 70, () => { tile.classList.add("in"); if (lead) { plopSound(0.2 * sp, 0.7); tone(note(i % 8) * 2, 0.2 * sp, 0.05, { vol: 0.05 }); } });
  });
  t += tiles.length * 70 + 300;

  // 2. One row per rule, each with its own act and a phrase a step higher than the last.
  rows.forEach((row, i) => {
    const base = i * 2; // scale degree this row starts on
    let len = 950;
    if (row.act === "length") len = 650 + tiles.length * 45;
    if (row.act === "syllables") len = 550 + best.syllables * 240;
    if (row.act === "echo") len = 1150;
    if (row.act === "secret") len = Math.max(3600, 900 + tiles.length * 90); // room for the philosopher's dance
    if (row.act === "clock") len = 900 + clockTicks(row.n).reduce((a, b) => a + b, 0);
    at(t, () => {
      const div = document.createElement("div");
      div.className = `tally-row ${row.cls || ""}`;
      div.innerHTML = `<i>${row.icon}</i><span><b>${esc(row.label)}</b><small>${esc(row.why)}</small></span><em>${row.act === "clock" ? "+0" : signed(row.n)}</em>`;
      rowsEl.appendChild(div);
      rowsEl.scrollTop = rowsEl.scrollHeight;
      if (g) g.level = Math.min(3, i);
      setHype(0.25 + 0.6 * (i + 1) / rows.length);
      if (row.act === "clock") clock(row, div, base);
      else at(150, () => fly(div.querySelector("em"), row.n, 420));
      act(row, base);
    });
    t += len;
  });

  // The clock drains faster and faster, one second (and one point) at a time.
  function clockTicks(n) {
    const out = [];
    for (let k = 0; k < n; k++) out.push(Math.max(38, 130 - k * 9));
    return out;
  }
  function clock(row, div, base) {
    const em = div.querySelector("em"), small = div.querySelector("small");
    const face = document.createElement("div");
    face.className = "tally-clock";
    face.innerHTML = `<i>⏱</i><b>${row.n}</b><small>sec</small>`;
    el.appendChild(face);
    const secs = face.querySelector("b");
    let wait = 380;
    clockTicks(row.n).forEach((gap, k) => {
      wait += gap;
      at(wait, () => {
        const left = row.n - k - 1;
        secs.textContent = left;
        em.textContent = "+" + (k + 1);
        small.textContent = `${left}s to go…`;
        face.classList.remove("tick"); void face.offsetWidth; face.classList.add("tick");
        fly(face, 1, 260);
        if (lead) pluck(note(base + Math.floor(k / 2)) * 2, 0, 0.06, 0.05);
      });
    });
    at(wait + 260, () => {
      small.textContent = `${row.n}s to spare · +1 a second`;
      face.classList.add("done");
      if (lead) [0, 4, 7].forEach((d, k) => pluck(note(base + 4 + d) * 2, k * SIXTEENTH, 0.2, 0.06));
    });
    at(wait + 700, () => face.remove());
  }

  function act(row, base) {
    switch (row.act) {
      case "win":
        flash(tiles, "hop", 600);
        if (lead) [0, 2, 4, 7].forEach((d, k) => pluck(note(base + d) * 2, k * SIXTEENTH, 0.2));
        break;
      case "length": // a wave runs along the word, climbing in pitch
        tiles.forEach((tile, k) => timers.push(setTimeout(() => {
          flash([tile], "stretch", 400);
          if (lead) pluck(note(base + Math.floor(k / 2)) * 2, 0, 0.08, 0.05);
        }, k * 45 * sp)));
        break;
      case "syllables": // each syllable claps and bounces in turn
        syllableChunks(best.word, best.syllables).forEach(([a, b], k) => timers.push(setTimeout(() => {
          flash(tiles.slice(a, b), "clap", 300);
          if (lead) { noise(0, 0.06, { vol: 0.18, high: false }); pluck(note(base + k) * 2, 0, 0.16); }
        }, k * 240 * sp)));
        break;
      case "rare": { // rare tiles spark and flash their value
        const p = st.lastResult.pattern;
        const own = k => (k === 0 && p.starts.length) || (k === word.length - 1 && p.ends.length); // the round's letters don't count
        const rare = tiles.filter((_, k) => letterPoints(word[k]) && !own(k));
        rare.forEach((tile, k) => timers.push(setTimeout(() => {
          tile.dataset.v = "+" + letterPoints(word[tiles.indexOf(tile)]);
          flash([tile], "spark", 900);
          if (lead) { pluck(note(base + 4 + k) * 2, 0, 0.1, 0.06); pluck(note(base + 7 + k) * 2, SIXTEENTH, 0.14, 0.06); }
        }, k * 130 * sp)));
        break;
      }
      case "clock":
        flash(tiles, "zoom", 500);
        if (lead) tone(note(base), 0, 0.3, { type: "triangle", vol: 0.08, slide: 4 });
        break;
      case "secret": // the philosopher dances Tecktonik; the tiles flip to gold one by one, and the screen shakes
        philosopherDance(el, 3000 * sp);
        el.classList.add("disco");
        timers.push(setTimeout(() => el.classList.remove("disco"), 3000 * sp));
        if (g) { const was = g.level; g.level = 5; timers.push(setTimeout(() => (g.level = was), 3000 * sp)); }
        tiles.forEach((tile, k) => timers.push(setTimeout(() => {
          flash([tile], "secret", 1200 + (tiles.length - k) * 90);
          if (lead) pluck(note(base + k) * 2, 0, 0.25, 0.05);
        }, k * 90 * sp)));
        timers.push(setTimeout(() => {
          ph.screen.classList.remove("quake"); void ph.screen.offsetWidth; ph.screen.classList.add("quake");
          if (lead) [0, 4, 7, 11].forEach((d, j) => pluck(note(base + 6 + d) * 2, j * SIXTEENTH / 2, 0.4, 0.06));
        }, tiles.length * 90 * sp));
        break;
      case "tough":
        flash(tiles, "shimmer", 900);
        if (lead) [0, 2, 4, 7].forEach((d, k) => pluck(note(base + d) * 2, k * SIXTEENTH, 0.2));
        break;
      case "guest": { // the guest's tile does a little jig
        const k = word.indexOf(best.guest, 1);
        const tile = tiles[k > 0 ? k : word.indexOf(best.guest)];
        if (tile) flash([tile], "jig", 1000);
        if (lead) [4, 2, 4, 7].forEach((d, j) => pluck(note(base + d) * 2, j * SIXTEENTH, 0.14, 0.07));
        break;
      }
      case "combo": // everything lights up at once
        flash(tiles, "spark", 900);
        tiles.forEach(t => (t.dataset.v = ""));
        ph.screen.classList.remove("quake"); void ph.screen.offsetWidth; ph.screen.classList.add("quake");
        if (lead) [0, 2, 4, 7, 9, 11].forEach((d, k) => pluck(note(base + d) * 2, k * SIXTEENTH / 2, 0.22, 0.06));
        break;
      case "echo": // a ghost of the old letters appears, and the reused letters glow
        ghost.textContent = row.ghost;
        flash([ghost], "show", 1000);
        flash(row.tiles.map(k => tiles[k]), "echoing", 1000);
        if (lead) [0, 1, 2, 3].forEach(k => pluck(note(base + 2) * 2, k * SIXTEENTH * 2, 0.2, 0.08 / (k + 1))); // echo, echo, echo
        break;
      default:
        if (lead) pluck(note(base) * 2, 0, 0.16);
    }
  }

  // 3. The finale grows with the score. The winner gets a flash, fireworks and letters doing the wave.
  at(t + 150, () => {
    totalEl.countId = -1; // in case a flying chip is still in the air
    totalEl.textContent = total;
    shown = total;
    const tierEl = el.querySelector(".tally-tier");
    tierEl.textContent = { legend: "LEGENDARY!", huge: "HUGE!", nice: "Nice!" }[tier] || "Nailed it!";
    el.classList.add("final", tier || "plain");
    if (lead) [0.22, 0.55, 0.79, 0.95].forEach((k, j) => plopSound(k * 1.1 * sp, 1.6 - j * 0.35));
    const top = rows.length * 2;
    if (lead) {
      const chord = [0, 2, 4, 7];
      chord.forEach((d, k) => pluck(note(top + d - 2) * 2, k * SIXTEENTH, 0.5, 0.06));
      chord.forEach(d => tone(note(top + d - 2) / 2, 0, 0.6, { type: "sine", vol: 0.08 }));
      if (g) g.level = 4;
    }
    setHype(1);
    at(250, () => el.classList.add("victory"));
    const box = el.getBoundingClientRect();
    const bursts = { legend: 7, huge: 5, nice: 3 }[tier] || 2;
    for (let k = 0; k < bursts; k++) {
      at(k * 140, () => firework(box.width * (0.2 + Math.random() * 0.6), box.height * (0.12 + Math.random() * 0.4), k));
    }
    confetti(ph.screen, Math.min(150, 30 + total * 2), 0.5);
    if (tier === "legend") tecktonik();
  });
  at(t + (tier === "legend" ? 2600 : 1600), finish);

  // Massive score: the letters dance Tecktonik while the groove goes all in.
  function tecktonik() {
    el.classList.add("dance");
    ph.screen.classList.remove("quake"); void ph.screen.offsetWidth; ph.screen.classList.add("quake");
    if (g) g.level = 5;
  }
}
