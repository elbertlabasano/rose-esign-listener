'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createUploader, signature, isDuplicateTitle } = require('./upload');

test('only explicit document title conflicts count as duplicates', () => {
  assert.equal(isDuplicateTitle(422, { errors: { document_title: ['The document title has already been taken.'] } }), true);
  assert.equal(isDuplicateTitle(409, { message: 'Document title already exists.' }), true);
  assert.equal(isDuplicateTitle(409, { code: 'duplicate_document_title' }), true);
  assert.equal(isDuplicateTitle(422, { errors: { document_title: ['The document title is required.'] } }), false);
  assert.equal(isDuplicateTitle(409, { message: 'Conflict' }), false);
  assert.equal(isDuplicateTitle(422, { errors: { vendor: ['Vendor already exists.'] } }), false);
  assert.equal(isDuplicateTitle(500, { message: 'Document title already exists.' }), false);
});

test('duplicate titles are archived without creation notifications; changed PDFs stay', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-duplicate-'));
  const db = new DatabaseSync(':memory:');
  const originalFetch = global.fetch;
  try {
    const config = { url: 'http://localhost/test', token: 'test', user_id: 8, template_id: 5 };
    const metadata = { po_no: '31164', vendor: 'Vendor', document_date: '2026-10-22',
      ship_to: 'Tagum', document_title: '31164-Vendor', filename: '31164-Vendor.pdf' };
    let notifications = 0;
    const upload = createUploader(db, config, async () => metadata, () => { notifications++; });
    for (const code of [409, 422]) {
      const file = path.join(folder, `${code}.pdf`);
      await fs.writeFile(file, 'original PDF');
      global.fetch = async () => new Response(JSON.stringify({
        errors: { document_title: ['The document title has already been taken.'] }
      }), { status: code });
      await upload(file, signature(await fs.stat(file)));
      await assert.rejects(fs.access(file), { code: 'ENOENT' });
      const row = db.prepare('SELECT * FROM pdf_uploads WHERE file_path = ?').get(file);
      assert.equal(row.status, 'duplicate');
      assert.equal(row.http_status, code);
      assert.equal(row.uploaded_at, null);
      assert.ok(row.archived_at);
      assert.equal(row.deleted_at, null);
      assert.equal(path.basename(path.dirname(row.archive_path)), 'already-exists');
      assert.equal(await fs.readFile(row.archive_path, 'utf8'), 'original PDF');
    }
    const changed = path.join(folder, 'changed.pdf');
    await fs.writeFile(changed, 'original PDF');
    global.fetch = async () => {
      await fs.writeFile(changed, 'replacement PDF with different content');
      return new Response(JSON.stringify({ message: 'Document title already exists.' }), { status: 409 });
    };
    await assert.rejects(upload(changed, signature(await fs.stat(changed))), /PDF changed/);
    assert.equal(await fs.readFile(changed, 'utf8'), 'replacement PDF with different content');
    assert.equal(notifications, 0);
  } finally {
    global.fetch = originalFetch;
    db.close();
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('failed uploads wait, survive uploader restart, and archive after confirmation', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-retry-'));
  const file = path.join(folder, 'test.pdf');
  const db = new DatabaseSync(':memory:');
  const originalFetch = global.fetch;
  try {
    await fs.writeFile(file, '%PDF-1.4 test');
    const expected = signature(await fs.stat(file));
    const config = { url: 'http://localhost/test', token: 'test', user_id: 8, template_id: 5, department_id: 2, retryDelayMs: 30000 };
    const metadata = { po_no: '31164', vendor: 'Test Vendor', document_date: '2026-10-22',
      ship_to: 'Tagum 7 Pag Asa', document_title: '31164-Test Vendor', filename: '31164-Test Vendor.pdf' };
    let calls = 0;
    let notifications = 0;
    const notify = (title) => {
      notifications++;
      assert.equal(title, metadata.document_title);
      // Notification errors must not stop archiving or cause another upload.
      throw new Error('Simulated notification failure');
    };
    global.fetch = async (_url, options) => {
      calls++;
      assert.equal(options.body.get('user_id'), '8');
      assert.equal(options.body.get('department_id'), config.department_id === undefined ? null : String(config.department_id));
      assert.equal(options.body.get('document_title'), metadata.document_title);
      assert.equal(options.body.get('attached_pdf').name, metadata.filename);
      for (const field of ['po_no', 'vendor', 'document_date', 'ship_to']) {
        assert.equal(options.body.get(field), metadata[field]);
      }
      if (calls === 3) return new Response(JSON.stringify({ message: 'Document title already exists.' }), { status: 409 });
      return calls === 1
        ? new Response(JSON.stringify({ message: 'Permission missing' }), { status: 422 })
        : new Response(JSON.stringify({ data: { id: 35 } }), { status: 201 });
    };
    let upload = createUploader(db, config, async () => metadata, notify);
    assert.equal(await upload(file, expected), false);
    assert.equal(db.prepare('SELECT status FROM pdf_uploads').get().status, 'failed');
    assert.equal(notifications, 0);
    await fs.access(file);
    upload = createUploader(db, config, async () => metadata, notify);
    assert.equal(await upload(file, expected), false);
    assert.equal(calls, 1);
    // A blank folder override must omit the API field on the next retry.
    config.department_id = undefined;
    db.exec('UPDATE pdf_uploads SET next_retry_at = 0');
    await upload(file, expected);
    assert.equal(calls, 2);
    assert.equal(notifications, 1);
    assert.equal(db.prepare('SELECT status FROM pdf_uploads').get().status, 'uploaded');
    const created = db.prepare('SELECT archive_path, archived_at, deleted_at FROM pdf_uploads').get();
    assert.equal(path.basename(path.dirname(created.archive_path)), 'created');
    assert.equal(await fs.readFile(created.archive_path, 'utf8'), '%PDF-1.4 test');
    assert.ok(created.archived_at);
    assert.equal(created.deleted_at, null);
    await assert.rejects(fs.access(file), { code: 'ENOENT' });
    // A returned PDF is archived only after the API confirms its title exists.
    await fs.writeFile(file, '%PDF-1.4 test');
    await upload(file, signature(await fs.stat(file)));
    assert.equal(calls, 3);
    assert.equal(notifications, 1);
    assert.equal(db.prepare('SELECT status FROM pdf_uploads').get().status, 'duplicate');
    await assert.rejects(fs.access(file), { code: 'ENOENT' });
    // If the backend no longer has it, a new request can be created.
    await fs.writeFile(file, '%PDF-1.4 test');
    await upload(file, signature(await fs.stat(file)));
    assert.equal(calls, 4);
    assert.equal(notifications, 2);
    assert.equal(db.prepare('SELECT status FROM pdf_uploads').get().status, 'uploaded');
    await assert.rejects(fs.access(file), { code: 'ENOENT' });
    // Unknown outcomes retry after the delay; the backend handles duplicates.
    await fs.writeFile(file, '%PDF-1.4 different');
    global.fetch = async () => { calls++; throw new Error('timeout'); };
    const changed = signature(await fs.stat(file));
    await upload(file, changed);
    await upload(file, changed);
    assert.equal(calls, 5);
    assert.equal(notifications, 2);
    await fs.access(file);
    db.exec('UPDATE pdf_uploads SET next_retry_at = 0');
    global.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ message: 'Document title already exists.' }), { status: 409 });
    };
    await upload(file, changed);
    assert.equal(calls, 6);
    await assert.rejects(fs.access(file), { code: 'ENOENT' });
    await fs.writeFile(file, '%PDF-1.4 unreadable');
    const badUpload = createUploader(db, config, async () => { throw new Error('Missing Vendor'); });
    await badUpload(file, signature(await fs.stat(file)));
    assert.equal(calls, 6);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM pdf_uploads WHERE status = 'parse_failed'").get().count, 1);
    await fs.access(file);
  } finally {
    global.fetch = originalFetch;
    db.close();
    await fs.rm(folder, { recursive: true, force: true });
  }
});

