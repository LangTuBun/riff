(function (global) {
  'use strict';

  const LOSSLESS_CODECS = new Set(['flac', 'alac', 'wavpack', 'ape', 'tta', 'truehd', 'mlp', 'dsd_lsbf', 'dsd_msbf']);

  const YT_ITAGS = {
    139: { codec: 'aac', profile: 'HE-AAC', container: 'm4a', sampleRate: 22050, nominalKbps: 48 },
    140: { codec: 'aac', profile: 'AAC-LC', container: 'm4a', sampleRate: 44100, nominalKbps: 128 },
    141: { codec: 'aac', profile: 'AAC-LC', container: 'm4a', sampleRate: 44100, nominalKbps: 256 },
    249: { codec: 'opus', profile: '', container: 'webm', sampleRate: 48000, nominalKbps: 50 },
    250: { codec: 'opus', profile: '', container: 'webm', sampleRate: 48000, nominalKbps: 70 },
    251: { codec: 'opus', profile: '', container: 'webm', sampleRate: 48000, nominalKbps: 160 },
    774: { codec: 'opus', profile: '', container: 'webm', sampleRate: 48000, nominalKbps: 256 },
    18: { codec: 'aac', profile: 'AAC-LC', container: 'mp4', sampleRate: 44100, nominalKbps: null, muxed: true }
  };

  function isLosslessCodec(codec) {
    const c = String(codec || '').toLowerCase();
    return LOSSLESS_CODECS.has(c) || c.startsWith('pcm_');
  }

  function toNum(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function pcmBits(codec) {
    const m = String(codec || '').match(/^pcm_[suf](\d+)/);
    return m ? Number(m[1]) : null;
  }

  function summarizeProbe(json) {
    if (!json || !Array.isArray(json.streams)) return null;
    const s = json.streams.find(x => x && x.codec_type === 'audio') || json.streams[0];
    if (!s) return null;
    const f = json.format || {};
    const codec = String(s.codec_name || '').toLowerCase();
    const lossless = isLosslessCodec(codec);
    let bitDepth = null;
    if (lossless) {
      bitDepth = toNum(s.bits_per_raw_sample) || pcmBits(codec) || toNum(s.bits_per_sample);
    }
    const duration = toNum(s.duration) || toNum(f.duration);
    const size = toNum(f.size);
    let bitrate = toNum(s.bit_rate) || toNum(f.bit_rate);
    if (!bitrate && size && duration) bitrate = Math.round(size * 8 / duration);
    return {
      codec,
      codecLong: s.codec_long_name || '',
      profile: s.profile && s.profile !== 'unknown' ? s.profile : '',
      container: String(f.format_name || '').split(',')[0],
      sampleRate: toNum(s.sample_rate),
      channels: toNum(s.channels),
      channelLayout: s.channel_layout || '',
      sampleFormat: s.sample_fmt || '',
      bitDepth,
      bitrate,
      duration,
      lossless
    };
  }

  function parseFfmpegBanner(stderr) {
    const text = String(stderr || '');
    const m = text.match(/Stream #\d+:\d+[^:]*: Audio: ([^\r\n]+)/);
    if (!m) return null;
    const parts = m[1].split(/,\s*/);
    const codecPart = parts[0] || '';
    const codec = codecPart.split(/\s+/)[0].toLowerCase();
    const profileMatch = codecPart.match(/\(([^)]+)\)/);
    let sampleRate = null;
    let channelLayout = '';
    let sampleFormat = '';
    let bitDepth = null;
    let bitrate = null;
    for (const p of parts.slice(1)) {
      const hz = p.match(/^(\d+) Hz$/);
      if (hz) { sampleRate = Number(hz[1]); continue; }
      const kb = p.match(/^(\d+) kb\/s/);
      if (kb) { bitrate = Number(kb[1]) * 1000; continue; }
      const fmt = p.match(/^((?:s|u|flt|dbl)\d*p?)(?: \((\d+) bit\))?$/);
      if (fmt) {
        sampleFormat = fmt[1];
        if (fmt[2]) bitDepth = Number(fmt[2]);
        continue;
      }
      if (!channelLayout && sampleRate) channelLayout = p.trim();
    }
    if (!bitrate) {
      const fb = text.match(/bitrate: (\d+) kb\/s/);
      if (fb) bitrate = Number(fb[1]) * 1000;
    }
    const lossless = isLosslessCodec(codec);
    if (lossless && !bitDepth) {
      bitDepth = pcmBits(codec) || ({ s16: 16, s16p: 16, s32: 32, s32p: 32 })[sampleFormat] || null;
    }
    const containerMatch = text.match(/Input #\d+, ([^,\s]+)/);
    const channels = channelLayout === 'mono' ? 1 : channelLayout === 'stereo' ? 2 : null;
    return {
      codec,
      codecLong: '',
      profile: profileMatch ? profileMatch[1] : '',
      container: containerMatch ? containerMatch[1] : '',
      sampleRate,
      channels,
      channelLayout,
      sampleFormat,
      bitDepth: lossless ? bitDepth : null,
      bitrate,
      duration: null,
      lossless
    };
  }

  function describeStreamSrc(src) {
    let u;
    try { u = new URL(src); } catch (e) { return { kind: 'unknown' }; }
    if (u.protocol === 'blob:') return { kind: 'hls' };
    const q = u.searchParams;
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
      if (u.pathname === '/api/local-track') return { kind: 'cache', id: q.get('id') || '' };
      if (u.pathname === '/api/library-file') return { kind: 'library', id: q.get('id') || '' };
      if (u.pathname === '/api/downloaded-track') return { kind: 'download', name: q.get('name') || '' };
      if (u.pathname === '/api/audio-proxy') return describeStreamSrc(q.get('url') || '');
      return { kind: 'unknown' };
    }
    if (/googlevideo\.com$/i.test(u.hostname)) {
      const itag = Number(q.get('itag')) || null;
      const known = itag ? YT_ITAGS[itag] : null;
      const clen = toNum(q.get('clen'));
      const dur = toNum(q.get('dur'));
      return {
        kind: 'youtube',
        itag,
        mime: q.get('mime') || '',
        codec: known ? known.codec : '',
        profile: known ? known.profile : '',
        container: known ? known.container : '',
        sampleRate: known ? known.sampleRate : null,
        muxed: !!(known && known.muxed),
        bitrate: known && known.muxed ? null : clen && dur ? Math.round(clen * 8 / dur) : (known ? known.nominalKbps * 1000 : null)
      };
    }
    if (/sndcdn\.com$/i.test(u.hostname)) {
      return { kind: 'soundcloud', hls: /\.m3u8/i.test(u.pathname) };
    }
    return { kind: 'remote' };
  }

  function estimateBandwidth(dbBins, sampleRate) {
    if (!dbBins || !dbBins.length || !sampleRate) return null;
    const n = dbBins.length;
    const hzPerBin = sampleRate / 2 / n;
    const lo = Math.max(1, Math.floor(1000 / hzPerBin));
    const hi = Math.min(n - 1, Math.floor(6000 / hzPerBin));
    let ref = 0;
    let count = 0;
    for (let i = lo; i <= hi; i++) {
      if (Number.isFinite(dbBins[i])) { ref += dbBins[i]; count++; }
    }
    if (!count) return null;
    ref /= count;
    if (ref < -110) return null;
    const floor = Math.max(ref - 55, -125);
    for (let i = n - 1; i > hi; i--) {
      let run = 0;
      for (let j = i; j > i - 4 && j > hi; j--) {
        if (dbBins[j] > floor) run++;
      }
      if (run >= 3) return Math.round((i + 0.5) * hzPerBin);
    }
    return Math.round(hi * hzPerBin);
  }

  function describeBandwidth(cutoffHz, sampleRate) {
    if (!cutoffHz) return '';
    const nyquist = sampleRate / 2;
    if (cutoffHz >= nyquist * 0.97) return 'full band';
    if (cutoffHz < 15500) return 'low-pass, low bitrate lossy';
    if (cutoffHz < 19000) return 'low-pass, typical of lossy encoding';
    if (cutoffHz < 21000) return 'band-limited near 20 kHz, typical of high-bitrate lossy';
    return 'wide band';
  }

  function decodeWaveFormat(hex) {
    const clean = String(hex || '').replace(/[^0-9a-f]/gi, '');
    if (clean.length < 36) return null;
    const bytes = [];
    for (let i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));
    const off = bytes[0] === 0x41 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0 ? 8 : 0;
    const u16 = i => bytes[off + i] | (bytes[off + i + 1] << 8);
    const u32 = i => (bytes[off + i] | (bytes[off + i + 1] << 8) | (bytes[off + i + 2] << 16) | (bytes[off + i + 3] << 24)) >>> 0;
    if (bytes.length < off + 16) return null;
    const tag = u16(0);
    const channels = u16(2);
    const sampleRate = u32(4);
    const containerBits = u16(14);
    let validBits = containerBits;
    let float = tag === 3;
    if (tag === 0xfffe && bytes.length >= off + 28) {
      validBits = u16(18) || containerBits;
      float = u32(24) === 3;
    }
    if (!channels || !sampleRate) return null;
    return { channels, sampleRate, containerBits, validBits, float };
  }

  function parseRegQuery(stdout) {
    const out = {};
    let key = null;
    for (const line of String(stdout || '').split(/\r?\n/)) {
      if (/^HKEY_/i.test(line)) { key = line.trim(); continue; }
      const m = line.match(/^\s+(.+?)\s{4}(REG_\w+)\s{4}(.*)$/) || line.match(/^\s+(.+?)\s{4}(REG_\w+)$/);
      if (key && m) {
        if (!out[key]) out[key] = {};
        out[key][m[1]] = m[3] === undefined ? '' : m[3].trim();
      }
    }
    return out;
  }

  const PKEY_NAME = '{a45c254e-df1c-4efd-8020-67d146a850e0},2';
  const PKEY_IFACE = '{b3f8fa53-0004-438e-9003-51a46e139bfc},6';
  const PKEY_FORMAT = '{f19f064d-082c-4e27-bc73-6882a1bb8e4c},0';

  function buildEndpointList(stateOut, propsOut) {
    const states = parseRegQuery(stateOut);
    const props = parseRegQuery(propsOut);
    const list = [];
    for (const key of Object.keys(states)) {
      const st = parseInt(states[key].DeviceState, 16);
      if ((st & 0xf) !== 1) continue;
      const p = props[`${key}\\Properties`] || {};
      const name = p[PKEY_NAME] || '';
      const iface = p[PKEY_IFACE] || '';
      list.push({
        id: key.split('\\').pop(),
        name,
        iface,
        label: iface ? `${name} (${iface})` : name,
        format: decodeWaveFormat(p[PKEY_FORMAT])
      });
    }
    return list;
  }

  function matchEndpoint(label, endpoints) {
    if (!Array.isArray(endpoints) || !endpoints.length) return null;
    const clean = String(label || '').replace(/^(Default|Communications)\s*[-–—:]\s*/i, '').trim().toLowerCase();
    if (!clean) return null;
    return endpoints.find(e => e.label.toLowerCase() === clean) ||
      endpoints.find(e => clean.startsWith(e.label.toLowerCase())) ||
      endpoints.find(e => e.name && clean.includes(e.name.toLowerCase()) && e.iface && clean.includes(e.iface.toLowerCase())) ||
      null;
  }

  function formatRate(hz) {
    if (!hz) return '—';
    const k = hz / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)} kHz`;
  }

  function formatKbps(bps) {
    return bps ? `${Math.round(bps / 1000)} kbps` : '—';
  }

  const api = {
    YT_ITAGS,
    isLosslessCodec,
    summarizeProbe,
    parseFfmpegBanner,
    describeStreamSrc,
    estimateBandwidth,
    describeBandwidth,
    decodeWaveFormat,
    parseRegQuery,
    buildEndpointList,
    matchEndpoint,
    formatRate,
    formatKbps
  };

  global.RiffAudioQuality = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
