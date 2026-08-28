/* ---------------------------------------------------------------
   Matilija Games — client

   The server is the only thing that knows the game state; this file
   draws whatever it is sent and sends back what the player did.
   Every state message is a full picture, already redacted for this
   player, so there is no local game logic to drift out of sync.
   --------------------------------------------------------------- */

(function () {
  "use strict";

  var LS_ID = "matilija.playerId";
  var LS_NAME = "matilija.name";
  var CODE_LEN = 4;
  var LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";   // no I or O, they read as 1 and 0

  var root = document.getElementById("root");
  var toastEl;
  var ws = null;
  var view = null;
  var code = null;
  var status = "idle";        // idle | connecting | live | down
  var draft = "";
  var retry = 0;
  var retryTimer = null;
  var joinCode = "";
  var screen = "games";   // games | setup

  var me = {
    id: store(LS_ID) || makeId(),
    name: store(LS_NAME) || ""
  };
  store(LS_ID, me.id);

  /* ---------------- small helpers ---------------- */

  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { /* private browsing — identity lasts this session only */ }
    return null;
  }

  function makeId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function el(tag, props, kids) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? "" : v);
      });
    }
    (kids || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  var toastTimer;
  function toast(message, bad) {
    if (!toastEl) {
      toastEl = el("div", { class: "toast", role: "status", "aria-live": "polite" });
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.toggle("bad", !!bad);
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 4200);
  }

  function poppy() {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "poppy");
    svg.setAttribute("aria-hidden", "true");
    // six crepe-paper petals around a gold centre
    for (var i = 0; i < 6; i++) {
      var p = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
      p.setAttribute("cx", "12"); p.setAttribute("cy", "6.4");
      p.setAttribute("rx", "3.5"); p.setAttribute("ry", "5.4");
      p.setAttribute("fill", "#F2EFE8");
      p.setAttribute("opacity", "0.92");
      p.setAttribute("transform", "rotate(" + (i * 60) + " 12 12)");
      svg.appendChild(p);
    }
    var c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "3.4");
    c.setAttribute("fill", "#E8B33C");
    svg.appendChild(c);
    return svg;
  }

  function teamClass(id) { return "team-" + id; }

  function randomCode() {
    var out = "";
    for (var i = 0; i < CODE_LEN; i++) out += LETTERS[Math.floor(Math.random() * LETTERS.length)];
    return out;
  }

  /* ---------------- connection ---------------- */

  function connect(newCode) {
    code = String(newCode || "").toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) { toast("A room code is four letters.", true); return; }
    location.hash = "#" + code;
    openSocket();
  }

  function openSocket() {
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} }
    status = "connecting";
    render();

    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var url = proto + "//" + location.host + "/api/room?code=" + encodeURIComponent(code) +
      "&pid=" + encodeURIComponent(me.id) + "&name=" + encodeURIComponent(me.name || "Player");

    var sock = new WebSocket(url);
    ws = sock;

    sock.onopen = function () { status = "live"; retry = 0; render(); };

    sock.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === "state") {
        var before = view;
        view = msg;
        // A fresh round arriving means the box should be empty and ready.
        if (roundKey(before) !== roundKey(msg)) draft = "";
        render();
      } else if (msg.t === "error") {
        toast(msg.message, true);
      }
    };

    sock.onclose = function () {
      if (ws !== sock) return;
      status = "down";
      render();
      retry += 1;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(openSocket, Math.min(800 * retry, 6000));
    };

    sock.onerror = function () { /* onclose handles it */ };
  }

  // Identifies "the box you are typing into right now". When this changes —
  // new round, new game, back to the lobby — whatever was half-typed is stale.
  // Other players submitting does not change it, so nobody loses what they
  // were writing.
  function roundKey(v) {
    if (!v) return "none";
    var t = myTeam(v);
    return v.phase + "|" + (t ? t.round + "|" + t.revealed : "-");
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function leave() {
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} }
    ws = null; view = null; code = null; status = "idle"; draft = ""; screen = "games";
    clearTimeout(retryTimer);
    location.hash = "";
    render();
  }

  function myTeam(v) {
    v = v || view;
    if (!v || !v.teams) return null;
    return v.teams.filter(function (t) { return t.mine; })[0] || null;
  }

  /* ---------------- screens ---------------- */

  function render() {
    var wantFocus = document.activeElement === document.body || document.activeElement === root;
    root.textContent = "";
    if (!code || !view) root.appendChild(homeScreen());
    else root.appendChild(roomScreen());

    var word = root.querySelector(".word-input");
    if (word) {
      word.value = draft;
      if (wantFocus) word.focus();
    }
  }

  // The logo is always the way home. Mid-game it asks first, because going
  // home now means leaving, and a mis-tap would drop you out of a round.
  function goHome() {
    if (code && view && view.phase === "playing") {
      if (!confirm("Leave the game?")) return;
    }
    if (code) { leave(); return; }
    screen = "games";
    joinCode = "";
    render();
  }

  function masthead() {
    return el("div", { class: "top" }, [
      el("button", {
        class: "brand", type: "button", "aria-label": "Home",
        onclick: goHome
      }, [
        poppy(), document.createTextNode("Matilija Games")
      ]),
      code ? el("button", { class: "btn btn-sm btn-ghost", type: "button", onclick: leave },
        [document.createTextNode("Leave")]) : null
    ]);
  }

  function homeScreen() {
    return screen === "setup" ? setupScreen() : gamesScreen();
  }

  var GAMES = [{
    id: "wavelength",
    name: "Wavelength",
    glyph: "🎯",
    blurb: "Everyone writes a word. Reveal together. Keep going until you all land on the same one."
  }];

  function gamesScreen() {
    return el("div", { class: "wrap" }, [
      masthead(),
      el("div", { class: "game-list" }, GAMES.map(function (g) {
        return el("button", {
          class: "game-tile", type: "button",
          onclick: function () { screen = "setup"; render(); }
        }, [
          el("div", { class: "glyph", text: g.glyph }),
          el("div", { class: "meta" }, [
            el("b", { text: g.name }),
            el("span", { class: "tiny", text: g.blurb })
          ])
        ]);
      }))
    ]);
  }

  function setupScreen() {
    var game = GAMES[0];

    var nameInput = el("input", {
      type: "text", maxlength: "20", placeholder: "Your name", value: me.name,
      "aria-label": "Your name",
      oninput: function (e) { me.name = e.target.value.slice(0, 20); store(LS_NAME, me.name); }
    });

    var codeInput = el("input", {
      type: "text", maxlength: "4", placeholder: "CODE", class: "code-input",
      autocapitalize: "characters", autocomplete: "off", spellcheck: "false",
      "aria-label": "Room code", value: joinCode,
      oninput: function (e) {
        joinCode = e.target.value.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 4);
        e.target.value = joinCode;
      },
      onkeydown: function (e) { if (e.key === "Enter") doJoin(); }
    });

    function requireName() {
      if (!me.name.trim()) { toast("Put your name in first.", true); nameInput.focus(); return false; }
      return true;
    }

    function doJoin() {
      if (!requireName()) return;
      if (joinCode.length !== 4) { toast("A room code is four letters.", true); codeInput.focus(); return; }
      connect(joinCode);
    }

    async function doCreate() {
      if (!requireName()) return;
      var candidate = randomCode();
      for (var i = 0; i < 6; i++) {
        try {
          var res = await fetch("/api/exists?code=" + candidate);
          var data = await res.json();
          if (!data.exists) break;
        } catch (e) { break; }
        candidate = randomCode();
      }
      connect(candidate);
    }

    return el("div", { class: "wrap" }, [
      masthead(),
      el("button", {
        class: "btn btn-sm btn-ghost back", type: "button", "aria-label": "Back to games",
        onclick: function () { screen = "games"; joinCode = ""; render(); }
      }, [document.createTextNode("←")]),
      el("div", { class: "game-tile still" }, [
        el("div", { class: "glyph", text: game.glyph }),
        el("div", { class: "meta" }, [
          el("b", { text: game.name }),
          el("span", { class: "tiny", text: game.blurb })
        ])
      ]),
      el("div", { class: "card" }, [
        el("div", { class: "field" }, [
          el("label", { class: "label", text: "Who are you" }),
          nameInput
        ]),
        el("button", { class: "btn btn-primary btn-lg btn-block", type: "button", onclick: doCreate },
          [document.createTextNode("Start a new game")]),
        el("hr", { class: "divider" }),
        el("div", { class: "field" }, [
          el("label", { class: "label", text: "Or join game" }),
          codeInput
        ]),
        el("button", { class: "btn btn-block", type: "button", onclick: doJoin },
          [document.createTextNode("Join game")])
      ])
    ]);
  }

  function statusLine() {
    if (status === "live") return null;
    return el("div", { class: "status-line down" }, [
      el("span", { class: "dot" }),
      el("span", { text: status === "connecting" ? "Connecting…" : "Reconnecting…" })
    ]);
  }

  function roomScreen() {
    var kids = [masthead(), statusLine()];

    if (view.phase === "lobby") kids = kids.concat(lobby());
    else if (view.phase === "over") kids = kids.concat(gameOver());
    else kids = kids.concat(playing());

    return el("div", { class: "wrap" }, kids);
  }

  /* ---------------- lobby ---------------- */

  function lobby() {
    var counts = [1, 2, 3];
    var seg = el("div", { class: "seg" }, counts.map(function (n) {
      return el("button", {
        type: "button", "aria-pressed": view.teamCount === n ? "true" : "false",
        onclick: function () { send({ t: "teamCount", count: n }); }
      }, [document.createTextNode(n === 1 ? "One group" : n + " teams")]);
    }));

    var blocks = [
      el("div", { class: "card" }, [
        el("div", { class: "code-display" }, [
          el("span", { class: "label", text: "Room code" }),
          el("span", { class: "code-value", text: view.code })
        ]),
        el("div", { class: "btn-row" }, [
          el("button", {
            class: "btn btn-sm", type: "button",
            onclick: function () { copy(location.origin + "/#" + view.code); }
          }, [document.createTextNode("Copy link")])
        ])
      ]),

      el("div", { class: "card" }, [
        el("div", { class: "round-head" }, [
          el("h2", { text: "In the room" }),
          el("span", { class: "label", text: view.players.length + (view.players.length === 1 ? " player" : " players") })
        ]),
        el("div", { class: "players" }, view.players.map(function (p) {
          return el("span", { class: "chip" + (p.connected ? "" : " away") + (p.id === view.you.id ? " you" : "") }, [
            el("span", { class: "dot" }),
            document.createTextNode(p.name)
          ]);
        })),
        el("div", { class: "field" }, [
          el("label", { class: "label", text: "How are we playing" }),
          seg
        ])
      ])
    ];

    if (view.teamCount > 1) {
      var ids = ["A", "B", "C"].slice(0, view.teamCount);
      blocks.push(el("div", { class: "card" }, [
        el("h2", { text: "Pick a side" }),
        el("div", { class: "team-pick" }, ids.map(function (id) {
          var members = view.players.filter(function (p) { return p.teamId === id; });
          return el("button", {
            class: "team-btn " + teamClass(id), type: "button",
            "aria-pressed": view.you.teamId === id ? "true" : "false",
            onclick: function () { send({ t: "pickTeam", teamId: id }); }
          }, [
            el("span", { class: "swatch" }),
            el("b", { text: "Team " + id }),
            el("span", { class: "who", text: members.length ? members.map(function (m) { return m.name; }).join(", ") : "empty" })
          ]);
        })),
        el("p", { class: "tiny", text: "Two players minimum on each team. Anyone who doesn't pick gets sorted in." })
      ]));
    }

    var enough = view.players.length >= 2;
    blocks.push(el("button", {
      class: "btn btn-primary btn-lg btn-block", type: "button",
      disabled: !enough,
      onclick: function () { send({ t: "start" }); }
    }, [document.createTextNode(enough ? "Start playing" : "Waiting for one more player…")]));

    return blocks;
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast("Link copied."); },
        function () { toast(text); }
      );
    } else {
      toast(text);
    }
  }

  /* ---------------- playing ---------------- */

  function playing() {
    var team = myTeam();
    if (!team) return [el("div", { class: "card" }, [el("p", { class: "lede", text: "Finding your seat…" })])];

    var blocks = [];

    if (team.revealed) blocks.push(revealCard(team));
    else blocks.push(writeCard(team));

    var rivals = view.teams.filter(function (t) { return !t.mine; });
    if (rivals.length) blocks.push(rivalCard(rivals));

    if (team.history.length) blocks.push(historyCard(team));

    return blocks;
  }

  function writeCard(team) {
    var mySubmission = team.yourWord;
    var pending = team.members.filter(function (m) { return m.connected && !m.submitted; });

    var input = el("input", {
      type: "text", class: "word-input", maxlength: "40",
      placeholder: "enter word", autocomplete: "off", spellcheck: "false",
      "aria-label": "Your word",
      oninput: function (e) { draft = e.target.value; },
      onkeydown: function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } }
    });

    function submit() {
      var word = draft.trim();
      if (!word) { toast("Write a word first.", true); input.focus(); return; }
      send({ t: "submit", word: word });
    }

    var body = mySubmission
      ? [
          el("span", { class: "label", text: "You wrote" }),
          el("div", { class: "your-word", text: mySubmission }),
          el("button", {
            class: "btn btn-sm btn-ghost", type: "button",
            onclick: function () { draft = mySubmission; send({ t: "unsubmit" }); }
          }, [document.createTextNode("Change it")])
        ]
      : [
          input,
          el("button", { class: "btn btn-primary btn-lg btn-block", type: "button", onclick: submit },
            [document.createTextNode("Submit")])
        ];

    return el("div", { class: "card" }, [
      el("div", { class: "round-head" }, [
        el("h2", { text: "Round " + team.round }),
        view.teamCount > 1 ? el("span", { class: "label " + teamClass(team.id), text: "Team " + team.id }) : null
      ]),
      el("p", { class: "tiny", text: "On the same wavelength?" }),
      el("div", { class: "field" }, body),
      el("hr", { class: "divider" }),
      el("div", { class: "waiting" }, [
        el("span", { class: "label", text: pending.length ? "Still writing" : "Everyone's in — revealing…" }),
        el("div", { class: "players" }, team.members.map(function (m) {
          return el("span", {
            class: "chip" + (m.connected ? "" : " away") + (m.submitted ? " done" : "") +
              (m.id === view.you.id ? " you" : "") + (!m.submitted && m.connected ? " pulse" : "")
          }, [
            m.submitted ? el("span", { class: "tick", text: "✓" }) : el("span", { class: "dot" }),
            document.createTextNode(m.name)
          ]);
        }))
      ]),
      team.used.length ? el("div", { class: "field" }, [
        el("span", { class: "label", text: "Already played" }),
        el("div", { class: "used-words" }, team.used.map(function (w) {
          return el("span", { class: "w", text: w });
        }))
      ]) : null
    ]);
  }

  function revealCard(team) {
    return el("div", { class: "card" }, [
      el("div", { class: "round-head" }, [
        el("h2", { text: "Round " + team.round }),
        view.teamCount > 1 ? el("span", { class: "label " + teamClass(team.id), text: "Team " + team.id }) : null
      ]),
      el("div", { class: "reveal-list" }, (team.words || []).map(function (w) {
        return el("div", { class: "reveal-row" }, [
          el("span", { class: "word", text: w.word }),
          el("span", { class: "who", text: w.name })
        ]);
      })),
      el("p", { class: "verdict no", text: "Keep going…" }),
      el("div", { class: "btn-row" }, [
        el("button", { class: "btn btn-primary", type: "button", onclick: function () { send({ t: "next" }); } },
          [document.createTextNode("Next round")]),
        el("button", { class: "btn", type: "button", onclick: function () { send({ t: "gotIt" }); } },
          [document.createTextNode("Close enough — we got it")])
      ])
    ]);
  }

  function rivalCard(rivals) {
    return el("div", { class: "card tight" }, [
      el("span", { class: "label", text: "The other side" }),
      el("div", { class: "rivals" }, rivals.map(function (t) {
        var done = t.members.filter(function (m) { return m.submitted; }).length;
        var total = t.members.length || 1;
        return el("div", { class: "rival " + teamClass(t.id) }, [
          el("b", { text: "Team " + t.id }),
          el("span", { class: "count", text: "round " + t.round }),
          el("span", { class: "bar" }, [el("i", { style: "width:" + Math.round((done / total) * 100) + "%" })]),
          el("span", { class: "count", text: done + "/" + total })
        ]);
      }))
    ]);
  }

  function historyCard(team) {
    return el("div", { class: "card tight" }, [
      el("span", { class: "label", text: "History" }),
      el("div", { class: "history" }, team.history.slice().reverse().map(function (h) {
        return el("div", { class: "round-block" + (h.matched ? " hit" : "") }, [
          el("span", { class: "rnum", text: "Round " + h.round }),
          el("div", { class: "words" }, h.entries.map(function (e) {
            return el("span", { class: "w", text: e.word });
          }))
        ]);
      }))
    ]);
  }

  /* ---------------- game over ---------------- */

  function gameOver() {
    var winner = view.teams.filter(function (t) { return t.id === view.winnerTeamId; })[0];
    var lastRound = winner && winner.history.length ? winner.history[winner.history.length - 1] : null;
    var word = lastRound && lastRound.entries.length ? lastRound.entries[0].word : "";
    var mine = winner && winner.mine;

    var blocks = [
      el("div", { class: "card" }, [
        el("div", { class: "win" }, [
          el("span", { class: "label", text: view.teamCount > 1
            ? (mine ? "Your team got there first" : "Team " + view.winnerTeamId + " got there first")
            : "You all landed on it" }),
          el("div", { class: "word", text: word }),
          el("p", { class: "tiny", text: winner && winner.manual
            ? "Called by the room."
            : "Matched on round " + (lastRound ? lastRound.round : "?") + "." })
        ]),
        el("button", { class: "btn btn-primary btn-lg btn-block", type: "button", onclick: function () { send({ t: "playAgain" }); } },
          [document.createTextNode("Play again")])
      ])
    ];

    view.teams.forEach(function (t) {
      if (!t.history.length) return;
      blocks.push(el("div", { class: "card tight" }, [
        el("span", { class: "label " + teamClass(t.id), text: view.teamCount > 1 ? "Team " + t.id : "The whole run" }),
        el("div", { class: "history" }, t.history.map(function (h) {
          return el("div", { class: "round-block" + (h.matched ? " hit" : "") }, [
            el("span", { class: "rnum", text: "Round " + h.round }),
            el("div", { class: "words" }, h.entries.map(function (e) {
              return el("span", { class: "w", text: e.word + " · " + e.name });
            }))
          ]);
        }))
      ]));
    });

    return blocks;
  }

  /* ---------------- boot ---------------- */

  window.addEventListener("hashchange", function () {
    var want = location.hash.replace("#", "").toUpperCase();
    if (want && want !== code) connect(want);
    else if (!want && code) leave();
  });

  var initial = location.hash.replace("#", "").toUpperCase();
  render();
  if (/^[A-Z]{4}$/.test(initial)) {
    if (me.name.trim()) connect(initial);
    else { joinCode = initial; screen = "setup"; render(); toast("Add your name, then join."); }
  }
})();
