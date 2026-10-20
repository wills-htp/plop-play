// Backdrops the player can choose (Feel → Scene). Each is a 1600×900 SVG anchored to the
// bottom of the window. Colors use light-dark() so every scene has a daytime and an evening look.
"use strict";

const ld = (light, dark) => `light-dark(${light}, ${dark})`;
const fill = (light, dark = light) => `style="fill:${ld(light, dark)}"`;

// Seeded random so a scene looks the same every time it's drawn.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sun(x, y) {
  return `<g><circle cx="${x}" cy="${y}" r="120" ${fill("#fff8d6", "#f3efd6")} opacity=".45"/><circle cx="${x}" cy="${y}" r="72" ${fill("#ffd23f", "#f3efd6")}/></g>`;
}

function clouds(spots) {
  const one = `<ellipse cx="0" cy="0" rx="70" ry="26"/><ellipse cx="45" cy="-18" rx="45" ry="30"/><ellipse cx="-40" cy="-10" rx="38" ry="22"/>`;
  return `<g class="clouds" ${fill("#ffffff", "rgba(255,255,255,.07)")}>${spots.map(([x, y, s]) => `<g transform="translate(${x} ${y}) scale(${s})">${one}</g>`).join("")}</g>`;
}

function emoji(items, size = 44) {
  return `<g font-size="${size}">${items.map(([e, x, y, s]) => `<text x="${x}" y="${y}"${s ? ` font-size="${s}"` : ""}>${e}</text>`).join("")}</g>`;
}

function skyline(rand, x0, x1, base, hmin, hmax, wmin, wmax, color, windows) {
  let out = "", x = x0;
  while (x < x1) {
    const w = wmin + Math.floor(rand() * (wmax - wmin)), h = hmin + Math.floor(rand() * (hmax - hmin));
    out += `<rect x="${x}" y="${base - h}" width="${w}" height="${h + 4}" ${color}/>`;
    if (windows) {
      for (let wy = base - h + 14; wy < base - 10; wy += 18)
        for (let wx = x + 8; wx < x + w - 10; wx += 14)
          if (rand() < 0.55) out += `<rect x="${wx}" y="${wy}" width="5" height="8" ${fill("rgba(255,255,255,.45)", "#ffd66b")}/>`;
    }
    x += w + Math.floor(rand() * 6);
  }
  return out;
}

function park() {
  const r = seeded(7), city = fill("#9fb8d3", "#16233f");
  let trees = "";
  for (let x = -20; x < 1660; x += 34) {
    const dark = r() < 0.5;
    trees += `<circle cx="${x}" cy="${585 + Math.floor(r() * 16 - 8)}" r="${26 + Math.floor(r() * 18)}" ${dark ? fill("#3f8a3f", "#183d2a") : fill("#4f9d4a", "#1f4a33")}/>`;
  }
  return `
    <defs><pattern id="gingham" width="28" height="28" patternUnits="userSpaceOnUse">
      <rect width="28" height="28" fill="#fffaf2"/><rect width="14" height="28" fill="#e2445c" opacity=".45"/><rect width="28" height="14" fill="#e2445c" opacity=".45"/>
    </pattern></defs>
    ${sun(1010, 230)}
    ${clouds([[180, 140, 1], [980, 95, 0.8], [560, 190, 0.6]])}
    ${skyline(r, -20, 1640, 560, 110, 230, 40, 80, fill("#c3d6ea", "#1d2c4c"), false)}
    ${skyline(r, -20, 560, 575, 90, 200, 45, 85, city, true)}
    <g ${city}>
      <rect x="640" y="250" width="90" height="330"/><rect x="660" y="215" width="50" height="40"/><rect x="676" y="185" width="18" height="35"/><rect x="683" y="140" width="4" height="50"/>
      <rect x="830" y="300" width="80" height="280"/><path d="M830 300 L870 215 L910 300 Z"/><rect x="868" y="170" width="4" height="50"/>
    </g>
    ${skyline(r, 980, 1640, 575, 90, 210, 45, 85, city, true)}
    ${trees}
    <path d="M0 600 Q 400 560 800 600 T 1600 590 V 900 H 0 Z" ${fill("#8fd17a", "#23523a")}/>
    <path d="M0 680 Q 500 630 1000 690 T 1600 670 V 900 H 0 Z" ${fill("#6dbf5c", "#1d4631")}/>
    <g transform="translate(90 760) skewX(-25)"><rect width="330" height="120" rx="6" fill="url(#gingham)"/></g>
    ${emoji([["🧺", 70, 790], ["🍉", 140, 820], ["🍋", 205, 790], ["🍓", 250, 835], ["🍇", 300, 800], ["🍷", 340, 840], ["🍎", 110, 860], ["🥤", 190, 870]])}`;
}

