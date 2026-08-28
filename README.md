# Matilija Games

Family games for whoever is in the room, on whatever phone they're holding.
Live at **matilijagames.com** (matilija.games redirects there).

The first game is **Converge**: everyone writes a word, all the words reveal at
once, and you keep going — each round writing the word that bridges the last
ones — until you all land on the same word.

## How a game runs

1. Someone opens the site, types their name, and taps **Start a new game**.
2. Everyone else opens the same site and enters the four-letter room code, or
   opens the shared link. Names go in; nobody needs an account.
3. In the lobby, pick **One group** (everybody converging together) or **2 / 3
   teams** and choose a side.
4. Each round: write a word, tap **Lock it in**. You can see who is still
   writing. Nothing is revealed until every connected player on your team is in.
5. If the words don't match, you see them all, then **Next round**. If they do,
   you've won.
6. Words can't be replayed — the game keeps the list, and a plural of a word you
   already used counts as the same word.

**Matching.** Case, punctuation, accents, plurals and the usual endings are all
treated as the same word: `Ship`, `ships`, `SHIP!` match, and so do `run` and
`running`. Anything the computer isn't sure of, you settle yourselves with
**Close enough — we got it**. It's a collaborative game, so the button always
wins over the algorithm.

**Teams.** Each team plays its own chain of words. You can see how far the other
team has got and how many of them have submitted, but never their words — until
the game ends, when everything opens up. First team to converge wins it.

**Leaving.** Closing the tab takes you out of the game — you disappear from the
player list, and if the others had already submitted, the round reveals without
you. Rejoining is just opening the link again. A round otherwise reveals when
everyone still present has submitted, so nobody can freeze the game by walking
off with their phone.

## How it's built

```
public/index.html   the whole client, one file, no dependencies
worker/index.js     the Worker plus the Room durable object
wrangler.jsonc      bindings and the durable-object migration
src/styles.css      styling
src/app.js          the client
build.py            writes public/index.html from src/
```

Rebuild after editing anything in `src/`:

```bash
python3 /Users/nikhilalleyne/matilija-games/build.py
```

Then commit and push — Cloudflare rebuilds on its own.

**Why a Durable Object and not KV.** The whole game turns on one question:
has everybody submitted yet? KV is eventually consistent, so different phones
would answer that differently and the reveal would fire at different moments —
exactly the thing that ruins the game. A Durable Object is a single instance,
one per room code, that every player's websocket connects to. It is the only
thing that decides when a round opens, and it tells every device at once.

Words never leave that object until the round reveals, so nothing is sitting in
a browser waiting to be peeked at, and another team's words aren't sent to your
device at all while the game is running.

---

# Getting it online

The domains are both registered at **Squarespace** and currently show its
placeholder page. Neither has MX records, so no email breaks when they move.
`matilija.games` has an SPF record worth keeping.

### 1. Make the GitHub repo

Create an empty repo — call it **matilija-games** — at <https://github.com/new>.
Don't add a README or licence; the push expects it empty. Then tell me and I'll
push, or run:

```bash
git remote add origin git@github.com:22nalleyne/matilija-games.git && git push -u origin main
```

### 2. Create the Worker from the repo

Cloudflare → **Compute → Workers & Pages → Create application → Connect GitHub**
→ pick **matilija-games**.

| Setting | Value |
|---|---|
| Project name | `matilija-games` |
| Branch | `main` |
| Build command | *(leave empty)* |
| Deploy command | `npx wrangler deploy` |

It'll give you a `matilija-games.<subdomain>.workers.dev` URL. Open it on two
devices and play a round — the game works fully on that address before any
domain is attached.

> **If the build fails mentioning Durable Objects or a paid plan:** the config
> asks for a SQLite-backed durable object, which is the free-tier flavour. Send
> me the build log and I'll adjust.

### 3. Point matilijagames.com at it

1. Cloudflare → **Add a domain → Connect a domain** → `matilijagames.com` → Free.
2. On the DNS review screen, **delete** the four `A` records (Squarespace IPs
   198.185.x / 198.49.x) and both `CNAME` records (`www` and `_domainconnect`).
   **Keep every `TXT` record** — they're the anti-spoofing set.
3. Continue to activation, then at Squarespace: **Domains → matilijagames.com →
   DNS → Nameservers → Custom nameservers** and paste Cloudflare's two.
4. Once Cloudflare shows the domain **Active**: Worker → **Domains → Add →
   Custom domain** → `matilijagames.com`, then again for `www.matilijagames.com`.

### 4. Do the same for matilija.games

Identical steps, and add `matilija.games` and `www.matilija.games` as custom
domains on the same Worker.

Then send it to the canonical name with a **Redirect Rule** on the
matilija.games zone: **Rules → Redirect Rules → Create rule**, applied to all
incoming requests, dynamic redirect to
`concat("https://matilijagames.com", http.request.uri.path)`, status **301**,
preserve query string.

It has to be a zone rule rather than code in the Worker: Cloudflare answers a
request for `/` from the static asset before the Worker ever runs, so a
redirect written in `worker/index.js` would never fire for the pages people
actually visit.

### 5. Play

Send the family `matilijagames.com`. One person starts a game and reads out the
four-letter code.

## Adding the next game

The hub on the home screen is a list of game tiles. A second game means a new
tile, a new screen in `src/app.js`, and — if it needs its own coordination — a
second durable object class alongside `Room`. The room-code plumbing, names,
presence and reconnection are all reusable.
