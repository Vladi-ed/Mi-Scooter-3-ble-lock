// Serializes complete asynchronous operations, not just individual GATT writes.
export class OperationQueue {
  constructor() { this.pending = []; this.active = false; this.closed = null; }
  run(action) {
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      this.pending.push({ action, resolve, reject });
      this.drain();
    });
  }
  async drain() {
    if (this.active) return;
    this.active = true;
    while (this.pending.length && !this.closed) {
      const task = this.pending.shift();
      try { task.resolve(await task.action()); } catch (error) { task.reject(error); }
    }
    this.active = false;
  }
  cancel(error) {
    this.closed = error;
    for (const task of this.pending.splice(0)) task.reject(error);
  }
}
