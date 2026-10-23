// Panel APIs sit behind a filter that rejects requests which don't look like
// they came from the panel's own front end — a bare fetch() gets "Forbidden".
// These are the headers a real browser running the app would send. Origin and
// Referer are added per panel by the caller, since they differ per panel.
export const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
};
