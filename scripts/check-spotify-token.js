/**
 * Isolated Spotify reachability check — run this when precheck-song-pool.js seems
 * to hang before the first "Spotify x/N" line.
 *
 *   node scripts/check-spotify-token.js
 *
 * It (1) confirms the Spotify creds are present (never prints them), (2) requests
 * a Client-Credentials token with a hard 20s timeout, and (3) does one test
 * search. Any stall now fails loudly instead of hanging forever.
 */
'use strict';
const path = require('path');
const { loadEnv, need } = require('./lib/util');

try {
  require('dns').setDefaultResultOrder('ipv4first');
} catch {
  /* older Node -> ignore */
}

loadEnv(path.join(__dirname, '.env'));

if (typeof fetch === 'undefined') {
  console.error('Need Node 18+ (global fetch missing).');
  process.exit(1);
}

const TIMEOUT_MS = 20000;
async function fetchWithTimeout(url, opts = {}, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`timed out after ${ms}ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

(async () => {
  const id = need('SPOTIFY_CLIENT_ID');
  const secret = need('SPOTIFY_CLIENT_SECRET');
  console.log(`CLIENT_ID length: ${id.length} | CLIENT_SECRET present: ${!!secret}`);

  console.log('Requesting client-credentials token (timeout 20s)…');
  const t0 = Date.now();
  let res;
  try {
    res = await fetchWithTimeout('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
  } catch (e) {
    console.error(`\nTOKEN REQUEST FAILED: ${e.message}`);
    console.error('-> Connectivity problem (DNS / IPv6 / firewall / proxy), NOT a list-size issue.');
    console.error('   Try another network, or check a proxy/VPN. The precheck now times out instead of hanging.');
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Token HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const data = await res.json();
  console.log(
    `Token OK in ${Date.now() - t0}ms (expires_in=${data.expires_in}s, token length=${(data.access_token || '').length}).`
  );

  console.log('Test search “Bohemian Rhapsody / Queen”…');
  const q = encodeURIComponent('track:"Bohemian Rhapsody" artist:"Queen"');
  const r2 = await fetchWithTimeout(`https://api.spotify.com/v1/search?type=track&limit=1&q=${q}`, {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  if (!r2.ok) {
    console.error(`Search HTTP ${r2.status}: ${await r2.text()}`);
    process.exit(1);
  }
  const hit = (await r2.json())?.tracks?.items?.[0];
  console.log(hit ? `Search OK -> ${hit.name} — ${hit.artists?.[0]?.name} (${hit.id})` : 'Search returned no items');
  console.log('\n✅ Spotify is reachable. If precheck previously hung, it was the missing timeout (now added).');
})();
