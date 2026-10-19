import { ASSET_LIMITS } from '../../../src/journal/assets';
import { API_BASE, ApiError, notifyUnauthenticated } from './client';
import type { JournalAssetView } from './types';

/** The upload cap the server enforces, bytes (8 MB). */
export const MAX_IMAGE_BYTES: number = ASSET_LIMITS.maxBytes;

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

/** Why a picked file cannot be uploaded, in words for the author; null when it is fine. The server checks again by magic bytes. */
export function imageFileProblem(file: { size: number; type: string; name?: string }): string | null {
  if (file.type !== '' && !file.type.startsWith('image/')) return 'That file is not an image.';
  if (file.size === 0) return 'That image is empty.';
  if (file.size > MAX_IMAGE_BYTES)
    return `This image is ${mb(file.size)} MB. Images are limited to ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`;
  return null;
}

interface ErrorBody {
  error: { code: string; message?: string; details?: unknown };
}

function errorBodyOf(text: string): ErrorBody | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && 'error' in value) {
      const error = (value as { error: unknown }).error;
      if (typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string')
        return value as ErrorBody;
    }
  } catch {
    // not JSON: handled by the caller
  }
  return null;
}

/** The server's answer to a failed upload, as an error whose message can go straight on the screen. */
export function uploadError(status: number, text: string): ApiError {
  const body = errorBodyOf(text);
  const code = body?.error.code ?? 'http_error';
  if (status === 413 || code === 'file_too_large')
    return new ApiError(
      'file_too_large',
      `This image is too large. Images are limited to ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
      413,
    );
  if (status === 415 || code === 'unsupported_image')
    return new ApiError(
      'unsupported_image',
      'Only PNG, JPEG, WebP, GIF or HEIC images can be added. That file is not one of them.',
      415,
    );
  if (body)
    return new ApiError(code, body.error.message || `Upload failed (HTTP ${status}).`, status, body.error.details);
  return new ApiError('http_error', `The server answered HTTP ${status} to the upload.`, status);
}

export interface UploadOptions {
  signal?: AbortSignal;
  /** 0 to 1, as the bytes leave the phone. */
  onProgress?: (fraction: number) => void;
}

/**
 * `POST /api/journal/assets`: the image as multipart form data, field `file`. The Content-Type is left to the browser (it
 * adds the boundary). XHR rather than fetch so the progress ring can move. The server re-encodes the image (EXIF stripped,
 * long edge 2000 px); the same bytes uploaded twice answer the same id.
 */
export function uploadJournalImage(file: Blob, options: UploadOptions = {}): Promise<JournalAssetView> {
  const problem = imageFileProblem({ size: file.size, type: file.type });
  if (problem) return Promise.reject(new ApiError('invalid_image', problem, 0));
  return new Promise<JournalAssetView>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    const name = file instanceof File && file.name ? file.name : 'image';
    form.append('file', file, name);

    const onAbort = () => xhr.abort();
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
    if (options.signal) {
      if (options.signal.aborted) {
        reject(new DOMException('The upload was cancelled.', 'AbortError'));
        return;
      }
      options.signal.addEventListener('abort', onAbort);
    }

    xhr.open('POST', `${API_BASE}/journal/assets`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.responseType = 'text';
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) options.onProgress?.(Math.min(1, event.loaded / event.total));
    };
    xhr.onload = () => {
      cleanup();
      const text = typeof xhr.response === 'string' ? xhr.response : '';
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const asset = JSON.parse(text) as JournalAssetView;
          if (typeof asset.id !== 'string') throw new Error('no id');
          options.onProgress?.(1);
          resolve(asset);
        } catch {
          reject(
            new ApiError('bad_response', 'The server answered with something that is not an image record.', xhr.status),
          );
        }
        return;
      }
      const error = uploadError(xhr.status, text);
      if (xhr.status === 401 && errorBodyOf(text)?.error.code === 'unauthenticated') notifyUnauthenticated();
      reject(error);
    };
    xhr.onerror = () => {
      cleanup();
      reject(new ApiError('network_error', 'Cannot reach the server. The image was not uploaded.', 0));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException('The upload was cancelled.', 'AbortError'));
    };
    xhr.send(form);
  });
}
