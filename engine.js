// Bookends game logic: a direct port of BookendsCore (Swift) so rules tried here carry over.
// Times are seconds on one shared clock (the "host" clock).
"use strict";

const ROLES = ["startsWith", "contains", "endsWith"];
const ROLE_LABEL = { startsWith: "Starts with", contains: "Contains", endsWith: "Ends with" };
const ALPHABET = "abcdefghijklmnopqrstuvwxyz".split("");
const ROUND_MODES = ["race", "list", "sandwich", "turn"];
// Classic and Sandwich are races: the first word wins. Turn rounds give everyone a short clock to find
// their single highest-scoring word; Frenzy is a list.
const isRace = mode => mode === "race" || mode === "sandwich";
// Secret words: never shown in the game, worth a big bonus when someone stumbles on one. Words the
// dictionary lacks are added to it, with their syllable counts.
const SECRET_WORDS = ["techno", "communism", "marxism", "synthesizer", "dialectic", "deterritorialization", "radical", "materialism", "literature"];
const SECRET_SYLLABLES = { techno: 2, marxism: 4, deterritorialization: 9 };
// What a player typed or said, as a plain lowercase word: phone keyboards can slip in accents,
// invisible characters or stray punctuation that would otherwise make a real word "not a word".
const cleanWord = raw => String(raw).normalize("NFKD").toLowerCase().replace(/[^a-z]/g, "");
const GUEST_LETTERS = ["x", "y", "t", "a", "i", "k"]; // letters with arms and legs to dance with

// Difficulty: Classic and Sandwich rounds can also ask for a longer word ("twist"), so the quickest easy
// word isn't always the play. Easy has none; Medium and Hard pick one of theirs at the reveal, only when
// enough words still fit (else the next easier one). Each round rolls its own level: "Mixed" (the default)
// from all three, and a level the host fixes leans on it but still mixes in a neighbour, so a Medium game
// has some rounds with no rule and some Hard ones.
const DIFFICULTY = {
  easy: { label: "Easy", twists: [] },
  medium: { label: "Medium", twists: [{ kind: "letters", n: 6 }, { kind: "letters", n: 7 }, { kind: "syllables", n: 2 }] },
  hard: { label: "Hard", twists: [{ kind: "letters", n: 8 }, { kind: "letters", n: 9 }, { kind: "syllables", n: 3 }, { kind: "syllables", n: 4 }] },
};
const LEVEL_ODDS = {
  mixed: [["easy", 0.5], ["medium", 0.3], ["hard", 0.2]],
  easy: [["easy", 1]],
  medium: [["easy", 0.3], ["medium", 0.45], ["hard", 0.25]],
  hard: [["medium", 0.3], ["hard", 0.7]],
};
const TWIST_MIN_WORDS = 8;
function meetsTwist(word, twist, syllables) {
  if (!twist) return true;
  return twist.kind === "letters" ? word.length >= twist.n : syllables.count(word) >= twist.n;
}
function twistText(twist) { return `at least ${twist.n} ${twist.kind}`; }
function rollLevel(difficulty) {
  let r = Math.random();
  for (const [level, odds] of LEVEL_ODDS[difficulty] || LEVEL_ODDS.mixed) if ((r -= odds) < 0) return level;
  return "easy";
}

// Bots play from the dictionary, no AI: they score every word that fits and pick one from a slice of that
// ranking (0 = the lowest-scoring word, 1 = the best), at a pace that suits their level. In Turn rounds they
// play a weaker word first and their real one later, so the live scoreboard moves. They sit out Frenzy.
const BOT_SKILL = {
  easy: { label: "Easy", rank: [0.2, 0.5], race: [0.45, 0.75], turn: [0.55, 0.9] },
  medium: { label: "Medium", rank: [0.6, 0.85], race: [0.25, 0.5], turn: [0.45, 0.85] },
  hard: { label: "Hard", rank: [0.95, 1], race: [0.1, 0.25], turn: [0.4, 0.8] },
};
const between = ([a, b]) => a + Math.random() * (b - a);

function defaultRoles(n) {
  if (n < 1) return [];
  if (n === 1) return ["startsWith"];
  return ["startsWith", ...Array(n - 2).fill("contains"), "endsWith"];
}

