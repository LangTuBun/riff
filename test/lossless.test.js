'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { cleanSoulseekQuery, buildSongJobRequest, buildSockseekConf, isLosslessExtension, primaryArtist, cleanTitle } = require('../src/shared/lossless');

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