test('archive failure resumes after restart without another API call', async () => {
  const { manilaDate } = require('./archive');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-move-retry-'));
  const file = path.join(folder, 'test.pdf');
  const db = new DatabaseSync(':memory:');
  const originalFetch = global.fetch;
  try {
    await fs.writeFile(file, 'original PDF');
    const expected = signature(await fs.stat(file));
    // A file occupying the archive date path prevents creating a directory.
    const obstruction = path.join(folder, manilaDate());
    await fs.writeFile(obstruction, 'keep me');
    const config = { url: 'http://localhost/test', token: 'test', user_id: 8, template_id: 5, desktopNotifications: false };
    const metadata = { po_no: '31164', vendor: 'Vendor', document_date: '2026-10-22',
      ship_to: 'Tagum', document_title: '31164-Vendor', filename: '31164-Vendor.pdf' };
    let calls = 0;
    global.fetch = async () => { calls++; return new Response(JSON.stringify({ data: { id: 35 } }), { status: 201 }); };
    const first = createUploader(db, config, async () => metadata);
    await assert.rejects(first(file, expected), /Archive directory cannot be a link/);
    await fs.access(file);
    await fs.unlink(obstruction);
    const restarted = createUploader(db, config, async () => metadata);
    await restarted(file, expected);
    assert.equal(calls, 1);
    const row = db.prepare('SELECT * FROM pdf_uploads').get();
    assert.equal(await fs.readFile(row.archive_path, 'utf8'), 'original PDF');
    assert.ok(row.archived_at);
    await assert.rejects(fs.access(file), { code: 'ENOENT' });
  } finally {
    global.fetch = originalFetch;
    db.close();
    await fs.rm(folder, { recursive: true, force: true });
  }
});
