'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { mkdirSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { createUploader, signature: fileSignature } = require('./upload');
const { readConfig } = require('./config');
const { pruneArchives } = require('./archive');
const config = readConfig();
if (process.argv[2]) throw new Error('Configure watched folders and preparers in .env instead of command-line arguments.');

const databasePath = path.join(__dirname, 'data', 'listener.db');
mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(`
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS pdf_files (
    id INTEGER PRIMARY KEY,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    detected_at TEXT NOT NULL
  );
`);
const savePdf = database.prepare(`
  INSERT INTO pdf_files (filename, file_path, detected_at)
  VALUES (?, ?, ?)
  ON CONFLICT(file_path) DO UPDATE SET filename = excluded.filename
`);
process.on('exit', () => database.close());
const watchers = config.folders.map((settings) => ({
  ...settings,
  uploadPdf: createUploader(database, settings),
  files: new Map(),
  lastError: undefined,
  nextCleanupAt: 0
}));
const pollMs = 1000;
const stableMs = 2000;
let stopping = false;
let timer;

// Add your PDF processing here. The full path is available as filePath.
async function onPdfReady(filePath, signature, uploadPdf) {
  savePdf.run(path.basename(filePath), filePath, new Date().toISOString());
  return uploadPdf(filePath, signature);
}

async function scanFolder(watcher) {
  const { folder, files, uploadPdf } = watcher;
  if (Date.now() >= watcher.nextCleanupAt) {
    watcher.nextCleanupAt = Date.now() + 60 * 60 * 1000;
    try {
      const removed = await pruneArchives(folder);
      if (removed) console.log(`Retention cleanup: removed ${removed} archived PDFs from ${folder}.`);
    } catch (error) {
      console.error(`Archive cleanup failed for ${folder}: ${error.message}`);
    }
  }
  try {
    const entries = await fs.readdir(folder, { withFileTypes: true });
    const seen = new Set();
    for (const entry of entries) {
      if (stopping) break;
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.pdf') continue;
      const filePath = path.join(folder, entry.name);
      seen.add(filePath);
      let stat;
      try {
        stat = await fs.stat(filePath);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const signature = fileSignature(stat);
      const previous = files.get(filePath);
      if (!previous || previous.signature !== signature) {
        files.set(filePath, { signature, stableSince: Date.now(), handled: false });
        continue;
      }
      if (!previous.handled && Date.now() - previous.stableSince >= stableMs) {
        try {
          const handled = await onPdfReady(filePath, signature, uploadPdf);
          previous.handled = handled !== false;
        } catch (error) {
          console.error(`Failed to process ${filePath}: ${error.message}`);
        }
      }
    }
    for (const filePath of files.keys()) {
      if (!seen.has(filePath)) files.delete(filePath);
    }
    watcher.lastError = undefined;
  } catch (error) {
    const message = `Cannot scan ${folder}: ${error.message}`;
    if (message !== watcher.lastError) console.error(message);
    watcher.lastError = message;
  }
}

async function scan() {
  for (const watcher of watchers) {
    if (stopping) break;
    await scanFolder(watcher);
  }
  if (!stopping) timer = setTimeout(scan, pollMs);
}

for (const watcher of watchers) {
  console.log(`Watching: ${watcher.folder} | prepared by user ${watcher.user_id} | template ${watcher.template_id} | department ${watcher.department_id ?? 'assigned by backend'}`);
}
console.log(`SQLite database: ${databasePath}`);
console.log('Press Ctrl+C to stop.');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    clearTimeout(timer);
  });
}
scan();