function beach() {
  let waves = "";
  for (let y = 500; y < 640; y += 28) {
    for (let x = (y / 28 % 2) * 60; x < 1600; x += 180) waves += `<path d="M${x} ${y} q 20 -10 40 0 t 40 0" fill="none" stroke-width="3" stroke-linecap="round" style="stroke:${ld("rgba(255,255,255,.6)", "rgba(255,255,255,.15)")}"/>`;
  }
  // Umbrella canopy: alternating stripes.
  let canopy = "";
  const cx = 300, cy = 640, R = 170, n = 8;
  for (let i = 0; i < n; i++) {
    const a0 = Math.PI + (i / n) * Math.PI, a1 = Math.PI + ((i + 1) / n) * Math.PI;
    canopy += `<path d="M${cx} ${cy} L${cx + R * Math.cos(a0)} ${cy + R * 0.55 * Math.sin(a0)} A ${R} ${R * 0.55} 0 0 1 ${cx + R * Math.cos(a1)} ${cy + R * 0.55 * Math.sin(a1)} Z" fill="${i % 2 ? "#ffffff" : "#e2445c"}"/>`;
  }
  return `
    ${sun(1000, 240)}
    ${clouds([[200, 150, 1], [760, 110, 0.7]])}
    <rect x="0" y="470" width="1600" height="200" ${fill("#3fb4d8", "#173b5c")}/>
    <rect x="0" y="470" width="1600" height="14" ${fill("#2a9cc4", "#122f4b")}/>
    ${waves}
    <path d="M1180 470 l 26 -60 l 0 60 z M1206 410 l 22 60 h -22 z" ${fill("#ffffff", "#c9d3e6")}/>
    <path d="M0 650 Q 400 610 900 640 T 1600 630 V 900 H 0 Z" ${fill("#f4dca0", "#5c5238")}/>
    <path d="M0 650 Q 400 610 900 640 T 1600 630" fill="none" stroke-width="10" style="stroke:${ld("#e6c98a", "#4b442f")}"/>
    <path d="M1420 860 C 1400 760 1440 640 1500 560" fill="none" stroke-width="26" stroke-linecap="round" style="stroke:${ld("#9b6b43", "#4a3524")}"/>
    <g transform="translate(1500 560)" ${fill("#3f9d4a", "#1f4a33")}>
      ${[-160, -120, -70, -20, 30, 70].map(a => `<ellipse cx="80" cy="0" rx="95" ry="18" transform="rotate(${a})"/>`).join("")}
    </g>
    <line x1="${cx}" y1="${cy}" x2="${cx + 20}" y2="860" stroke-width="8" style="stroke:${ld("#8a8f99", "#555b66")}"/>
    ${canopy}
    <g transform="translate(420 760) skewX(-20)"><rect width="260" height="90" rx="8" fill="#2f8ef0"/><rect y="30" width="260" height="30" fill="#ffc531"/></g>
    ${emoji([["🏐", 120, 800], ["🍹", 470, 790], ["🕶️", 560, 830], ["🐚", 760, 860], ["🦀", 900, 840], ["🍉", 220, 870], ["🧴", 640, 870]])}`;
}

