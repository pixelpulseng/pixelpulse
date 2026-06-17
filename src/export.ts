export interface CsvColumn {
  name: string;
  units: string;
  precision: number;
  data: number[];
}

export function downloadCSV(columns: CsvColumn[]): void {
  const header = columns.map(c => `"${c.name} (${c.units})"`).join(',') + '\n';
  const rows: string[] = [header];

  for (let i = 0; i < columns[0].data.length; i++) {
    rows.push(
      columns.map(c => c.data[i].toFixed(c.precision)).join(',') + '\n',
    );
  }

  downloadFile(rows, 'text/csv', `export${+new Date()}.csv`);
}

export interface SnapshotMeta {
  // Heading line (e.g. channel name + units); shown bold in the title bar.
  title: string;
  // Optional free-text chart label entered by the user.
  label?: string;
}

// Composite a stack of aligned, equal-size canvases (back-to-front) into one
// PNG with a title bar (heading, optional label, timestamp) and download it.
// `background` paints behind the plot so the PNG isn't transparent.
export function snapshotPNG(
  layers: HTMLCanvasElement[],
  meta: SnapshotMeta,
  background = '#ffffff',
): void {
  const plot = layers.find(c => c.width > 0 && c.height > 0);
  if (!plot) return;
  const w = plot.width;
  const h = plot.height;

  const barH = meta.label ? 56 : 36;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h + barH;
  const ctx = out.getContext('2d')!;

  // Title bar
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, w, barH);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 14px "Droid Sans", sans-serif';
  ctx.fillText(meta.title, 10, meta.label ? 16 : barH / 2);

  const stamp = new Date().toLocaleString();
  ctx.font = '12px "Droid Sans", sans-serif';
  ctx.fillStyle = '#bbb';
  ctx.textAlign = 'right';
  ctx.fillText(stamp, w - 10, meta.label ? 16 : barH / 2);
  ctx.textAlign = 'left';

  if (meta.label) {
    ctx.font = '13px "Droid Sans", sans-serif';
    ctx.fillStyle = '#eee';
    ctx.fillText(meta.label, 10, 40);
  }

  // Plot area: background then each layer back-to-front
  ctx.fillStyle = background;
  ctx.fillRect(0, barH, w, h);
  for (const layer of layers) {
    if (layer.width > 0 && layer.height > 0) ctx.drawImage(layer, 0, barH);
  }

  out.toBlob((blob) => {
    if (blob) downloadFile([blob], 'image/png', `snapshot${+new Date()}.png`);
  }, 'image/png');
}

export function downloadFile(data: BlobPart[], type: string, filename: string): void {
  const url = URL.createObjectURL(new Blob(data, { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10);
}
