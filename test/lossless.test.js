'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { cleanSoulseekQuery, buildSongJobRequest, buildSockseekConf, isLosslessExtension, primaryArtist, cleanTitle, classifyUltrasonic, maxItunesArtwork, pickBestCover } = require('../src/shared/lossless');

test('hi-res preference raises sockseek ranking ceilings', () => {
  const q = cleanSoulseekQuery({ title: 'x', artist: 'y' });
  const plain = buildSongJobRequest(q).options.downloadSettings.search.preferredCond;
  const hires = buildSongJobRequest(q, { preferHiRes: true }).options.downloadSettings.search.preferredCond;
  assert.strictEqual(plain.minBitDepth, undefined);
  assert.deepStrictEqual(hires, { lengthTolerance: 3, minBitDepth: 24, minSampleRate: 88200, maxSampleRate: 384000, maxBitrate: 20000 });
});

test('ultrasonic cliff marks upsampled files', () => {
  assert.strictEqual(classifyUltrasonic(-39.9, -104.8), 'upsampled');
  assert.strictEqual(classifyUltrasonic(-39.8, -39.5), 'hires');
  assert.strictEqual(classifyUltrasonic(-60, -61), 'hires');
  assert.strictEqual(classifyUltrasonic(-130, -140), 'unknown');
  assert.strictEqual(classifyUltrasonic(-40, -Infinity), 'upsampled');
});

test('itunes artwork urls are asked for the largest original', () => {
  assert.strictEqual(maxItunesArtwork('https://is1-ssl.mzstatic.com/image/thumb/a/b.jpg/100x100bb.jpg'), 'https://is1-ssl.mzstatic.com/image/thumb/a/b.jpg/3000x3000bb-100.jpg');
  assert.strictEqual(maxItunesArtwork('https://example.com/x.jpg'), 'https://example.com/x.jpg');
});

test('largest cover wins, ties go to the better source', () => {
  const best = pickBestCover([
    { source: 'embedded', width: 500, height: 500, rank: 1 },
    { source: 'itunes', width: 1500, height: 1500, rank: 0 },
    { source: 'stream', width: 0, height: 0, rank: 2 }
  ]);
  assert.strictEqual(best.source, 'itunes');
  assert.strictEqual(pickBestCover([{ source: 'embedded', width: 1000, height: 1000, rank: 1 }, { source: 'itunes', width: 1000, height: 1000, rank: 0 }]).source, 'itunes');
  assert.strictEqual(pickBestCover([]), null);
});

test('youtube music metadata is reduced to the primary artist and bare title', () => {
  const q = cleanSoulseekQuery({ title: 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)', artist: 'Daft Punk, Pharrell Williams & Nile Rodgers', duration: 369.6 });
  assert.strictEqual(q.artist, 'Daft Punk');
  assert.strictEqual(q.title, 'Get Lucky');
  assert.strictEqual(q.length, 370);
});

test('channel suffixes and video noise are stripped', () => {
  assert.strictEqual(primaryArtist('Adele - Topic'), 'Adele');
  assert.strictEqual(primaryArtist('TaylorSwiftVEVO'), 'TaylorSwift');
  assert.strictEqual(primaryArtist('Metro Boomin x Future'), 'Metro Boomin');
  assert.strictEqual(primaryArtist('Simon & Garfunkel'), 'Simon & Garfunkel');
  assert.strictEqual(cleanTitle('Blinding Lights (Official Audio) [HD]'), 'Blinding Lights');
  assert.strictEqual(cleanTitle('Song ft. Someone'), 'Song');
});

test('version tags that change the recording are kept', () => {
  assert.strictEqual(cleanTitle('Midnight City (Live)'), 'Midnight City (Live)');
  assert.strictEqual(cleanTitle('One More Time (Radio Edit)'), 'One More Time (Radio Edit)');
});

test('artist is taken from an "Artist - Title" title when missing', () => {
  const q = cleanSoulseekQuery({ title: 'Daft Punk - Around the World', artist: '' });
  assert.strictEqual(q.artist, 'Daft Punk');
  assert.strictEqual(q.title, 'Around the World');
  assert.strictEqual(q.length, null);
});

test('job request requires lossless formats and disables the yt-dlp fallback', () => {
  const req = buildSongJobRequest(cleanSoulseekQuery({ title: 'x', artist: 'y' }));
  assert.deepStrictEqual(req.options.downloadSettings.search.necessaryCond.formats.replace.slice(0, 2), ['flac', 'wav']);
  assert.strictEqual(req.options.downloadSettings.ytDlp.useYtdlp, false);
  assert.strictEqual(req.downloadBehavior.default, 'Automatic');
  assert.strictEqual(req.options.downloadSettings.search.necessaryCond.lengthTolerance, 15);
  assert.strictEqual(req.options.downloadSettings.search.preferredCond.lengthTolerance, 3);
});

test('length is dropped when the source duration is unreliable', () => {
  assert.strictEqual(cleanSoulseekQuery({ title: 'x', artist: 'y', duration: 250, lengthUnreliable: true }).length, null);
  assert.strictEqual(cleanSoulseekQuery({ title: 'x', artist: 'y', duration: 250 }).length, 250);
});

test('config quotes values and rejects multi-line input', () => {
  const conf = buildSockseekConf({ username: 'me', password: ' p=ss#1 ' });
  assert.match(conf, /^username = "me"$/m);
  assert.match(conf, /^password = " p=ss#1 "$/m);
  assert.throws(() => buildSockseekConf({ username: 'me', password: 'a\nb' }));
  assert.throws(() => buildSockseekConf({ username: '', password: 'x' }));
});

test('lossless extension check', () => {
  assert.ok(isLosslessExtension('.FLAC'));
  assert.ok(isLosslessExtension('wav'));
  assert.ok(!isLosslessExtension('.mp3'));
});
