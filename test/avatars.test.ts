import type { JoltApiError, JoltSession } from '@getjolt/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectImage } from '../src/services/images.js';
import { signUp, startInstance, waitFor, type TestInstance } from './helpers.js';

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

function pngHeader(width: number, height: number) {
  const header = Buffer.alloc(33);
  PIXEL.copy(header, 0, 0, 16);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

let a: TestInstance;
let alice: JoltSession;

beforeAll(async () => {
  a = await startInstance();
  alice = await signUp(a, 'alice');
});

afterAll(async () => {
  await alice?.signOut();
  await a?.close();
});

describe('avatars', () => {
  it('stores an upload and serves it to anyone', async () => {
    await alice.setAvatar(new Blob([PIXEL], { type: 'image/png' }));
    const url = await waitFor(() => alice.state.me[a.domain]?.avatarUrl);
    expect(url).toMatch(new RegExp(`^http://${a.domain}/api/v1/avatars/[\\w-]{43}$`));

    const response = await fetch(url);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(Buffer.from(await response.arrayBuffer()).equals(PIXEL)).toBe(true);
  });

  it('refuses files that only claim to be images', async () => {
    const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/png' });
    const error = await alice.setAvatar(svg).catch((e: JoltApiError) => e);
    expect((error as JoltApiError).status).toBe(400);

    const unsupported = new Blob(['<svg/>'], { type: 'image/svg+xml' });
    expect(await alice.setAvatar(unsupported).catch((e: JoltApiError) => e.status)).toBe(415);
  });

  it('refuses images that are too large', async () => {
    const huge = new Blob([pngHeader(5000, 5000)], { type: 'image/png' });
    const error = await alice.setAvatar(huge).catch((e: JoltApiError) => e);
    expect((error as JoltApiError).message).toMatch(/at most/);
  });

  it('removes the avatar and deletes the unused image', async () => {
    const url = alice.state.me[a.domain]!.avatarUrl!;
    await alice.setAvatar(null);
    await waitFor(() => alice.state.me[a.domain]?.avatarUrl === null);
    expect((await fetch(url)).status).toBe(404);
  });
});

describe('inspectImage', () => {
  it('reads dimensions from every accepted format', () => {
    expect(inspectImage(PIXEL)).toEqual({ type: 'image/png', width: 1, height: 1 });

    const gif = Buffer.from('GIF89a\x40\x00\x20\x00', 'latin1');
    expect(inspectImage(gif)).toEqual({ type: 'image/gif', width: 64, height: 32 });

    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x02, 0x00,
      0x03, 0x01,
    ]);
    expect(inspectImage(jpeg)).toEqual({ type: 'image/jpeg', width: 512, height: 256 });

    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBPVP8X', 8, 'latin1');
    webp.writeUIntLE(299, 24, 3);
    webp.writeUIntLE(149, 27, 3);
    expect(inspectImage(webp)).toEqual({ type: 'image/webp', width: 300, height: 150 });
  });

  it('returns null for anything else', () => {
    expect(inspectImage(Buffer.from('not an image'))).toBeNull();
    expect(inspectImage(PIXEL.subarray(0, 12))).toBeNull();
  });
});