// ---------- Pattern ----------
// "Contains" letters must be in the interior: what's left after removing the constrained
// first/last letter. Repeated "contains" letters must each appear.
class WordPattern {
  constructor(constraints) {
    this.constraints = constraints; // [{role, letter}]
    this.starts = constraints.filter(c => c.role === "startsWith").map(c => c.letter);
    this.ends = constraints.filter(c => c.role === "endsWith").map(c => c.letter);
    this.contains = constraints.filter(c => c.role === "contains").map(c => c.letter);
  }
  get minimumLength() {
    return (this.starts.length ? 1 : 0) + (this.ends.length ? 1 : 0) + this.contains.length;
  }
  get isSatisfiable() {
    return new Set(this.starts).size <= 1 && new Set(this.ends).size <= 1;
  }
  matches(raw) {
    const w = raw.toLowerCase();
    if (!this.isSatisfiable || w.length < Math.max(this.minimumLength, 1)) return false;
    let lo = 0, hi = w.length;
    if (this.starts.length) { if (w[0] !== this.starts[0]) return false; lo = 1; }
    if (this.ends.length) { if (w[w.length - 1] !== this.ends[0]) return false; hi = w.length - 1; }
    const avail = {};
    for (let i = lo; i < hi; i++) avail[w[i]] = (avail[w[i]] || 0) + 1;
    for (const l of this.contains) {
      if (!avail[l]) return false;
      avail[l]--;
    }
    return true;
  }
  // The start and end letters trade places (Frenzy's SWAP!).
  swapped() {
    const flip = { startsWith: "endsWith", endsWith: "startsWith", contains: "contains" };
    return new WordPattern(this.constraints.map(c => ({ role: flip[c.role], letter: c.letter })));
  }
  toString() {
    const parts = [this.starts[0] ? this.starts[0].toUpperCase() : ""];
    for (const c of this.contains) parts.push(c.toUpperCase());
    parts.push(this.ends[0] ? this.ends[0].toUpperCase() : "");
    return parts.join("…");
  }
}

// ---------- Lexicon & syllables ----------
class Lexicon {
  constructor(text) {
    this.all = text.split("\n").filter(Boolean);
    const known = new Set(this.all);
    this.all.push(...SECRET_WORDS.filter(w => !known.has(w)));
    this.words = new Set(this.all);
    this.byFirst = {};
    for (const w of this.all) (this.byFirst[w[0]] ||= []).push(w);
  }
  contains(w) { return this.words.has(cleanWord(w)); }
  matches(p, limit = Infinity) {
    if (!p.isSatisfiable || limit <= 0) return [];
    const pool = p.starts.length ? (this.byFirst[p.starts[0]] || []) : this.all;
    const out = [];
    for (const w of pool) {
      if (p.matches(w)) { out.push(w); if (out.length >= limit) break; }
    }
    return out;
  }
  hasMatch(p) { return this.matches(p, 1).length > 0; }
  examples(p, n) { return shuffle(this.matches(p)).slice(0, n); }
}

class Syllables {
  constructor(text) {
    this.table = new Map();
    for (const line of text.split("\n")) {
      const [w, n] = line.split(" ");
      if (w) this.table.set(w, +n);
    }
    for (const [w, n] of Object.entries(SECRET_SYLLABLES)) if (!this.table.has(w)) this.table.set(w, n);
  }
  count(w) { w = w.toLowerCase(); return this.table.get(w) ?? Syllables.estimate(w); }
  static estimate(w) {
    const v = new Set("aeiouy");
    let groups = 0, inV = false;
    for (const c of w) { const isV = v.has(c); if (isV && !inV) groups++; inV = isV; }
    const n = w.length;
    if (n > 2 && w[n - 1] === "e" && !v.has(w[n - 2])) {
      const consonantLE = w[n - 2] === "l" && !v.has(w[n - 3]);
      if (!consonantLE) groups--;
    }
    return Math.max(groups, 1);
  }
}

// ---------- Rules ----------
function defaultRules() {
  return {
    mode: "race",               // first round's type: "race" (Classic) | "list" (Frenzy) | "sandwich"
    rotation: "same",           // later rounds: "same" (host switches by hand) | "alternate" | "random"
    target: { kind: "ongoing", n: 10 }, // or {kind:"points", n} / {kind:"rounds", n}; "ongoing" never ends
    scoring: {
      winPoints: 10,                            // Classic/Sandwich: winning the race, before bonuses
      basePoints: 1,                            // Frenzy: each word found
      frenzyWinBonus: 10,                       // Frenzy: everyone keeps their points; the top scorer also gets this
      lengthBonus: true, lengthThreshold: 4,
      syllableBonus: true, syllableThreshold: 1,
      syllableGrow: true,                       // each extra syllable is worth more: +1, +3, +6, +10…
      letterBonus: true,                        // rare letters you chose: half their Scrabble value, so OXEN beats OPEN
      combo: true,                              // 4 kinds of bonus → ×1.5, 5 or more → ×2
      guest: true, guestChance: 0.5, guestPoints: 3, // a letter dances in mid-round; use it while it dances for a bonus
      secretWords: true, secretPoints: 25,      // one of SECRET_WORDS: a big flat bonus, outside the combo
      // Prototype-only ideas (not in the Swift app yet):
      speedBonus: true, speedWindow: 30,        // Classic/Sandwich: +1 for every whole second left under N
      rareWord: true,                           // +5/+8/+10/+12 the less common the word (see wordRarity)
      rarityBonus: false,                       // +1/+2/+3 when few words fit the letters
      // Echo: reuse end letters from the last few rounds (beyond the ones this round needs).
      // Older rounds pay more: points × how many rounds ago (1, 2, 3).
      echoBonus: true, echoOne: 2, echoBoth: 5, echoRounds: 3,
    },
    countdown: 3,     // you see only your own letter until it ends (others are ?), so nobody gets a head start
    rulesVersion: 2,  // bump to reset saved settings whose defaults changed (see mergeRules)
    botLevel: "medium",         // how well bots play: "easy" | "medium" | "hard"
    difficulty: "mixed",        // "mixed" (a level each round) | "easy" | "medium" | "hard" for the whole game
    graceWindow: 0.25,
    raceTimeLimit: 30,
    turnTime: 15,     // Turn rounds: how long everyone has to find their best word
    listDuration: 60,
    cancelSharedWords: false,
    frenzySwap: true,           // Frenzy: at a random moment the start and end letters trade places
    // Prototype-only idea: letters vanish once answering opens; peeking costs time.
    hideLetters: true,
    peekCost: 3,      // points lost for each peek (your round score can go below zero; your total can't)
    peekDuration: 2,  // how long a peek shows the letters
    revealFor: 1.5,   // with hidden letters: how long they show once the clock starts
  };
}

