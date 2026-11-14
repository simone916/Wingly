// Filename → media identity. Pure functions, no I/O (unit-tested in test/parse.test.js).
import path from 'node:path';

export const VIDEO_EXT = new Set([
  '.mp4', '.m4v', '.mkv', '.webm', '.avi', '.mov', '.wmv', '.flv', '.ts', '.m2ts', '.mpg', '.mpeg', '.ogv',
]);

// Release-name noise that marks the end of the real title.
const JUNK = new RegExp(
  '\\b(' +
    [
      '2160p', '1080p', '1080i', '720p', '576p', '480p', '4k', 'uhd', 'hdr', 'hdr10', 'dv', 'sdr',
      'bluray', 'blu-ray', 'bdrip', 'brrip', 'bdremux', 'remux', 'web-dl', 'webdl', 'webrip', 'web',
      'hdtv', 'pdtv', 'dvdrip', 'dvd', 'hdrip', 'cam', 'telesync',
      'x264', 'x265', 'h264', 'h265', 'h\\.264', 'h\\.265', 'hevc', 'avc', 'av1', 'xvid', 'divx', '10bit',
      'aac', 'ac3', 'eac3', 'dts', 'dts-hd', 'truehd', 'atmos', 'flac', 'mp3', 'ddp?5\\.1', 'dd5\\.1',
      'proper', 'repack', 'extended', 'unrated', 'remastered', 'limited', 'internal',
      "director'?s\\.?cut", 'multi', 'dubbed', 'subbed',
    ].join('|') +
    ')\\b',
  'i',
);

function clean(s) {
  return s
    .replace(/\[[^\]]*\]/g, ' ') // [group] tags
    .replace(/[._]+/g, ' ')
    .replace(/\s+-\s*$/, '')
    .replace(/[\s\-–(\[]+$/, '')
    .replace(/^[\s\-–)]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cutAtJunk(s) {
  const m = JUNK.exec(s);
  return m ? s.slice(0, m.index) : s;
}

function splitYear(s) {
  // Last plausible year wins: "2001 A Space Odyssey 1968" → 1968.
  const years = [...s.matchAll(/(?:^|[\s.(\[_-])((?:19|20)\d{2})(?=$|[\s.)\]_-])/g)];
  if (!years.length) return { title: s, year: null };
  const m = years[years.length - 1];
  const before = s.slice(0, m.index);
  if (!clean(before)) return { title: s, year: null }; // the year *is* the title ("1917")
  return { title: before, year: Number(m[1]) };
}

const EPISODE_PATTERNS = [
  /\bS(\d{1,2})[\s._-]*E(\d{1,3})(?:[\s._-]*E?\d{1,3})*/i, // S01E02, S01.E02, S01E02E03
  /\b(\d{1,2})x(\d{1,3})\b/i, // 1x02
  /\bSeason[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})/i,
];

/**
 * @param {string} filePath absolute or relative path of a video file
 * @param {'movie'|'show'} libraryType
 */
export function parseMedia(filePath, libraryType = 'movie') {
  const base = path.basename(filePath, path.extname(filePath));
  const dirs = path.dirname(filePath).split(path.sep).filter(Boolean);
  const parent = dirs[dirs.length - 1] || '';
  const grand = dirs[dirs.length - 2] || '';

  for (const re of EPISODE_PATTERNS) {
    const m = re.exec(base);
    if (!m) continue;
    let showRaw = base.slice(0, m.index);
    if (!clean(showRaw)) {
      // "S01E02.mkv" inside "Show Name/Season 1/"
      showRaw = /^(season|series|s)\s*\d+$/i.test(clean(parent)) || /^specials$/i.test(parent) ? grand : parent;
    }
    const { title: showTitle, year } = splitYear(cutAtJunk(showRaw));
    const epTitle = clean(cutAtJunk(base.slice(m.index + m[0].length)));
    return {
      kind: 'episode',
      showTitle: clean(showTitle) || clean(showRaw) || 'Unknown Show',
      season: Number(m[1]),
      episode: Number(m[2]),
      title: epTitle || `Episode ${Number(m[2])}`,
      year,
    };
  }

  if (libraryType === 'show') {
    // No SxxEyy marker: treat "Show/Season 2/07 - Title.mkv" style.
    const sm = /^(?:season|series|s)\s*(\d+)$/i.exec(clean(parent));
    const em = /^(\d{1,3})(?:\s*[-.]\s*|\s+)(.*)$/.exec(clean(base));
    if (sm && em) {
      const { title: showTitle, year } = splitYear(grand);
      return {
        kind: 'episode',
        showTitle: clean(showTitle) || 'Unknown Show',
        season: Number(sm[1]),
        episode: Number(em[1]),
        title: clean(cutAtJunk(em[2])) || `Episode ${Number(em[1])}`,
        year,
      };
    }
  }

  let { title, year } = splitYear(cutAtJunk(base));
  title = clean(title);
  if (!title || (year === null && /^(movie|video|feature|main)$/i.test(title))) {
    // Generic filename — the folder usually carries the real name.
    const p = splitYear(cutAtJunk(parent));
    if (clean(p.title)) ({ title, year } = { title: clean(p.title), year: p.year ?? year });
  }
  return { kind: 'movie', title: title || base, year };
}
