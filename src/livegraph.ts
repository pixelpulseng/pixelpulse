/**
 * Real-time canvas plotting library
 * Ported from livegraph.coffee
 * Original: (C) 2011 Kevin Mehall (Nonolith Labs) <km@kevinmehall.net>
 * Distributed under the terms of the BSD License
 */

import { gridLabels, logGridLabels } from './human-units.js';
import { PhosphorRenderer } from './phosphor.js';

export const PADDING = 10;
export const AXIS_SPACING = 25;

// Snap to half-gridline resolution: midpoints between the rendered lines
// count too, keeping snap steps fine without busying up the grid. The
// lattice extrapolates past the drawn ticks so drags beyond the edge
// still snap.
function nearestTick(value: number, grid?: [number, string][]): number {
  if (!grid || grid.length === 0) return value;
  if (grid.length === 1) return grid[0][0];
  const step = (grid[1][0] - grid[0][0]) / 2;
  if (!(step > 0)) return value;
  return grid[0][0] + Math.round((value - grid[0][0]) / step) * step;
}

// --- Geometry ---

export interface Geom {
  ytop: number;
  ybottom: number;
  xleft: number;
  xright: number;
  width: number;
  height: number;
}

// --- Transform ---

export type Transform = [sx: number, sy: number, dx: number, dy: number];

export function makeTransform(geom: Geom, xaxis: Axis, yaxis: Axis): Transform {
  const sx = geom.width / xaxis.span();
  const sy = -geom.height / yaxis.span();
  const dx = geom.xleft - xaxis.visibleMin * sx;
  const dy = geom.ybottom - yaxis.visibleMin * sy;
  return [sx, sy, dx, dy];
}

export function transform(x: number, y: number, [sx, sy, dx, dy]: Transform): [number, number] {
  return [dx + x * sx, dy + y * sy];
}

export function invTransform(x: number, y: number, [sx, sy, dx, dy]: Transform): [number, number] {
  return [(x - dx) / sx, (y - dy) / sy];
}

function snapPx(px: number): number {
  return Math.round(px - 0.5) + 0.5;
}