const PRESETS = {
  classic: () => ({ ...defaultRules(), target: { kind: "points", n: 10 } }),
  sandwich: () => ({ ...defaultRules(), mode: "sandwich", raceTimeLimit: 45 }),
  frenzy: () => ({ ...defaultRules(), mode: "list", target: { kind: "rounds", n: 5 } }),
  mix: () => ({ ...defaultRules(), rotation: "alternate" }),
};

// Scrabble tile values. A letter's bonus is half of (value − 1), rounded up, so common letters
// add nothing: X and J +4, Q and Z +5, K +2, F H V W Y +2, B C M P D G +1.
const LETTER_VALUES = { a: 1, b: 3, c: 3, d: 2, e: 1, f: 4, g: 2, h: 4, i: 1, j: 8, k: 5, l: 1, m: 3, n: 1, o: 1, p: 3, q: 10, r: 1, s: 1, t: 1, u: 1, v: 4, w: 4, x: 8, y: 4, z: 10 };
const letterPoints = c => Math.ceil(((LETTER_VALUES[c] || 1) - 1) / 2);

// The letters a player chose themselves: the word minus the ones the round's pattern requires.
function spareLetters(word, pattern) {
  const w = word.toLowerCase();
  if (!pattern) return w.split("");
  let lo = 0, hi = w.length;
  if (pattern.starts.length) lo = 1;
  if (pattern.ends.length) hi = w.length - 1;
  const spare = w.slice(lo, hi).split("");
  for (const l of pattern.contains) { const i = spare.indexOf(l); if (i >= 0) spare.splice(i, 1); }
  return spare;
}
function letterBonusFor(word, pattern = null) {
  return spareLetters(word, pattern).reduce((n, c) => n + letterPoints(c), 0);
}

// How common a word is, from public-domain lists of everyday English (data/frequency.js): core words
// earn nothing extra and ones few people would think of earn a lot, so a rare word with rare letters
// beats a longer everyday one (QUIXOTIC over UNDERSTANDING). Paid on top, outside the combo, like time left.
// The lists separate everyday words from the rest far better than they rank the rest, so leaving the core
// pays most of the bonus and the rarer groups add a little more.
const RARE_WORD_TIERS = [{ points: 0, label: "everyday" }, { points: 5, label: "less common" }, { points: 8, label: "uncommon" }, { points: 10, label: "rare" }];
const VERY_RARE = { points: 12, label: "very rare" }; // in none of the lists
let wordTiers = null;
function wordRarity(word) {
  if (!wordTiers) {
    wordTiers = new Map();
    for (const groups of [globalThis.window?.BOOKENDS_COMMON, globalThis.window?.BOOKENDS_MORE_TIERS]) {
      (groups || []).forEach((words, t) => { for (const w of words.split("\n")) if (w) wordTiers.set(w, t); });
    }
  }
  if (!wordTiers.size) return { points: 0, label: "" };
  const t = wordTiers.get(word);
  return t == null ? VERY_RARE : RARE_WORD_TIERS[t];
}

function rarityBonusFor(matchCount) {
  if (matchCount < 10) return 3;
  if (matchCount < 50) return 2;
  if (matchCount < 200) return 1;
  return 0;
}

// The echo bonus (in the rules, but players have to notice it): which end letters from recent
// rounds does this word use, not counting the letters this round's pattern already requires?
// (Last round P…E, this round O…N: OPEN uses both P and E, OVEN only E.)
// recent[0] is last round, recent[1] the one before, and so on. Each spare letter counts once,
// oldest rounds first since they pay the most.
function echoMatches(word, pattern, recent = []) {
  const spare = spareLetters(word, pattern);
  const out = [];
  for (let k = recent.length - 1; k >= 0; k--) {
    const prev = recent[k];
    const wanted = [prev.starts[0], prev.ends[0]].filter(Boolean);
    const letters = [];
    for (const l of wanted) { const i = spare.indexOf(l); if (i >= 0) { spare.splice(i, 1); letters.push(l); } }
    if (letters.length) out.push({ ago: k + 1, pattern: prev.toString(), letters, both: wanted.length > 1 && letters.length === wanted.length });
  }
  return out.sort((a, b) => a.ago - b.ago);
}

