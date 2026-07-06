/**
 * Device access layer for the Pixelpulse UI — backend selection facade.
 *
 * Two interchangeable backends implement the same Dataserver API:
 *   - WebUSB (default when available): in-browser drivers, no daemon.
 *   - WebSocket: the Nonolith Connect daemon — multi-client sharing,
 *     remote (LAN) operation, and non-WebUSB browsers.
 *
 * Selection, first match wins:
 *   1. `?server=host:port` in the query string  -> WebSocket to that host
 *   2. `#connect` or `#connect=host:port` hash  -> WebSocket (default
 *      localhost:9003)
 *   3. WebUSB supported                          -> WebUSB
 *   4. otherwise                                 -> WebSocket localhost:9003
 *
 * Pages import everything from this module; the shared classes and types
 * live in dataserver-common.ts.
 */

import { isSupported } from './smu/index.js';
import { Dataserver } from './dataserver-common.js';
import { WSDataserver } from './dataserver-ws.js';
import { USBDataserver } from './dataserver-webusb.js';
import { SimDataserver } from './dataserver-sim.js';
import { AudioDataserver } from './dataserver-audio.js';

export * from './dataserver-common.js';

export function webusbSupported(): boolean {
  return isSupported();
}

export type BackendChoice =
  | { kind: 'webusb' }
  | { kind: 'websocket'; host: string }
  | { kind: 'sim' }
  | { kind: 'audio' };

export function chooseBackend(): BackendChoice {
  if (typeof location !== 'undefined') {
    const q = new URLSearchParams(location.search).get('server');
    if (q) return { kind: 'websocket', host: q };

    const m = /(?:^#|&)connect(?:=([^&]+))?(?:&|$)/.exec(location.hash);
    if (m) return { kind: 'websocket', host: m[1] ?? 'localhost:9003' };

    // Simulated M1K (software LED/resistor loads): hardware-free testing
    if (/(?:^#|&)sim(?:&|$)/.test(location.hash)) return { kind: 'sim' };

    // Speaker/mic as the instrument (soundcard scope + signal generator)
    if (/(?:^#|&)audio(?:&|$)/.test(location.hash)) return { kind: 'audio' };
  }

  if (isSupported()) return { kind: 'webusb' };
  return { kind: 'websocket', host: 'localhost:9003' };
}

export const backend: BackendChoice = chooseBackend();

export const server: Dataserver =
  backend.kind === 'websocket' ? new WSDataserver(backend.host)
    : backend.kind === 'sim' ? new SimDataserver()
      : backend.kind === 'audio' ? new AudioDataserver()
        : new USBDataserver();

console.log(
  backend.kind === 'websocket'
    ? `dataserver: WebSocket backend (${backend.host})`
    : `dataserver: ${backend.kind} backend`,
);
