/**
 * Audio backend: speaker/headphone out as the signal source, microphone as
 * the measurement input (see src/smu/audio-device.ts). Selected by the
 * `#audio` URL hash.
 *
 * Audio capture needs a user gesture (autoplay policy) and microphone
 * permission, so — like the WebUSB pairing flow — a floating button starts
 * the device instead of connect() doing it silently.
 */

import { USBDataserver, USBDevice_ } from './dataserver-webusb.js';
import { AudioDevice } from './smu/audio-device.js';
import type { SMUDevice } from './smu/index.js';

export class AudioDataserver extends USBDataserver {
  private enableButton: HTMLButtonElement | null = null;

  override connect(): void {
    this.version = '1.3';
    setTimeout(() => this.connected.notify(), 0);
    this.showEnableButton();
  }

  override async requestDevice(): Promise<void> {
    // No pairing dialog; the enable button is the whole flow.
  }

  private showEnableButton(): void {
    if (typeof document === 'undefined' || this.enableButton) return;

    const btn = document.createElement('button');
    btn.textContent = '\u{1F3A4} Enable audio device (mic + speaker)…';
    btn.style.cssText =
      'position:fixed;top:12px;right:12px;z-index:10000;font-size:15px;'
      + 'padding:8px 14px;cursor:pointer;border-radius:6px;border:1px solid #888;';
    btn.addEventListener('click', () => {
      void this.start(btn);
    });
    this.enableButton = btn;

    const attach = (): void => {
      document.body.appendChild(btn);
    };
    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach);
  }

  private async start(btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      // Measurement path must be flat: no echo cancellation, no AGC, no
      // noise suppression — those "help" voice and destroy signals.
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: false,
        },
      });
      const ctx = new AudioContext();
      await ctx.resume();

      // AudioDevice fulfills the StreamingDevice contract used by every
      // generic command path (same note as the SimM1K registration).
      const dev = new AudioDevice(ctx, mic) as unknown as SMUDevice;
      this.devices = [new USBDevice_(dev)];
      btn.remove();
      this.enableButton = null;
      this.devicesChanged.notify(this.devices);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = `\u{1F3A4} Audio failed (${e instanceof Error ? e.message : String(e)}) — retry?`;
    }
  }
}