// Every scoring idea lives here, so this is the one place to experiment.
function scoreWord(word, { scoring, syllables, mode, elapsed, matchCount, pattern = null, recent = [], guest = null }) {
  const echoes = scoring.echoBonus && pattern ? echoMatches(word, pattern, recent.slice(0, scoring.echoRounds)) : [];
  for (const e of echoes) e.points = (e.both ? scoring.echoBoth : scoring.echoOne) * e.ago;
  const syl = syllables.count(word);
  const extraSyl = Math.max(0, syl - scoring.syllableThreshold);
  const s = {
    word,
    syllables: syl,
    base: mode === "list" ? scoring.basePoints : scoring.winPoints,
    lengthBonus: scoring.lengthBonus ? Math.max(0, word.length - scoring.lengthThreshold) : 0,
    syllableBonus: !scoring.syllableBonus ? 0 : scoring.syllableGrow ? extraSyl * (extraSyl + 1) / 2 : extraSyl,
    letterBonus: scoring.letterBonus ? letterBonusFor(word, pattern) : 0,
    speedBonus: scoring.speedBonus && isRace(mode) && elapsed != null ? Math.max(0, Math.floor(scoring.speedWindow - elapsed)) : 0,
    elapsed,
    rarityBonus: scoring.rarityBonus ? rarityBonusFor(matchCount) : 0,
    echoBonus: echoes.reduce((t, e) => t + e.points, 0),
    guestBonus: guest && spareLetters(word, pattern).includes(guest) ? scoring.guestPoints : 0,
    rareWordBonus: 0,
    rareWord: "",
    secretBonus: scoring.secretWords && SECRET_WORDS.includes(word) ? scoring.secretPoints : 0,
    guest,
    echoes,
    cancelled: false,
  };
  if (scoring.rareWord) { const r = wordRarity(word); s.rareWordBonus = r.points; s.rareWord = r.label; }
  // Time left and secret words are paid out on top, outside the combo: time because nearly every win has
  // some (it would make combos trivial), secrets because they're already huge.
  const kinds = [s.lengthBonus, s.syllableBonus, s.letterBonus, s.rarityBonus, s.echoBonus, s.guestBonus].filter(n => n > 0).length;
  s.comboKinds = kinds;
  s.combo = scoring.combo ? (kinds >= 5 ? 2 : kinds === 4 ? 1.5 : 1) : 1;
  return s;
}
function bonusSum(s) {
  return s.base + s.lengthBonus + s.syllableBonus + (s.letterBonus || 0) + s.rarityBonus + (s.echoBonus || 0) + (s.guestBonus || 0);
}
function wordTotal(s) {
  return s.cancelled ? 0 : Math.round(bonusSum(s) * (s.combo || 1)) + (s.speedBonus || 0) + (s.rareWordBonus || 0) + (s.secretBonus || 0);
}

// ---------- Engine (host) ----------
class GameEngine {
  static LIST_SLACK = 0.5;
  static TIE = 0.001;
  static NO_WORDS_PAUSE = 2.5; // seconds the "Doh!" screen shows before everyone picks again

  constructor(lexicon, syllables, rules = defaultRules()) {
    this.lexicon = lexicon;
    this.syllables = syllables;
    this.state = {
      players: [], seatRoles: [], rules, phase: { type: "lobby" }, round: 0, roundMode: rules.mode,
      scores: {}, locked: new Set(), revealed: {}, pattern: null, matchCount: 0,
      listCounts: {}, listPoints: {}, peeks: {}, lastResult: null, champions: [], recentPatterns: [],
    };
    this.picks = {};
    this.raceAnswers = {};
    this.listWords = {};
    this.firstAnswerAt = null;
    this.rolesCustomized = false;
    // A round ends once nobody still playing could change it: in a race, once everyone without an answer
    // has played past the best time; otherwise once everyone has played out the clock. Here every player
    // is on this clock, so that's just the time. Online, each phone reports how far it has got
    // (online.js replaces progressFor), and a phone that has gone quiet is waited for up to maxWait.
    this.maxWait = Infinity;
  }
  // How many seconds into the round this player has played without an answer arriving here.
  progressFor(id, now) { return now - this.state.phase.opensAt; }

  // Lobby
  addPlayer(p) {
    const st = this.state;
    const existing = st.players.find(x => x.id === p.id);
    if (existing) { existing.isConnected = true; existing.name = p.name; return; }
    st.players.push({ isBot: false, isConnected: true, ...p });
    st.scores[p.id] ??= 0;
    if (st.phase.type === "picking" || st.phase.type === "answering") st.locked.add(p.id);
    this.refreshSeatRoles();
  }
  removePlayer(id, now) {
    const st = this.state;
    if (st.phase.type !== "lobby") return this.setConnected(id, false, now);
    st.players = st.players.filter(p => p.id !== id);
    delete st.scores[id];
    this.refreshSeatRoles();
  }
  setConnected(id, connected, now) {
    const p = this.state.players.find(x => x.id === id);
    if (!p) return;
    p.isConnected = connected;
    if (this.state.phase.type === "picking") this.revealIfReady(now);
  }
  moveSeat(from, to) {
    const ps = this.state.players;
    if (from < 0 || from >= ps.length || to < 0 || to >= ps.length) return;
    const [p] = ps.splice(from, 1);
    ps.splice(to, 0, p);
  }
  setRole(role, index) {
    if (index < 0 || index >= this.state.seatRoles.length) return;
    this.state.seatRoles[index] = role;
    this.rolesCustomized = true;
  }
  resetRoles() { this.rolesCustomized = false; this.refreshSeatRoles(); }
  setRules(r) { this.state.rules = r; }
  refreshSeatRoles() {
    const n = this.state.players.length;
    if (this.rolesCustomized && this.state.seatRoles.length !== n) {
      const roles = this.state.seatRoles.slice(0, n);
      while (roles.length < n) roles.splice(Math.max(roles.length - 1, 0), 0, "contains");
      this.state.seatRoles = roles;
    } else if (!this.rolesCustomized) {
      this.state.seatRoles = defaultRoles(n);
    }
  }
  roleOf(id) {
    const i = this.state.players.findIndex(p => p.id === id);
    return i >= 0 ? this.state.seatRoles[i] : null;
  }

