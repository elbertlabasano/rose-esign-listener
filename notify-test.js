'use strict';

// Load the project's .env without starting the folder listener or calling the API.
require('./config');
const { notifyRequestCreated } = require('./notifications');
console.log('Testing notifications only; no request is created and no PDF is deleted.');
console.log('Check the desktop banner and Notification Center (Win+N).');
notifyRequestCreated('Desktop notification test - document titles will appear here.', undefined, undefined, {
  test: true,
  mode: process.argv[2]
});
