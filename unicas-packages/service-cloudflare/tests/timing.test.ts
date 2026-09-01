import { describe, expect, test, vi } from "vitest";
import { ServerTiming } from "../src/timing.js";

describe("ServerTiming", () => {
  test("aggregates repeated operations and preserves streamed responses", async () => {
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(12.5)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(23.5);
    const timing = new ServerTiming();
    await timing.time("cas_d1_node", async () => undefined);
    await timing.time("cas_d1_node", async () => undefined);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("content"));
        controller.close();
      },
    });

    const response = timing.decorate(new Response(body, {
      headers: { "Server-Timing": "cas_auth;dur=1.0" },
    }));

    expect(response.headers.get("Server-Timing"))
      .toBe('cas_auth;dur=1.0, cas_d1_node;dur=6.0;desc="2 calls"');
    expect(response.headers.get("Timing-Allow-Origin")).toBe("*");
    await expect(response.text()).resolves.toBe("content");
  });
});