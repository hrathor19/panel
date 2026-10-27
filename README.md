# Panel Gateway

Lets your team use one or more NoPaperForms publisher panels with their **own**
usernames and passwords, without ever handing out the real panel credentials.

People sign in once, pick a panel (NPF, NPF5, NPF8…), and get the real vendor
panel with the shared account already signed in. The panel password never
reaches a browser.

## How it works

```
person ─► /login ─► /panels ─► /p/npf5/ ─┐
   own password      picker              │  vendor's app, served from us
                                         │
                      opaque session ────┤  swapped server-side
                                         ▼
                            services.nopaperforms.com
```

Each panel is mounted under its own prefix, so two can be open in two tabs at
once. Three strings in the vendor bundle are rewritten per panel:

| Rewritten | From | To |
|---|---|---|
| `apiBaseUrl` | the vendor API | `/p/<slug>/npf-api/` |
| `cookiePath` | `/` | `/p/<slug>/` |
| `<base href>` | `/` | `/p/<slug>/` |

The gateway authenticates on its own **HttpOnly** cookie. The `access_token`
cookie the vendor app insists on is a meaningless placeholder — stealing it
gains nothing. The real upstream token lives in storage, one per panel, shared
by every process, and is injected into each proxied request.

## Pages

| Page | Who | What |
|---|---|---|
| `/login` | everyone | sign in |
| `/panels` | everyone | pick a panel |
| `/account` | everyone | change your own password |
| `/p/<slug>/` | assigned users | the panel itself |
| `/admin` | admins | overview, users, panels, sessions, activity |

**Overview** — users, panels, who is connected, today's requests, blocked
exports and failed sign-ins.

**Users** — add, edit, reset password, disable, delete. Per person: role,
whether they may download exports, and which panels they reach (all, or a
list). Generated passwords are shown once and use an alphabet with no
`l`/`I`/`1` or `O`/`0`, because they get read off screens and dictated.

**Institutes** — each panel account can see many institutes, and the panel's own
"Select Institute" dropdown lists all of them. In Admin → Users you can tick
which institutes a person may open, per panel. Leave "Every institute" on and
nothing changes for them.

Enforced on the server, not just in the dropdown. The institute id reaches the
panel three ways, and all three are checked: the URL path
(`filtersByCollege/<id>/…`), the encrypted POST body (`college_id`, `collegeId`
or `college`, at any depth), and the case where no institute is named at all —
which is refused rather than allowed to span everything. The `collegeList`
response is filtered too, so the dropdown only offers what they hold.

Endpoints default to institute-scoped: one the vendor adds later fails closed,
not open. The short list of genuinely institute-agnostic endpoints is in
`src/institutes.js`. Reading the encrypted body costs ~40ms, so it is only done
for people who actually have institute limits — everyone else is unaffected.

**Panels** — name, address, shared username and password. **Test** signs in
right then and reports what came back, so you can tell a wrong password from an
unreachable panel. Passwords are encrypted at rest and never sent to a browser.

**Sessions** — who is signed in, from where, on what. Sign anyone out.

**Activity** — every sign-in, request and blocked export, filterable, with CSV
export.

Disabling, deleting, resetting a password or changing panel access takes effect
**immediately** — no waiting for a session to lapse.

## Sign-in location and forensics

Every sign-in attempt is recorded with where it came from, on what, and whether
anything about it looks unusual. Admin → Sign-ins.

**`LOCATION_MODE`** decides what happens at sign-in:

| Mode | Behaviour |
|---|---|
| `off` | never ask |
| `capture` | ask and record, but let people in either way |
| `require` | refuse the sign-in without one |

`capture` is usually what you want: you get the coordinates without a denied
prompt locking anybody out.

**Coordinates are resolved to an address.** A latitude and longitude only
answers "where" if you paste it into a map, so the reported position is
reverse-geocoded and both are kept — "Sector 62, Noida" in the list, the exact
numbers and a map link beneath it. `REVERSE_GEOCODE=0` turns that off if you
would rather the coordinates did not go to a geocoder.

**A timezone is not a location.** The device clock (`Asia/Kolkata`) is recorded
and shown, but labelled as the clock and kept separate from where someone was.
IANA still uses the legacy spelling `Asia/Calcutta`, which reads like a place
name in a list, so it is normalised for display.

Two things to be honest about:

- **It needs HTTPS.** Geolocation is a secure-context API. Over plain HTTP on
  anything but `localhost` the browser refuses it outright, and no amount of
  clicking Allow helps — so over a LAN address no coordinates are ever
  recorded, whatever the mode says. `npm run doctor` warns on `capture` without
  TLS and fails on `require`, since that combination locks everyone out.
- **A reported position can be faked.** Browser devtools have a location
  override. Treat it as a deterrent and a record, not proof.

