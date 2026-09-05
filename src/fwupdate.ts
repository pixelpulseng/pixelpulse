/**
 * Firmware update
 * Ported from fwupdate.coffee
 * Original: (C) 2012 Nonolith Labs
 * Author: Kevin Mehall <km@kevinmehall.net>
 * Distributed under the terms of the GNU GPLv3
 */

import { server, Device, BootloaderDevice } from './dataserver.js';

interface FirmwareImage {
  fwVersion: string;
  gitVersion?: string;
  hwVersion: string;
  device_match: string;
  device: string;
  crc: number;
  data: number[];
}

interface UrlParams {
  image?: string;
  nohwcheck?: string;
}

function getElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Element #${id} not found`);
  }
  return el as T;
}

function hideElement(id: string): void {
  getElement(id).style.display = 'none';
}

function showElement(id: string): void {
  getElement(id).style.display = '';
}

function setTextContent(id: string, text: string): void {
  getElement(id).textContent = text;
}

function hideAll(selector: string): void {
  const els = document.querySelectorAll<HTMLElement>(selector);
  for (const el of els) {
    el.style.display = 'none';
  }
}

class FirmwareUpdateApp {
  private device: Device | null = null;
  private firmware: FirmwareImage | null = null;
  private params: UrlParams;

  constructor(params: UrlParams) {
    this.params = params;

    server.connect();

    server.disconnected.listen(() => {
      hideElement('no-devices');
      hideElement('multi-device-note');
      hideElement('device-info');
      showElement('no-connect');
    });

    if (params.image === 'custom') {
      this.startFirmwareSelPage();
    } else if (params.image) {
      this.loadFirmware(params.image);
    }
  }

