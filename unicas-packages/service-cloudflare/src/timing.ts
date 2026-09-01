export interface TimingSink {
  time<T>(name: string, operation: () => Promise<T>): Promise<T>;
}

interface TimingEntry {
  durationMs: number;
  count: number;
}

/** Per-request Server-Timing collector. Repeated operations are aggregated. */
export class ServerTiming implements TimingSink {
  readonly #entries = new Map<string, TimingEntry>();

  record(name: string, durationMs: number): void {
    const current = this.#entries.get(name);
    if (current) {
      current.durationMs += durationMs;
      current.count++;
    } else {
      this.#entries.set(name, { durationMs, count: 1 });
    }
  }

  async time<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await operation();
    } finally {
      this.record(name, performance.now() - started);
    }
  }

  headerValue(): string {
    return [...this.#entries].map(([name, entry]) => {
      const count = entry.count === 1 ? "" : `;desc=\"${entry.count} calls\"`;
      return `${name};dur=${entry.durationMs.toFixed(1)}${count}`;
    }).join(", ");
  }

  decorate(response: Response): Response {
    const headers = new Headers(response.headers);
    const value = this.headerValue();
    if (value) {
      const existing = headers.get("Server-Timing");
      headers.set("Server-Timing", existing ? `${existing}, ${value}` : value);
      headers.set("Timing-Allow-Origin", "*");
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

export function timeOperation<T>(
  timing: TimingSink | undefined,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  return timing ? timing.time(name, operation) : operation();
}