  // Rounds
  startGame() {
    const st = this.state;
    for (const p of st.players) st.scores[p.id] = 0;
    st.round = 0; st.lastResult = null; st.champions = []; st.recentPatterns = [];
    st.roundMode = st.rules.mode;
    this.beginRound();
  }
  lockLetter(id, letter, now) {
    if (this.state.phase.type !== "picking") return;
    this.picks[id] = letter;
    this.state.locked.add(id);
    this.revealIfReady(now);
  }
  repick() {
    if (this.state.phase.type !== "noWordFits") return;
    this.state.round--;
    this.beginRound();
  }
  // Host ends a game early (the only way an ongoing game ends); the leaders win it.
  endGame() {
    const st = this.state;
    if (st.phase.type !== "roundOver") return;
    const top = Math.max(...Object.values(st.scores));
    st.champions = st.players.map(p => p.id).filter(id => st.scores[id] === top);
    st.phase = { type: "gameOver" };
  }
  nextRound() {
    const st = this.state;
    if (st.phase.type !== "roundOver") return;
    if (st.rules.rotation === "alternate") st.roundMode = ROUND_MODES[(ROUND_MODES.indexOf(st.roundMode) + 1) % ROUND_MODES.length];
    else if (st.rules.rotation === "random") st.roundMode = ROUND_MODES[Math.floor(Math.random() * ROUND_MODES.length)];
    this.beginRound();
  }
  // Each round is Classic ("race"), Frenzy ("list") or Sandwich (a Classic race plus a middle letter);
  // the host can switch it until the letters are revealed.
  setRoundMode(mode) {
    const t = this.state.phase.type;
    if (t === "lobby" || t === "picking" || t === "noWordFits") this.state.roundMode = mode;
  }
  backToLobby() {
    Object.assign(this.state, { phase: { type: "lobby" }, locked: new Set(), revealed: {}, pattern: null });
  }

  // Showing the letters again costs time, so peeking is a tradeoff.
  peek(id, now) {
    const st = this.state;
    if (st.phase.type !== "answering" || !st.rules.hideLetters || now < st.phase.opensAt) return false;
    st.peeks[id] = (st.peeks[id] || 0) + 1;
    if (st.roundMode === "list") for (const e of this.frenzyEntries()) st.listPoints[e.player] = e.points;
    if (st.roundMode === "turn" && this.raceAnswers[id]) st.listPoints[id] = wordTotal(this.raceAnswers[id].word) - this.peekCostFor(id);
    return true;
  }
  // The dancing guest letter, if one is on stage at this moment.
  guestAt(now) {
    const g = this.state.phase.guest;
    return g && now >= g.from && now <= g.to ? g.letter : null;
  }
  // Points a player has lost to peeking this round.
  peekCostFor(id) { return (this.state.peeks[id] || 0) * this.state.rules.peekCost; }
  // A player's own deadline (the same for everyone).
  closesAtFor(id) { return this.state.phase.closesAt; }

