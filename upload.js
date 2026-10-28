'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { extractPdfMetadata } = require('./pdf-metadata');
const { notifyRequestCreated } = require('./notifications');

function signature(stat) {
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function isDuplicateTitle(status, payload) {
  if (![409, 422].includes(status) || !payload || typeof payload !== 'object') return false;
  const duplicate = /already\s+(?:been\s+)?(?:taken|exists?|used)|duplicate/i;
  const titleErrors = payload.errors?.document_title;
  const messages = Array.isArray(titleErrors) ? titleErrors : [titleErrors];
  if (messages.some((message) => typeof message === 'string' && duplicate.test(message))) return true;
  if (['document_title_exists', 'duplicate_document_title'].includes(String(payload.code).toLowerCase())) return true;
  return typeof payload.message === 'string' &&
    /document[ _-]+title/i.test(payload.message) && duplicate.test(payload.message);
}

function createUploader(database, config, extractMetadata = extractPdfMetadata, notifyCreated = notifyRequestCreated) {
  if (!config.token || !config.url || !config.user_id || !config.template_id) {
    throw new Error('Complete API_URL, API_TOKEN, USER_ID_n, and TEMPLATE_ID in .env.');
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS pdf_uploads (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL,
      filename TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      document_title TEXT NOT NULL,
      status TEXT NOT NULL,
      http_status INTEGER,
      response_body TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      uploaded_at TEXT,
      deleted_at TEXT,
      UNIQUE(file_path, content_hash)
    );
  `);
  if (!database.prepare('PRAGMA table_info(pdf_uploads)').all().some((column) => column.name === 'next_retry_at')) {
    database.exec('ALTER TABLE pdf_uploads ADD COLUMN next_retry_at INTEGER');
  }
  if (!database.prepare('PRAGMA table_info(pdf_uploads)').all().some((column) => column.name === 'po_metadata')) {
    database.exec('ALTER TABLE pdf_uploads ADD COLUMN po_metadata TEXT');
  }
  const saveMetadata = database.prepare('UPDATE pdf_uploads SET po_metadata = ?, document_title = ? WHERE id = ?');
  const retryDelayMs = config.retryDelayMs || 30000;
  const scheduleRetry = database.prepare('UPDATE pdf_uploads SET next_retry_at = ? WHERE id = ?');
  const claimRetry = database.prepare(`UPDATE pdf_uploads SET status = 'uploading',
    next_retry_at = NULL, error = NULL WHERE id = ? AND status IN ('failed', 'uncertain')
    AND (next_retry_at IS NULL OR next_retry_at <= ?)`);
  const find = database.prepare('SELECT * FROM pdf_uploads WHERE file_path = ? AND content_hash = ?');
  const insert = database.prepare(`INSERT INTO pdf_uploads
    (file_path, filename, content_hash, document_title, status, created_at)
    VALUES (?, ?, ?, ?, 'uploading', ?)`);
  const result = database.prepare(`UPDATE pdf_uploads SET status = ?, http_status = ?,
    response_body = ?, error = ?, uploaded_at = ? WHERE id = ?`);
  const cleanup = database.prepare('UPDATE pdf_uploads SET deleted_at = ?, error = NULL WHERE id = ?');
  const cleanupError = database.prepare('UPDATE pdf_uploads SET error = ? WHERE id = ?');
  const resetReturned = database.prepare(`UPDATE pdf_uploads SET status = 'failed',
    deleted_at = NULL, uploaded_at = NULL, next_retry_at = NULL, error = NULL,
    http_status = NULL, response_body = NULL
    WHERE id = ? AND status NOT IN ('failed', 'uncertain')`);

  return async function uploadPdf(filePath, expectedSignature) {
    const before = await fs.stat(filePath);
    if (signature(before) !== expectedSignature) throw new Error('PDF changed; waiting for it to settle.');
    const bytes = await fs.readFile(filePath);
    if (signature(await fs.stat(filePath)) !== expectedSignature) throw new Error('PDF changed while reading.');
    const hash = createHash('sha256').update(bytes).digest('hex');
    let record = find.get(filePath, hash);
    if (record && !['failed', 'uncertain'].includes(record.status)) {
      if (!resetReturned.run(record.id).changes) return false;
      console.log(`PDF returned to folder: ${record.filename}; checking with the API again.`);
      record = find.get(filePath, hash);
    }
    const retry = ['failed', 'uncertain'].includes(record?.status);
    if (retry && record.next_retry_at && Date.now() < record.next_retry_at) return false;
    if (!record || retry) {
      const filename = path.basename(filePath);
      let metadata;
      try {
        metadata = await extractMetadata(bytes);
      } catch (error) {
        if (!record) {
          insert.run(filePath, filename, hash, path.parse(filename).name, new Date().toISOString());
          record = find.get(filePath, hash);
        }
        result.run('parse_failed', null, null, error.message, null, record.id);
        console.error(`Cannot extract PO fields from ${filename}: ${error.message}; retained PDF, no API request sent.`);
        return;
      }
      const title = metadata.document_title;
      if (retry) {
        if (!claimRetry.run(record.id, Date.now()).changes) return false;
      } else {
        insert.run(filePath, filename, hash, title, new Date().toISOString());
      }
      record = find.get(filePath, hash);
      saveMetadata.run(JSON.stringify(metadata), title, record.id);
      console.log(`[${new Date().toISOString()}] ${retry ? 'Retrying' : 'Uploading'} PDF: ${filePath}`);
      const form = new FormData();
      form.set('user_id', String(config.user_id));
      form.set('template_id', String(config.template_id));
      if (config.department_id !== undefined) form.set('department_id', String(config.department_id));
      form.set('document_title', title);
      for (const field of ['po_no', 'vendor', 'document_date', 'ship_to']) {
        form.set(field, metadata[field]);
      }
      form.set('attached_pdf', new Blob([bytes], { type: 'application/pdf' }), metadata.filename);
      let response;
      let body;
      try {
        response = await fetch(config.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
          body: form,
          signal: AbortSignal.timeout(60000),
          redirect: 'error'
        });
        body = await response.text();
      } catch (error) {
        result.run('uncertain', null, null, 'Network error or timeout; check backend before retrying.', null, record.id);
        scheduleRetry.run(Date.now() + retryDelayMs, record.id);
        console.error(`Upload outcome uncertain for ${filename}; retained PDF. Retrying in ${retryDelayMs / 1000} seconds; backend handles duplicates.`);
        return false;
      }
      let json;
      try { json = JSON.parse(body); } catch { /* Unexpected responses require review. */ }
      const confirmed = response.ok && response.status !== 202 && json &&
        typeof json === 'object' && json.success !== false && !json.error && !json.errors;
      const duplicateTitle = isDuplicateTitle(response.status, json);
      if (!confirmed && !duplicateTitle) {
        const status = response.status >= 400 && response.status < 500 ? 'failed' : 'uncertain';
        result.run(status, response.status, body, 'Creation not confirmed; PDF retained for review.', null, record.id);
        console.error(`API did not confirm creation for ${filename} (HTTP ${response.status}); retained PDF.`);
        const details = [json?.message, ...Object.values(json?.errors || {}).flat()]
          .filter((value) => typeof value === 'string');
        for (const detail of new Set(details)) {
          console.error(`API: ${detail.split(config.token).join('[REDACTED]')}`);
        }
        scheduleRetry.run(Date.now() + retryDelayMs, record.id);
        console.log(`Retry scheduled in ${retryDelayMs / 1000} seconds for ${filename}.`);
        return false;
      }
      // Persist confirmation before deleting so a restart never uploads it again.
      result.run(duplicateTitle ? 'duplicate' : 'uploaded', response.status, body, null,
        duplicateTitle ? null : new Date().toISOString(), record.id);
      record = find.get(filePath, hash);
      console.log(duplicateTitle ? `Document title already exists: ${title}; deleting duplicate PDF.` : `API created request for: ${filename}`);
      if (!duplicateTitle && config.desktopNotifications !== false) {
        try {
          notifyCreated(title, json.data?.reference);
        } catch (error) {
          console.error(`Desktop notification failed: ${error.message}`);
        }
      }
    }
    if (!['uploaded', 'duplicate'].includes(record.status)) {
      console.log(`PDF retained: ${record.filename} (${record.status}; review pdf_uploads before retrying).`);
      return;
    }
    try {
      if (signature(await fs.stat(filePath)) !== expectedSignature) throw new Error('PDF changed after upload; keeping current file.');
      const currentHash = createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
      if (currentHash !== hash || signature(await fs.stat(filePath)) !== expectedSignature) {
        throw new Error('PDF changed after upload; keeping current file.');
      }
      await fs.unlink(filePath);
      cleanup.run(new Date().toISOString(), record.id);
      console.log(`Deleted ${record.status === 'duplicate' ? 'duplicate' : 'uploaded'} PDF: ${filePath}`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        cleanup.run(new Date().toISOString(), record.id);
        return;
      }
      cleanupError.run(error.message, record.id);
      throw error;
    }
  };
}

module.exports = { createUploader, signature, isDuplicateTitle };
