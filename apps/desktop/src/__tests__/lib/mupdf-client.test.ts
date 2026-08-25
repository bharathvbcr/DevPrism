import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    FakeWorker.instances.push(this);
  }
}

function lastWorker(): FakeWorker {
  return FakeWorker.instances[FakeWorker.instances.length - 1];
}

function initWorker(worker: FakeWorker) {
  worker.onmessage?.({ data: ["INIT", 0, null] });
}

/** call() gates on the INIT handshake promise; let its continuations run. */
async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

import { getMupdfClient, resetMupdfClient } from "@/lib/mupdf/mupdf-client";

describe("mupdf-client worker termination", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", FakeWorker);
    FakeWorker.instances.length = 0;
    resetMupdfClient();
    FakeWorker.instances.length = 0;
  });

  it("resolves pending requests on normal responses", async () => {
    const client = getMupdfClient();
    const worker = lastWorker();
    initWorker(worker);

    const pending = client.countPages(3);
    await flushMicrotasks();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    const [message] = worker.postMessage.mock.calls[0] as [[string, number]];
    worker.onmessage?.({ data: ["RESULT", message[1], 42] });

    await expect(pending).resolves.toBe(42);
  });

  it("rejects all pending requests when the worker errors", async () => {
    const client = getMupdfClient();
    const worker = lastWorker();
    initWorker(worker);

    const first = client.countPages(1);
    const second = client.searchPage(1, 0, "needle");
    await flushMicrotasks();
    worker.onerror?.({ message: "out of memory" });

    await expect(first).rejects.toThrow("mupdf worker terminated");
    await expect(second).rejects.toThrow("mupdf worker terminated");

    // Singleton is dropped so the next call spins up a fresh worker.
    getMupdfClient();
    expect(FakeWorker.instances.length).toBe(2);
  });

  it("resetMupdfClient rejects pending requests immediately instead of leaving them to time out", async () => {
    const client = getMupdfClient();
    const worker = lastWorker();
    initWorker(worker);

    const first = client.countPages(7);
    const second = client.getAllPageSizes(7);
    await flushMicrotasks();
    resetMupdfClient();

    await expect(first).rejects.toThrow("mupdf worker terminated");
    await expect(second).rejects.toThrow("mupdf worker terminated");
    expect(worker.terminate).toHaveBeenCalled();

    // A brand-new worker serves the next request.
    getMupdfClient();
    const freshWorker = lastWorker();
    initWorker(freshWorker);
    const pending = getMupdfClient().countPages(9);
    await flushMicrotasks();
    expect(freshWorker.postMessage).toHaveBeenCalledTimes(1);
    const [, id] = freshWorker.postMessage.mock.calls[0][0] as [
      string,
      number,
      unknown[],
    ];
    freshWorker.onmessage?.({ data: ["RESULT", id, 5] });
    await expect(pending).resolves.toBe(5);
  });
});
