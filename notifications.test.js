'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { notifyRequestCreated } = require('./notifications');

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