function pub() {
  // Indoors: a wood-panelled wall, shelves of bottles, a mirror, the bar with taps, and pints.
  let bottles = "";
  const r = seeded(11), colors = ["#2f7a3e", "#7a3b2e", "#c9a227", "#3b5ea8", "#8b5cf6", "#c8d2dc"];
  for (const shelf of [300, 420]) {
    for (let x = 90; x < 1540; x += 26 + Math.floor(r() * 10)) {
      if (x > 560 && x < 1040 && shelf === 420) continue; // mirror gap
      const h = 50 + Math.floor(r() * 40), c = colors[Math.floor(r() * colors.length)];
      bottles += `<rect x="${x}" y="${shelf - h}" width="16" height="${h}" rx="5" fill="${c}" opacity=".9"/><rect x="${x + 5}" y="${shelf - h - 16}" width="6" height="18" fill="${c}"/>`;
    }
  }
  let lights = "";
  for (let x = 120; x < 1600; x += 260) {
    lights += `<line x1="${x}" y1="0" x2="${x}" y2="90" stroke-width="3" style="stroke:${ld("#3a2a1e", "#120c08")}"/>
      <circle cx="${x}" cy="110" r="70" fill="#ffd98a" opacity=".18"/><path d="M${x - 34} 110 q 34 -50 68 0 z" ${fill("#2a4a3a", "#1a2e24")}/><circle cx="${x}" cy="112" r="10" fill="#ffe7a8"/>`;
  }
  let taps = "";
  for (let i = 0; i < 6; i++) {
    const x = 520 + i * 90;
    taps += `<rect x="${x}" y="555" width="14" height="55" rx="4" ${fill("#c9ccd1", "#8f949c")}/><rect x="${x - 6}" y="520" width="26" height="42" rx="8" fill="${colors[i % colors.length]}"/>`;
  }
  return `
    <rect width="1600" height="900" ${fill("#7a4b2e", "#3a2416")}/>
    ${Array.from({ length: 22 }, (_, i) => `<rect x="${i * 76}" y="0" width="3" height="640" ${fill("rgba(0,0,0,.12)", "rgba(0,0,0,.25)")}/>`).join("")}
    ${lights}
    <rect x="560" y="320" width="480" height="210" rx="10" ${fill("#a9c6c9", "#2c4044")} opacity=".7"/>
    <rect x="560" y="320" width="480" height="210" rx="10" fill="none" stroke-width="10" style="stroke:${ld("#c9a227", "#8a6f1c")}"/>
    <text x="800" y="445" text-anchor="middle" font-size="64" font-family="Fredoka, sans-serif" font-weight="700" style="fill:${ld("#fff7e0", "#ffe7a8")}" opacity=".85">PINTS</text>
    <rect x="60" y="300" width="1480" height="10" ${fill("#5a3520", "#24160c")}/>
    <rect x="60" y="420" width="1480" height="10" ${fill("#5a3520", "#24160c")}/>
    ${bottles}
    <rect x="1180" y="440" width="260" height="140" rx="8" ${fill("#2d3a33", "#1a221e")}/>
    <text x="1310" y="490" text-anchor="middle" font-size="26" font-family="Fredoka, sans-serif" fill="#f6f2e4">TONIGHT</text>
    <text x="1310" y="530" text-anchor="middle" font-size="22" font-family="Fredoka, sans-serif" fill="#ffc531">word games 🍺</text>
    ${taps}
    <rect x="0" y="610" width="1600" height="40" rx="6" ${fill("#5a3520", "#2a190e")}/>
    <rect x="0" y="650" width="1600" height="250" ${fill("#6b3f24", "#331f12")}/>
    ${Array.from({ length: 12 }, (_, i) => `<rect x="${i * 140 + 20}" y="680" width="110" height="190" rx="8" ${fill("rgba(0,0,0,.1)", "rgba(0,0,0,.2)")}/>`).join("")}
    ${emoji([["🍺", 90, 600, 64], ["🍺", 180, 600, 64], ["🍻", 300, 600, 64], ["🥨", 1100, 600, 52], ["🍺", 1460, 600, 64], ["🥜", 1380, 600, 44]])}`;
}

