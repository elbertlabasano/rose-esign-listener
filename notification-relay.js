'use strict';

const path = require('node:path');
const { mkdirSync, existsSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const eventDatabase = path.join(__dirname, 'data', 'notifications', 'events.db');

function publishNotification(documentTitle, reference, options = {}) {
  const filename = options.filename || eventDatabase;
  const now = options.now || Date.now();
  mkdirSync(path.dirname(filename), { recursive: true });
  const database = new DatabaseSync(filename);
  try {
    database.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS notification_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_title TEXT NOT NULL,
        reference TEXT,
        mode TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`);
    const result = database.prepare(`INSERT INTO notification_events
      (document_title, reference, mode, created_at) VALUES (?, ?, ?, ?)`)
      .run(String(documentTitle), reference == null ? null : String(reference), options.mode || 'toast', now);
    database.prepare('DELETE FROM notification_events WHERE created_at < ?')
      .run(now - 7 * 24 * 60 * 60 * 1000);
    return Number(result.lastInsertRowid);
  } finally {
    database.close();
  }
}

function readEvents(after, filename = eventDatabase) {
  if (!existsSync(filename)) return [];
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout = 1000');
    return database.prepare('SELECT * FROM notification_events WHERE id > ? ORDER BY id LIMIT 100').all(after);
  } finally {
    database.close();
  }
}

function latestEventId(filename = eventDatabase) {
  if (!existsSync(filename)) return 0;
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    return database.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM notification_events').get().id;
  } finally {
    database.close();
  }
}

function createEventConsumer({ after, read = readEvents, save, notify, now = Date.now }) {
  let cursor = after;
  return function poll() {
    for (const event of read(cursor)) {
      // Save before display: a crash must not replay the same event on restart.
      // A crash between this save and the toast can lose a notification.
      save(event.id);
      cursor = event.id;
      if (event.created_at < now() - 10 * 60 * 1000) continue;
      notify(event.document_title, event.reference, undefined, { delivery: 'direct', mode: event.mode });
    }
  };
}

module.exports = { eventDatabase, publishNotification, readEvents, latestEventId, createEventConsumer };
