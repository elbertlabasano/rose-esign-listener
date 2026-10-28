'use strict';

const path = require('node:path');
const { loadEnvFile } = require('node:process');

try {
  loadEnvFile(path.join(__dirname, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

function positiveId(value, name) {
  if (!/^[1-9]\d*$/.test(value || '') || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
}

function readConfig(env = process.env) {
  if (!env.API_TOKEN) throw new Error('Set API_TOKEN in .env.');
  const url = env.API_URL || 'http://127.0.0.1:8001/api/v1/requests/from-pdf';
  if (!['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('API_URL must use HTTP or HTTPS.');
  const indexes = Object.keys(env).filter((key) => /^WATCH_FOLDER_[1-9]\d*$/.test(key))
    .map((key) => Number(key.slice('WATCH_FOLDER_'.length))).sort((a, b) => a - b);
  if (!indexes.length) throw new Error('Set WATCH_FOLDER_1, USER_ID_1, and TEMPLATE_ID in .env.');
  const seen = new Set();
  if (!['toast', 'balloon'].includes(env.DESKTOP_NOTIFICATION_MODE || 'toast')) {
    throw new Error('DESKTOP_NOTIFICATION_MODE must be toast or balloon.');
  }
  const notificationSetting = (env.DESKTOP_NOTIFICATIONS || 'true').toLowerCase();
  if (!['true', 'false'].includes(notificationSetting)) {
    throw new Error('DESKTOP_NOTIFICATIONS must be true or false.');
  }
  const retrySeconds = positiveId(env.RETRY_DELAY_SECONDS || '30', 'RETRY_DELAY_SECONDS');
  const folders = indexes.map((index) => {
    const folderValue = env[`WATCH_FOLDER_${index}`];
    if (!folderValue?.trim() || !path.isAbsolute(folderValue)) {
      throw new Error(`WATCH_FOLDER_${index} must be an absolute folder path.`);
    }
    const folder = path.resolve(folderValue);
    const key = process.platform === 'win32' ? folder.toLowerCase() : folder;
    if (seen.has(key)) throw new Error(`Duplicate watched folder: ${folder}`);
    seen.add(key);
    const departmentValue = env[`DEPARTMENT_ID_${index}`] ?? env.DEPARTMENT_ID;
    return {
      folder,
      url,
      token: env.API_TOKEN,
      retryDelayMs: retrySeconds * 1000,
      desktopNotifications: notificationSetting === 'true',
      user_id: positiveId(env[`USER_ID_${index}`], `USER_ID_${index}`),
      department_id: departmentValue === undefined || departmentValue.trim() === ''
        ? undefined
        : positiveId(departmentValue, `DEPARTMENT_ID_${index} or DEPARTMENT_ID`),
      template_id: positiveId(env[`TEMPLATE_ID_${index}`] || env.TEMPLATE_ID, `TEMPLATE_ID_${index} or TEMPLATE_ID`)
    };
  });
  return { folders };
}

module.exports = { readConfig };
