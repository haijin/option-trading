import { describe, expect, it } from 'vitest';
import { ASSET_LIMITS, assetRelPath, isAssetId, sniffImage, storedFormatOf, thumbRelPath } from '../../src/journal';

const bytes = (...b: number[]) => Uint8Array.from(b);
const text = (s: string) => Uint8Array.from(Buffer.from(s, 'latin1'));

describe('sniffImage: the first bytes decide, never the name', () => {
  it('recognises PNG, JPEG, WebP, GIF and HEIC', () => {
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('png');
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0, 0))).toBe('jpeg');
    expect(sniffImage(Uint8Array.from([...text('RIFF'), 1, 2, 3, 4, ...text('WEBPVP8 ')]))).toBe('webp');
    expect(sniffImage(text('GIF89a\u0001\u0000'))).toBe('gif');
    expect(sniffImage(text('GIF87a\u0001\u0000'))).toBe('gif');
    expect(sniffImage(Uint8Array.from([0, 0, 0, 24, ...text('ftypheic'), 0, 0]))).toBe('heic');
    expect(sniffImage(Uint8Array.from([0, 0, 0, 24, ...text('ftypmif1'), 0, 0]))).toBe('heic');
  });

  it('rejects programs, scripts, SVG, text, truncated signatures and empty input', () => {
    expect(sniffImage(text('MZ\u0090\u0000\u0003'))).toBeNull();
    expect(sniffImage(text('#!/bin/sh\necho hi'))).toBeNull();
    expect(sniffImage(text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'))).toBeNull();
    expect(sniffImage(text('<html><body>not an image'))).toBeNull();
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull();
    expect(sniffImage(bytes(0xff, 0xd8))).toBeNull();
    expect(sniffImage(Uint8Array.from([...text('RIFF'), 1, 2, 3, 4, ...text('WAVEfmt ')]))).toBeNull();
    expect(sniffImage(Uint8Array.from([0, 0, 0, 24, ...text('ftypmp42'), 0, 0]))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });

  it('stores HEIC as JPEG and everything else as itself', () => {
    expect(storedFormatOf('heic')).toBe('jpeg');
    expect(storedFormatOf('png')).toBe('png');
  });
});

describe('asset paths', () => {
  const user = '11111111-2222-4333-8444-555555555555';
  const asset = '0b9a8f0e-6b8c-4f9e-8a53-5a6d6c1b9a11';

  it('builds the path from ids and the year only', () => {
    expect(assetRelPath(user, 2026, asset, 'jpeg')).toBe(`journal/${user}/2026/${asset}.jpg`);
    expect(thumbRelPath(`journal/${user}/2026/${asset}.png`)).toBe(`journal/${user}/2026/${asset}.thumb.webp`);
  });

  it('refuses anything that is not an id, so a path can never come from a client name', () => {
    expect(() => assetRelPath('../../etc', 2026, asset, 'png')).toThrow();
    expect(() => assetRelPath(user, 2026, '../passwd', 'png')).toThrow();
    expect(isAssetId(asset)).toBe(true);
    expect(isAssetId('not-an-id')).toBe(false);
    expect(isAssetId(`${asset}/..`)).toBe(false);
  });

  it('keeps the limits in one place', () => {
    expect(ASSET_LIMITS.maxBytes).toBe(8 * 1024 * 1024);
    expect(ASSET_LIMITS.maxEdge).toBe(2000);
    expect(ASSET_LIMITS.thumbEdge).toBe(320);
  });
});
