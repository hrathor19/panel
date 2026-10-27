// Turns a User-Agent string into something a person can read in an audit list.
//
// It is a hint, not evidence: a User-Agent is set by the client and can say
// anything. It is useful for "this sign-in came from a Windows machine when
// Priya only ever uses a Mac", not for proving what someone ran.

const BROWSERS = [
  [/Edg(?:e|A|iOS)?\/([\d.]+)/, 'Edge'],
  [/OPR\/([\d.]+)/, 'Opera'],
  [/SamsungBrowser\/([\d.]+)/, 'Samsung Internet'],
  [/Firefox\/([\d.]+)/, 'Firefox'],
  [/CriOS\/([\d.]+)/, 'Chrome'],
  [/Chrome\/([\d.]+)/, 'Chrome'],
  [/Version\/([\d.]+).*Safari/, 'Safari'],
  [/Safari\/([\d.]+)/, 'Safari'],
];

const PLATFORMS = [
  [/Windows NT 10\.0/, 'Windows 10/11'],
  [/Windows NT 6\.3/, 'Windows 8.1'],
  [/Windows NT 6\.1/, 'Windows 7'],
  [/Windows/, 'Windows'],
  [/iPhone OS ([\d_]+)/, 'iOS'],
  [/iPad.*OS ([\d_]+)/, 'iPadOS'],
  [/Mac OS X ([\d_.]+)/, 'macOS'],
  [/Android ([\d.]+)/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

export function describeDevice(userAgent = '') {
  const ua = String(userAgent);

  let browser = 'Unknown browser';
  let browserVersion = '';
  for (const [pattern, name] of BROWSERS) {
    const hit = ua.match(pattern);
    if (hit) {
      browser = name;
      browserVersion = (hit[1] ?? '').split('.')[0];
      break;
    }
  }

  let os = 'Unknown OS';
  let osVersion = '';
  for (const [pattern, name] of PLATFORMS) {
    const hit = ua.match(pattern);
    if (hit) {
      os = name;
      osVersion = (hit[1] ?? '').replace(/_/g, '.');
      break;
    }
  }

  const kind = /iPad|Tablet/i.test(ua) ? 'Tablet'
    : /Mobi|iPhone|Android/i.test(ua) ? 'Phone'
      : 'Computer';

  const label = [browser, browserVersion].filter(Boolean).join(' ')
    + ' on '
    + [os, os === 'macOS' || os === 'iOS' || os === 'Android' ? osVersion : ''].filter(Boolean).join(' ').trim();

  return { browser, browserVersion, os, osVersion, kind, label, userAgent: ua.slice(0, 400) };
}

// A stable-ish handle for "the same machine and browser as last time". Only as
// good as the User-Agent, which is why it is used to flag a change rather than
// to authorise anything.
export function deviceFingerprint(userAgent, extra = {}) {
  const d = describeDevice(userAgent);
  return [d.browser, d.os, d.kind, extra.screen ?? '', extra.timezone ?? ''].join('|');
}
