'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { publishNotification, readEvents, latestEventId, createEventConsumer } = require('./notification-relay');

test('relay works with a read-only SQLite reader, independent user cursors and no replay', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-relay-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const filename = path.join(folder, 'events.db');
  const now = 10000000;
  assert.deepEqual(readEvents(0, filename), []);
  assert.equal(latestEventId(filename), 0);
  const first = publishNotification('PO 123', 'RRC-123', { filename, now });
  assert.equal(latestEventId(filename), first);
  const userA = [], userB = [];
  let cursorA = 0, cursorB = 0;
  const make = (cursor, save, shown) => createEventConsumer({
    after: cursor, read: id => readEvents(id, filename), now: () => now,
    save, notify: (title, reference, send, options) => {
      assert.equal(options.delivery, 'direct');
      shown.push([title, reference]);
    }
  });
  const a = make(0, id => { cursorA = id; }, userA);
  const b = make(0, id => { cursorB = id; }, userB);
  a(); a(); b();
  assert.deepEqual(userA, [['PO 123', 'RRC-123']]);
  assert.deepEqual(userB, userA);
  assert.equal(cursorA, first);
  assert.equal(cursorB, first);
  const second = publishNotification('PO 124', null, { filename, now });
  make(cursorA, id => { cursorA = id; }, userA)();
  assert.equal(userA.length, 2);
  assert.equal(cursorA, second);
});

test('skips stale events, does not display when cursor persistence fails, and bounds retention', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'esign-relay-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const filename = path.join(folder, 'events.db');
  const now = 8 * 24 * 60 * 60 * 1000;
  publishNotification('Too old', null, { filename, now: 1 });
  const stale = publishNotification('Stale', null, { filename, now: now - 11 * 60 * 1000 });
  const fresh = publishNotification('Fresh', 'REF', { filename, now });
  const rows = readEvents(0, filename);
  assert.equal(rows.length, 2);
  let cursor = 0;
  const shown = [];
  createEventConsumer({ after: 0, read: id => readEvents(id, filename), now: () => now,
    save: id => { cursor = id; }, notify: title => shown.push(title) })();
  assert.deepEqual(shown, ['Fresh']);
  assert.equal(cursor, fresh);
  assert.throws(createEventConsumer({ after: stale, read: id => readEvents(id, filename),
    save: () => { throw new Error('Disk full'); }, notify: () => assert.fail('Must not display') }), /Disk full/);
});
