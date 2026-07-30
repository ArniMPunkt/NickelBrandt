'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  insertPoolSongs,
  insertPoolSongsOrRollback,
  rollbackCreatedPool,
} = require('../scripts/upload-song-pool');

function createSupabaseDouble(options = {}) {
  const calls = [];
  const client = {
    calls,
    from(table) {
      calls.push({ table, op: 'from' });
      if (table === 'pool_songs') {
        return {
          insert(rows) {
            calls.push({ table, op: 'insert', rows });
            return {
              async select(columns) {
                calls.push({ table, op: 'select', columns });
                return {
                  data: options.insertData || rows.map((_, index) => ({ id: `song-${index}` })),
                  error: options.insertError || null,
                };
              },
            };
          },
        };
      }
      if (table === 'song_pools') {
        return {
          delete() {
            calls.push({ table, op: 'delete' });
            return {
              async eq(column, value) {
                calls.push({ table, op: 'eq', column, value });
                return { error: options.rollbackError || null };
              },
            };
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
  return client;
}

test('insertPoolSongs writes all songs in one bulk insert', async () => {
  const supabase = createSupabaseDouble();
  const written = await insertPoolSongs(supabase, [
    { title: 'One' },
    { title: 'Two' },
  ]);

  assert.equal(written, 2);
  assert.deepEqual(supabase.calls.map((call) => `${call.table}:${call.op}`), [
    'pool_songs:from',
    'pool_songs:insert',
    'pool_songs:select',
  ]);
});

test('insertPoolSongs throws instead of retrying row-by-row on bulk error', async () => {
  const supabase = createSupabaseDouble({
    insertError: { message: 'constraint failed' },
  });

  await assert.rejects(
    () => insertPoolSongs(supabase, [{ title: 'One' }]),
    /Failed to insert pool_songs: constraint failed/
  );
  assert.equal(
    supabase.calls.filter((call) => call.table === 'pool_songs' && call.op === 'insert').length,
    1
  );
});

test('rollbackCreatedPool deletes the created pool row', async () => {
  const supabase = createSupabaseDouble();
  await rollbackCreatedPool(supabase, 'pool-1');

  assert.deepEqual(supabase.calls.map((call) => `${call.table}:${call.op}`), [
    'song_pools:from',
    'song_pools:delete',
    'song_pools:eq',
  ]);
  assert.equal(supabase.calls[2].column, 'id');
  assert.equal(supabase.calls[2].value, 'pool-1');
});

test('insertPoolSongsOrRollback deletes created pool when song insert fails', async () => {
  const supabase = createSupabaseDouble({
    insertError: { message: 'network broke' },
  });

  await assert.rejects(
    () => insertPoolSongsOrRollback(supabase, 'pool-2', [{ title: 'One' }]),
    /Failed to insert pool_songs: network broke/
  );

  assert.equal(
    supabase.calls.some((call) =>
      call.table === 'song_pools' &&
      call.op === 'eq' &&
      call.column === 'id' &&
      call.value === 'pool-2'
    ),
    true
  );
});
