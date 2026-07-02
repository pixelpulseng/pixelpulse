/**
 * Simulated-device backend: the WebUSB dataserver with a SimM1K registered
 * in place of real hardware. Everything above the driver — command dispatch,
 * listeners, triggering, decimation — is the real code path, so UI behavior
 * exercised against this backend is representative of a live device.
 *
 * Selected by the `#sim` URL hash (see dataserver.ts). Intended for
 * automated browser verification and hardware-free development.
 */

import { USBDataserver, USBDevice_ } from './dataserver-webusb.js';
import { SimM1K } from './smu/sim-device.js';
import type { SMUDevice } from './smu/index.js';

export class SimDataserver extends USBDataserver {
  override connect(): void {
    this.version = '1.3'; // suppress the "update Connect" banner

    // Optional battery emulation on channel A: #sim&bat=<capacity mAh>
    const bat = /(?:^#|&)bat=([0-9.]+)/.exec(
      typeof location !== 'undefined' ? location.hash : '');
    const batteryMAh = bat ? parseFloat(bat[1]) : 0;

    // SMUDevice is a union of the concrete hardware drivers; SimM1K fulfills
    // the StreamingDevice contract that every generic command path uses.
    // M1K-hardware-only paths (VBUS/temperature/frontend) fail through the
    // dispatch error handling, which the UI already tolerates.
    const sim = new SimM1K({ batteryMAh }) as unknown as SMUDevice;
    this.devices = [new USBDevice_(sim)];

    // initSession subscribes to these events after calling connect();
    // defer the notifications so subscribers exist when they fire.
    setTimeout(() => {
      this.connected.notify();
      this.devicesChanged.notify(this.devices);
    }, 0);
  }

  override async requestDevice(): Promise<void> {
    // No pairing in sim mode.
  }
}