  private startFirmwareSelPage(): void {
    hideAll('#p1 > div');
    showElement('upload-firmware');

    const fileInput = getElement<HTMLInputElement>('file');
    const handler = (e: Event): void => {
      fileInput.removeEventListener('change', handler);
      const target = e.target as HTMLInputElement;
      const files = target.files;
      if (!files || files.length === 0) return;
      const file = files[0];
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const json = JSON.parse(reader.result as string) as FirmwareImage;
          this.firmwareLoaded(json);
        } catch (error) {
          console.error(error);
          alert('Invalid JSON');
        }
      };
      reader.readAsText(file, 'utf-8');
    };
    fileInput.addEventListener('change', handler);
  }

  private async loadFirmware(image: string): Promise<void> {
    if (/(\w[\w.]+\/)+\w[\w.]+/.test(image)) {
      try {
        const response = await fetch('/firmware/' + image);
        if (!response.ok) {
          alert('Could not load firmware image');
          return;
        }
        const json = (await response.json()) as FirmwareImage;
        this.firmwareLoaded(json);
      } catch {
        alert('Could not load firmware image');
      }
    } else {
      alert('Invalid firmware image path');
    }
  }

  private firmwareLoaded = (firmware: FirmwareImage): void => {
    this.firmware = firmware;

    let version = this.firmware.fwVersion;
    if (this.firmware.gitVersion) {
      version = `${version} (git ${this.firmware.gitVersion})`;
    }

    setTextContent('available-version', version);
    this.startDevicePage();
  };

  private startDevicePage(): void {
    server.devicesChanged.listen(this.updateDevices);
    this.updateDevices();
  }

  private isApplicable(dev: Device): boolean {
    if (!this.firmware) return false;

    if (
      dev.model === this.firmware.device_match &&
      dev.hwVersion === this.firmware.hwVersion
    ) {
      return true;
    } else if (dev.model === 'com.nonolithlabs.bootloader') {
      return true;
    }
    return false;
  }

  private updateDevices = (): void => {
    const potentialDevices = server.devices.filter((dev) =>
      this.isApplicable(dev),
    );

    hideAll('#p1 > div');
    hideElement('btn_install');

    if (potentialDevices.length === 0) {
      showElement('no-devices');
      this.device = null;
    } else {
      if (potentialDevices.length > 1) {
        showElement('multi-device-note');
      }
      showElement('device-info');
      showElement('btn_install');
      this.selectDevice(potentialDevices[0]);
    }
  };

  private selectDevice(device: Device): void {
    this.device = device;
    let hardwareDevice = '';
    let firmwareVersion = '';

    if (this.device.model === 'com.nonolithlabs.cee') {
      hardwareDevice = `Nonolith CEE ${this.device.hwVersion}`;
      const parts = this.device.fwVersion.split('/');
      firmwareVersion = parts[0];
      const gitVersion = parts[1];
      if (gitVersion) {
        firmwareVersion = `${firmwareVersion} (git ${gitVersion})`;
      }
    } else if (this.device.model === 'com.nonolithlabs.bootloader') {
      if (this.device.hwVersion === 'unknown') {
        hardwareDevice = 'Bootloader';
      } else {
        hardwareDevice = this.device.hwVersion;
      }
      firmwareVersion = 'Unknown (already in bootloader mode)';
    }

    setTextContent('hw-device', hardwareDevice);
    setTextContent('current-version', firmwareVersion);
    setTextContent('serial', this.device.serial);

    const btnInstall = getElement('btn_install');
    const handler = (): void => {
      btnInstall.removeEventListener('click', handler);
      this.startInstall();
    };
    btnInstall.addEventListener('click', handler);
  }

  private startInstall(): void {
    server.devicesChanged.unListen(this.updateDevices);

    const openedEls = document.querySelectorAll('.opened');
    for (const el of openedEls) {
      el.classList.remove('opened');
    }
    getElement('p2').classList.add('opened');
    getElement('log').innerHTML = '';

    const logEl = getElement('log');

    const log = (message: string, cls = 'run'): void => {
      const div = document.createElement('div');
      div.innerHTML = message;
      div.className = cls;
      logEl.appendChild(div);
    };

    const logDone = (): void => {
      const lastChild = logEl.querySelector('div:last-child');
      if (lastChild) {
        lastChild.classList.add('ok');
      }
    };

    if (!this.firmware || !this.device) return;

    log(`Installing firmware ${this.firmware.fwVersion}`, 'ok');

    const serial = this.device.serial;
    const firmware = this.firmware;
    const params = this.params;

    const waitForDevice = (targetSerial: string): Promise<Device> => {
      return new Promise((resolve) => {
        const listCb = (): void => {
          for (const dev of server.devices) {
            if (dev.serial === targetSerial) {
              server.devicesChanged.unListen(listCb);
              resolve(dev);
              return;
            }
          }
        };
        server.devicesChanged.listen(listCb);
      });
    };

    const startBootloader = async (dev: Device): Promise<void> => {
      const deviceConn = server.selectDevice(dev);

      await new Promise<void>((resolve) => {
        const cb = (): void => {
          logDone();
          deviceConn.changed.unListen(cb);
          resolve();
        };
        log('Selecting device');
        deviceConn.changed.listen(cb);
      });

      if (dev.model === 'com.nonolithlabs.bootloader') {
        await doUpdate(deviceConn as BootloaderDevice);
      } else {
        log('Entering bootloader mode');
        server.send('enterBootloader');
        const newDev = await waitForDevice(serial);
        logDone();
        await startBootloader(newDev);
      }
    };

    const doUpdate = async (deviceConn: BootloaderDevice): Promise<void> => {
      log('Validating image');

      const product = deviceConn.hw_product;
      const version = deviceConn.hw_version;

      if (!(product === firmware.device && version === firmware.hwVersion)) {
        log('Firmware image is not for this hardware.', 'fail');
        log(`Device: ${product} ${version}`, 'fail');
        log(`Firmware: ${firmware.device} ${firmware.hwVersion}`, 'fail');
        if (!params.nohwcheck) return;
      } else {
        logDone();
      }

      log('Erasing');
      await new Promise<void>((resolve) => {
        deviceConn.erase(() => resolve());
      });
      logDone();

      log('Writing flash');
      await new Promise<void>((resolve) => {
        deviceConn.write(firmware.data, () => resolve());
      });
      logDone();

      log('Verifying install');
      const crcResult = await new Promise<Record<string, unknown>>((resolve) => {
        deviceConn.crcApp((m) => resolve(m));
      });
      logDone();

      const valid = crcResult.crc === firmware.crc;
      if (!valid) {
        log(`INVALID CRC ${crcResult.crc} != ${firmware.crc}`, 'fail');
      } else {
        log('Resetting device');
        deviceConn.reset();
        const newDev = await waitForDevice(serial);
        if (newDev.model === 'com.nonolithlabs.bootloader') {
          log('Device remained in bootloader mode', 'fail');
        } else {
          logDone();
          log('Success!', 'ok');
          showElement('btn_done');
        }
      }
    };

    void startBootloader(this.device);
  }
}

// URL params
function parseUrlParams(): UrlParams {
  const searchParams = new URLSearchParams(location.search);
  const params: UrlParams = {};
  const image = searchParams.get('image');
  if (image !== null) params.image = image;
  const nohwcheck = searchParams.get('nohwcheck');
  if (nohwcheck !== null) params.nohwcheck = nohwcheck;
  return params;
}

const params = parseUrlParams();

document.addEventListener('DOMContentLoaded', () => {
  new FirmwareUpdateApp(params);
});
