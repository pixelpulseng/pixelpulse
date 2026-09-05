/**
 * Calibration tool
 * Ported from calibrate.coffee
 * Original: (C) 2011 Nonolith Labs, Kevin Mehall
 * Replaces async.js callbacks with async/await
 */

import { server, DataListener, type CEEDevice, type Stream, type Channel } from './dataserver.js';

let testingSerial: string | null = null;

interface CalData {
  serial?: string;
  hwVersion?: string;
  fwVersion?: string;
  time?: Date;
  a: ChannelCalData;
  b: ChannelCalData;
  sweep?: Record<string, number[] | Float32Array>;
}

interface ChannelCalData {
  offset?: Record<number, Record<string, number>>;
  iset?: Record<number, number>;
}

const data: CalData = { a: {}, b: {} };

function log(content: string | HTMLElement, success?: boolean): void {
  const div = document.createElement('div');
  if (typeof content === 'string') {
    div.textContent = content;
  } else {
    div.appendChild(content);
  }
  if (success != null) {
    div.style.color = success ? 'green' : 'red';
  }
  document.getElementById('log')?.appendChild(div);
  window.scrollTo(0, document.body.scrollHeight);
}

function chooseDevice(): void {
  for (const dev of server.devices) {
    if (dev.model === 'com.nonolithlabs.cee') {
      onCEE(server.selectDevice(dev) as CEEDevice);
      return;
    } else if (dev.model === 'com.nonolithlabs.bootloader') {
      onBootloaderDevice(server.selectDevice(dev) as CEEDevice);
      return;
    }
  }
}

function onBootloaderDevice(dev: CEEDevice): void {
  // Bootloader: flash and verify
  dev.changed.subscribe(() => {
    startWithDevice(dev);

    const flashAndCheck = async () => {
      const valid = await crcApp(dev);
      if (!valid) {
        await erase(dev);
        await write(dev);
        const v2 = await crcApp(dev);
        if (v2) server.send('reset');
      } else {
        server.send('reset');
      }
    };

    flashAndCheck();
  });
}

function startWithDevice(dev: CEEDevice): void {
  if (testingSerial !== dev.serial) {
    testingSerial = dev.serial;
    const h1 = document.createElement('h1');
    h1.textContent = dev.serial;
    log(h1);
  }
}

// Promisified helpers for bootloader device
function erase(dev: CEEDevice): Promise<void> {
  return new Promise((resolve) => {
    (dev as unknown as { erase: (cb: () => void) => void }).erase(() => {
      log('Erased');
      resolve();
    });
  });
}

function crcApp(dev: CEEDevice): Promise<boolean> {
  return new Promise((resolve) => {
    (dev as unknown as { crcApp: (cb: (m: Record<string, unknown>) => void) => void }).crcApp((m) => {
      const firmware = (window as unknown as Record<string, unknown>).firmware as { crc: number } | undefined;
      const valid = firmware ? m.crc === firmware.crc : false;
      const vs = valid ? 'Valid' : 'INVALID';
      log(`App CRC: ${m.crc} - ${vs}`, valid);
      resolve(valid);
    });
  });
}

function write(_dev: CEEDevice): Promise<void> {
  return new Promise((resolve) => {
    const firmware = (window as unknown as Record<string, unknown>).firmware as { data: number[] };
    server.send('write', {
      data: firmware.data,
      id: server.createCallback((m) => {
        const success = (m as Record<string, unknown>).result === 0;
        log(`Wrote flash, status ${(m as Record<string, unknown>).result}`, success);
        if (success) resolve();
      }),
    });
  });
}

// Promisified sample getter
function getSample(stream: Stream, t: number): Promise<number> {
  return new Promise((resolve) => {
    stream.getSample(t, resolve);
  });
}

