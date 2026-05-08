export class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.items.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters) w({ value: undefined as unknown as T, done: true });
    this.waiters.length = 0;
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      const value = this.items.shift() as T;
      return Promise.resolve({ value, done: false });
    }
    if (this.closed) return Promise.resolve({ value: undefined as unknown as T, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  return(): Promise<IteratorResult<T>> {
    this.close();
    return Promise.resolve({ value: undefined as unknown as T, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}
