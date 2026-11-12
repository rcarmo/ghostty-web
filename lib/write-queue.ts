// Cooperative parsing adapted from rundel/ghostterm c653ed12 (MIT).
const CHUNK = 16 * 1024;
const BUDGET_MS = 8;
const MAX_PENDING = 8 * 1024 * 1024;
type Data = string | Uint8Array;
type Entry = { data: Data; done?: () => void };
const weight = (data: Data) => data.length * (typeof data === 'string' ? 2 : 1);

/** Never split a surrogate pair or a valid UTF-8 codepoint. VT sequences stream. */
export function splitWrite(data: Data, limit = CHUNK): [Data, Data | null] {
  if (!Number.isInteger(limit) || limit < 4)
    throw new RangeError('Write chunk must be at least four units');
  if (data.length <= limit) return [data, null];
  let cut = limit;
  if (typeof data === 'string') {
    const unit = data.charCodeAt(cut - 1);
    if (unit >= 0xd800 && unit <= 0xdbff) cut--;
    return [data.slice(0, cut), data.slice(cut)];
  }
  while (cut > limit - 3 && (data[cut] & 0xc0) === 0x80) cut--;
  return [data.subarray(0, cut), data.subarray(cut)];
}

/** Bounded, ordered parser queue. Completion means parsed, not necessarily painted. */
export class WriteQueue {
  private entries: Entry[] = [];
  private pending = 0;
  private flushing = false;
  private disposed = false;
  private cancel?: () => void;
  constructor(
    private consume: (data: Data) => void,
    private schedule: (fn: () => void) => () => void,
    private failed: (error: Error) => void,
    private now = () => performance.now()
  ) {}
  enqueue(data: Data, done?: () => void): void {
    if (this.disposed) return;
    if (this.pending + weight(data) > MAX_PENDING)
      throw new RangeError('Terminal parser backlog exceeds 8 MiB');
    // Async consumers must own mutable bytes, even if a caller reuses its buffer.
    data = typeof data === 'string' ? data : data.slice();
    this.pending += weight(data);
    this.entries.push({ data, done });
    if (!this.flushing && !this.cancel) this.flush(true);
  }
  private flush(synchronous = false): void {
    if (this.disposed || this.flushing) return;
    this.cancel = undefined;
    this.flushing = true;
    const start = this.now();
    let consumed = false;
    try {
      while (this.entries.length && !this.disposed) {
        if (consumed && this.now() - start >= BUDGET_MS) break;
        const entry = this.entries[0];
        const [chunk, rest] = splitWrite(entry.data);
        if (rest === null) this.entries.shift();
        else entry.data = rest;
        this.pending -= weight(chunk);
        if (chunk.length) this.consume(chunk);
        consumed = true;
        if (rest === null && entry.done) queueMicrotask(entry.done);
      }
    } catch (error) {
      this.clear();
      const cause = error instanceof Error ? error : new Error(String(error));
      this.failed(cause);
      if (synchronous) throw cause;
    } finally {
      this.flushing = false;
    }
    if (this.entries.length && !this.disposed) this.cancel = this.schedule(() => this.flush());
  }
  clear(): void {
    this.cancel?.();
    this.cancel = undefined;
    this.entries = [];
    this.pending = 0;
  }
  dispose(): void {
    this.clear();
    this.disposed = true;
  }
}
