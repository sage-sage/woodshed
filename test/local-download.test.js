import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { crc32, makeZip } from '../js/local-download.js';

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('makeZip output opens with a real unzip tool and round-trips names and bytes', () => {
  const files = [
    { name: 'Woodshed/README.txt', data: new TextEncoder().encode('hello\r\nworld') },
    { name: 'Woodshed/app/Start Woodshed.cmd', data: new TextEncoder().encode('@echo off') },
    { name: 'Woodshed/bin/blob.bin', data: Uint8Array.from({ length: 70000 }, (_, i) => (i * 31) & 255) },
  ];
  const zip = makeZip(files);
  const p = path.join(os.tmpdir(), `ws-zip-test-${process.pid}.zip`);
  fs.writeFileSync(p, zip);
  const py = `import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n: len(z.read(n)) for n in z.namelist()}))`;
  const out = JSON.parse(execFileSync('python', ['-I', '-c', py, p], { encoding: 'utf8' }));
  fs.unlinkSync(p);
  assert.deepEqual(out, { 'Woodshed/README.txt': 12, 'Woodshed/app/Start Woodshed.cmd': 9, 'Woodshed/bin/blob.bin': 70000 });
});