  // `via` is how the word came in ("type" or "speak"); it's kept for the collected round data.
  submit(id, raw, elapsed, now, via = "type") {
    const st = this.state;
    if (st.phase.type !== "answering" || !st.pattern) return { kind: "closed" };
    const { opensAt, closesAt } = st.phase;
    const slack = isRace(st.roundMode) ? 0 : GameEngine.LIST_SLACK;
    if (now < opensAt || now > this.closesAtFor(id) + slack) return { kind: "closed" };
    const word = cleanWord(raw);
    if (!this.lexicon.contains(word)) return { kind: "notAWord" };
    if (!st.pattern.matches(word)) return { kind: "doesNotFit" };
    if (!meetsTwist(word, st.twist, this.syllables)) return { kind: "twist" };
    const scored = scoreWord(word, {
      scoring: st.rules.scoring, syllables: this.syllables, mode: st.roundMode,
      elapsed: Math.max(0, elapsed), matchCount: st.matchCount,
      pattern: st.pattern, recent: st.recentPatterns, guest: this.guestAt(now),
    });
    scored.via = via === "speak" ? "speak" : "type";
    if (isRace(st.roundMode)) {
      if (this.raceAnswers[id]) return { kind: "alreadyUsed" };
      const total = Math.max(0, elapsed);
      this.raceAnswers[id] = { word: scored, elapsed: total };
    } else if (st.roundMode === "turn") {
      // Keep trying until the clock runs out; only your best word counts.
      const list = (this.listWords[id] ||= []);
      if (list.some(w => w.word === word)) return { kind: "alreadyUsed" };
      list.push(scored);
      const prev = this.raceAnswers[id];
      const better = !prev || wordTotal(scored) > wordTotal(prev.word);
      if (better) this.raceAnswers[id] = { word: scored, elapsed: Math.max(0, elapsed) };
      st.listCounts[id] = list.length;
      st.listPoints[id] = wordTotal(this.raceAnswers[id].word) - this.peekCostFor(id); // live, like Frenzy
      return { kind: "accepted", scored, better };
    } else {
      const list = (this.listWords[id] ||= []);
      if (list.some(w => w.word === word)) return { kind: "alreadyUsed" };
      list.push(scored);
      st.listCounts[id] = list.length;
      for (const e of this.frenzyEntries()) st.listPoints[e.player] = e.points; // live scores everyone can see
    }
    return { kind: "accepted", scored };
  }

  // Returns true if state changed.
  tick(now) {
    const st = this.state;
    if (st.phase.type === "noWordFits" && now >= (st.phase.until ?? Infinity)) { this.repick(); return true; }
    if (st.phase.type !== "answering") return false;
    const due = this.botMoves.filter(m => now >= m.at);
    if (due.length) {
      this.botMoves = this.botMoves.filter(m => now < m.at);
      for (const m of due) this.submit(m.id, m.word, m.at - st.phase.opensAt, m.at);
      return true;
    }
    if (st.phase.swapAt != null && !st.swapped && now >= st.phase.swapAt) {
      st.swapped = true;
      st.pattern = st.pattern.swapped();
      st.matchCount = this.lexicon.matches(st.pattern).length;
      return true;
    }
    const { opensAt, closesAt } = st.phase, dur = closesAt - opensAt;
    const humans = st.players.filter(p => !p.isBot && p.isConnected);
    let target = dur + GameEngine.LIST_SLACK, cap = closesAt + GameEngine.LIST_SLACK + this.maxWait;
    if (isRace(st.roundMode)) {
      const answers = Object.values(this.raceAnswers);
      // Everyone's in: nothing left to wait for.
      if (humans.length && humans.every(p => this.raceAnswers[p.id])) { this.finishRound(); return true; }
      target = dur; cap = closesAt + this.maxWait;
      if (answers.length) {
        this.firstAnswerAt ??= now;
        target = Math.min(dur, Math.min(...answers.map(a => a.elapsed)) + st.rules.graceWindow);
        cap = Math.min(cap, this.firstAnswerAt + this.maxWait);
      }
    }
    const waiting = humans.length
      ? humans.some(p => !(isRace(st.roundMode) && this.raceAnswers[p.id]) && this.progressFor(p.id, now) < target)
      : now - opensAt < target; // only bots: just the clock
    if (!waiting || now >= cap) { this.finishRound(); return true; }
    return false;
  }

  beginRound() {
    const st = this.state;
    st.round++;
    st.phase = { type: "picking" };
    st.locked = new Set(st.players.filter(p => p.isBot).map(p => p.id));
    st.revealed = {}; st.pattern = null; st.listCounts = {}; st.listPoints = {}; st.peeks = {}; st.sandwich = null; st.swapped = false; st.matchCount = 0; st.twist = null; st.level = null;
    this.picks = {}; this.raceAnswers = {}; this.listWords = {}; this.firstAnswerAt = null; this.botMoves = [];
  }

  // Each bot's words and when it plays them (times as fractions of the answering clock).
  planBots(opens, dur) {
    const st = this.state, skill = BOT_SKILL[st.rules.botLevel] || BOT_SKILL.medium;
    const bots = st.players.filter(p => p.isBot);
    if (!bots.length || st.roundMode === "list") return;
    const ranked = this.fitting().map(word => ({ word, total: wordTotal(scoreWord(word, {
      scoring: st.rules.scoring, syllables: this.syllables, mode: st.roundMode, elapsed: null,
      matchCount: st.matchCount, pattern: st.pattern, recent: st.recentPatterns,
    })) })).sort((a, b) => a.total - b.total);
    if (!ranked.length) return;
    const at = r => ranked[Math.min(ranked.length - 1, Math.floor(r * ranked.length))].word;
    for (const b of bots) {
      const rank = between(skill.rank);
      if (st.roundMode === "turn") {
        const end = between(skill.turn);
        this.botMoves.push({ id: b.id, at: opens + dur * end * between([0.3, 0.6]), word: at(rank * between([0.3, 0.7])) });
        this.botMoves.push({ id: b.id, at: opens + dur * end, word: at(rank) });
      } else {
        this.botMoves.push({ id: b.id, at: opens + Math.min(dur, st.rules.raceTimeLimit) * between(skill.race), word: at(rank) });
      }
    }
  }