function relMousePos(elem: HTMLElement, event: MouseEvent): [number, number] {
  const rect = elem.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

// --- Axis ---

export class Axis {
  visibleMin: number;
  visibleMax: number;
  autoScroll: number | false;
  isAnimating = false;
  prescale?: number;

  constructor(
    public min: number,
    public max: number,
    public unit = '',
    public scaleUnit = false,
  ) {
    if (max as unknown === 'auto') {
      this.autoScroll = min;
      this.max = 0;
      this.visibleMax = 0;
    } else {
      this.autoScroll = false;
      this.visibleMax = max;
    }
    this.visibleMin = min;
  }

  span(): number {
    return this.visibleMax - this.visibleMin;
  }

  xtransform(x: number, geom: Geom): number {
    return (x - this.visibleMin) * geom.width / this.span() + geom.xleft;
  }

  ytransform(y: number, geom: Geom): number {
    return geom.ybottom - (y - this.visibleMin) * geom.height / this.span();
  }

  invYtransform(ypx: number, geom: Geom): number {
    return (geom.ybottom - ypx) / geom.height * this.span() + this.visibleMin;
  }

  window(min: number, max: number, done?: boolean, target?: [number, number]): void {
    if (min !== this.visibleMin || max !== this.visibleMax) {
      this.visibleMin = min;
      this.visibleMax = max;
      this.isAnimating = true;
      this.windowChanged(min, max, done, target);
    }

    if (done && this.isAnimating) {
      this.windowDoneAnimating(this.visibleMin, this.visibleMax);
      this.isAnimating = false;
    }
  }

  windowChanged(_min: number, _max: number, _done?: boolean, _target?: [number, number]): void {}
  windowDoneAnimating(_min: number, _max: number): void {}

  gridLabels(ticks: number): [number, string][] {
    return gridLabels(
      this.visibleMin, this.visibleMax,
      this.unit, ticks, this.scaleUnit,
      this.min, this.max, this.prescale,
    );
  }
}

export class LogAxis extends Axis {
  override gridLabels(_ticks: number): [number, string][] {
    return logGridLabels(this.visibleMin, this.visibleMax, this.unit);
  }
}

class DigitalAxis {
  min = 0;
  max = 1;

  xtransform(x: number, geom: Geom): number {
    return x ? geom.xleft : geom.xright;
  }

  ytransform(y: number, geom: Geom): number {
    return y ? geom.ytop : geom.ybottom;
  }

  invYtransform(ypx: number, geom: Geom): boolean {
    return (geom.ybottom - ypx) > geom.height / 2;
  }
}

export const digitalAxis = new DigitalAxis();

// --- Series ---

export class Series {
  // Per-series vertical transform applied on top of the graph's shared y-axis,
  // for scope-style overlay mode where each trace has its own volts/div and
  // vertical position. Rendered y = (ydata - yoffset) * yscale, so yoffset is
  // in data units and yscale is a dimensionless gain. Defaults are a no-op, so
  // ordinary single-axis graphs are unaffected.
  yoffset = 0;
  yscale = 1;

  constructor(
    public xdata: Float32Array | number[],
    public ydata: Float32Array | number[],
    public color: [number, number, number],
    public style?: string,
  ) {}

  cssColor(): string {
    return `rgb(${this.color[0]},${this.color[1]},${this.color[2]})`;
  }
}

// --- WebGL shader state ---

interface ShaderProgram extends WebGLProgram {
  attrib: { x: number; y: number };
  uniform: { transform: WebGLUniformLocation; color: WebGLUniformLocation };
}

interface GLState {
  gl: WebGLRenderingContext;
  shaderProgram: ShaderProgram;
  xBuffer: WebGLBuffer;
  yBuffer: WebGLBuffer;
}

// --- Canvas options ---

export interface CanvasOptions {
  yleft?: boolean;
  yright?: boolean;
  ygrid?: boolean;
  xbottom?: boolean;
  xgrid?: boolean;
  xgridZero?: boolean;
  gridcolor?: string;
}

// --- LiveGraph Canvas ---

export class GraphCanvas {
  axisCanvas: HTMLCanvasElement;
  graphCanvas: HTMLCanvasElement;
  ctxa: CanvasRenderingContext2D;
  ctxg: CanvasRenderingContext2D | null = null;
  glState: GLState | null = null;

  geom!: Geom;
  width = 0;
  height = 0;

  showYleft: boolean;
  showYright: boolean;
  showYgrid: boolean;
  showXbottom: boolean;
  showXgrid: boolean;
  showXgridZero: boolean;
  gridcolor: string;

  rightClickTime = 0;
  overlays: Overlay[] = [];
  action: Action | null = null;
  renderer = '';
  phosphor: PhosphorRenderer | null = null;
  phosphorEnabled = false;
  phosphorAccumulate = false; // true in triggered mode: accumulate across sweeps
  phosphorNeedsFull = true; // full re-scatter required (transform/buffer change)
  protected phosphorTransform: [number, number, number, number] | null = null;
  protected phosphorShiftCarry = 0; // fractional scroll-shift remainder (px)

  private redrawRequested = false;
  private axisRedrawRequested = false;
  private xgridticks = 10;
  private ygridticks = 10;

  onResized?: () => void;

  constructor(
    public div: HTMLElement,
    public xaxis: Axis,
    public yaxis: Axis,
    public series: Series[],
    opts: CanvasOptions = {},
  ) {
    this.div.setAttribute('class', 'livegraph');

    this.axisCanvas = document.createElement('canvas');
    this.graphCanvas = document.createElement('canvas');
    this.div.appendChild(this.axisCanvas);
    this.div.appendChild(this.graphCanvas);

    this.div.addEventListener('mousedown', this.mousedown);
    this.div.addEventListener('dblclick', this.doubleclick);
    this.div.addEventListener('contextmenu', (e) => e.preventDefault());

    this.showYleft = opts.yleft ?? true;
    this.showYright = opts.yright ?? true;
    this.showYgrid = opts.ygrid ?? true;
    this.showXbottom = opts.xbottom ?? false;
    this.showXgrid = opts.xgrid ?? false;
    this.showXgridZero = opts.xgridZero ?? false;
    this.gridcolor = opts.gridcolor ?? 'rgba(0,0,0,0.08)';

    this.ctxa = this.axisCanvas.getContext('2d')!;

    if (!this.initWebGL()) {
      this.initCanvas2D();
    }
  }

  private initCanvas2D(): boolean {
    this.ctxg = this.graphCanvas.getContext('2d');
    this.renderer = 'canvas2d';
    return true;
  }

  private initWebGL(): boolean {
    const shaderVS = `
      attribute float x;
      attribute float y;
      uniform mat4 transform;
      void main(void) {
        gl_Position = transform * vec4(x, y, 1.0, 1.0);
        gl_Position.z = -1.0;
        gl_Position.w = 1.0;
      }
    `;

    const shaderFS = `
      #ifdef GL_ES
      precision mediump float;
      #endif
      uniform vec4 color;
      void main(void) {
        gl_FragColor = color;
      }
    `;

    const gl = this.graphCanvas.getContext('webgl');
    if (!gl) return false;

    const compileShader = (type: number, source: string): WebGLShader | null => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    };

    const fs = compileShader(gl.FRAGMENT_SHADER, shaderFS);
    const vs = compileShader(gl.VERTEX_SHADER, shaderVS);
    if (!fs || !vs) return false;

    const program = gl.createProgram()!;
    gl.attachShader(program, fs);
    gl.attachShader(program, vs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Could not initialize shaders');
      return false;
    }

    gl.useProgram(program);

    const shaderProgram: ShaderProgram = Object.assign(program, {
      attrib: {
        x: gl.getAttribLocation(program, 'x'),
        y: gl.getAttribLocation(program, 'y'),
      },
      uniform: {
        transform: gl.getUniformLocation(program, 'transform')!,
        color: gl.getUniformLocation(program, 'color')!,
      },
    });

    gl.enableVertexAttribArray(shaderProgram.attrib.x);
    gl.enableVertexAttribArray(shaderProgram.attrib.y);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const xBuffer = gl.createBuffer()!;
    const yBuffer = gl.createBuffer()!;

    this.glState = { gl, shaderProgram, xBuffer, yBuffer };
    this.renderer = 'webgl';
    return true;
  }

  // --- Performance stats ---

  private psDiv?: HTMLElement;
  private psCount = 0;
  private psSum = 0;
  private psRunningSum = 0;
  private psRunningCount = 0;

  perfStatEnable(div: HTMLElement): void {
    this.psDiv = div;
    setInterval(() => {
      this.psRunningSum += this.psSum;
      this.psRunningCount += this.psCount;
      this.psDiv!.innerHTML =
        `${this.renderer}: ${this.psCount}fps; ${this.psSum}ms draw time; Avg: ${this.psRunningSum / this.psRunningCount}`;
      this.psCount = 0;
      this.psSum = 0;
    }, 1000);
  }

  private perfStat(time: number): void {
    this.psCount += 1;
    this.psSum += time;
  }

  // --- Actions ---

  startAction(action?: Action): void {
    if (this.action) {
      this.action.cancel();
    }
    this.action = action ?? null;
  }

  // --- Mouse handling ---

  private mousedown = (e: MouseEvent): void => {
    if (e.button === 0) {
      const pos = relMousePos(this.div, e);
      this.onClick(pos, e);
    } else if (e.button === 2) {
      const t = +new Date();
      if (this.rightClickTime && this.rightClickTime + 200 > t) {
        this.rightClickTime = 0;
        this.onDblClick(e, relMousePos(this.div, e), 2);
      } else {
        this.rightClickTime = t;
      }
    }
  };

  startDrag(origPos: [number, number]): () => void {
    let pos = origPos;

    const mousemove = (e: MouseEvent) => {
      pos = relMousePos(this.div, e);
      this.action?.onDrag(pos, origPos);
    };

    const mouseup = () => {
      this.action?.onRelease(pos, origPos);
      window.removeEventListener('mousemove', mousemove);
      window.removeEventListener('mouseup', mouseup);
      document.body.style.cursor = 'auto';
    };

    window.addEventListener('mousemove', mousemove);
    window.addEventListener('mouseup', mouseup);

    return mouseup;
  }

  onClick(_pos: [number, number], _e: MouseEvent): void {}

  private doubleclick = (e: MouseEvent): void => {
    const pos = relMousePos(this.div, e);
    this.onDblClick(e, pos, 1);
  };

  onDblClick(_e: MouseEvent, _pos: [number, number], _btn: number): void {}

  // --- Resize ---

  resized(): void {
    if (!(this.div.offsetWidth > 0 && this.div.offsetHeight > 0 && this.xaxis && this.yaxis)) {
      return;
    }

    this.width = this.div.offsetWidth;
    this.height = this.div.offsetHeight;
    this.axisCanvas.width = this.width;
    this.axisCanvas.height = this.height;
    this.graphCanvas.width = this.width;
    this.graphCanvas.height = this.height;

    const yleftPx = this.showYleft ? AXIS_SPACING : 0;
    const yrightPx = this.showYright ? AXIS_SPACING : 0;
    const xbottomPx = this.showXbottom ? AXIS_SPACING : 0;

    this.geom = {
      ytop: PADDING,
      ybottom: this.height - (PADDING + xbottomPx),
      xleft: PADDING + yleftPx,
      xright: this.width - (PADDING + yrightPx),
      width: this.width - 2 * PADDING - (yleftPx + yrightPx),
      height: this.height - 2 * PADDING - xbottomPx,
    };

    this.xgridticks = Math.min(this.width / 50, 10);
    this.ygridticks = this.height / 35;

    if (this.phosphor) {
      this.phosphor.resize(this.width, this.height, this.geom);
      this.phosphorNeedsFull = true;
    }

    this.onResized?.();
    this.refreshViewParams();
    this.needsRedraw(true);
  }

  // Snap a data-space coordinate to the nearest drawn gridline value, so
  // scrubbing drag handles steps through round values (with phosphor
  // persistence, each step leaves a distinct overlaid trace).
  snapX(value: number): number {
    return nearestTick(value, this.xaxis?.gridLabels(this.xgridticks));
  }

  snapY(value: number): number {
    return nearestTick(value, this.yaxis?.gridLabels(this.ygridticks));
  }

  enablePhosphor(color: [number, number, number]): void {
    if (!this.phosphor) {
      this.phosphor = new PhosphorRenderer(this.div, color, this.graphCanvas);
    } else {
      this.phosphor.setColor(color);
    }
    this.phosphorEnabled = true;
    this.phosphorNeedsFull = true;
    if (this.width > 0) {
      this.phosphor.resize(this.width, this.height, this.geom);
    }
    this.needsRedraw();
  }

  disablePhosphor(): void {
    this.phosphorEnabled = false;
    this.phosphor?.clear();
    this.needsRedraw();
  }

  // --- Drawing ---

  private refreshViewParams(): void {
    if (this.glState) {
      this.webglRefreshViewParams();
    }
  }

  redrawAxis(): void {
    this.ctxa.clearRect(0, 0, this.width, this.height);

    let xgrid: [number, string][] | undefined;
    let ygrid: [number, string][] | undefined;

    if (this.showXgrid || this.showXbottom) {
      xgrid = this.xaxis.gridLabels(this.xgridticks);
    }
    if (this.showYgrid || this.showYleft || this.showYright) {
      ygrid = this.yaxis.gridLabels(this.ygridticks);
    }

    if ((this.showXgrid || this.showXgridZero) && xgrid) this.drawXgrid(xgrid);
    if (this.showXbottom && xgrid) this.drawXAxis(xgrid, this.geom.ybottom);
    if (this.showYgrid && ygrid) this.drawYgrid(ygrid);
    if (this.showYleft && ygrid) this.drawYAxis(ygrid, this.geom.xleft, 'right', -5);
    if (this.showYright && ygrid) this.drawYAxis(ygrid, this.geom.xright, 'left', 8);
  }

  private drawXAxis(xgrid: [number, string][], y: number): void {
    this.ctxa.strokeStyle = 'black';
    this.ctxa.lineWidth = 1;
    this.ctxa.beginPath();
    this.ctxa.moveTo(snapPx(this.geom.xleft), snapPx(y));
    this.ctxa.lineTo(snapPx(this.geom.xright), snapPx(y));
    this.ctxa.stroke();

    this.ctxa.textAlign = 'center';
    this.ctxa.textBaseline = 'top';

    for (const [x, label] of xgrid) {
      const xp = snapPx(this.xaxis.xtransform(x, this.geom));
      this.ctxa.beginPath();
      this.ctxa.moveTo(xp, y - 4);
      this.ctxa.lineTo(xp, y + 4);
      this.ctxa.stroke();
      this.ctxa.fillText(label, xp, y + 5);
    }
  }

  private drawXgrid(grid: [number, string][]): void {
    if (this.showXgridZero && !this.showXgrid) {
      grid = [[0, '0']];
    }

    this.ctxa.strokeStyle = this.gridcolor;
    this.ctxa.lineWidth = 1;
    for (const [x] of grid) {
      const xp = snapPx(this.xaxis.xtransform(x, this.geom));
      if (xp > this.geom.xright + 1 || xp < this.geom.xleft) continue;
      this.ctxa.beginPath();
      this.ctxa.moveTo(xp, this.geom.ybottom);
      this.ctxa.lineTo(xp, this.geom.ytop);
      this.ctxa.stroke();
    }
  }

  private drawYAxis(grid: [number, string][], x: number, align: CanvasTextAlign, textoffset: number): void {
    this.ctxa.strokeStyle = 'black';
    this.ctxa.lineWidth = 1;
    this.ctxa.textAlign = align;
    this.ctxa.textBaseline = 'middle';

    this.ctxa.beginPath();
    this.ctxa.moveTo(snapPx(x), snapPx(this.geom.ytop));
    this.ctxa.lineTo(snapPx(x), snapPx(this.geom.ybottom));
    this.ctxa.stroke();

    for (const [y, label] of grid) {
      const yp = snapPx(this.yaxis.ytransform(y, this.geom));
      this.ctxa.beginPath();
      this.ctxa.moveTo(x - 4, yp);
      this.ctxa.lineTo(x + 4, yp);
      this.ctxa.stroke();
      this.ctxa.fillText(label, x + textoffset, yp);
    }
  }

  private drawYgrid(grid: [number, string][]): void {
    this.ctxa.strokeStyle = this.gridcolor;
    this.ctxa.lineWidth = 1;
    for (const [y] of grid) {
      const yp = snapPx(this.yaxis.ytransform(y, this.geom));
      this.ctxa.beginPath();
      this.ctxa.moveTo(this.geom.xleft, yp);
      this.ctxa.lineTo(this.geom.xright, yp);
      this.ctxa.stroke();
    }
  }

  needsRedraw(fullRedraw = false): void {
    this.axisRedrawRequested ||= fullRedraw;
    if (!this.redrawRequested) {
      this.redrawRequested = true;
      requestAnimationFrame(this.redraw);
    }
  }

  // Force a synchronous redraw. Needed before reading back the WebGL trace
  // canvas (created without preserveDrawingBuffer): drawImage() only sees the
  // framebuffer in the same task that rendered it.
  drawSync(): void {
    this.redraw();
  }

  private redraw = (): void => {
    const startTime = performance.now();

    if (this.height !== this.div.offsetHeight || this.width !== this.div.offsetWidth) {
      this.resized();
    }

    this.redrawRequested = false;

    // Hidden (display:none) or not yet laid out: resized() bails before
    // creating geom, and nothing can be drawn anyway
    if (!this.geom) return;

    this.action?.onAnim();

    if (this.axisRedrawRequested) {
      this.redrawAxis();
      this.refreshViewParams();
      this.axisRedrawRequested = false;
      for (const overlay of this.overlays) {
        overlay.resized();
      }
    }

    this.redrawGraph();
    this.perfStat(performance.now() - startTime);
  };

  private redrawGraph(): void {
    if (this.phosphorEnabled && this.phosphor) {
      this.redrawPhosphor();
    }

    if (this.glState) {
      this.redrawGraphWebGL();
    } else {
      this.redrawGraphCanvas2D();
    }
  }

  private redrawPhosphor(): void {
    if (!this.phosphor) return;

    // Triggered accumulation fades old sweeps (persistence); scrolling mode
    // doesn't fade — history physically exits off the left edge.
    this.phosphor.decayPerSecond = this.phosphorAccumulate ? 0.25 : 1.0;

    // Samples are deposited incrementally as data arrives (see
    // TimeseriesGraph.onPhosphorData); a full re-scatter happens only when
    // the view transform changes or the data buffer is rebuilt.
    const t = makeTransform(this.geom, this.xaxis, this.yaxis);
    const pt = this.phosphorTransform;
    if (!pt || pt[0] !== t[0] || pt[1] !== t[1] || pt[2] !== t[2] || pt[3] !== t[3]) {
      this.phosphorNeedsFull = true;
    }

    if (this.phosphorNeedsFull) {
      this.phosphorNeedsFull = false;
      this.phosphorTransform = t;
      this.phosphorShiftCarry = 0;
      this.phosphor.clear();
      this.phosphorFullScatter(t);
    }

    if (this.phosphor.render(this.geom)) {
      this.needsRedraw(); // persistence still fading
    }
  }

  protected phosphorFullScatter([sx, sy, dx, dy]: [number, number, number, number]): void {
    for (const series of this.series) {
      this.phosphor!.scatter(
        series.xdata, series.ydata,
        sx, sy, dx, dy, this.geom,
      );
    }
  }

  private redrawGraphCanvas2D(): void {
    if (!this.ctxg) return;
    this.ctxg.clearRect(0, 0, this.width, this.height);
    this.ctxg.lineWidth = this.phosphorEnabled ? 1 : 2;
    this.ctxg.globalAlpha = this.phosphorEnabled ? 0.3 : 1.0;

    const [sx, sy, dx, dy] = makeTransform(this.geom, this.xaxis, this.yaxis);

    for (const series of this.series) {
      this.ctxg.strokeStyle = series.cssColor();
      this.ctxg.save();

      this.ctxg.beginPath();
      this.ctxg.rect(
        this.geom.xleft, this.geom.ytop,
        this.geom.xright - this.geom.xleft,
        this.geom.ybottom - this.geom.ytop,
      );
      this.ctxg.clip();

      this.ctxg.beginPath();
      const datalen = Math.min(series.xdata.length, series.ydata.length);

      // Fold the per-series vertical transform into sy/dy (see redrawGraphWebGL).
      const sys = sy * series.yscale;
      const dys = dy - sy * series.yoffset * series.yscale;

      let cull = true;
      for (let i = 0; i < datalen; i++) {
        if (cull && series.xdata[i + 1] < this.xaxis.visibleMin) continue;

        const x = series.xdata[i];
        const y = series.ydata[i];
        this.ctxg.lineTo(x * sx + dx, y * sys + dys);

        if (cull && x > this.xaxis.visibleMax) break;
      }

      this.ctxg.stroke();
      this.ctxg.restore();
    }
    this.ctxg.globalAlpha = 1.0;
  }

  // Base transform components (shared y-axis), cached for the per-series
  // matrices built each frame in redrawGraphWebGL.
  private glTransform: Transform = [0, 0, 0, 0];

  private webglRefreshViewParams(): void {
    if (!this.glState) return;
    const { gl } = this.glState;

    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.enable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, this.width, this.height);
    gl.scissor(this.geom.xleft, this.height - this.geom.ybottom, this.geom.width, this.geom.height);
    gl.lineWidth(2);

    this.glTransform = makeTransform(this.geom, this.xaxis, this.yaxis);
  }

  private redrawGraphWebGL(): void {
    if (!this.glState) return;
    const { gl, shaderProgram, xBuffer, yBuffer } = this.glState;

    gl.clear(gl.COLOR_BUFFER_BIT);

    const [sx, sy, dx, dy] = this.glTransform;
    const w = 2.0 / this.width;
    const h = -2.0 / this.height;

    for (const series of this.series) {
      // Fold the per-series vertical transform (y-yoffset)*yscale into the
      // shared y mapping: sy' = sy*yscale, dy' = dy - sy*yoffset*yscale.
      const sys = sy * series.yscale;
      const dys = dy - sy * series.yoffset * series.yscale;

      // Column-major order
      const tmatrix = new Float32Array([
        sx * w, 0, 0, 0,
        0, sys * h, 0, 0,
        dx * w, dys * h, 0, 0,
        -1, 1, -1, 1,
      ]);
      gl.uniformMatrix4fv(shaderProgram.uniform.transform, false, tmatrix);
      gl.uniform4fv(shaderProgram.uniform.color, new Float32Array([
        series.color[0] / 255.0,
        series.color[1] / 255.0,
        series.color[2] / 255.0,
        1,
      ]));

      gl.bindBuffer(gl.ARRAY_BUFFER, xBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, series.xdata as Float32Array, gl.STREAM_DRAW);
      gl.vertexAttribPointer(shaderProgram.attrib.x, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, yBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, series.ydata as Float32Array, gl.STREAM_DRAW);
      gl.vertexAttribPointer(shaderProgram.attrib.y, 1, gl.FLOAT, false, 0, 0);
      // Never request more vertices than the smaller buffer holds, or the whole
      // draw call is rejected (GL_INVALID_OPERATION) and nothing renders.
      gl.drawArrays(gl.LINE_STRIP, 0, Math.min(series.xdata.length, series.ydata.length));
    }
  }
}