**What is actually trustworthy.** The IP is observed by the server, not
reported by the page, so it cannot simply be typed. Each sign-in stores both
the claimed position and the IP's registered location, and compares them. A
browser saying Delhi while the connection comes from Dubai is the interesting
case, and it is flagged.

**Recorded per sign-in:** time, account, outcome (signed in / wrong password /
location refused / throttled), IP and what it resolves to, network operator,
browser, operating system, device type, screen size, timezone, reported
coordinates and their accuracy.

**Flags raised:**

| Flag | Means |
|---|---|
| Impossible travel | two sign-ins further apart than anyone could travel between them |
| Location disagrees with network | reported position is 300 km+ from where the IP sits |
| New device | browser/OS combination not seen for this account before |
| New location | first sign-in from this city |
| Location refused | the prompt was denied |
| First sign-in | no prior history, so nothing to compare against |

These are prompts for a person, not verdicts — "new device" means someone
bought a laptop as often as it means two people share an account. Impossible
travel is the one worth acting on without thinking twice.

Exportable as CSV. IP lookups are cached for a day, private addresses are never
sent anywhere, and a slow lookup never delays a sign-in.

## What it blocks

**Bulk exports**, unless the person has the export permission:
`downloadLeadDetailsViewList`, `downloadCampaignDetailsViewList`,
`downloadGeographicalStateViewList`, `downloadDashboardSummaryPDF`,
`downloadTaxonomy`.

**Account changes, for everyone including admins** — these act on the *shared*
panel account, so one person could lock out the whole team: `editProfile`,
`resetPassword`, `forgot`, and `logout` (forwarding it would invalidate the
shared token and sign out everybody on that panel).

Login is throttled per account and per IP.

## Running it locally

```bash
npm install
cp .env.example .env     # set SESSION_SECRET
npm start                # prints a one-time admin password on first run
```

Users, panels and the audit log go in `./data`.

## Deploying to Vercel

Vercel runs this as a serverless function, which has **no filesystem and no
memory between requests**. Storage must be external, or nothing persists and
everyone is signed out constantly. The gateway refuses to start on Vercel
without it rather than failing confusingly later.

1. **Add a KV store.** Vercel dashboard → Storage → Create → KV, and connect it
   to the project. That sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
   (Upstash directly works too: set `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN`.)

2. **Set environment variables** (Project → Settings → Environment Variables):

   | Variable | Value |
   |---|---|
   | `SESSION_SECRET` | `openssl rand -hex 32` — **set this before the first deploy** |
   | `ADMIN_EMAIL` | your email |
   | `ADMIN_PASSWORD` | a password you choose, at least 10 characters |

3. **Deploy.**

   ```bash
   npm i -g vercel
   vercel
   vercel --prod
   ```

4. Sign in at `https://<your-app>.vercel.app/login` and add your panels.

`vercel.json` routes every path to the function and allows 60s per request, for
the slower panel reports.

### Things to know about Vercel specifically

- **`SESSION_SECRET` also encrypts stored panel passwords.** Change it and the
  saved panel passwords become unreadable and must be re-entered. Set it once,
  before you add any panels.
- **Request timeout.** 60s on Pro, 10s on Hobby. A slow export may be cut off on
  Hobby.
- **No fixed outbound IP.** If NoPaperForms ever IP-restricts your account,
  serverless will break and a VPS will not.
- **Cold starts** add a second or so to the first request after an idle period.

A small VPS avoids all four and costs about the same. The gateway runs on either
without code changes — the only difference is whether the Redis variables are
set. `GET /gw/health` reports which backend is live.

## Deploying to an Azure VM

See **[deploy/AZURE.md](deploy/AZURE.md)** for the full runbook: DNS, the Azure
NSG rules people forget, Node, the service user, systemd, nginx, certbot, and
what to do on the first sign-in. `deploy/` also holds the systemd unit and nginx
site used there.

## Deploying to any other VPS

Behind nginx with TLS; the gateway speaks plain HTTP.

```nginx
server {
    listen 443 ssl;
    server_name panel.kollegeapply.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

Set `TRUST_PROXY=1`. Then:

```ini
[Unit]
Description=Panel Gateway
After=network.target

[Service]
Type=simple
User=npfgw
WorkingDirectory=/opt/npf-gateway
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`chmod 600 .env`, and keep `data/` out of any backup others can read.

## Leak controls

The motive here is stopping lead data walking out. It is worth being exact
about which of these controls actually hold, because they are not equal.

### What cannot be done

No web page can do these. Not this one, not any.

- **Screenshots cannot be blocked.** The operating system takes them and never
  consults the browser. There is no API to refuse.
