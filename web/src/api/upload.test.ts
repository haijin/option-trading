import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeXhr } from '../pages/journal/testXhr';
import { ApiError, onUnauthenticated } from './client';
import { imageFileProblem, MAX_IMAGE_BYTES, uploadError, uploadJournalImage } from './upload';

const png = (size = 1000, name = 'chart.png') => new File([new Uint8Array(size)], name, { type: 'image/png' });

beforeEach(() => {
  FakeXhr.reset();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});
afterEach(() => vi.unstubAllGlobals());

describe('imageFileProblem', () => {
  it('accepts images and an empty type with an image name (HEIC from an iPhone)', () => {
    expect(imageFileProblem({ size: 1000, type: 'image/png' })).toBeNull();
    expect(imageFileProblem({ size: 1000, type: '' })).toBeNull();
    expect(imageFileProblem({ size: MAX_IMAGE_BYTES, type: 'image/jpeg' })).toBeNull();
  });

  it('says in words when a file is not an image, is empty, or is over 8 MB', () => {
    expect(imageFileProblem({ size: 10, type: 'application/pdf' })).toBe('That file is not an image.');
    expect(imageFileProblem({ size: 0, type: 'image/png' })).toBe('That image is empty.');
    expect(imageFileProblem({ size: 9 * 1024 * 1024, type: 'image/png' })).toBe(
      'This image is 9.0 MB. Images are limited to 8 MB.',
    );
  });

  it('shares the server cap: exactly 8 MB', () => {
    expect(MAX_IMAGE_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('uploadJournalImage', () => {
  it('posts the file as multipart form data in the field "file", without a Content-Type of its own', async () => {
    const promise = uploadJournalImage(png(2048, 'screenshot.png'));
    const xhr = FakeXhr.last();
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/journal/assets');
    expect(xhr.body).toBeInstanceOf(FormData);
    expect(xhr.file?.name).toBe('screenshot.png');
    expect(xhr.file?.size).toBe(2048);
    // the browser adds the multipart boundary; setting the header ourselves would break it
    expect(Object.keys(xhr.headers).map((k) => k.toLowerCase())).not.toContain('content-type');
    xhr.respond(201, {
      id: '11111111-1111-4111-8111-111111111111',
      url: '/api/journal/assets/11111111-1111-4111-8111-111111111111',
      width: 800,
      height: 600,
    });
    await expect(promise).resolves.toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      url: '/api/journal/assets/11111111-1111-4111-8111-111111111111',
      width: 800,
      height: 600,
    });
  });

  it('reports progress as a fraction and finishes at 1', async () => {
    const seen: number[] = [];
    const promise = uploadJournalImage(png(), { onProgress: (f) => seen.push(f) });
    const xhr = FakeXhr.last();
    xhr.progress(250, 1000);
    xhr.progress(1000, 1000);
    xhr.respond(201, { id: 'a', url: 'u', width: 1, height: 1 });
    await promise;
    expect(seen).toEqual([0.25, 1, 1]);
  });

  it('checks the size before sending anything', async () => {
    const big = png(9 * 1024 * 1024);
    await expect(uploadJournalImage(big)).rejects.toMatchObject({
      code: 'invalid_image',
      message: 'This image is 9.0 MB. Images are limited to 8 MB.',
    });
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it('turns 413 and 415 into readable messages', async () => {
    const tooBig = uploadJournalImage(png());
    FakeXhr.last().respond(413, { error: { code: 'file_too_large', message: 'Images are limited to 8 MB.' } });
    const e1 = (await tooBig.catch((e: unknown) => e)) as ApiError;
    expect(e1).toBeInstanceOf(ApiError);
    expect(e1.status).toBe(413);
    expect(e1.message).toBe('This image is too large. Images are limited to 8 MB.');

    const bad = uploadJournalImage(png());
    FakeXhr.last().respond(415, { error: { code: 'unsupported_image', message: 'x' } });
    const e2 = (await bad.catch((e: unknown) => e)) as ApiError;
    expect(e2.code).toBe('unsupported_image');
    expect(e2.message).toBe('Only PNG, JPEG, WebP, GIF or HEIC images can be added. That file is not one of them.');
  });

  it('passes other server errors through with their own words, and copes with a non-JSON answer', async () => {
    const a = uploadJournalImage(png());
    FakeXhr.last().respond(400, { error: { code: 'empty_file', message: 'The upload is empty.' } });
    await expect(a).rejects.toMatchObject({ code: 'empty_file', message: 'The upload is empty.', status: 400 });
    const b = uploadJournalImage(png());
    FakeXhr.last().respond(502, '<html>bad gateway</html>');
    await expect(b).rejects.toMatchObject({ code: 'http_error', status: 502 });
  });

  it('tells the auth gate on 401 unauthenticated, like every other request', async () => {
    const listener = vi.fn();
    const off = onUnauthenticated(listener);
    const promise = uploadJournalImage(png());
    FakeXhr.last().respond(401, { error: { code: 'unauthenticated', message: 'Sign in.' } });
    await expect(promise).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it('says the server cannot be reached on a network error', async () => {
    const promise = uploadJournalImage(png());
    FakeXhr.last().fail();
    await expect(promise).rejects.toMatchObject({ code: 'network_error', status: 0 });
  });

  it('can be cancelled', async () => {
    const controller = new AbortController();
    const promise = uploadJournalImage(png(), { signal: controller.signal });
    controller.abort();
    expect(FakeXhr.last().aborted).toBe(true);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    const already = new AbortController();
    already.abort();
    await expect(uploadJournalImage(png(), { signal: already.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects an answer that is not an image record', async () => {
    const promise = uploadJournalImage(png());
    FakeXhr.last().respond(201, { nope: true });
    await expect(promise).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('uploadError', () => {
  it('maps by status even when the body is not the error shape', () => {
    expect(uploadError(413, '').code).toBe('file_too_large');
    expect(uploadError(415, 'whatever').code).toBe('unsupported_image');
  });
});