// --- Overlays ---

export class Overlay {
  constructor(public lg: GraphCanvas) {
    lg.overlays.push(this);
  }

  resized(): void {}

  remove(): void {
    const i = this.lg.overlays.indexOf(this);
    if (i !== -1) this.lg.overlays.splice(i, 1);
  }
}

export class Dot extends Overlay {
  dot: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  center: number;
  x: number;
  y = 0;
  tx = 0;
  ty = 0;
  private shape = '';

  constructor(
    lg: GraphCanvas,
    public fill: string,
    public radius = 5,
    public xpos: 'r' | 'l' | false = 'r',
  ) {
    super(lg);

    this.dot = document.createElement('canvas');
    this.dot.width = 2 * radius + 4;
    this.dot.height = 2 * radius + 4;
    this.center = radius + 2;

    this.x = PADDING + AXIS_SPACING;

    this.dot.style.position = 'absolute';
    this.dot.style.marginTop = `${-this.center}px`;
    this.dot.style.marginRight = `${-this.center}px`;
    this.dot.style.marginLeft = `${-this.center}px`;

    this.ctx = this.dot.getContext('2d')!;
    lg.div.appendChild(this.dot);

    this.render();
  }

  override remove(): void {
    this.dot.remove();
    super.remove();
  }

  override resized(): void {
    this.position(this.x, this.y);
  }

