'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function manilaDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Archive path must stay inside the watched folder.');
  }
}

async function archiveDirectory(root, date, category) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['created', 'already-exists'].includes(category)) {
    throw new Error('Invalid archive directory.');
  }
  let directory = root;
  for (const name of [date, category]) {
    directory = path.join(directory, name);
    inside(root, directory);
    try { await fs.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Archive directory cannot be a link.');
  }
  return directory;
}

const fileHash = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const signature = (stat) => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

async function archivePdf({ source, filename, category, hash, expectedSignature, destination, remember, now }) {
  const root = path.dirname(source);
  let directory;
  if (destination) {
    inside(root, destination);
    const relative = path.relative(root, destination).split(path.sep);
    if (relative.length !== 3 || relative[1] !== category) throw new Error('Invalid saved archive path.');
    directory = await archiveDirectory(root, relative[0], category);
  } else {
    directory = await archiveDirectory(root, manilaDate(now), category);
  }
  const base = path.parse(path.basename(filename));
  if (base.ext.toLowerCase() !== '.pdf') throw new Error('Archive filename must be a PDF.');
  let copied = false;
  if (destination) {
    try {
      const stat = await fs.lstat(destination);
      if (!stat.isFile() || stat.isSymbolicLink() || await fileHash(destination) !== hash) {
        throw new Error('Saved archive file differs; retaining source.');
      }
      copied = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (let suffix = 0; !copied; suffix++) {
    const candidate = destination || path.join(directory, `${base.name}${suffix ? ` (${suffix})` : ''}.pdf`);
    inside(root, candidate);
    // Persist the destination before copying, so a restart can finish the move.
    remember(candidate);
    try {
      await fs.copyFile(source, candidate, constants.COPYFILE_EXCL);
      destination = candidate;
      copied = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      destination = undefined;
    }
  }
  if (signature(await fs.stat(source)) !== expectedSignature || await fileHash(source) !== hash || await fileHash(destination) !== hash) {
    throw new Error('PDF changed during archiving; source retained.');
  }
  if (signature(await fs.stat(source)) !== expectedSignature) throw new Error('PDF changed during archiving; source retained.');
  await fs.unlink(source);
  return destination;
}

async function pruneArchives(root, now = new Date()) {
  const cutoff = new Date(`${manilaDate(now)}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 6);
  const oldest = cutoff.toISOString().slice(0, 10);
  const dates = await fs.readdir(root, { withFileTypes: true });
  let removed = 0;
  for (const date of dates) {
    if (!date.isDirectory() || date.isSymbolicLink() || !/^\d{4}-\d{2}-\d{2}$/.test(date.name)) continue;
    const parsed = new Date(`${date.name}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date.name || date.name >= oldest) continue;
    const datePath = path.join(root, date.name);
    inside(root, datePath);
    for (const category of ['created', 'already-exists']) {
      const directory = path.join(datePath, category);
      inside(root, directory);
      let stat;
      try { stat = await fs.lstat(directory); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      for (const file of await fs.readdir(directory, { withFileTypes: true })) {
        if (!file.isFile() || file.isSymbolicLink() || path.extname(file.name).toLowerCase() !== '.pdf') continue;
        const target = path.join(directory, file.name);
        inside(root, target);
        await fs.unlink(target);
        removed++;
      }
      try { await fs.rmdir(directory); } catch (error) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error; }
    }
    try { await fs.rmdir(datePath); } catch (error) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error; }
  }
  return removed;
}

module.exports = { manilaDate, archivePdf, pruneArchives };
