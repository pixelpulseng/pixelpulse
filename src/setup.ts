/**
 * Setup wizard - minimal JS for page navigation and connect detection
 * Ported from inline scripts in setup.html
 */

let currentPage = 0;

const pageFuncs: Record<number, () => void> = {};
const pageUnload: Record<number, () => void> = {};

function selectPage(n: number): void {
  const unload = pageUnload[currentPage];
  if (unload) unload();
  currentPage = n;

  document.querySelectorAll('.opened').forEach(el => el.classList.remove('opened'));
  document.getElementById(`p${n}`)?.classList.add('opened');

  const fn = pageFuncs[n];
  if (fn) fn();
}

function nextPage(): void {
  selectPage(currentPage + 1);
}

// Expose for onclick handlers in HTML
Object.assign(window, { nextPage, selectPage });

// Page 1: browser check
pageFuncs[1] = () => {
  const ua = navigator.userAgent;
  if (ua.includes('Chrom')) {
    const el = document.querySelector('#getbrowser .ischrome') as HTMLElement | null;
    if (el) el.style.display = 'block';
    const btn = document.getElementById('browsernext');
    if (btn) {
      btn.textContent = 'Continue';
      btn.classList.remove('secondary');
      btn.classList.add('primary');
    }
    setTimeout(nextPage, 700);
  } else if (ua.includes('Firefox')) {
    const el = document.querySelector('#getbrowser .isfirefox') as HTMLElement | null;
    if (el) el.style.display = 'block';
    const dl = document.querySelector('#getbrowser .download') as HTMLElement | null;
    if (dl) dl.style.display = 'block';
  } else {
    const el = document.querySelector('#getbrowser .unsupported') as HTMLElement | null;
    if (el) el.style.display = 'block';
    const dl = document.querySelector('#getbrowser .download') as HTMLElement | null;
    if (dl) dl.style.display = 'block';
  }
};

// Page 2: install Nonolith Connect
pageFuncs[2] = () => {
  const ua = navigator.userAgent;
  if (ua.includes('Linux')) document.getElementById('install-linux')?.classList.add('highlight');
  else if (ua.includes('Windows')) document.getElementById('install-win')?.classList.add('highlight');
  else if (ua.includes('Mac')) document.getElementById('install-mac')?.classList.add('highlight');

  tryConnect();
};

function tryConnect(): void {
  const ws = new WebSocket('ws://localhost:9003/ws/v0');
  ws.onopen = () => {
    const install = document.getElementById('install');
    if (install) install.style.display = 'none';
    const success = document.getElementById('install-success');
    if (success) success.style.display = 'block';
    setTimeout(nextPage, 1000);
  };
  ws.onclose = () => {
    setTimeout(tryConnect, 500);
  };
}

document.addEventListener('DOMContentLoaded', () => {
  selectPage(1);
});
