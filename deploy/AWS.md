# Deploying to AWS

Target: the gateway on an EC2 instance, behind nginx with a Let's Encrypt
certificate, managed by systemd. Same shape as the Azure runbook — what differs
is the first four steps, and they are the ones that bite.

The gateway uses ~76 MB of RSS under load and has three dependencies, all pure
JavaScript. No native modules means Graviton (ARM) works as well as x86 and
costs less, so these steps use it.

---

## Read this first if you are moving here to fix the 502

If the panel is 502-ing on Azure **because NoPaperForms is refusing that
server's IP**, moving to AWS will not fix it. An AWS address is a datacenter
address too; a vendor that blocks one range usually blocks both. You would
spend a day migrating and land on the same error with a different IP in it.

Confirm the cause before you migrate. On the Azure box:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://publisher.nopaperforms.com/
```

- `200` — the vendor is fine with that server. The 502 is something else and
  moving clouds will not help. Run `npm run reach` to find it.
- `403` — the vendor is blocking it. **The fix is an allowlist, not a new
  cloud.** Send NoPaperForms the server's public IP and ask them to permit it.
  If you move to AWS, send them the Elastic IP from step 2 instead.

There are good reasons to run this on your own AWS account — billing you
control, a box your tech team does not share with the CRM. "The other one gets
a 403" is not one of them.

---

## Which AWS service

**EC2** (or Lightsail, which is EC2 with fewer knobs). Not App Runner, not ECS
Fargate, not Lambda.

The gateway keeps sign-in sessions and the upstream panel tokens in process
memory, and users, panels and the audit log in `data/` on disk. The serverless
options give you neither a stable process nor a writable disk, and they scale
to more than one instance by design — which here means people being signed out
at random as requests land on different copies. The gateway can run that way,
but it needs a shared store first (`src/storage.js` speaks Upstash over REST;
ElastiCache is TCP and would need a driver added).

One small instance is the right answer for a tool used by a team.

| Option | Spec | Roughly |
|---|---|---|
| EC2 `t4g.small` | 2 vCPU ARM, 2 GB | ~$12/mo + ~$2 storage |
| EC2 `t3.micro` | 2 vCPU x86, 1 GB | free for 12 months on a new account, then ~$8/mo |
| Lightsail 2 GB | fixed price, static IP and transfer included | $12/mo |

Check the current prices — these move. 1 GB is enough to run it; give it 1 GB
of swap if you go that small, because `npm ci` is the heaviest thing that will
ever happen on the box.

Pick **ap-south-1 (Mumbai)** unless you have a reason not to. NoPaperForms
serves from there, and so is your team.

---

## 1. Launch the instance

EC2 → Launch instance.

- **Name**: `panel`
- **AMI**: Ubuntu Server 24.04 LTS — pick the **arm64** image for `t4g`, x86 for `t3`
- **Instance type**: `t4g.small`
- **Key pair**: create one, download the `.pem`, `chmod 400` it. You cannot
  download it twice.
- **Storage**: 20 GB gp3. The 8 GB default fills up once journald has been
  running a while.
- **Security group**: create new — see step 3 before you accept the defaults.

## 2. Elastic IP — do not skip this

A fresh EC2 instance gets a public IP that **changes every time it stops and
starts**. When that happens your DNS points at someone else's server, TLS
renewal fails, and any IP you gave NoPaperForms is no longer yours.

EC2 → Elastic IPs → **Allocate**, then **Actions → Associate** with the
instance.

```bash
# on the instance, confirm what the world sees
curl -s ifconfig.me; echo
```

That address is the one that goes in DNS and in any allowlist request.

## 3. Security group

Inbound:

| Port | Source | Why |
|---|---|---|
| 22 | **your IP only** (`My IP`) | SSH. Leaving this open to `0.0.0.0/0` means a password-guessing bot inside the hour. |
| 80 | Anywhere | certbot's HTTP challenge, and the redirect to 443 |
| 443 | Anywhere | the panel itself |

Do **not** open 8080. nginx is the only thing that should reach the gateway.

Outbound: the default is allow-all, which is what you want. **If your account
has a locked-down default, the gateway needs outbound 443** — it fetches the
vendor's app and API on every request. A missing outbound rule here is exactly
the 502 at the top of this document.

## 4. DNS

An `A` record for your subdomain pointing at the Elastic IP. If
`kollegeapply.com` is on Route 53, do it there; if it is with another
registrar, do it there — AWS does not need to host your DNS.

```bash
dig +short panel.kollegeapply.com
```

Do not continue until that returns the Elastic IP. certbot will fail otherwise,
and Let's Encrypt rate-limits failed attempts.

## 5. Connect

```bash
ssh -i ~/panel-key.pem ubuntu@panel.kollegeapply.com
```

Ubuntu AMIs log in as `ubuntu`, not `ec2-user` — that is Amazon Linux.

## 6. Node 20+

```bash
node -v    # Ubuntu 24.04 ships 18, which is too old
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Add swap if you are on a 1 GB instance:

