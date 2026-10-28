'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { manilaDate, archivePdf, pruneArchives } = require('./archive');
const { signature } = require('./upload');

test('Manila processing date crosses midnight independently of the host timezone', () => {
  assert.equal(manilaDate(new Date('2026-10-27T15:59:59Z')), '2026-10-27');
  assert.equal(manilaDate(new Date('2026-10-27T16:00:00Z')), '2026-10-28');
});

test('archives without overwriting collisions and recovers an interrupted move', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-archive-'));
  try {
    const source = path.join(folder, 'input.pdf');
    const now = new Date('2026-10-28T00:00:00Z');
    const directory = path.join(folder, '2026-10-28', 'created');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, '31164-Vendor.pdf'), 'existing file');
    await fs.writeFile(source, 'PDF contents');
    const hash = createHash('sha256').update('PDF contents').digest('hex');
    let saved;
    const archived = await archivePdf({ source, filename: '31164-Vendor.pdf', category: 'created', hash,
      expectedSignature: signature(await fs.stat(source)), remember: (value) => { saved = value; }, now });
    assert.equal(path.basename(archived), '31164-Vendor (1).pdf');
    assert.equal(saved, archived);
    assert.equal(await fs.readFile(path.join(directory, '31164-Vendor.pdf'), 'utf8'), 'existing file');
    assert.equal(await fs.readFile(archived, 'utf8'), 'PDF contents');
    await assert.rejects(fs.access(source), { code: 'ENOENT' });
    // Simulate a crash after the exclusive copy but before unlinking the source.
    await fs.writeFile(source, 'PDF contents');
    const resumed = await archivePdf({ source, filename: '31164-Vendor.pdf', category: 'created', hash,
      expectedSignature: signature(await fs.stat(source)), destination: saved, remember: () => {}, now });
    assert.equal(resumed, archived);
    await assert.rejects(fs.access(source), { code: 'ENOENT' });
    // A saved destination outside the watched folder is rejected before moving.
    await fs.writeFile(source, 'PDF contents');
    await assert.rejects(archivePdf({ source, filename: '31164-Vendor.pdf', category: 'created', hash,
      destination: path.join(folder, '..', 'outside.pdf'), remember: () => {}, now }), /inside the watched folder/);
    await fs.access(source);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('retains today plus six Manila dates and never deletes pending or unrelated files', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-retention-'));
  try {
    const put = async (relative) => {
      const file = path.join(folder, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'keep or expire');
      return file;
    };
    const oldCreated = await put('2026-10-21/created/old.pdf');
    const oldDuplicate = await put('2026-10-21/already-exists/old.PDF');
    const keep = await Promise.all([
      put('2026-10-22/created/boundary.pdf'), put('2026-10-28/already-exists/today.pdf'),
      put('pending.pdf'), put('2026-10-21/other/unrelated.pdf'),
      put('2026-10-21/created/notes.txt'), put('2026-10-21/created/subfolder/keep.pdf'),
      put('2026-02-30/created/invalid-date.pdf'), put('2026-10-29/created/future.pdf')
    ]);
    assert.equal(await pruneArchives(folder, new Date('2026-10-27T16:00:00Z')), 2);
    await assert.rejects(fs.access(oldCreated), { code: 'ENOENT' });
    await assert.rejects(fs.access(oldDuplicate), { code: 'ENOENT' });
    for (const file of keep) await fs.access(file);
    assert.equal(await pruneArchives(folder, new Date('2026-10-27T16:00:00Z')), 0);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
