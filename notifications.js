'use strict';

function notifyRequestCreated(documentTitle, reference, send, options = {}) {
  // Do not wait for a user to dismiss a toast before processing the next PDF.
  try {
    const module = send ? null : require('node-notifier');
    const backend = module?.default || module;
    const mode = options.mode || process.env.DESKTOP_NOTIFICATION_MODE || 'toast';
    if (!['toast', 'balloon'].includes(mode)) throw new Error('DESKTOP_NOTIFICATION_MODE must be toast or balloon.');
    const selected = !send && mode === 'balloon' && process.platform === 'win32'
      ? new backend.WindowsBalloon({ withFallback: false }) : backend;
    const notifier = send || selected.notify.bind(selected);
    notifier({
      title: options.test ? 'E-sign notification test' : 'E-sign request created',
      message: `${documentTitle}${reference ? `\nReference: ${reference}` : ''}`,
      sound: true,
      wait: false,
      time: 10000
    }, (error, response, metadata) => {
      if (error) {
        console.error(`Desktop notification failed (${mode}): ${error.message}`);
      } else {
        console.log(`Desktop notification helper (${mode}): ${metadata?.action || response || 'submitted'}. This does not confirm a visible banner.`);
      }
    });
    console.log(`Desktop notification requested (${mode}): ${documentTitle}`);
  } catch (error) {
    console.error(`Desktop notification failed: ${error.message}`);
  }
}

module.exports = { notifyRequestCreated };
