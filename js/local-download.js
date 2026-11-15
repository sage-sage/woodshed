/**
 * "Download for Windows" on the hosted copy: fetches the published files listed in dl/manifest.json, packs them
 * into a zip in the browser (stored, no compression: the files are small) and hands it to the viewer's download
 * prompt. Pure zip writer + CRC-32 so it needs no library.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {{name:string, data:Uint8Array}[]} entries  @returns {Uint8Array} a valid .zip (store method, UTF-8 names) */
export function makeZip(entries) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 names
    lh.setUint16(8, 0, true); // stored
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, e.data.length, true);
    lh.setUint32(22, e.data.length, true);
    lh.setUint16(26, name.length, true);
    locals.push(new Uint8Array(lh.buffer), name, e.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, e.data.length, true);
    ch.setUint32(24, e.data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + e.data.length;
  }
  const cdSize = centrals.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** Fetch every file named in dl/manifest.json and return the finished zip. onProgress(done, total). */
export async function buildLocalZip(onProgress = () => {}) {
  const res = await fetch('dl/manifest.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('The download is not available on this copy.');
  const manifest = await res.json();
  const entries = [];
  let done = 0;
  for (const f of manifest.files) {
    const r = await fetch(f.url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`Could not fetch ${f.url} (${r.status}).`);
    entries.push({ name: f.zip, data: new Uint8Array(await r.arrayBuffer()) });
    onProgress(++done, manifest.files.length);
  }
  return { zip: makeZip(entries), filename: manifest.filename || 'Woodshed for Windows.zip' };
}

/** Just the Tab Grabber extension from the same manifest, as its own zip (one "Woodshed Tab Grabber/" folder). */
export async function buildExtensionZip(onProgress = () => {}) {
  const res = await fetch('dl/manifest.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('The download is not available on this copy.');
  const prefix = 'Woodshed/Woodshed Tab Grabber/';
  const files = (await res.json()).files.filter((f) => f.zip.startsWith(prefix));
  if (!files.length) throw new Error('The extension is not part of this copy.');
  const entries = [];
  for (const f of files) {
    const r = await fetch(f.url, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`Could not fetch ${f.url} (${r.status}).`);
    entries.push({ name: f.zip.slice('Woodshed/'.length), data: new Uint8Array(await r.arrayBuffer()) });
    onProgress(entries.length, files.length);
  }
  return { zip: makeZip(entries), filename: 'Woodshed Tab Grabber.zip' };
}
