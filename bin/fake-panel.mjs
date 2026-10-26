// A stand-in for a NoPaperForms publisher panel: serves an Angular-shaped
// shell plus the API behind it, and records which access-token it is handed.
import { createServer } from 'node:http';
import { decryptPayload } from '../src/npf-crypto.js';

export function startFakePanel({ port, accessKey, rek, username, password, token }) {
  const seen = [];

  const bundle = `
    var env={production:!0,accessKey:"${accessKey}",request_encryption_key:"${rek}",
    rememberCookieExpireTime:36e6,apiBaseUrl:"http://localhost:${port}/",mode:"web",
    appType:"publisher",cookiePath:"/",unAuthorisedCode:401,environment:"live"};
    var urls={loginURL:"users/v3/login"};
  `;

  const index = `<!doctype html><html><head><meta charset="utf-8">
<base href="/"><title>Publisher Panel</title>
<link rel="stylesheet" href="styles.aaa111.css"></head>
<body><app-root></app-root>
<script type="text/javascript" src="main.abc123.js"></script></body></html>`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const got = req.headers['access-token'] ?? null;
    seen.push({ path: url.pathname, token: got });

    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type });
      res.end(body);
    };

    if (url.pathname === '/') return send(200, 'text/html', index);
    if (url.pathname === '/main.abc123.js') return send(200, 'application/javascript', bundle);
    if (url.pathname === '/styles.aaa111.css') return send(200, 'text/css', 'body{color:red}');

    if (url.pathname === '/users/v3/login') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let creds;
      try {
        creds = JSON.parse(decryptPayload(Buffer.concat(chunks).toString('utf8'), rek));
      } catch {
        return send(200, 'application/json', JSON.stringify({ status: 0, message: 'could not decrypt' }));
      }
      if (creds.email !== username || creds.password !== password) {
        return send(200, 'application/json', JSON.stringify({ code: 604, status: 0, message: 'Entered email id or password is incorrect.' }));
      }
      return send(200, 'application/json', JSON.stringify({
        status: 1, data: { accessToken: token, userId: 'np-1', name: 'Ops', mobile: '' },
      }));
    }

    if (got !== token) {
      return send(401, 'application/json', JSON.stringify({ status: 0, message: 'Unauthorised' }));
    }

    // The institute list the dropdown is built from: an object map, as the
    // real panel returns it.
    if (url.pathname === '/publishers/v1/collegeList/') {
      return send(200, 'application/json', JSON.stringify({
        status: 1,
        data: { colleges: { 101: 'Alpha University', 102: 'Beta Institute', 103: 'Gamma College' } },
      }));
    }

    // Everything else echoes what it was asked for, so a test can prove the
    // gateway either forwarded or refused.
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    if (raw) { try { body = JSON.parse(decryptPayload(raw, rek)); } catch { body = 'unreadable'; } }
    seen[seen.length - 1].body = body;
    if (url.pathname.includes('download')) {
      res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename=leads.csv' });
      return res.end('name,email\nLead One,l1@x.com');
    }
    return send(200, 'application/json', JSON.stringify({ status: 1, data: { menu: ['Dashboard', 'Leads'], panel: port } }));
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, seen, origin: `http://localhost:${port}` }));
  });
}