  position(x: number | null, y: number): void {
    if (x != null) this.x = x;
    this.y = y;

    if (!this.lg.geom) return;

    // Determine visibility
    let visible = !isNaN(y) && y != null;
    if ((!this.xpos && this.x > this.lg.xaxis.visibleMax) || this.x < this.lg.xaxis.visibleMin) {
      visible = false;
    }

    const v = visible ? 'visible' : 'hidden';
    if (this.dot.style.visibility !== v) this.dot.style.visibility = v;

    // Clamp only the drawn position; this.y keeps the data-space coordinate
    // so later repositioning (zoom, resize) doesn't inherit the clamp
    let shape: string;
    let drawY = this.y;
    if (drawY > this.lg.yaxis.visibleMax) {
      drawY = this.lg.yaxis.visibleMax;
      shape = 'up';
    } else if (drawY < this.lg.yaxis.visibleMin) {
      drawY = this.lg.yaxis.visibleMin;
      shape = 'down';
    } else {
      shape = 'circle';
    }

    const [sx, sy, dx, dy] = makeTransform(this.lg.geom, this.lg.xaxis, this.lg.yaxis);
    this.ty = Math.round(dy + drawY * sy);

    if (this.shape !== shape) {
      this.shape = shape;
      this.render();
    }

    this.dot.style.top = `${this.ty}px`;

    if (this.xpos === 'r') {
      this.dot.style.right = `${this.x}px`;
      this.dot.style.left = 'auto';
    } else if (this.xpos === 'l') {
      this.dot.style.left = `${this.x}px`;
      this.dot.style.right = 'auto';
    } else {
      this.tx = Math.round(dx + this.x * sx);
      this.dot.style.left = `${this.tx}px`;
      this.dot.style.right = 'auto';
    }
  }

