# Deploying to an Azure Linux VM

Target: `panel.kollegeapply.com` on an Azure VM, behind nginx with a Let's
Encrypt certificate, managed by systemd.

The gateway uses ~76 MB of RSS under load and has three dependencies, none of
which compile. It sits comfortably on a 1 GB VM beside an existing app.

There is deliberately no install script. Your VM already runs the CRM, and a
script that edits nginx on a box serving production is a bad trade for the few
minutes it saves. Paste these a block at a time and read what each one says.

---

## Before you start: the one thing that will catch you out

**Panel passwords are encrypted with `SESSION_SECRET`.** User passwords are
bcrypt hashes and do not depend on it, but panel passwords do. So:

| If you… | Then… |
|---|---|
| Generate a **new** secret on the server | Users carry over. **Panel passwords do not** — re-enter them in `/admin`. |
| Copy your **existing** `.env` secret to the server | Everything carries over, including panels. |

Starting fresh on the server is cleaner — you only re-type two panel passwords,
and the laptop's secret never leaves the laptop. These steps assume that.

---

## 1. DNS

Point the subdomain at the VM's **public** IP before touching certbot; issuance
fails otherwise.

```bash
# On the VM, confirm what the world sees:
curl -s ifconfig.me; echo
```

Create an `A` record: `panel` → that IP. Then, from anywhere:

```bash
dig +short panel.kollegeapply.com
```

Do not continue until that returns the VM's IP.

## 2. Open the ports in Azure

This is the step people miss. The VM firewall is not the only gate — Azure's
**Network Security Group** sits in front of it.

Portal → your VM → Networking → Network settings → **Create port rule**
→ Inbound, and add TCP **80** and **443** from Any.

Or from the Azure CLI:

```bash
az vm open-port --resource-group <rg> --name <vm> --port 80  --priority 1010
az vm open-port --resource-group <rg> --name <vm> --port 443 --priority 1011
```

If `ufw` is active on the VM as well:

```bash
sudo ufw allow 'Nginx Full'
```

Do **not** open 8080. The gateway listens on localhost only as far as the
internet is concerned — nginx is the only thing that should reach it.

## 3. Node 20+

```bash
node -v
```

If that is missing or below 20.12:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## 4. A user and a home for it

```bash
sudo useradd --system --create-home --home-dir /opt/panel --shell /usr/sbin/nologin panel
```

## 5. Ship the code

From your laptop, in the project directory:

```bash
tar --exclude=node_modules --exclude=data --exclude=.env --exclude=.git \
    -czf /tmp/panel.tgz .
scp /tmp/panel.tgz azureuser@panel.kollegeapply.com:/tmp/
```

On the VM:

```bash
sudo tar -xzf /tmp/panel.tgz -C /opt/panel
cd /opt/panel
sudo -u panel npm ci --omit=dev
```

`npm ci` needs `package-lock.json`, which is in the archive. `--omit=dev` is
safe: every dependency the gateway runs on is a production one.

## 6. Configure

```bash
sudo -u panel tee /opt/panel/.env >/dev/null <<EOF
SESSION_SECRET=$(openssl rand -hex 32)
PORT=8080
SESSION_HOURS=12
TRUST_PROXY=1

BRAND=KollegeApply
WATERMARK_MODE=all
WATERMARK_OPACITY=0.17
DISABLE_COPY=1
BULK_MAX_PER_WINDOW=300
BULK_WINDOW_MINUTES=60

ADMIN_EMAIL=himanshu.rathore@kollegeapply.com
ADMIN_PASSWORD=<choose a strong one, 10+ characters>
EOF

sudo chmod 600 /opt/panel/.env
sudo mkdir -p /opt/panel/data
sudo chown -R panel:panel /opt/panel
```

`TRUST_PROXY=1` matters: it makes the audit log record real client IPs instead
of `127.0.0.1`, and marks session cookies `Secure`.

Check it before going further:

```bash
cd /opt/panel && sudo -u panel npm run doctor
```

Fix anything it marks `FAIL`.

## 7. Run it as a service

