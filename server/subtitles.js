// SRT → WebVTT conversion and cue shifting (needed when a transcode starts mid-file).

export function srtToVtt(srt) {
  const body = srt
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .split(/\n{2,}/)
    .map((block) => block.replace(/^\d+\n(?=\d{2}:\d{2})/, '').trim()) // drop numeric cue ids
    .filter((block) => block.includes('-->'))
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

const TS = /(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/;
const toSec = (m) => Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
function fmt(sec) {
  const ms = Math.round(sec * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
}

/** Move every cue `offset` seconds earlier, dropping cues that end before 0. */
export function shiftVtt(vtt, offset) {
  if (!offset) return vtt;
  const blocks = vtt.replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const out = ['WEBVTT'];
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const ma = TS.exec(a);
    const mb = TS.exec(b);
    if (!ma || !mb) continue;
    const end = toSec(mb) - offset;
    if (end <= 0) continue;
    const start = Math.max(0, toSec(ma) - offset);
    out.push([`${fmt(start)} --> ${fmt(end)}`, ...lines.slice(i + 1)].join('\n'));
  }
  return out.join('\n\n') + '\n';
}