```bash
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 7. A user and a home for it

No `--create-home`: that copies `/etc/skel` in, and the next step wants the
directory to be ours.

```bash
sudo useradd --system --home-dir /opt/panel --shell /usr/sbin/nologin panel
sudo mkdir -p /opt/panel && sudo chown panel:panel /opt/panel
```

## 8. Ship the code

The repo is private, so the server needs a credential to read it. A **deploy
key** is the right one — read-only and scoped to this single repository, so a
compromised server cannot push to it.

Note the `-H` on every command below. Without it `sudo` keeps *your* `HOME`,
ssh looks for the key in `/home/ubuntu/.ssh`, and you get a confusing
permission denied from GitHub.

```bash
sudo -u panel mkdir -p /opt/panel/.ssh && sudo chmod 700 /opt/panel/.ssh
sudo -H -u panel ssh-keygen -t ed25519 -N '' -C 'panel deploy key' \
     -f /opt/panel/.ssh/id_ed25519
sudo -H -u panel bash -c 'ssh-keyscan -t ed25519 github.com >> /opt/panel/.ssh/known_hosts'
sudo cat /opt/panel/.ssh/id_ed25519.pub
```

Paste that public key into GitHub → the `panel` repo → Settings → Deploy keys →
**Add deploy key**. Leave "Allow write access" unchecked.

`/opt/panel` is not empty now, so `git clone` would refuse. Point an empty repo
at the remote instead — the result is an ordinary checkout that `git pull`
updates:

```bash
sudo -H -u panel git -C /opt/panel init -q
sudo -H -u panel git -C /opt/panel remote add origin git@github.com:hrathor19/panel.git
sudo -H -u panel git -C /opt/panel fetch -q origin main
sudo -H -u panel git -C /opt/panel checkout -q -b main --track origin/main
cd /opt/panel && sudo -u panel npm ci --omit=dev
```

No GitHub access from the box? Copy it up instead — simpler, but then every
update is another `scp`:

```bash
# laptop
tar --exclude=node_modules --exclude=data --exclude=.env --exclude=.git \
    -czf /tmp/panel.tgz .
scp -i ~/panel-key.pem /tmp/panel.tgz ubuntu@panel.kollegeapply.com:/tmp/
# instance
sudo tar -xzf /tmp/panel.tgz -C /opt/panel && sudo chown -R panel:panel /opt/panel
cd /opt/panel && sudo -u panel npm ci --omit=dev
```

## 9. Configure

**Panel passwords are encrypted with `SESSION_SECRET`.** User accounts are
bcrypt hashes and do not depend on it; stored panel passwords do.

| If you… | Then… |
|---|---|
| Generate a **new** secret here | Fresh start. Re-enter the panel passwords in `/admin`. |
| Copy `.env` and `data/` from the Azure box | Everything carries over — users, panels, audit log. |

Migrating rather than starting fresh:

```bash
# Azure box
sudo tar -czf /tmp/carry.tgz -C /opt/panel data .env
# then scp it across, and on the AWS instance:
sudo tar -xzf /tmp/carry.tgz -C /opt/panel && sudo chown -R panel:panel /opt/panel
```

Starting fresh:

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

`TRUST_PROXY=1` matters behind nginx: without it every row in the audit log
says `127.0.0.1`, and session cookies are not marked `Secure`.

Check before going further:

```bash
cd /opt/panel && sudo -u panel npm run doctor
```

Fix anything marked `FAIL`.

## 10. Run it as a service

```bash
sudo cp /opt/panel/deploy/panel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now panel
sudo systemctl status panel --no-pager
curl -s localhost:8080/gw/health; echo
```

Then prove the box can reach the vendor, before nginx and TLS muddy the
picture. No panels are configured yet, so check the origin directly:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://publisher.nopaperforms.com/
```

