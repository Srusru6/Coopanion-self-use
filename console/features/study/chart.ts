/**
 * The focus statistics chart: one stacked bar per bucket (an hour, a day, a month or a year),
 * automatic focus at the bottom and manual on top, with the axis labels the Core computed.
 * Plain DOM and SVG, so the settings page and its World panel draw the same chart.
 */

export interface ChartBucket {
  label: string;
  seconds: number;
  auto: number;
  manual: number;
}

export interface ChartTexts {
  /** Shown instead of the chart when every bucket is empty. */
  empty: string;
  auto: string;
  manual: string;
}

const W = 640;
const H = 200;
const LEFT = 46;
const RIGHT = 10;
const TOP = 12;
const BOTTOM = 28;

/** A total in seconds, `1h 03m` past the hour and `3m 04s` under it. */
function span(total: number): string {
  const n = Math.max(0, Math.round(total));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(n % 60).padStart(2, '0')}s`;
}

/** The axis top, rounded up to a length that reads as a round number of minutes or hours. */
function niceMax(seconds: number): number {
  if (seconds <= 60) return 60;
  const minutes = seconds / 60;
  const step = [1, 2, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720].find((n) => n >= minutes);
  return (step ?? Math.ceil(minutes / 60) * 60) * 60;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = doc.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/** How many bars to skip between two printed labels, so the axis stays legible. */
function labelStep(count: number): number {
  if (count <= 12) return 1;
  if (count <= 24) return 3;
  return Math.ceil(count / 6);
}

export function focusChart(doc: Document, buckets: readonly ChartBucket[], t: ChartTexts): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'study-chart';

  const total = buckets.reduce((sum, b) => sum + b.seconds, 0);
  if (total <= 0) {
    wrap.classList.add('empty');
    const note = doc.createElement('div');
    note.className = 'placeholder';
    note.textContent = t.empty;
    wrap.append(note);
    return wrap;
  }

  const plotW = W - LEFT - RIGHT;
  const plotH = H - TOP - BOTTOM;
  const base = TOP + plotH;
  const max = niceMax(Math.max(...buckets.map((b) => b.seconds)));
  const svg = svgEl(doc, 'svg', {
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': t.auto + ' / ' + t.manual,
  });

  // horizontal guides at zero, half and full scale
  for (const frac of [0, 0.5, 1]) {
    const y = base - plotH * frac;
    svg.append(svgEl(doc, 'line', { x1: LEFT, y1: y, x2: W - RIGHT, y2: y, class: frac === 0 ? 'axis' : 'grid' }));
    const label = svgEl(doc, 'text', { x: LEFT - 8, y: y + 4, class: 'tick', 'text-anchor': 'end' });
    label.textContent = span(max * frac);
    svg.append(label);
  }

  const slot = plotW / buckets.length;
  const barW = Math.min(30, slot * 0.58);
  const step = labelStep(buckets.length);

  buckets.forEach((bucket, i) => {
    const x = LEFT + slot * i + (slot - barW) / 2;
    if (bucket.seconds > 0) {
      const hAuto = (bucket.auto / max) * plotH;
      const hManual = (bucket.manual / max) * plotH;
      const group = svgEl(doc, 'g', {});
      const title = svgEl(doc, 'title', {});
      title.textContent = `${bucket.label} · ${span(bucket.seconds)}`;
      group.append(title);
      if (hAuto > 0) {
        group.append(svgEl(doc, 'rect', {
          x, y: base - hAuto, width: barW, height: hAuto, rx: 2, class: 'bar-auto',
        }));
      }
      if (hManual > 0) {
        // a 0.5px gap keeps the two tones apart where the parts are thin
        group.append(svgEl(doc, 'rect', {
          x, y: base - hAuto - hManual + (hAuto > 0 ? 0.5 : 0), width: barW,
          height: Math.max(1, hManual - (hAuto > 0 ? 0.5 : 0)), rx: 2, class: 'bar-manual',
        }));
      }
      svg.append(group);
    }
    if (i % step === 0) {
      const tick = svgEl(doc, 'text', { x: LEFT + slot * i + slot / 2, y: H - 8, class: 'tick x', 'text-anchor': 'middle' });
      tick.textContent = bucket.label;
      svg.append(tick);
    }
  });

  const legend = doc.createElement('div');
  legend.className = 'study-legend';
  for (const [cls, label] of [['bar-auto', t.auto], ['bar-manual', t.manual]] as const) {
    const item = doc.createElement('span');
    const swatch = doc.createElement('i');
    swatch.className = cls;
    item.append(swatch, doc.createTextNode(label));
    legend.append(item);
  }

  wrap.append(svg, legend);
  return wrap;
}
