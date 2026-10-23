# Handover: deploying the Panel Gateway

For whoever is setting this up on Azure. The full runbook is
[AZURE.md](AZURE.md); this page is what you need to know before starting.

## What this is

Staff sign in here with their own passwords and get the NoPaperForms publisher
panel with a shared vendor account already signed in. The vendor password never
reaches a browser. The point of the whole thing is that fewer people hold that
credential.

## You do not need the NPF panel passwords

This matters, so it is first.

Deploy the code and get the service running. **Do not ask for the NoPaperForms
credentials.** Once the gateway is up, the business owner signs in and adds the
panels himself through Admin → Panels. The deployment works end to end without
anyone on the technical side seeing a vendor password.

One honest caveat: root on the VM can read `.env` and `data/`, and those two
together decrypt the stored panel passwords. This separation is about not
*handing out* credentials, not about defending against your own sysadmin. The
people with root should be people the business would trust with the password
anyway.

## What is in the repo, and what is not

| In the repo | Not in the repo — never commit it |
|---|---|
| All source, `deploy/`, `views/` | `.env` — contains `SESSION_SECRET` |
| `.env.example` as a template | `data/` — users, panels, audit log |
| `package-lock.json` | `node_modules/` |

`.gitignore` already covers all three. If you see `.env` or `data/` in
`git status`, stop and fix it before pushing.

## What you need from the business

- An Azure VM with SSH access, and permission to edit its Network Security Group
- DNS control for the subdomain (`panel.kollegeapply.com`)
- An email address for the first administrator account

That is all. No vendor credentials.

## Generate the secret on the server

```bash
openssl rand -hex 32
```

Do not reuse one from a laptop or another environment, and do not put it in the
repo, a ticket, or a chat message.

`SESSION_SECRET` signs sessions **and encrypts the stored panel passwords**.
Changing it later makes saved panel passwords unreadable and they have to be
re-entered. Set it once, before any panels are added, and include it in whatever
you back up.

## Shape of the deployment

```
browser ──HTTPS──► nginx (443) ──HTTP──► gateway (127.0.0.1:8080) ──► NoPaperForms
                   certbot TLS           systemd: npf-gateway
```

- Node 20.12+, three dependencies, none of which compile
- ~76 MB RSS under load; the systemd unit caps it at 320 MB
- State is files under `/opt/npf-gateway/data` — no database
- Port 8080 is localhost-facing only. Do not open it in the NSG.

## Single instance only

Sessions and upstream tokens live in this process's memory. Two instances behind
a load balancer will sign people out at random. Run exactly one. If it ever has
to scale out, the storage layer already supports a shared backend over REST
(`src/storage.js`) — Azure Cache for Redis speaks TCP rather than REST, so that
would need a small driver added first.

## Verifying you are done

```bash
cd /opt/npf-gateway && sudo -u npfgw npm run doctor
```

Everything should be `ok`, with at most a warning that no panels are configured
yet — that is expected; the owner adds those.

Then hand over:

- the URL
- the first administrator email and its one-time password
- a note to change it at `/account` and to remove `ADMIN_PASSWORD` from `.env`
  afterwards, then restart

## Back these up

`data/` and `.env`, together, and somewhere restricted — between them they are
full access to the panels.

```bash
sudo tar -czf /root/npf-gateway-$(date +%F).tgz -C /opt/npf-gateway data .env
```

## Running the tests

```bash
npm test
```

102 end-to-end tests against two stand-in panels in a throwaway directory. No
real credentials, no network to NoPaperForms, nothing touched in `data/`. Safe
to run anywhere, including on the server.
