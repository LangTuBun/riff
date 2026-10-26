const LOSSLESS_FORMATS = ['flac', 'wav', 'alac', 'ape', 'wv', 'aiff', 'aif'];

const NOISE_IN_BRACKETS = /\s*[([][^)\]]*\b(feat\.?|ft\.?|featuring|official|audio|video|lyrics?|visuali[sz]er|hd|hq|4k|mv|m\/v)\b[^)\]]*[)\]]/gi;

function primaryArtist(artist) {
  let a = String(artist || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/\s+(feat\.?|ft\.?|featuring|with)\s+.*$/i, '')
    .trim();
  if (a.includes(',')) a = a.split(',')[0].trim();
  if (a.includes(';')) a = a.split(';')[0].trim();
  a = a.replace(/\s+x\s+.*$/i, '').trim();
  return a;
}

function cleanTitle(title) {
  return String(title || '')
    .replace(NOISE_IN_BRACKETS, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanSoulseekQuery(track) {
  const t = track || {};
  let artist = primaryArtist(t.artist);
  let title = cleanTitle(t.title);
  if (!artist && title.includes(' - ')) {
    const i = title.indexOf(' - ');
    artist = title.slice(0, i).trim();
    title = title.slice(i + 3).trim();
  }
  const seconds = Math.round(Number(t.duration) || 0);
  return {
    artist: artist || null,
    title: title || null,
    album: t.album ? String(t.album).trim() || null : null,
    uri: null,
    length: seconds > 0 && !t.lengthUnreliable ? seconds : null,
    artistMaybeWrong: !!t.artistMaybeWrong
  };
}

function buildSongJobRequest(query) {
  return {
    songQuery: query,
    options: {
      outputParentDir: null,
      downloadSettings: {
        search: {
          necessaryCond: { formats: { replace: LOSSLESS_FORMATS.slice() }, lengthTolerance: 15 },
          preferredCond: { lengthTolerance: 3 }
        },
        ytDlp: { useYtdlp: false },
        skip: { skipExisting: false }
      }
    },
    downloadBehavior: { default: 'Automatic' }
  };
}

function confValue(v) {
  const s = String(v == null ? '' : v);
  if (/[\r\n]/.test(s)) throw new Error('value must be a single line');
  return `"${s}"`;
}

function buildSockseekConf({ username, password }) {
  if (!username || !password) throw new Error('username and password are required');
  return [
    '# written by Riff, do not edit',
    `username = ${confValue(username)}`,
    `password = ${confValue(password)}`,
    ''
  ].join('\n');
}

function isLosslessExtension(ext) {
  return LOSSLESS_FORMATS.includes(String(ext || '').replace(/^\./, '').toLowerCase());
}

if (typeof module !== 'undefined') {
  module.exports = { LOSSLESS_FORMATS, primaryArtist, cleanTitle, cleanSoulseekQuery, buildSongJobRequest, buildSockseekConf, isLosslessExtension };
}