  private render(): void {
    // Clear canvas by resetting width
    this.dot.width = this.dot.width;
    this.ctx.fillStyle = this.fill;
    this.ctx.strokeStyle = this.fill;
    this.ctx.lineWidth = 2;

    switch (this.shape) {
      case 'circle':
        this.ctx.arc(this.center, this.center, this.radius, 0, Math.PI * 2, true);
        break;
      case 'down':
        this.ctx.moveTo(this.center, this.center + this.radius);
        this.ctx.lineTo(this.center + this.radius * 0.86, this.center - this.radius * 0.5);
        this.ctx.lineTo(this.center - this.radius * 0.86, this.center - this.radius * 0.5);
        this.ctx.lineTo(this.center, this.center + this.radius);
        break;
      case 'up':
        this.ctx.moveTo(this.center, this.center - this.radius);
        this.ctx.lineTo(this.center + this.radius * 0.86, this.center + this.radius * 0.5);
        this.ctx.lineTo(this.center - this.radius * 0.86, this.center + this.radius * 0.5);
        this.ctx.lineTo(this.center, this.center - this.radius);
        break;
    }

    this.ctx.fill();
    this.ctx.stroke();
  }

  isNear(x: number, y: number, r: number): boolean {
    return (Math.pow(x - this.tx, 2) + Math.pow(y - this.ty, 2)) < r * r;
  }
}