```bash
sudo cp /opt/panel/deploy/panel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now panel
sudo systemctl status panel --no-pager
```

It should report `active (running)`. Confirm locally:

```bash
curl -s localhost:8080/gw/health; echo
```

## 8. nginx

```bash
sudo cp /opt/panel/deploy/nginx-panel.conf /etc/nginx/sites-available/panel
sudo ln -s /etc/nginx/sites-available/panel /etc/nginx/sites-enabled/
sudo nginx -t
```

`nginx -t` must pass before you reload — a reload with a bad config on a box
that is already serving your CRM takes the CRM down too.

```bash
sudo systemctl reload nginx
curl -I http://panel.kollegeapply.com
```

## 9. TLS

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d panel.kollegeapply.com --redirect
```

certbot edits the nginx file to add the certificate and the port-80 redirect,
and installs a renewal timer. Verify:

```bash
curl -I https://panel.kollegeapply.com
systemctl list-timers | grep certbot
```

## 10. First sign-in

Open `https://panel.kollegeapply.com/login` and sign in with the `ADMIN_EMAIL`
and `ADMIN_PASSWORD` you set.

Then:

1. **Admin → Panels** — add NPF and NPF5 with the shared account and its
   password. Press **Test** on each.
2. **Admin → Users** — add your team. Leave "may download exports" off unless
   someone genuinely needs it.
3. Remove `ADMIN_PASSWORD` from `.env` (it is only read when no users exist) and
   `sudo systemctl restart panel`.
4. **Rotate the NPF panel passwords.** Until you do, every copy already
   circulating still works and the gateway is just another door, not the only
   one.

---

## Day to day

```bash
sudo systemctl restart panel        # after any code or .env change
sudo journalctl -u panel -f         # live logs
sudo journalctl -u panel --since today
cd /opt/panel && sudo -u panel npm run doctor    # config check
cd /opt/panel && sudo -u panel npm run verify    # sign in to every panel
```

Code changes need a restart — Node loads modules once at start.

### Updating

```bash
# laptop
tar --exclude=node_modules --exclude=data --exclude=.env --exclude=.git -czf /tmp/panel.tgz .
scp /tmp/panel.tgz azureuser@panel.kollegeapply.com:/tmp/

# VM
sudo tar -xzf /tmp/panel.tgz -C /opt/panel
cd /opt/panel
sudo -u panel npm ci --omit=dev
sudo chown -R panel:panel /opt/panel
sudo -u panel npm run doctor && sudo systemctl restart panel
```

The archive excludes `data` and `.env`, so an update never overwrites your users,
panels or configuration.

### Backups

`data/` holds everything: users, panels, audit log. `.env` holds the key that
decrypts the panel passwords. **Back up both, and keep them somewhere only you
can read** — together they are full access to your panels.

```bash
sudo tar -czf /root/panel-$(date +%F).tgz -C /opt/panel data .env
```

---

## When it will not come up

| Symptom | Cause | Fix |
|---|---|---|
| `curl localhost:8080` works, the domain does not | NSG still closed | Add the 80/443 inbound rules (step 2) |
| certbot fails to issue | DNS not pointing at the VM yet | `dig +short panel.kollegeapply.com` |
| `active (exited)` straight after start | config error | `journalctl -u panel -n 40` — the gateway prints a plain reason and exits |
| Everything logs in, no panels listed | panels not added yet | `/admin` → Panels |
| "Panel is temporarily unavailable" | shared panel credential wrong | `/admin` → Panels → **Test** |
| Audit log shows `127.0.0.1` for everyone | `TRUST_PROXY` not set | set `TRUST_PROXY=1`, restart |
| Signed out on every page load | `SESSION_SECRET` missing, so each restart changes it | set it in `.env` |

### If you later run more than one instance

Sessions and upstream tokens live in this process's memory. Two instances behind
a load balancer will sign people out at random. One VM is fine; if you ever scale
out, the gateway needs a shared store — it already supports Upstash over REST.
Azure Cache for Redis speaks the TCP protocol rather than REST, so that would
need a small driver added to `src/storage.js` first. Ask then.