// Promisified setConstant
function setConstant(channel: Channel, mode: string | number, val: number): Promise<void> {
  return new Promise((resolve) => {
    channel.setConstant(String(mode), val, () => resolve());
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onCEE(dev: CEEDevice): void {
  let changedCount = 0;
  let changedCb: (() => void) | null = null;

  dev.changed.subscribe(() => {
    if (changedCount === 0) {
      startWithDevice(dev);
      if (dev.fwVersion !== ((window as unknown as Record<string, unknown>).firmware as { fwVersion: string })?.fwVersion) {
        server.send('enterBootloader');
        return;
      }

      data.serial = dev.serial;
      data.hwVersion = dev.hwVersion;
      data.fwVersion = dev.fwVersion;
      data.time = new Date();
      server.send('tempCalibration');
      log(`Found CEE ${dev.hwVersion}, ${dev.fwVersion}`);
      runTests(dev);
    } else {
      dev.startCapture();
      changedCb?.();
    }
    changedCount += 1;
  });

  function changeRaw(raw: boolean): Promise<void> {
    return new Promise((resolve) => {
      dev.configure({ raw });
      changedCb = resolve;
    });
  }

  async function zeroOffset(): Promise<void> {
    async function testStream(channel: Channel, stream: Stream, setval: number): Promise<void> {
      const d = await getSample(stream, 0.5);
      const target = stream.id === 'v' ? setval / 2 : 0;
      const success = Math.abs(d - target) < 100;
      log(`Channel ${channel.id} ${stream.id} offset at ${setval} is ${d} (${d - target})LSB`, success);
      if (!data[channel.id as 'a' | 'b'].offset) data[channel.id as 'a' | 'b'].offset = {};
      if (!data[channel.id as 'a' | 'b'].offset![setval]) data[channel.id as 'a' | 'b'].offset![setval] = {};
      data[channel.id as 'a' | 'b'].offset![setval][stream.id] = d;
    }

    async function offsetAt(setval: number): Promise<void> {
      await setConstant(dev.channels.a, 1, setval);
      await Promise.all([
        testStream(dev.channels.a, dev.channels.a.streams.v, setval),
        testStream(dev.channels.a, dev.channels.a.streams.i, setval),
        testStream(dev.channels.b, dev.channels.b.streams.v, setval),
        testStream(dev.channels.b, dev.channels.b.streams.i, setval),
      ]);
    }

    await changeRaw(true);
    await setConstant(dev.channels.b, 3, 0);
    await delay(100);
    await offsetAt(0);
    await offsetAt(3000);

    server.send('tempCalibration', {
      offset_a_v: -Math.round(data.a.offset![0].v),
      offset_a_i: -Math.round(data.a.offset![0].i),
      offset_b_v: -Math.round(data.b.offset![0].v),
      offset_b_i: -Math.round(data.b.offset![0].i),
    });
  }

  async function measureCSAError(): Promise<void> {
    await changeRaw(false);

    dev.channels.a.streams.i.setGain(32);
    dev.channels.b.streams.i.setGain(32);
    dev.channels.b.setDirect({ mode: '3', source: 'constant', value: 0, channel: dev.channels.b.id });
    await new Promise<void>((resolve) => {
      dev.channels.a.setPeriodic('1', 'triangle', 5, 2.5, 2.5, () => resolve());
    });

    log('Measuring 9919 error');
    const streams: Stream[] = [];
    const streamLabels: string[] = [];
    for (const [chId, channel] of Object.entries(dev.channels)) {
      for (const [sId, stream] of Object.entries(channel.streams)) {
        streams.push(stream);
        streamLabels.push(`${chId}_${sId}`);
      }
    }

    const l = new DataListener(dev, streams);
    l.configure(0, 0.4, 2000, false);
    l.submit();
    dev.startCapture();

    await new Promise<void>((resolve) => {
      l.done.subscribe(() => {
        dev.channels.a.streams.i.setGain(1);
        dev.channels.b.streams.i.setGain(1);

        data.sweep = {};
        for (let i = 0; i < streamLabels.length; i++) {
          data.sweep[streamLabels[i]] = Array.from(l.data[i]);
        }
        data.sweep.time = Array.from(l.xdata);
        log('done', true);
        resolve();
      });
    });
  }

  async function calibrateIset(): Promise<void> {
    async function calibrate(channel: Channel, target: number): Promise<void> {
      let dacval = 3000;
      const otherdac = 0;
      let stepsize = 50;
      let above = false;
      let count = 0;

      const step = (): Promise<void> => new Promise((resolve) => {
        const [daca, dacb] = channel.id === 'a' ? [dacval, otherdac] : [otherdac, dacval];
        dev.controlTransfer(0xC0, 0x15, Math.round(daca), Math.round(dacb), [], 0, () => {
          channel.streams.i.getSample(0.02, (d) => {
            if (stepsize <= 1) {
              log(`ISET DAC ${channel.id} ${target}ma is ${dacval}`, true);
              if (!data[channel.id as 'a' | 'b'].iset) data[channel.id as 'a' | 'b'].iset = {};
              data[channel.id as 'a' | 'b'].iset![target] = dacval;
              resolve();
              return;
            }

            const nabove = d > target;
            if (above !== nabove) {
              stepsize /= 2;
              above = nabove;
            }

            dacval = Math.round(dacval + (above ? stepsize : -stepsize));
            count += 1;

            if (dacval < 1300 || count > 100) {
              log(`DACVAL too far, ${count}`, false);
              resolve();
            } else {
              step().then(resolve);
            }
          });
        });
      });

      await step();
    }

    await setConstant(dev.channels.b, 1, 0);
    await setConstant(dev.channels.a, 1, 5);
    await calibrate(dev.channels.a, 200);
    await calibrate(dev.channels.a, 390);
    await setConstant(dev.channels.a, 1, 0);
    await setConstant(dev.channels.b, 1, 5);
    await calibrate(dev.channels.b, 200);
    await calibrate(dev.channels.b, 390);
  }

  function writeEEPROM(): Promise<void> {
    return new Promise((resolve) => {
      server.send('writeCalibration', {
        offset_a_v: -Math.round(data.a.offset![0].v),
        offset_a_i: -Math.round(data.a.offset![0].i),
        offset_b_v: -Math.round(data.b.offset![0].v),
        offset_b_i: -Math.round(data.b.offset![0].i),
        dac200_a: data.a.iset![200],
        dac200_b: data.b.iset![200],
        dac400_a: data.a.iset![390],
        dac400_b: data.b.iset![390],
        id: server.createCallback(() => {
          log('Wrote EEPROM', true);
          resolve();
        }),
      });
    });
  }

  async function runTests(dev: CEEDevice): Promise<void> {
    await zeroOffset();
    await measureCSAError();
    await calibrateIset();
    dev.pauseCapture();
    log('Testing complete', true);
    await writeEEPROM();
    saveData();
  }

  function saveData(): void {
    fetch('http://localhost:1337/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(() => {
      log('Saved data', true);
    });
  }
}

// --- Setup page for calibration ---

function setFirmware(fw: { fwVersion: string; device: string; hwVersion: string; crc: number }): void {
  (window as unknown as Record<string, unknown>).firmware = fw;
  log(`Loaded firmware ${fw.fwVersion} for ${fw.device} ${fw.hwVersion}, CRC = ${fw.crc}`, true);
}

document.addEventListener('DOMContentLoaded', () => {
  server.connect();

  server.disconnected.subscribe(() => {
    document.body.innerHTML = '<h1>Disconnected</h1>';
  });

  server.devicesChanged.subscribe(chooseDevice);
  chooseDevice();

  // Load firmware JSON
  fetch(`cee.json?${+new Date()}`)
    .then(r => r.json())
    .then(setFirmware)
    .catch(() => log('Server request failed', false));
});
