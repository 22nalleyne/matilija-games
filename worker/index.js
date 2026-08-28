/* ---------------------------------------------------------------
   Matilija Games — Cloudflare Worker + Durable Object

   One Durable Object per room code. It is the single authority on
   who is connected, who has submitted, and when a round may be
   revealed — which is the whole reason this isn't built on KV. Every
   device gets the reveal from the same place at the same moment.

     GET /api/exists?code=ABCD   is that room already in use?
     GET /api/room?code=...      websocket upgrade; joins the room

   Bindings (see wrangler.jsonc):
     ROOMS    Durable Object namespace, class Room
     ASSETS   the built site in ./public
   --------------------------------------------------------------- */

const NAME_MAX = 20;
const WORD_MAX = 40;
const CODE_LEN = 4;
const MAX_PLAYERS = 12;
const IDLE_MS = 1000 * 60 * 60 * 12;   // a room older than this is fair game

/* ---------------- word comparison ----------------
   Family-grade, not linguistics. It catches case, punctuation,
   plurals and the common endings, and everything it misses is
   settled by the "We got it" button — so it is allowed to be
   imperfect, but it must never be the reason a win is refused.
*/

function normalize(word) {
  return String(word || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Rather than reduce each word to one stem and hope the two agree, expand
// each into the small set of forms it could be written as, and call it a
// match if those sets touch. That way bus/buses and run/running land
// together without inventing a stemmer that mangles short words.
function variants(word) {
  const s = normalize(word);
  const out = new Set();
  if (!s) return out;
  out.add(s);
  if (s.length > 3) {
    if (/ies$/.test(s)) out.add(s.slice(0, -3) + "y");
    if (/es$/.test(s)) out.add(s.slice(0, -2));
    if (/s$/.test(s)) out.add(s.slice(0, -1));
  }
  if (s.length > 4) {
    const drop = /ing$/.test(s) ? 3 : (/ed$/.test(s) ? 2 : 0);
    if (drop) {
      const base = s.slice(0, -drop);
      out.add(base);
      out.add(base.replace(/([bdfglmnprt])\1$/, "$1"));
      out.add(base + "e");
    }
  }
  return out;
}

function sameWord(a, b) {
  const A = variants(a), B = variants(b);
  if (!A.size || !B.size) return false;
  for (const v of A) if (B.has(v)) return true;
  return false;
}

/* ---------------- room shape ---------------- */

const TEAM_STYLES = [
  { id: "A", name: "Gold" },
  { id: "B", name: "Teal" },
  { id: "C", name: "Coral" }
];

function freshRoom(code) {
  return {
    code: code,
    phase: "lobby",          // lobby | playing | over
    createdAt: Date.now(),
    touchedAt: Date.now(),
    teamCount: 1,
    hostId: null,
    players: {},             // id -> { id, name, teamId }
    teams: [],
    winnerTeamId: null
  };
}

function freshTeam(style) {
  return {
    id: style.id,
    name: style.name,
    members: [],
    round: 1,
    submissions: {},         // playerId -> word (never leaves the DO until reveal)
    revealed: false,
    matched: false,
    won: false,
    used: [],                // normalized words already played by this team
    history: []
  };
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;
  }

  async load() {
    if (!this.room) this.room = (await this.state.storage.get("room")) || null;
    return this.room;
  }

  async save() {
    if (this.room) {
      this.room.touchedAt = Date.now();
      await this.state.storage.put("room", this.room);
    }
  }

  connectedIds() {
    const ids = new Set();
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att && att.playerId) ids.add(att.playerId);
    }
    return ids;
  }

  async fetch(request) {
    const url = new URL(request.url);
    await this.load();

    if (url.pathname.endsWith("/exists")) {
      const live = !!(this.room && Object.keys(this.room.players).length &&
        Date.now() - (this.room.touchedAt || 0) < IDLE_MS);
      return new Response(JSON.stringify({ exists: live }), {
        headers: { "content-type": "application/json" }
      });
    }

    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected a websocket", { status: 426 });
    }

    const code = (url.searchParams.get("code") || "").toUpperCase();
    const name = String(url.searchParams.get("name") || "").slice(0, NAME_MAX).trim() || "Player";
    const playerId = String(url.searchParams.get("pid") || "").slice(0, 40) || crypto.randomUUID();

    if (!this.room || Date.now() - (this.room.touchedAt || 0) > IDLE_MS) this.room = freshRoom(code);

    const known = this.room.players[playerId];
    if (!known && Object.keys(this.room.players).length >= MAX_PLAYERS) {
      return new Response("that room is full", { status: 403 });
    }
    if (known) {
      known.name = name;
    } else {
      this.room.players[playerId] = { id: playerId, name: name, teamId: null };
      if (this.room.phase === "playing") this.seatLatecomer(playerId);
    }
    if (!this.room.hostId || !this.room.players[this.room.hostId]) this.room.hostId = playerId;

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ playerId: playerId });

    await this.save();
    this.broadcast();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Someone arriving after kickoff joins whichever team is smallest.
  seatLatecomer(playerId) {
    if (!this.room.teams.length) return;
    const smallest = this.room.teams.slice().sort(function (a, b) { return a.members.length - b.members.length; })[0];
    smallest.members.push(playerId);
    this.room.players[playerId].teamId = smallest.id;
  }

  teamOf(playerId) {
    return this.room.teams.filter(function (t) { return t.members.indexOf(playerId) >= 0; })[0] || null;
  }

  async webSocketMessage(ws, raw) {
    await this.load();
    if (!this.room) return;

    const att = ws.deserializeAttachment() || {};
    const pid = att.playerId;
    const me = this.room.players[pid];
    if (!me) return;

    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    const fail = (text) => ws.send(JSON.stringify({ t: "error", message: text }));

    switch (msg.t) {
      case "rename": {
        me.name = String(msg.name || "").slice(0, NAME_MAX).trim() || me.name;
        break;
      }

      case "teamCount": {
        if (this.room.phase !== "lobby") return;
        const n = Number(msg.count);
        if ([1, 2, 3].indexOf(n) < 0) return;
        this.room.teamCount = n;
        // Drop anyone sitting on a team that no longer exists.
        const live = TEAM_STYLES.slice(0, n).map(function (s) { return s.id; });
        for (const p of Object.values(this.room.players)) {
          if (p.teamId && live.indexOf(p.teamId) < 0) p.teamId = null;
        }
        break;
      }

      case "pickTeam": {
        if (this.room.phase !== "lobby") return;
        const id = msg.teamId;
        const live = TEAM_STYLES.slice(0, this.room.teamCount).map(function (s) { return s.id; });
        me.teamId = live.indexOf(id) >= 0 ? id : null;
        break;
      }

      case "start": {
        if (this.room.phase !== "lobby") return;
        const players = Object.values(this.room.players);
        if (players.length < 2) return fail("You need at least two players.");
        this.room.teams = TEAM_STYLES.slice(0, this.room.teamCount).map(freshTeam);

        if (this.room.teamCount === 1) {
          this.room.teams[0].members = players.map(function (p) { return p.id; });
          for (const p of players) p.teamId = "A";
        } else {
          for (const p of players) {
            const chosen = this.room.teams.filter(function (t) { return t.id === p.teamId; })[0];
            if (chosen) chosen.members.push(p.id);
          }
          // Balance whoever never picked.
          for (const p of players) {
            if (this.teamOf(p.id)) continue;
            const smallest = this.room.teams.slice().sort(function (a, b) { return a.members.length - b.members.length; })[0];
            smallest.members.push(p.id);
            p.teamId = smallest.id;
          }
          const thin = this.room.teams.filter(function (t) { return t.members.length < 2; });
          if (thin.length) return fail("Every team needs at least two players.");
        }
        this.room.phase = "playing";
        this.room.winnerTeamId = null;
        break;
      }

      case "submit": {
        if (this.room.phase !== "playing") return;
        const team = this.teamOf(pid);
        if (!team || team.revealed || team.won) return;
        const word = String(msg.word || "").slice(0, WORD_MAX).trim();
        if (!word) return fail("Write a word first.");
        const key = normalize(word);
        if (!key) return fail("That needs at least one letter or number.");
        if (team.used.some(function (u) { return sameWord(u, word); })) {
          return fail("“" + word + "” has already been played. Pick a new one.");
        }
        team.submissions[pid] = word;
        this.maybeReveal(team);
        break;
      }

      case "unsubmit": {
        if (this.room.phase !== "playing") return;
        const team = this.teamOf(pid);
        if (!team || team.revealed || team.won) return;
        delete team.submissions[pid];
        break;
      }

      case "next": {
        const team = this.teamOf(pid);
        if (!team || !team.revealed || team.won) return;
        this.advance(team);
        break;
      }

      case "gotIt": {
        const team = this.teamOf(pid);
        if (!team || !team.revealed || team.won) return;
        this.declareWin(team, true);
        break;
      }

      case "playAgain": {
        this.room.phase = "lobby";
        this.room.teams = [];
        this.room.winnerTeamId = null;
        break;
      }

      default: return;
    }

    await this.save();
    this.broadcast();
  }

  // A round opens only when every connected member of that team is in.
  maybeReveal(team) {
    const connected = this.connectedIds();
    const present = team.members.filter(function (id) { return connected.has(id); });
    if (present.length < 2) return;
    const allIn = present.every(function (id) { return team.submissions[id] !== undefined; });
    if (!allIn) return;

    team.revealed = true;
    const words = present.map((id) => team.submissions[id]);
    team.matched = words.every(function (w) { return sameWord(w, words[0]); });
    if (team.matched) this.declareWin(team, false);
  }

  declareWin(team, manual) {
    team.won = true;
    team.matched = true;
    team.manual = !!manual;
    this.pushHistory(team);
    this.room.winnerTeamId = team.id;
    this.room.phase = "over";
  }

  pushHistory(team) {
    const entries = Object.keys(team.submissions).map((id) => ({
      id: id,
      name: (this.room.players[id] || {}).name || "?",
      word: team.submissions[id]
    }));
    team.history.push({ round: team.round, entries: entries, matched: team.matched });
    for (const e of entries) {
      const key = normalize(e.word);
      if (key && team.used.indexOf(key) < 0) team.used.push(key);
    }
  }

  advance(team) {
    this.pushHistory(team);
    team.round += 1;
    team.submissions = {};
    team.revealed = false;
    team.matched = false;
  }

  viewFor(pid) {
    const r = this.room;
    const connected = this.connectedIds();
    const me = r.players[pid] || null;
    const over = r.phase === "over";

    return {
      t: "state",
      code: r.code,
      phase: r.phase,
      teamCount: r.teamCount,
      hostId: r.hostId,
      winnerTeamId: r.winnerTeamId,
      you: me ? { id: me.id, name: me.name, teamId: me.teamId } : null,
      players: Object.values(r.players).map(function (p) {
        return { id: p.id, name: p.name, teamId: p.teamId, connected: connected.has(p.id) };
      }),
      teams: r.teams.map((t) => {
        const mine = !!(me && t.members.indexOf(me.id) >= 0);
        // Another team's words stay sealed until the game is over, so a
        // glance at someone else's phone can't steer your own answer.
        const showWords = over || (mine && t.revealed);
        return {
          id: t.id,
          name: t.name,
          round: t.round,
          revealed: t.revealed,
          matched: t.matched,
          won: t.won,
          manual: !!t.manual,
          mine: mine,
          members: t.members.map((id) => ({
            id: id,
            name: (r.players[id] || {}).name || "?",
            connected: connected.has(id),
            submitted: t.submissions[id] !== undefined
          })),
          words: showWords
            ? t.members.filter(function (id) { return t.submissions[id] !== undefined; })
                .map((id) => ({ id: id, name: (r.players[id] || {}).name || "?", word: t.submissions[id] }))
            : null,
          yourWord: mine && me && t.submissions[me.id] !== undefined ? t.submissions[me.id] : null,
          history: (mine || over) ? t.history : [],
          used: mine ? t.used : []
        };
      })
    };
  }

  broadcast() {
    if (!this.room) return;
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (!att || !att.playerId) continue;
      try { ws.send(JSON.stringify(this.viewFor(att.playerId))); } catch (e) { /* closing */ }
    }
  }

  // Closing the tab leaves the game. Anyone who comes back with the same
  // link simply joins again, so this is cheap to undo — and it keeps the
  // player list honest about who is actually there.
  removePlayer(pid) {
    if (!pid || !this.room.players[pid]) return;
    delete this.room.players[pid];

    if (this.room.hostId === pid) {
      const rest = Object.keys(this.room.players);
      this.room.hostId = rest.length ? rest[0] : null;
    }

    for (const team of this.room.teams) {
      const at = team.members.indexOf(pid);
      if (at >= 0) team.members.splice(at, 1);
      delete team.submissions[pid];
      // Losing a player can complete the round for everyone left.
      if (this.room.phase === "playing" && !team.revealed && !team.won) this.maybeReveal(team);
    }
  }

  async dropped(ws) {
    await this.load();
    if (!this.room) return;
    const att = ws.deserializeAttachment() || {};
    this.removePlayer(att.playerId);
    await this.save();
    this.broadcast();
  }

  async webSocketClose(ws) { await this.dropped(ws); }
  async webSocketError(ws) { await this.dropped(ws); }
}

