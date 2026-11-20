import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldBlockRouteChange } from '../js/nav-guard.js';

const play = '#/song/demo/play';

test('a swipe-back (no click or key) off a playing song is blocked', () => {
  assert.equal(shouldBlockRouteChange({ oldHash: play, newHash: '#/library', playing: true, intentAgeMs: Infinity }), true);
});

test('a click just before leaving is real navigation', () => {
  assert.equal(shouldBlockRouteChange({ oldHash: play, newHash: '#/library', playing: true, intentAgeMs: 120 }), false);
});

test('not playing, or not on the play screen: never blocked', () => {
  assert.equal(shouldBlockRouteChange({ oldHash: play, newHash: '#/library', playing: false, intentAgeMs: Infinity }), false);
  assert.equal(shouldBlockRouteChange({ oldHash: '#/pedalboard', newHash: '#/library', playing: true, intentAgeMs: Infinity }), false);
  assert.equal(shouldBlockRouteChange({ oldHash: '#/song/demo/learn', newHash: play, playing: true, intentAgeMs: Infinity }), false);
});

test('a stale click (over a second ago) does not count', () => {
  assert.equal(shouldBlockRouteChange({ oldHash: play, newHash: '#/song/demo/sync', playing: true, intentAgeMs: 5000 }), true);
});
