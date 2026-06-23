/**
 * Isolated Supabase write check — run this instead of the full 201-song import
 * while diagnosing the "permission denied for table song_pools" error.
 *
 *   node scripts/check-supabase-key.js
 *
 * It (1) reports the key's format/role WITHOUT printing the key, and (2) attempts
 * a single dummy insert into song_pools, then deletes it. Never logs the secret.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Minimal .env loader (same as the import script).
(function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
})(path.join(__dirname, '.env'));

const url = process.env.SUPABASE_URL || '';
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// --- Diagnose the key without revealing it ---
const fmt = key.startsWith('sb_secret_')
  ? 'NEW secret key (service_role) ✓'
  : key.startsWith('sb_publishable_')
    ? 'NEW publishable key (anon — WRONG kind) ✗'
    : key.startsWith('eyJ')
      ? 'legacy JWT'
      : '(empty / unknown) ✗';
console.log('SUPABASE_URL present:', !!url);
console.log('key length:', key.length, '| prefix:', JSON.stringify(key.slice(0, 12)), '| format:', fmt);
if (key.startsWith('eyJ')) {
  try {
    const seg = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const role = JSON.parse(Buffer.from(seg, 'base64').toString()).role;
    console.log('JWT role claim:', role, role === 'service_role' ? '✓' : '✗ (needs service_role)');
  } catch {
    console.log('could not decode JWT payload');
  }
}

// --- Attempt one isolated write ---
(async () => {
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase
    .from('song_pools')
    .insert({ name: '__diag_test__', description: 'delete me' })
    .select()
    .single();
  if (error) {
    console.log('\nINSERT FAILED:', error.code || '', '-', error.message);
    console.log(
      error.message && error.message.includes('permission denied')
        ? '-> GRANT-level denial. If the key above is service_role/sb_secret_, the table is missing grants (see remedy).'
        : error.message && error.message.includes('row-level security')
          ? '-> RLS rejection (so grants DO exist; the key is resolving to anon — use the service_role/secret key).'
          : '-> see message above.'
    );
    process.exit(1);
  }
  console.log('\nINSERT OK (id=' + data.id + ') — cleaning up…');
  await supabase.from('song_pools').delete().eq('id', data.id);
  console.log('Cleanup done. Service-role write works. ✅');
})();
