import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeId } from '../js/player.js';

test('parseYouTubeId: extracts 11-char ID from 14 valid URL shapes and rejects invalid ones', () => {
  const validCases = [
    ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['http://youtube.com/watch?v=dQw4w9WgXcQ&feature=youtu.be', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/watch?time_continue=42&v=dQw4w9WgXcQ&t=42s', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=120', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1', 'dQw4w9WgXcQ'],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ?feature=share', 'dQw4w9WgXcQ'],
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=_-9A8b7C6d5', '_-9A8b7C6d5'],
    ['youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['youtu.be/dQw4w9WgXcQ?si=xyz123', 'dQw4w9WgXcQ']
  ];

  for (const [input, expected] of validCases) {
    assert.equal(parseYouTubeId(input), expected, `Failed on valid input: ${input}`);
  }

  const invalidCases = [
    '',
    '   ',
    null,
    undefined,
    'too_short',
    'way_too_long_for_a_youtube_id',
    'https://vimeo.com/12345678901',
    'https://www.youtube.com/channel/UC38IQsAvIsxxjztdMZQtwHA',
    'https://www.youtube.com/playlist?list=PL1234567890',
    'https://www.youtube.com/watch?v=bad',
    'not a url at all with spaces'
  ];

  for (const invalid of invalidCases) {
    assert.equal(parseYouTubeId(invalid), null, `Expected null for invalid input: ${invalid}`);
  }
});
