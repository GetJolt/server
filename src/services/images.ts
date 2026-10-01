// Identifies uploaded images from their bytes instead of trusting the declared content type, and reads their
// dimensions from the header so oversized images can be refused without decoding them.

import type { AvatarContentType } from '@getjolt/protocol';

export interface ImageInfo {
  type: AvatarContentType;
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function inspectImage(data: Buffer): ImageInfo | null {
  try {
    if (data.subarray(0, 8).equals(PNG_SIGNATURE) && data.toString('latin1', 12, 16) === 'IHDR') {
      return { type: 'image/png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    }
    const gif = data.toString('latin1', 0, 6);
    if (gif === 'GIF87a' || gif === 'GIF89a') {
      return { type: 'image/gif', width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
    }
    if (data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
      return webp(data);
    }
    if (data[0] === 0xff && data[1] === 0xd8) return jpeg(data);
  } catch {
    // Reading past the end of a truncated file throws, which just means it isn't a valid image.
  }
  return null;
}

function webp(data: Buffer): ImageInfo | null {
  const chunk = data.toString('latin1', 12, 16);
  const size = (width: number, height: number): ImageInfo => ({ type: 'image/webp', width, height });
  if (chunk === 'VP8 ') return size(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
  if (chunk === 'VP8X') return size(1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3));
  if (chunk === 'VP8L') {
    // 14-bit width and height minus one, packed back to back after the signature byte.
    const bits = data.readUInt32LE(21);
    return size(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
  }
  return null;
}

function jpeg(data: Buffer): ImageInfo | null {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Start-of-frame markers carry the dimensions. C4, C8 and CC share the range but mean something else.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        type: 'image/jpeg',
        height: data.readUInt16BE(offset + 5),
        width: data.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + data.readUInt16BE(offset + 2);
  }
  return null;
}
