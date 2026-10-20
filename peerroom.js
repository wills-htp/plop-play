// Rooms for the public web build (Vercel), where claude.ai's `room` isn't available. Same calls as that
// room (join, emit, on, presence, peers, onPeers), built on PeerJS: WebRTC between browsers, introduced by
// PeerJS's free signalling server, with no accounts.
//
// Each room has a hub: the first browser to claim the PeerJS id for the room's name. Everyone else connects
// to the hub, which relays messages and keeps the list of who's here. If the hub leaves, the others race to
// claim the id; the winner becomes the new hub and the rest reconnect to it. (The hub only relays; who runs
// the game is decided separately, in online.js.)
"use strict";

function peerLobby() {
  return {
    join: name => joinPeerRoom(name),
    // No lobby across rooms here, so nothing to count: the 100-room cap only applies on claude.ai.
    onPeers: h => { setTimeout(() => h({ peers: [], joined: [], left: [], updated: [] }), 0); return () => {}; },
    peers: () => [],
    presence: async () => {},
  };
}

function joinPeerRoom(name) {
  const hubId = "plop-game-v1-" + name;
  const label = "p" + Math.random().toString(36).slice(2, 10); // this tab, for the whole visit
  let presence = {};
  const handlers = {}, peerHandlers = [];
  let list = Object.freeze([]);        // everyone here, as the hub last said
  let peer = null, hubConn = null;     // as a spoke: our connection to the hub
  let members = null;                  // as the hub: label -> { presence, conn }
  let closed = false;

  // ---- delivering to this page ----
  const deliver = (topic, data, from) => {
    for (const h of handlers[topic] || []) { try { h({ topic, data, peer: from, isMe: false, sameTab: false }); } catch (e) { console.error(e); } }
  };
  const setList = entries => {
    const next = Object.freeze(entries.map(([peerLabel, pr]) => Object.freeze({ peer: peerLabel, presence: Object.freeze(pr || {}), isMe: peerLabel === label, sameTab: peerLabel === label, kind: "viewer", guest: false })));
    const before = new Map(list.map(p => [p.peer, p])), after = new Map(next.map(p => [p.peer, p]));
    const joined = next.filter(p => !before.has(p.peer));
    const left = list.filter(p => !after.has(p.peer));
    const updated = next.filter(p => before.has(p.peer) && JSON.stringify(before.get(p.peer).presence) !== JSON.stringify(p.presence));
    list = next;
    if (joined.length || left.length || updated.length) for (const h of peerHandlers) { try { h({ peers: list, joined, left, updated }); } catch (e) { console.error(e); } }
  };

  // ---- as the hub ----
  const hubBroadcast = msg => { for (const m of members.values()) if (m.conn?.open) m.conn.send(msg); };
  const hubPeers = () => {
    const entries = [...members].map(([l, m]) => [l, m.presence]);
    hubBroadcast({ k: "peers", list: entries });
    setList(entries);
  };
  const becomeHub = p => {
    peer = p; hubConn = null;
    members = new Map([[label, { presence, conn: null }]]);
    p.on("connection", conn => {
      let who = null;
      conn.on("data", msg => {
        if (!msg || typeof msg !== "object") return;
        if (msg.k === "hello" || msg.k === "presence") {
          who = String(msg.from);
          members.set(who, { presence: msg.presence || {}, conn });
          hubPeers();
        } else if (msg.k === "emit" && who) {
          deliver(msg.topic, msg.data, who);
          for (const [l, m] of members) if (l !== who && m.conn?.open) m.conn.send({ k: "emit", from: who, topic: msg.topic, data: msg.data });
        }
      });
      const gone = () => { if (who && members.get(who)?.conn === conn) { members.delete(who); hubPeers(); } };
      conn.on("close", gone);
      conn.on("error", gone);
    });
    p.on("disconnected", () => { if (!closed) p.reconnect(); }); // lost the signalling server; WebRTC links stay up
    hubPeers();
  };

  // ---- as a spoke ----
  const becomeSpoke = p => new Promise((resolve, reject) => {
    peer = p; members = null;
    const conn = p.connect(hubId, { reliable: true });
    hubConn = conn;
    let ok = false;
    const fail = setTimeout(() => { if (!ok) { conn.close(); reject(new Error("hub-unreachable")); } }, 8000);
    conn.on("open", () => conn.send({ k: "hello", from: label, presence }));
    conn.on("data", msg => {
      if (!msg || typeof msg !== "object") return;
      if (msg.k === "peers" && Array.isArray(msg.list)) { setList(msg.list); if (!ok) { ok = true; clearTimeout(fail); resolve(); } }
      else if (msg.k === "emit") deliver(msg.topic, msg.data, String(msg.from));
    });
    conn.on("close", () => { if (ok && !closed) rejoin(); });
    conn.on("error", () => { if (ok && !closed) rejoin(); });
  });

  // Claim the room's id to be the hub; if someone has it, connect to them instead.
  const connect = () => new Promise((resolve, reject) => {
    const p = new Peer(hubId);
    p.on("open", () => { becomeHub(p); resolve(); });
    p.on("error", err => {
      if (err.type !== "unavailable-id") { p.destroy(); return reject(err); }
      p.destroy();
      const q = new Peer();
      q.on("open", () => becomeSpoke(q).then(resolve, err2 => { q.destroy(); reject(err2); }));
      q.on("error", e => { if (!q.open) reject(e); });
    });
  });

  let rejoining = false;
  const rejoin = async () => {
    if (rejoining || closed) return;
    rejoining = true;
    try { peer?.destroy(); } catch { /* already gone */ }
    // The old hub's id takes a moment to free up; everyone tries a little apart.
    for (let attempt = 0; attempt < 8 && !closed; attempt++) {
      await new Promise(r => setTimeout(r, 400 + Math.random() * 900 + attempt * 500));
      try { await connect(); rejoining = false; return; } catch { /* try again */ }
    }
    rejoining = false;
  };

  const room = {
    name,
    async emit(topic, data) {
      if (members) { for (const [l, m] of members) if (l !== label && m.conn?.open) m.conn.send({ k: "emit", from: label, topic, data }); }
      else if (hubConn?.open) hubConn.send({ k: "emit", from: label, topic, data });
    },
    on(topic, h) { (handlers[topic] ||= []).push(h); return () => { handlers[topic] = handlers[topic].filter(x => x !== h); }; },
    async presence(patch) {
      presence = { ...presence };
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete presence[k]; else presence[k] = v; }
      if (members) { members.set(label, { presence, conn: null }); hubPeers(); }
      else if (hubConn?.open) hubConn.send({ k: "presence", from: label, presence });
    },
    peers: () => list,
    onPeers(h) { peerHandlers.push(h); setTimeout(() => h({ peers: list, joined: list, left: [], updated: [] }), 0); return () => {}; },
    connected: () => !!(members || hubConn?.open),
    async leave() { closed = true; try { peer?.destroy(); } catch { /* already gone */ } },
  };
  addEventListener("pagehide", () => room.leave());
  return connect().then(() => room);
}