  revealIfReady(now) {
    const st = this.state;
    const humans = st.players.filter(p => !p.isBot && p.isConnected);
    if (!humans.length || !humans.every(p => this.picks[p.id])) return;

    const seats = st.players.map((p, i) => ({ p, i })).filter(({ p }) => this.picks[p.id] || p.isBot);
    const bots = seats.filter(s => s.p.isBot).map(s => s.p.id);
    // Sandwich rounds need a middle letter; if no seat supplies one, a bot does.
    const needsFiller = st.roundMode === "sandwich" && !seats.some(({ i }) => st.seatRoles[i] === "contains");
    let filler = null;
    const pattern = () => new WordPattern([
      ...seats.map(({ p, i }) => ({ role: st.seatRoles[i], letter: this.picks[p.id] })),
      ...(filler ? [{ role: "contains", letter: filler }] : []),
    ]);
    if (bots.length || needsFiller) {
      for (let t = 0; t < 200; t++) {
        for (const b of bots) this.picks[b] = ALPHABET[Math.floor(Math.random() * 26)];
        if (needsFiller) filler = ALPHABET[Math.floor(Math.random() * 26)];
        if (this.lexicon.hasMatch(pattern())) break;
      }
    }
    st.sandwich = filler;
    const p = pattern();
    st.pattern = p;
    st.revealed = { ...this.picks };
    st.matchCount = this.lexicon.matches(p).length;
    st.twist = null; st.level = null;
    if (st.matchCount > 0 && isRace(st.roundMode)) {
      const all = this.lexicon.matches(p), wanted = rollLevel(st.rules.difficulty);
      const levels = ["hard", "medium"].slice(["hard", "medium", "easy"].indexOf(wanted)); // wanted, then easier
      for (const level of levels) {
        st.twist = shuffle(DIFFICULTY[level].twists.slice()).find(t => {
          const n = all.filter(w => meetsTwist(w, t, this.syllables)).length;
          return n >= TWIST_MIN_WORDS && n < all.length;
        }) || null;
        if (st.twist) { st.level = level; break; }
      }
      if (st.twist) st.matchCount = this.fitting(p).length;
    }
    if (st.matchCount > 0) {
      const opens = now + st.rules.countdown;
      const dur = { list: st.rules.listDuration, turn: st.rules.turnTime }[st.roundMode] ?? st.rules.raceTimeLimit;
      st.phase = { type: "answering", opensAt: opens, closesAt: opens + dur };
      // Sometimes a guest letter dances in partway through. Pick one that some fitting word can use.
      if (st.rules.scoring.guest && Math.random() < st.rules.scoring.guestChance) {
        const race = st.roundMode !== "list";
        const from = opens + (race ? 1.5 + Math.random() * Math.min(6, dur * 0.3) : dur * (0.1 + Math.random() * 0.6));
        const stay = race ? 6 : 9;
        const letter = shuffle(GUEST_LETTERS).find(l => this.lexicon.hasMatch(new WordPattern([...p.constraints, { role: "contains", letter: l }])));
        if (letter) st.phase.guest = { letter, from, to: Math.min(from + stay, opens + dur) };
      }
      this.planBots(opens, dur);
      // Frenzy: swap at a random moment, as long as some word still fits the swapped letters.
      if (st.roundMode === "list" && st.rules.frenzySwap && this.lexicon.hasMatch(p.swapped())) {
        st.phase.swapAt = opens + dur * (0.15 + Math.random() * 0.7);
      }
    } else {
      st.phase = { type: "noWordFits", until: now + GameEngine.NO_WORDS_PAUSE }; // then straight back to picking
    }
  }

