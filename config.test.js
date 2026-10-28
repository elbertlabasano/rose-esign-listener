'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readConfig } = require('./config');

test('department default, per-folder override, and invalid IDs', () => {
  const env = { API_TOKEN: 'test', TEMPLATE_ID: '5', DEPARTMENT_ID: '2',
    WATCH_FOLDER_1: path.resolve('first'), USER_ID_1: '6',
    WATCH_FOLDER_2: path.resolve('second'), USER_ID_2: '8', DEPARTMENT_ID_2: '3' };
  assert.deepEqual(readConfig(env).folders.map((folder) => folder.department_id), [2, 3]);
  assert.equal(readConfig(env).folders[0].desktopNotifications, true);
  assert.equal(readConfig({ ...env, DESKTOP_NOTIFICATIONS: 'false' }).folders[0].desktopNotifications, false);
  assert.throws(() => readConfig({ ...env, DESKTOP_NOTIFICATIONS: 'invalid' }), /DESKTOP_NOTIFICATIONS/);
  assert.throws(() => readConfig({ ...env, DESKTOP_NOTIFICATION_MODE: 'invalid' }), /DESKTOP_NOTIFICATION_MODE/);
  assert.doesNotThrow(() => readConfig({ ...env, DESKTOP_NOTIFICATION_MODE: 'balloon' }));
  for (const value of ['0', '-1', 'abc', '1.5']) {
    assert.throws(() => readConfig({ ...env, DEPARTMENT_ID_2: value }), /DEPARTMENT_ID/);
  }
  assert.equal(readConfig({ ...env, DEPARTMENT_ID: undefined }).folders[0].department_id, undefined);
  assert.equal(readConfig({ ...env, DEPARTMENT_ID_2: '' }).folders[1].department_id, undefined);
});