export class TriggerOverlay extends Overlay {
  el: HTMLDivElement;
  triangle: HTMLCanvasElement;
  y = 0;

  constructor(lg: GraphCanvas, color?: string, border?: number) {
    super(lg);

    this.el = document.createElement('div');
    this.triangle = document.createElement('canvas');
    this.triangle.width = 10;
    this.triangle.height = 11;

    this.style(color, border);

    this.el.appendChild(this.triangle);
    lg.div.appendChild(this.el);
  }

  style(color = '#ffaa00', border = 1): void {
    const ctx = this.triangle.getContext('2d')!;
    ctx.clearRect(0, 0, this.triangle.width, this.triangle.height);
    ctx.fillStyle = color;
    ctx.moveTo(0, 0);
    ctx.lineTo(10, 5.5);
    ctx.lineTo(0, 11);
    ctx.lineTo(0, 0);
    ctx.fill();

    Object.assign(this.el.style, {
      position: 'absolute',
      left: `${PADDING + AXIS_SPACING}px`,
      right: `${PADDING + AXIS_SPACING}px`,
      borderTop: `${border}px solid ${color}`,
      height: '0',
    });

    Object.assign(this.triangle.style, {
      marginTop: '-6px',
      marginLeft: '-3px',
    });
  }

  showBorder(show: boolean): void {
    this.el.style.borderTopWidth = show ? '1px' : '0';
  }

