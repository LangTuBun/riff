'use strict';

const test = require('node:test');
const assert = require('node:assert');

const aq = require('../src/shared/audio-quality');

test('ffprobe opus stream is lossy with no bit depth', () => {
  const info = aq.summarizeProbe({
    streams: [{ codec_type: 'audio', codec_name: 'opus', sample_fmt: 'fltp', sample_rate: '48000', channels: 2, channel_layout: 'stereo', bits_per_sample: 0 }],
    format: { format_name: 'matroska,webm', duration: '213.061000', size: '3433755', bit_rate: '128930' }
  });
  assert.strictEqual(info.codec, 'opus');
  assert.strictEqual(info.container, 'matroska');
  assert.strictEqual(info.sampleRate, 48000);
  assert.strictEqual(info.bitDepth, null);
  assert.strictEqual(info.bitrate, 128930);
  assert.strictEqual(info.lossless, false);
});

test('ffprobe 24-bit flac reports raw sample bits', () => {
  const info = aq.summarizeProbe({
    streams: [{ codec_type: 'audio', codec_name: 'flac', sample_fmt: 's32', sample_rate: '96000', channels: 2, bits_per_raw_sample: '24' }],
    format: { format_name: 'flac', duration: '10', size: '4000000' }
  });
  assert.strictEqual(info.bitDepth, 24);
  assert.strictEqual(info.lossless, true);
  assert.strictEqual(info.bitrate, 3200000);
});

test('pcm wav bit depth comes from the codec name', () => {
  const info = aq.summarizeProbe({ streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '44100', channels: 2 }], format: {} });
  assert.strictEqual(info.bitDepth, 16);
});

test('ffmpeg banner fallback parses flac stream line', () => {
  const stderr = "Input #0, flac, from 'x.flac':\n  Duration: 00:03:00.00, start: 0.000000, bitrate: 2400 kb/s\n  Stream #0:0: Audio: flac, 96000 Hz, stereo, s32 (24 bit)\n";
  const info = aq.parseFfmpegBanner(stderr);
  assert.strictEqual(info.codec, 'flac');
  assert.strictEqual(info.container, 'flac');
  assert.strictEqual(info.sampleRate, 96000);
  assert.strictEqual(info.channelLayout, 'stereo');
  assert.strictEqual(info.bitDepth, 24);
  assert.strictEqual(info.bitrate, 2400000);
});

test('ffmpeg banner fallback keeps lossy bit depth empty', () => {
  const info = aq.parseFfmpegBanner('Input #0, mp3, from \'a.mp3\':\n  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 320 kb/s\n');
  assert.strictEqual(info.profile, 'mp3float');
  assert.strictEqual(info.bitDepth, null);
  assert.strictEqual(info.bitrate, 320000);
});

test('googlevideo url gives itag details and real bitrate', () => {
  const d = aq.describeStreamSrc('https://rr1---sn-x.googlevideo.com/videoplayback?itag=251&mime=audio%2Fwebm&clen=3433755&dur=213.061');
  assert.strictEqual(d.kind, 'youtube');
  assert.strictEqual(d.codec, 'opus');
  assert.strictEqual(d.sampleRate, 48000);
  assert.strictEqual(d.bitrate, Math.round(3433755 * 8 / 213.061));
});

test('muxed video itag does not report the video bitrate as audio', () => {
  const d = aq.describeStreamSrc('https://rr1---sn-x.googlevideo.com/videoplayback?itag=18&mime=video%2Fmp4&clen=9000000&dur=200');
  assert.strictEqual(d.muxed, true);
  assert.strictEqual(d.bitrate, null);
});

test('local server urls map to probe kinds', () => {
  assert.deepStrictEqual(aq.describeStreamSrc('http://127.0.0.1:38472/api/local-track?id=abc'), { kind: 'cache', id: 'abc' });
  assert.deepStrictEqual(aq.describeStreamSrc('http://127.0.0.1:38472/api/library-file?id=local_1'), { kind: 'library', id: 'local_1' });
  assert.deepStrictEqual(aq.describeStreamSrc('http://127.0.0.1:38472/api/downloaded-track?name=a%20b.flac'), { kind: 'download', name: 'a b.flac' });
  assert.strictEqual(aq.describeStreamSrc('blob:file:///123').kind, 'hls');
});

test('registry wave format blob decodes extensible pcm', () => {
  const f = aq.decodeWaveFormat('4100000001000000FEFF020080BB000000DC05000800200016001800030000000100000000001000800000AA00389B71');
  assert.deepStrictEqual(f, { channels: 2, sampleRate: 48000, containerBits: 32, validBits: 24, float: false });
});

test('registry wave format blob decodes float subformat', () => {
  const f = aq.decodeWaveFormat('4100000001000000FEFF020080BB000000DC05000800200016002000030000000300000000001000800000AA00389B71');
  assert.strictEqual(f.float, true);
  assert.strictEqual(f.validBits, 32);
});

test('endpoint list keeps active devices and matches chromium labels', () => {
  const base = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render';
  const states = `${base}\\{a}\r\n    DeviceState    REG_DWORD    0x1\r\n\r\n${base}\\{b}\r\n    DeviceState    REG_DWORD    0x4\r\n`;
  const props = [
    `${base}\\{a}\\Properties\r\n    {a45c254e-df1c-4efd-8020-67d146a850e0},2    REG_SZ    Speakers\r\n`,
    `${base}\\{a}\\Properties\r\n    {b3f8fa53-0004-438e-9003-51a46e139bfc},6    REG_SZ    Realtek(R) Audio\r\n`,
    `${base}\\{a}\\Properties\r\n    {f19f064d-082c-4e27-bc73-6882a1bb8e4c},0    REG_BINARY    4100000001000000FEFF0200803E0000007D00000400100016001000030000000100000000001000800000AA00389B71\r\n`
  ].join('\n');
  const list = aq.buildEndpointList(states, props);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].label, 'Speakers (Realtek(R) Audio)');
  assert.strictEqual(list[0].format.sampleRate, 16000);
  assert.strictEqual(aq.matchEndpoint('Default - Speakers (Realtek(R) Audio)', list), list[0]);
  assert.strictEqual(aq.matchEndpoint('Headphones (Other)', list), null);
});

test('bandwidth estimate finds a lossy low-pass', () => {
  const rate = 48000;
  const bins = new Float32Array(8192).map((_, i) => ((i + 0.5) * rate / 2 / 8192 < 16000 ? -40 : -135));
  const cutoff = aq.estimateBandwidth(bins, rate);
  assert.ok(Math.abs(cutoff - 16000) < 50, `cutoff ${cutoff}`);
  assert.match(aq.describeBandwidth(cutoff, rate), /lossy/);
});

test('bandwidth estimate reports full band content', () => {
  const rate = 44100;
  const bins = new Float32Array(8192).fill(-50);
  const cutoff = aq.estimateBandwidth(bins, rate);
  assert.strictEqual(aq.describeBandwidth(cutoff, rate), 'full band');
});

test('silence gives no bandwidth estimate', () => {
  assert.strictEqual(aq.estimateBandwidth(new Float32Array(1024).fill(-140), 48000), null);
});
