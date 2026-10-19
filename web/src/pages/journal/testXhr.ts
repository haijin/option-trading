/** A stand-in for XMLHttpRequest that tests drive by hand (not a test file: it is imported by the image tests). */
export class FakeXhr {
  static instances: FakeXhr[] = [];
  static reset(): void {
    FakeXhr.instances = [];
  }
  static last(): FakeXhr {
    const x = FakeXhr.instances.at(-1);
    if (!x) throw new Error('no upload was started');
    return x;
  }

  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  response: unknown = '';
  responseType = '';
  aborted = false;
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  send(body: unknown): void {
    this.body = body;
  }
  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }

  // ---- the test's side
  progress(loaded: number, total: number): void {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respond(status: number, body: unknown): void {
    this.status = status;
    this.response = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.();
  }
  fail(): void {
    this.onerror?.();
  }
  /** The file part of the form that was sent. */
  get file(): File | null {
    const form = this.body;
    return form instanceof FormData ? (form.get('file') as File | null) : null;
  }
}
