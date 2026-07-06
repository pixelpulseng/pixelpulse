/**
 * Pixelpulse main controller
 * Ported from app.coffee
 * Original: (C) 2011 Nonolith Labs, Kevin Mehall <km@kevinmehall.net>
 * Distributed under the terms of the GNU GPLv3
 */

import { type CEEDevice, type BootloaderDevice } from './dataserver.js';
import { initSession, parseFlags } from './session.js';
import {
  initView, destroyView, toggleTrigger, togglePhosphor, toggleOverlay,
  autozoom, setLayout, captureState, setupToolbar,
} from './views.js';

// Expose to inline onclick handlers in HTML
Object.assign(window, {
  pixelpulse: { setLayout, toggleTrigger, togglePhosphor, toggleOverlay, autozoom },
});

const flags = parseFlags();

document.addEventListener('DOMContentLoaded', () => {
  if (flags.perfstat) {
    const el = document.getElementById('perfstat');
    if (el) el.style.display = 'block';
  }

  setupToolbar();

  initSession({
    app: 'Pixelpulse',
    model: ['com.nonolithlabs.cee', 'com.analogdevices.m1k', 'org.pixelpulse.audio'],
    updateMessage: "You're missing <a href='http://www.nonolithlabs.com/blog/2012/09-19-software-features'>new features</a>",

    reset() {
      document.body.classList.remove('triggering');
      destroyView();
    },

    updateDevsMenu(l) {
      const switchBtn = document.getElementById('switchDev');
      if (switchBtn) switchBtn.style.display = l.length > 1 ? '' : 'none';
    },

    initDevice(dev: CEEDevice | BootloaderDevice) {
      (dev as CEEDevice).captureStateChanged?.subscribe((s: boolean) => {
        captureState.notify(s);
      });
    },

    deviceChanged(dev: CEEDevice | BootloaderDevice) {
      initView(dev as CEEDevice);
      captureState.notify((dev as CEEDevice).captureState);
    },

    deviceRemoved() {},
  });
});