  override remove(): void {
    this.el.remove();
    super.remove();
  }

  override resized(): void {
    this.position(this.y);
  }

  position(y: number): void {
    this.y = y;
    if (!this.lg.geom) return;

    this.y = Math.max(this.lg.yaxis.visibleMin, Math.min(this.lg.yaxis.visibleMax, this.y));

    const [, sy, , dy] = makeTransform(this.lg.geom, this.lg.xaxis, this.lg.yaxis);
    const ty = Math.round(dy + this.y * sy);
    this.el.style.top = `${ty}px`;
  }
}

// --- Actions ---

export class Action {
  stop = false;

  constructor(
    public lg: GraphCanvas,
    public origPos: [number, number] | null,
    public allTargets: GraphCanvas[] = [lg],
    public doneCallback?: () => void,
  ) {
    for (const tgt of allTargets) {
      tgt.startAction();
    }
    lg.startAction(this);
  }

  redraw(redrawAxes: boolean): void {
    for (const graph of this.allTargets) {
      graph.needsRedraw(redrawAxes);
    }
  }

  cancel(): void {
    this.stop = true;
    this.doneCallback?.();
    this.doneCallback = undefined;
  }

  onDrag(_pos: [number, number], _origPos?: [number, number]): void {}
  onRelease(_pos?: [number, number], _origPos?: [number, number]): void {}
  onAnim(): void {}
}

export class DragScrollAction extends Action {
  private origMin: number;
  private origMax: number;
  private span: number;
  private scale: number;
  private velocity = 0;
  private pressed = true;
  private x: number;
  private lastX: number;
  private t: number;

  constructor(
    lg: GraphCanvas, origPos: [number, number],
    allTargets?: GraphCanvas[], doneCallback?: () => void,
  ) {
    super(lg, origPos, allTargets ?? [lg], doneCallback);
    lg.startDrag(origPos);

    this.origMin = lg.xaxis.visibleMin;
    this.origMax = lg.xaxis.visibleMax;
    this.span = lg.xaxis.span();
    this.scale = makeTransform(lg.geom, lg.xaxis, lg.yaxis)[0];

    this.x = this.lastX = origPos[0];
    this.t = +new Date();
  }

  override onDrag([x]: [number, number]): void {
    this.scrollTo(x);
    this.x = x;
  }

