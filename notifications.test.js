'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { notifyRequestCreated, notificationDelivery } = require('./notifications');

test('notification includes the document title and request reference', () => {
  let called = false;
  notifyRequestCreated('31164-Coca-Cola Europacific Philippines, Inc.', 'RRC-123', (options, callback) => {
    called = true;
    assert.equal(options.title, 'E-sign request created');
    assert.equal(options.message, '31164-Coca-Cola Europacific Philippines, Inc.\nReference: RRC-123');
    assert.equal(options.wait, false);
    callback(null);
  });
  assert.equal(called, true);
});

test('SYSTEM auto delivery relays while desktop users and explicit test notifications display directly', () => {
  assert.equal(notificationDelivery({}, { USERNAME: 'SYSTEM' }, 'win32'), 'relay');
  assert.equal(notificationDelivery({}, { USERNAME: 'Alice' }, 'win32'), 'direct');
  assert.equal(notificationDelivery({ delivery: 'direct' }, { USERNAME: 'SYSTEM' }, 'win32'), 'direct');
  assert.equal(notificationDelivery({ test: true }, { DESKTOP_NOTIFICATION_DELIVERY: 'relay' }, 'win32'), 'direct');
  assert.equal(notificationDelivery({}, { DESKTOP_NOTIFICATION_DELIVERY: 'relay' }, 'win32'), 'relay');
  assert.throws(() => notificationDelivery({}, { DESKTOP_NOTIFICATION_DELIVERY: 'wrong' }), /DELIVERY/);
});

test('relay publishes only title, reference and mode instead of invoking desktop notifier', () => {
  let received;
  notifyRequestCreated('PO 123', 'RRC-123', undefined, {
    delivery: 'relay', mode: 'toast',
    publish: (...args) => { received = args; }
  });
  assert.deepEqual(received, ['PO 123', 'RRC-123', { mode: 'toast' }]);
});
