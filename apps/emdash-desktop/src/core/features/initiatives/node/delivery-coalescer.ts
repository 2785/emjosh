export type DeliveryCoalescerOptions<T> = {
  /** Quiet time after the latest item before a key's batch goes out. */
  debounceMs: number;
  /** Longest a batch waits from its first item, however busy the feed is. */
  maxWaitMs: number;
  flush: (key: string, items: T[]) => Promise<void>;
  onError?: (error: unknown) => void;
};

/** What initiative deliveries use unless configured otherwise. */
export const DEFAULT_DELIVERY_WINDOW = {
  debounceMs: 8_000,
  maxWaitMs: 45_000,
} as const;

type Batch<T> = { items: T[]; firstAt: number; timer: ReturnType<typeof setTimeout> | null };

/**
 * Batches items per key (a recipient) so a burst goes out as one delivery: a short debounce keeps
 * a lone item from waiting long, and a max wait bounds how long a steady stream is held.
 */
export class DeliveryCoalescer<T> {
  private readonly batches = new Map<string, Batch<T>>();

  constructor(private readonly options: DeliveryCoalescerOptions<T>) {}

  add(key: string, item: T): void {
    const batch = this.batches.get(key) ?? { items: [], firstAt: Date.now(), timer: null };
    batch.items.push(item);
    this.batches.set(key, batch);
    const untilMax = batch.firstAt + this.options.maxWaitMs - Date.now();
    this.schedule(key, batch, Math.max(0, Math.min(this.options.debounceMs, untilMax)));
  }

  /** Drops pending batches; their messages stay readable through read_messages. */
  dispose(): void {
    for (const batch of this.batches.values()) if (batch.timer) clearTimeout(batch.timer);
    this.batches.clear();
  }

  private schedule(key: string, batch: Batch<T>, delayMs: number): void {
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      batch.timer = null;
      this.due(key, batch).catch((error: unknown) => this.options.onError?.(error));
    }, delayMs);
  }

  private async due(key: string, batch: Batch<T>): Promise<void> {
    if (this.batches.get(key) !== batch) return;
    if (batch.timer) clearTimeout(batch.timer);
    this.batches.delete(key);
    await this.options.flush(key, batch.items);
  }
}