  // What one round says about how people play, kept to build bots from real players later (stats.js
  // stores it). It's per scenario (letters, round type, twist) and keeps raw words and times, so scores
  // can be worked out again under different rules. `best` is the top score any fitting word could get
  // without the time bonus; dividing by it lets rounds with easy and hard letters be compared.
  roundRecord(entries, winners) {
    const st = this.state, r = st.rules;
    const ctx = { scoring: r.scoring, syllables: this.syllables, mode: st.roundMode, elapsed: null, matchCount: st.matchCount, pattern: st.pattern, recent: st.recentPatterns };
    let best = 0, bestWord = null;
    for (const w of this.fitting()) { const n = wordTotal(scoreWord(w, ctx)); if (n > best) { best = n; bestWord = w; } }
    const pattern = st.swapped ? st.pattern.swapped() : st.pattern; // the letters as dealt, before any SWAP
    const letters = pattern.constraints.map(c => `${c.role === "startsWith" ? "^" : c.role === "endsWith" ? "$" : "+"}${c.letter}`).sort().join("");
    const twist = st.twist ? `${st.twist.kind}>=${st.twist.n}` : "";
    const words = id => (isRace(st.roundMode) ? [this.raceAnswers[id]?.word].filter(Boolean) : this.listWords[id] || []);
    return {
      v: 1, id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36), at: new Date().toISOString(), round: st.round,
      mode: st.roundMode, letters, pattern: pattern.toString(), twist, level: st.level || "", sandwich: st.sandwich || "", swapped: !!st.swapped,
      key: [st.roundMode, letters, twist].join("|"),
      fits: st.matchCount, best, bestWord, limit: st.phase.closesAt - st.phase.opensAt, hideLetters: !!r.hideLetters,
      players: st.players.filter(p => !p.isBot).length, bots: st.players.filter(p => p.isBot).length, botLevel: r.botLevel,
      answers: st.players.map(p => {
        const e = entries.find(x => x.player === p.id) || {};
        return {
          p: p.id, bot: !!p.isBot, won: winners.includes(p.id), points: e.points ?? 0, peeks: st.peeks[p.id] || 0,
          words: words(p.id).map(w => ({ w: w.word, t: w.elapsed == null ? null : Math.round(w.elapsed * 100) / 100, pts: wordTotal(w) - (w.speedBonus || 0), via: w.via || "type" })),
        };
      }),
    };
  }

  // Every word that fits the letters and this round's twist.
  fitting(p = this.state.pattern) { return this.lexicon.matches(p).filter(w => meetsTwist(w, this.state.twist, this.syllables)); }

  // Frenzy points per player as things stand, with shared words cancelled when that rule is on.
  frenzyEntries() {
    const st = this.state, finders = {};
    for (const ws of Object.values(this.listWords)) for (const w of ws) finders[w.word] = (finders[w.word] || 0) + 1;
    return st.players.map(p => {
      const ws = (this.listWords[p.id] || []).map(w => ({ ...w }));
      if (st.rules.cancelSharedWords) for (const w of ws) if (finders[w.word] > 1) w.cancelled = true;
      const peekCost = this.peekCostFor(p.id);
      return { player: p.id, words: ws, elapsed: null, points: ws.reduce((t, w) => t + wordTotal(w), 0) - peekCost, peeks: st.peeks[p.id] || 0, peekCost };
    });
  }

  finishRound() {
    const st = this.state;
    const entries = [];
    let winners = [];
    if (st.roundMode === "turn") {
      // The highest-scoring word wins (ties share it); the quicker of equal scores doesn't matter.
      const totals = Object.values(this.raceAnswers).map(a => wordTotal(a.word));
      const best = totals.length ? Math.max(...totals) : null;
      for (const p of st.players) {
        const a = this.raceAnswers[p.id], peekCost = this.peekCostFor(p.id);
        const won = a && wordTotal(a.word) === best;
        if (won) winners.push(p.id);
        entries.push({ player: p.id, words: a ? [a.word] : [], elapsed: null, tries: (this.listWords[p.id] || []).length, points: (won ? wordTotal(a.word) : 0) - peekCost, peeks: st.peeks[p.id] || 0, peekCost });
      }
    } else if (isRace(st.roundMode)) {
      const times = Object.values(this.raceAnswers).map(a => a.elapsed);
      const best = times.length ? Math.min(...times) : null;
      for (const p of st.players) {
        const a = this.raceAnswers[p.id];
        const peekCost = this.peekCostFor(p.id);
        if (!a) { entries.push({ player: p.id, words: [], elapsed: null, points: -peekCost, peeks: st.peeks[p.id] || 0, peekCost }); continue; }
        const won = best != null && a.elapsed - best <= GameEngine.TIE;
        if (won) winners.push(p.id);
        entries.push({ player: p.id, words: [a.word], elapsed: a.elapsed, points: (won ? wordTotal(a.word) : 0) - peekCost, peeks: st.peeks[p.id] || 0, peekCost });
      }
    } else {
      entries.push(...this.frenzyEntries());
      const top = Math.max(0, ...entries.map(e => e.points));
      if (top > 0) winners = entries.filter(e => e.points === top).map(e => e.player);
      // Everyone keeps what they found; the winner (or everyone tied for the top) gets a bonus on top.
      for (const e of entries) if (winners.includes(e.player)) { e.winBonus = st.rules.scoring.frenzyWinBonus; e.points += e.winBonus; }
    }
    st.recentPatterns = [st.pattern, ...st.recentPatterns].slice(0, 5);
    const before = { ...st.scores };
    for (const e of entries) st.scores[e.player] = Math.max(0, (st.scores[e.player] || 0) + e.points);
    st.lastResult = {
      seq: (this.resultSeq = (this.resultSeq || 0) + 1), // tells one result from the next, even after a copy
      round: st.round, mode: st.roundMode, pattern: st.pattern, entries, winners, before,
      examples: shuffle(this.fitting().filter(w => !entries.some(e => e.words.some(x => x.word === w)))).slice(0, 6), matchCount: st.matchCount, twist: st.twist,
    };
    this.lastRecord = this.roundRecord(entries, winners);
    const t = st.rules.target;
    const over = t.kind === "ongoing" ? false : t.kind === "points" ? Object.values(st.scores).some(s => s >= t.n) : st.round >= t.n;
    if (over) {
      const top = Math.max(...Object.values(st.scores));
      st.champions = st.players.map(p => p.id).filter(id => st.scores[id] === top);
      st.phase = { type: "gameOver" };
    } else {
      st.phase = { type: "roundOver" };
    }
  }
}

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