/* ---------------- the Worker ---------------- */

function validCode(code) {
  return /^[A-Z]{4}$/.test(String(code || "").toUpperCase());
}

/*
   NOTE: matilija.games -> matilijagames.com is NOT done here. Cloudflare
   serves a matching static asset before this Worker runs, so a request for
   "/" is answered by public/index.html and never reaches this code. Only
   paths with no matching file (i.e. /api/*) get here. The redirect lives as
   a Redirect Rule on the matilija.games zone instead, which also covers
   plain http.
*/

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (ALIASES.indexOf(url.hostname) >= 0) {
      const to = new URL(url.toString());
      to.hostname = CANONICAL;
      to.protocol = "https:";
      to.port = "";
      return Response.redirect(to.toString(), 301);
    }

    if (url.pathname === "/api/exists" || url.pathname === "/api/room") {
      const code = String(url.searchParams.get("code") || "").toUpperCase();
      if (!validCode(code)) {
        return new Response(JSON.stringify({ ok: false, error: "bad_code" }), {
          status: 400, headers: { "content-type": "application/json" }
        });
      }
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      const target = new URL(request.url);
      target.pathname = url.pathname === "/api/exists" ? "/exists" : "/ws";
      return stub.fetch(new Request(target.toString(), request));
    }

    return env.ASSETS.fetch(request);
  }
};