`200` and you are clear. Anything else, fix it here — there is only one thing
in the way at this point, and the table at the end of this file says which.
Once panels are added in step 13, `npm run reach` tests the whole chain.

## 11. nginx

```bash
sudo apt-get install -y nginx
sudo cp /opt/panel/deploy/nginx-panel.conf /etc/nginx/sites-available/panel
sudo ln -s /etc/nginx/sites-available/panel /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
curl -I http://panel.kollegeapply.com
```

Edit `server_name` in that file first if your subdomain differs.

## 12. TLS

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d panel.kollegeapply.com --redirect
curl -I https://panel.kollegeapply.com
systemctl list-timers | grep certbot
```

## 13. First sign-in

Open `https://panel.kollegeapply.com/login` with the `ADMIN_EMAIL` and
`ADMIN_PASSWORD` from step 9.

1. **Admin → Panels** — add each NPF panel, press **Test** on each. Then, on
   the box, `cd /opt/panel && sudo -u panel npm run reach` — every line should
   say `ok`.
2. **Admin → Users** — add the team. Leave "may download exports" off unless
   someone genuinely needs it.
3. Remove `ADMIN_PASSWORD` from `.env` (read only when no users exist) and
   `sudo systemctl restart panel`.
4. Now that you are on HTTPS, set `LOCATION_MODE=capture` and restart —
   browsers refuse geolocation outside a secure context, which is why it is off
   by default.
5. **Rotate the NPF panel passwords.** Until you do, every copy already
   circulating still works and the gateway is one door of several.

---

## Day to day

```bash
sudo systemctl restart panel                     # after any code or .env change
sudo journalctl -u panel -f                      # live logs
cd /opt/panel && sudo -u panel npm run doctor    # config check
cd /opt/panel && sudo -u panel npm run verify    # sign in to every panel
cd /opt/panel && sudo -u panel npm run reach     # why a panel will not open
```

### Updating

With the deploy key in place:

```bash
sudo -H -u panel git -C /opt/panel pull
cd /opt/panel && sudo -u panel npm ci --omit=dev
sudo -u panel npm run doctor && sudo systemctl restart panel
```

`data/` and `.env` are gitignored, so a pull never touches your users, panels
or configuration.

### Backups

`data/` holds users, panels and the audit log. `.env` holds the key that
decrypts the panel passwords. Together they are full access to your panels —
back up both, keep them where only you can read them.

```bash
sudo tar -czf /root/panel-$(date +%F).tgz -C /opt/panel data .env
```

An EBS snapshot (EC2 → Volumes → Actions → Create snapshot, or a Data Lifecycle
Manager policy for a daily one) covers the whole disk and is worth having as
well — but it is a disk image, not something you can read a user out of. Keep
the tarball too.

---

## When it will not come up

| Symptom | Cause | Fix |
|---|---|---|
| SSH times out | security group has no 22 from your IP, or your IP changed | EC2 → Security groups → edit inbound |
| `curl localhost:8080` works, the domain does not | 80/443 not open | security group inbound rules (step 3) |
| Worked yesterday, wrong server today | no Elastic IP — the instance restarted and changed address | step 2 |
| certbot fails to issue | DNS not pointing at the Elastic IP yet | `dig +short panel.kollegeapply.com` |
| 502, and `reach` says `ETIMEDOUT` | outbound 443 blocked | security group outbound rule |
| 502, and `reach` says `HTTP 403` | the vendor is blocking this IP | send them the Elastic IP to allowlist |
| `active (exited)` right after start | config error | `journalctl -u panel -n 40` — it prints a plain reason and exits |
| Signed out on every page load | `SESSION_SECRET` unset, so it changes each restart | set it in `.env` |
| Audit log shows `127.0.0.1` for everyone | `TRUST_PROXY` not set | `TRUST_PROXY=1`, restart |
| Panels listed but none open after a migration | new `SESSION_SECRET`, old stored passwords | re-enter them in `/admin` |

## If you run AWS and Azure at the same time

They are two separate installations. Users, sessions and the audit log do not
sync, so an account added on one does not exist on the other, and a sign-in on
one is invisible in the other's forensics. Both hold a copy of the panel
credentials, and both need whatever allowlisting the vendor requires.

That is fine as a staged migration — stand AWS up, move people over, turn Azure
off. It is a poor steady state. Pick one and point DNS at it.
