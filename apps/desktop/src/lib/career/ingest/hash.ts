/** SHA-1 hex digests for KB content addressing. */

/** Async SHA-1 via Web Crypto (browser / Tauri webview / Node 19+). */
export async function sha1Hex(input: string | Uint8Array): Promise<string> {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  // Copy into a fresh ArrayBuffer-backed view for BufferSource typing (TS 5.7+).
  const view = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-1", view);
  return bufferToHex(digest);
}

/** Sync SHA-1 for chunk builders (pure JS — works in webview and vitest). */
export function sha1HexSync(input: string): string {
  return sha1Pure(Array.from(new TextEncoder().encode(input)));
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

/** Compact SHA-1 over raw UTF-8 bytes. */
function sha1Pure(bytes: number[]): string {
  const ml = bytes.length;
  const withPad = bytes.slice();
  withPad.push(0x80);
  while (withPad.length % 64 !== 56) withPad.push(0);
  const bitLen = ml * 8;
  for (let i = 7; i >= 0; i--) {
    withPad.push((bitLen / 2 ** (i * 8)) & 0xff);
  }

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Array<number>(80);
  for (let i = 0; i < withPad.length; i += 64) {
    for (let j = 0; j < 16; j++) {
      const o = i + j * 4;
      w[j] =
        ((withPad[o]! << 24) |
          (withPad[o + 1]! << 16) |
          (withPad[o + 2]! << 8) |
          withPad[o + 3]!) >>>
        0;
    }
    for (let j = 16; j < 80; j++) {
      const x = w[j - 3]! ^ w[j - 8]! ^ w[j - 14]! ^ w[j - 16]!;
      w[j] = ((x << 1) | (x >>> 31)) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let j = 0; j < 80; j++) {
      let f: number;
      let k: number;
      if (j < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (j < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[j]!) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4]
    .map((n) => n.toString(16).padStart(8, "0"))
    .join("");
}