function recess() {
  let hop = "";
  const squares = [[0, 0], [0, 1], [-0.5, 2], [0.5, 2], [0, 3], [-0.5, 4], [0.5, 4], [0, 5]];
  squares.forEach(([dx, row], i) => {
    const x = 760 + dx * 70 - row * 30, y = 860 - row * 40;
    hop += `<g transform="translate(${x} ${y}) skewX(-35)"><rect width="66" height="38" fill="none" stroke-width="3" style="stroke:${ld("#ffffff", "#c9d3e6")}"/></g>
      <text x="${x + 22 - 6}" y="${y + 28}" font-size="22" font-family="Fredoka, sans-serif" style="fill:${ld("#ffffff", "#c9d3e6")}">${i + 1}</text>`;
  });
  let windows = "";
  for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++)
    windows += `<rect x="${110 + col * 80}" y="${330 + row * 80}" width="50" height="50" rx="4" ${fill("#bfe6ff", "#ffd66b")}/>`;
  return `
    ${sun(1000, 230)}
    ${clouds([[700, 130, 0.8], [1250, 170, 0.6]])}
    <rect x="80" y="280" width="440" height="330" ${fill("#c4584a", "#5a2a24")}/>
    <path d="M60 290 L300 180 L540 290 Z" ${fill("#8e3b32", "#3d1c18")}/>
    <circle cx="300" cy="245" r="28" fill="#fffaf0"/><path d="M300 245 v -18 M300 245 h 12" stroke="#233047" stroke-width="4" stroke-linecap="round"/>
    ${windows}
    <rect x="270" y="540" width="60" height="70" ${fill("#2f8ef0", "#1d3b66")}/>
    <line x1="600" y1="200" x2="600" y2="610" stroke-width="6" style="stroke:${ld("#9aa3ad", "#555b66")}"/>
    <path d="M603 205 h 70 v 44 h -70 z" fill="#2f8ef0"/>
    <path d="M0 600 Q 500 570 1000 600 T 1600 590 V 900 H 0 Z" ${fill("#7cc96b", "#23523a")}/>
    <path d="M300 900 L 520 700 H 1240 L 1400 900 Z" ${fill("#5f6b7a", "#2c3442")}/>
    ${hop}
    <g stroke-width="12" stroke-linecap="round" style="stroke:${ld("#2f8ef0", "#1d3b66")}">
      <line x1="1250" y1="470" x2="1200" y2="700"/><line x1="1250" y1="470" x2="1300" y2="700"/>
      <line x1="1520" y1="470" x2="1470" y2="700"/><line x1="1520" y1="470" x2="1570" y2="700"/>
      <line x1="1240" y1="470" x2="1530" y2="470"/>
    </g>
    <g stroke-width="3" style="stroke:${ld("#5f6b7a", "#8f949c")}"><line x1="1320" y1="474" x2="1320" y2="610"/><line x1="1370" y1="474" x2="1370" y2="610"/><line x1="1420" y1="474" x2="1420" y2="600"/><line x1="1470" y1="474" x2="1470" y2="600"/></g>
    <rect x="1310" y="606" width="70" height="12" rx="4" fill="#e2445c"/><rect x="1410" y="596" width="70" height="12" rx="4" fill="#ffc531"/>
    <path d="M1080 700 L 1160 520 L 1180 520 L 1100 700 Z" ${fill("#9b5de5", "#4b2d73")}/>
    ${emoji([["🪁", 820, 160, 64], ["⚽", 1120, 820], ["🎒", 150, 700], ["🧃", 230, 720], ["🍎", 200, 860], ["🏀", 1500, 860]])}`;
}

const SCENES = {
  park:   { label: "🌳 At the park",  draw: park,   accent: ["#2f9a3e", "#44b552"], accentInk: "#ffffff", sky: [["#8fd0ff", "#dff3ff"], ["#0b1428", "#2a3a66"]] },
  beach:  { label: "🏖️ At the beach", draw: beach,  accent: ["#0e8fa0", "#2bb3c4"], accentInk: "#ffffff", sky: [["#7fd3ff", "#e6f7ff"], ["#0c1630", "#3a3f78"]] },
  pub:    { label: "🍺 At the pub",   draw: pub,    accent: ["#2f6b4f", "#4f9a74"], accentInk: "#ffffff", sky: [["#7a4b2e", "#7a4b2e"], ["#3a2416", "#3a2416"]] },
  recess: { label: "🛝 At recess",    draw: recess, accent: ["#f2b705", "#f5c623"], accentInk: "#233047", sky: [["#8fd0ff", "#e3f5ff"], ["#0b1428", "#2a3a66"]] },
};

function applyScene(name) {
  const scene = SCENES[name] || SCENES.park, root = document.documentElement.style;
  root.setProperty("--accent", ld(...scene.accent));
  root.setProperty("--accent-ink", scene.accentInk);
  root.setProperty("--sky-top", ld(scene.sky[0][0], scene.sky[1][0]));
  root.setProperty("--sky-low", ld(scene.sky[0][1], scene.sky[1][1]));
  document.querySelector(".scene").innerHTML =
    `<svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMax slice">${scene.draw()}</svg>`;
}