- **DevTools cannot be blocked.** Keyboard shortcuts can be swallowed, but the
  browser's own menu, right-click → Inspect, `view-source:`, and launching the
  browser with devtools already open all go around it. Detection tricks are
  defeated in seconds and break ordinary browsing.
- **A phone camera defeats all of it.**

Anyone who promises otherwise for a browser-based tool is selling something.

### Watermarking — attribution, and it works

Every panel page is overlaid with a tiled mark carrying **the brand, the
viewer's email address, the timestamp, and the panel name**. It does not stop a
capture; it makes any capture self-identifying. A screenshot forwarded to a
competitor says who took it.

Design decisions that matter:

- The tile is small, so a screenshot cropped to a few rows still contains one
  whole mark including the identity line.
- The email line is weighted to stay legible after the downscaling and JPEG
  compression of a messaging app. A legible brand with an illegible name
  attached is useless.
- It is re-attached by a `MutationObserver` and an interval, so the panel
  rebuilding its DOM — or someone deleting the node in the inspector — does not
  remove it. Turning JavaScript off does remove it; nothing injected into a page
  survives that.
- `WATERMARK_MODE=all` by default, admins included. Attribution costs nothing.
- `WATERMARK_OPACITY=0.17` by default. Tuned against a dense lead table: at 0.30
  the mark cuts through phone digits, at 0.12 the identity line stops surviving
  compression. Raise or lower it to taste — the range that works is 0.12-0.22.

### Copy blocking — friction, and only friction

For `role=user`: text selection, copy, cut, right-click, drag, print, save and
view-source are intercepted, and printing is blanked. Input fields stay
typeable.

This raises the effort of a casual copy-paste. It stops nobody who opens the
network tab or replays their session cookie with `curl`. Treat it as a speed
bump, not a wall. Set `DISABLE_COPY=0` if it gets in your team's way — be aware
that counsellors cannot select a phone number to paste into a dialler while it
is on.

### Bulk retrieval cap — the one that actually bounds a leak

Counted on the server, per account, so the browser does not get a vote. Lead
listing endpoints are capped at `BULK_MAX_PER_WINDOW` requests per
`BULK_WINDOW_MINUTES` for anyone **without** export permission. Exceeding it
returns 429 and is recorded in the audit log against that person.

A counsellor working leads reads a few pages an hour. Someone paging through the
database to copy it reads hundreds. This is the control that catches the second
case, and the only one in this list that cannot be worked around from the
client.

Export permission exempts you — if you are trusted to download the whole list in
one click, a paging limit is theatre.

### What to lean on

In descending order of what actually protects you:

1. **Export permission off by default.** The five download endpoints are the
   real exfiltration route; everything else is retail.
2. **The bulk cap.** Server-side, unbypassable.
3. **The audit log.** Every request attributed to a person and a panel. This is
   how you find out, and it is admissible in an HR conversation.
4. **Watermarking.** Deterrence through attribution.
5. **Copy blocking.** Friction.

What none of this replaces: only giving panel access to people who need it, and
removing it the day they leave. One click in Admin → Users.

## Commands

```bash
npm start                                      # run it
npm test                                       # 79 end-to-end tests, no real credentials
npm run verify                                 # sign in to every panel, report what came back
npm run userlist                               # recovery CLI — normal use is /admin
npm run passwd -- someone@example.com          # set a new password
npm run useradd -- new@example.com "Name" admin
```

`npm test` runs against two stand-in panels in a throwaway data directory. It
never touches real credentials, users or audit data.

## When it breaks

The panels are a third party and can change under you.

| Symptom | Cause | Fix |
|---|---|---|
| `Forbidden` from a panel | a bot filter rejected us before any password check | confirm the panel opens in a normal browser |
| "Temporarily unavailable" for everyone | shared password changed, or account locked | **Test** that panel in `/admin` |
| Blank page, console 404s | bundles renamed upstream | restart to clear the asset cache |
| Login rejected on every panel | bundle encryption key rotated | self-healing within 6h; restart to force |
| Signed out constantly on Vercel | no KV store attached | set the Redis variables |
| One screen empty, rest fine | a new API endpoint | nothing needed, unless it is a download to gate — add it to `src/policy.js` |

`npm run verify` is the first thing to run in any of these.

**Code changes need a restart.** Node loads modules once at boot.

## Things to know

- **Rotate the panel passwords** once this is live, so copies already
  circulating stop working. That is what makes the gateway the only way in.
- **Account sharing may breach the vendor's terms**, and this re-serves their
  app from your domain. Ask your account manager about sub-users — if they
  exist, that beats this and you can retire it.
- **Anyone with export rights can still export.** The gateway limits reach, not
  trust.
- **A viewer can still read what is on their own screen.** This stops bulk
  extraction and gives you attribution; it is not DRM.