  private scrollTo(x: number): void {
    const scrollby = (x - this.origPos![0]) / this.scale;
    this.lg.xaxis.window(this.origMin - scrollby, this.origMax - scrollby);
    this.redraw(true);
  }

  override onRelease(): void {
    this.pressed = false;
    this.t = +new Date() - 1;
    this.redraw(true);
  }

  override onAnim(): void {
    if (this.stop) return;

    const t = +new Date();
    const dt = Math.min(t - this.t, 100);
    this.t = t;

    if (dt === 0) return;

    const minOvershoot = Math.max(this.lg.xaxis.min - this.lg.xaxis.visibleMin, 0);
    const maxOvershoot = Math.max(this.lg.xaxis.visibleMax - this.lg.xaxis.max, 0);

    if (this.pressed) {
      const dx = this.x - this.lastX;
      this.lastX = this.x;
      this.velocity = dx / dt;
      const overshoot = Math.max(minOvershoot, maxOvershoot);
      if (overshoot > 0) {
        this.velocity *= (1 - overshoot * this.scale) / 200;
      }
    } else {
      if (minOvershoot * this.scale > 1) {
        if (this.velocity <= 0) {
          this.velocity = -1 * minOvershoot * this.scale / 100;
        } else {
          this.velocity -= 0.1 * dt;
        }
      } else if (maxOvershoot * this.scale > 1) {
        if (this.velocity >= 0) {
          this.velocity = 1 * maxOvershoot * this.scale / 100;
        } else {
          this.velocity += 0.1 * dt;
        }
      } else {
        const vstep = (this.velocity > 0 ? 1 : -1) * 0.05;
        this.velocity -= vstep;

        if (Math.abs(this.velocity) < Math.abs(vstep) * 10) {
          if (minOvershoot) {
            this.lg.xaxis.window(this.lg.xaxis.min, this.lg.xaxis.min + this.span);
            this.redraw(true);
          } else if (maxOvershoot) {
            this.lg.xaxis.window(this.lg.xaxis.max - this.span, this.lg.xaxis.max);
            this.redraw(true);
          }
          this.cancel();
          return;
        }
      }

      this.x = this.x + this.velocity * dt;
      this.scrollTo(this.x);
    }
  }

  override cancel(): void {
    this.lg.xaxis.window(this.lg.xaxis.visibleMin, this.lg.xaxis.visibleMax, true);
    super.cancel();
  }
}

export interface AnimateXOptions {
  time: number;
}

export class AnimateXAction extends Action {
  protected endMin: number;
  protected endMax: number;
  private origMin: number;
  private origMax: number;
  private time: number;
  private startT: number;

  constructor(
    opts: AnimateXOptions, lg: GraphCanvas,
    endMin: number, endMax: number,
    allTargets?: GraphCanvas[], doneCallback?: () => void,
  ) {
    super(lg, null, allTargets ?? [lg], doneCallback);

    this.time = opts.time;
    this.origMin = lg.xaxis.visibleMin;
    this.origMax = lg.xaxis.visibleMax;
    this.endMin = endMin;
    this.endMax = endMax;

    const endSpan = endMax - endMin;
    const tooMax = this.endMax > lg.xaxis.max;
    const tooMin = this.endMin < lg.xaxis.min;

    if (tooMin && tooMax) {
      this.endMax = lg.xaxis.max;
      this.endMin = lg.xaxis.min;
    } else if (tooMax) {
      this.endMax = lg.xaxis.max;
      this.endMin = this.endMax - endSpan;
    } else if (tooMin) {
      this.endMin = lg.xaxis.min;
      this.endMax = this.endMin + endSpan;
    }

    this.startT = +new Date();
    this.redraw(true);
  }

  override onAnim(): void {
    if (this.stop) return;

    const t = +new Date() - this.startT;
    const ps = t / this.time;
    const pe = 1 - ps;

    if (ps > 1) {
      this.cancel();
    } else {
      this.lg.xaxis.window(
        this.origMin * pe + this.endMin * ps,
        this.origMax * pe + this.endMax * ps,
        false,
        [this.endMin, this.endMax],
      );
      this.redraw(true);
    }
  }

  override cancel(): void {
    this.lg.xaxis.window(this.endMin, this.endMax, true);
    this.redraw(true);
    super.cancel();
  }
}

export interface ZoomXOptions extends AnimateXOptions {
  zoomFactor: number;
}

export class ZoomXAction extends AnimateXAction {
  constructor(
    opts: ZoomXOptions, lg: GraphCanvas, origPos: [number, number],
    allTargets?: GraphCanvas[], doneCallback?: () => void,
  ) {
    const startSpan = lg.xaxis.span();
    const endSpan = startSpan * opts.zoomFactor;
    const center = invTransform(
      origPos[0], origPos[1],
      makeTransform(lg.geom, lg.xaxis, lg.yaxis),
    )[0];

    super(opts, lg, center - endSpan / 2, center + endSpan / 2, allTargets, doneCallback);
  }
}
