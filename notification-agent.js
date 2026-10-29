'use strict';

// Intentionally does not load config/.env, watch folders, or import upload.js.
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { latestEventId, createEventConsumer } = require('./notification-relay');
const { notifyRequestCreated } = require('./notifications');

function startAgent() {
  if (process.platform === 'win32' && /^SYSTEM$/i.test(process.env.USERNAME || '')) {
    throw new Error('Run notification-agent.js as a logged-in desktop user, not SYSTEM.');
  }
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is missing; run this helper in a Windows user session.');
  const project = createHash('sha256').update(__dirname.toLowerCase()).digest('hex').slice(0, 16);
  const session = (process.env.SESSIONNAME || 'desktop').replace(/[^a-zA-Z0-9_-]/g, '_');
  const stateDirectory = path.join(process.env.LOCALAPPDATA, 'RoseEsignListener', project, session);
  fs.mkdirSync(stateDirectory, { recursive: true });

  const lockFile = path.join(stateDirectory, 'agent.lock');
  const cursorFile = path.join(stateDirectory, 'cursor.json');
  let lock;
  try {
    lock = fs.openSync(lockFile, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = Number(fs.readFileSync(lockFile, 'utf8'));
    if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('Invalid notification helper lock; inspect ' + lockFile);
    try {
      process.kill(owner, 0);
      console.log('Notification helper already running for this user/session.');
      return;
    } catch (probeError) {
      if (probeError.code !== 'ESRCH') throw probeError;
    }
    fs.unlinkSync(lockFile);
    // If another helper won the race, its exclusive lock makes this one fail.
    lock = fs.openSync(lockFile, 'wx');
  }
  fs.writeFileSync(lock, String(process.pid));
  process.on('exit', () => {
    fs.closeSync(lock);
    try { fs.unlinkSync(lockFile); } catch { /* Already removed. */ }
  });

  function save(after) {
    const temporary = cursorFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ after }), 'utf8');
    fs.renameSync(temporary, cursorFile);
  }
  let after;
  if (fs.existsSync(cursorFile)) {
    after = JSON.parse(fs.readFileSync(cursorFile, 'utf8')).after;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid notification cursor: ' + cursorFile);
  } else {
    // New users see future events, not the existing historical queue.
    after = latestEventId();
    save(after);
  }
  const consume = createEventConsumer({ after, save, notify: notifyRequestCreated });
  let lastError;
  const poll = () => {
    try {
      consume();
      lastError = undefined;
    } catch (error) {
      if (lastError !== error.message) console.error('Notification relay: ' + error.message);
      lastError = error.message;
    }
  };
  poll();
  const timer = setInterval(poll, 1000);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => clearInterval(timer));
  console.log('Notification helper running for the current desktop session. No PDFs will be processed by this helper.');
}

if (require.main === module) {
  try { startAgent(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { startAgent };
