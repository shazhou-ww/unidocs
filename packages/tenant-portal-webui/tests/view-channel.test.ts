import { describe, expect, it, vi } from "vitest";
import { createLocalChannel, type ViewImplementation, type HostImplementation } from "../src/view/channel.js";
import { toProtocolMarkers, type RoledMarker } from "../src/view/markers.js";

function stubHost(): HostImplementation {
  return {
    readBlob: vi.fn(),
    listThreads: vi.fn(async () => ({ items: [], nextCursor: null })),
    getThread: vi.fn(),
    createThread: vi.fn(async () => ({ threadId: "th-new", comments: [], replies: [] })),
    appendComment: vi.fn(),
    storeBlob: vi.fn(),
  } as unknown as HostImplementation;
}

function stubView(): ViewImplementation {
  return {
    initialize: vi.fn(async () => ({ acceptedProtocol: "unidocs-view-host/v1" as const })),
    loadSnapshot: vi.fn(async () => ({ renderedVersionIdx: 0 })),
    setViewport: vi.fn(async () => ({ appliedRevision: 1 })),
    setMarkers: vi.fn(async () => undefined),
    focusLocation: vi.fn(async () => ({ located: true, reason: "located" as const })),
    dispose: vi.fn(async () => undefined),
  };
}

describe("createLocalChannel", () => {
  it("callView 转发到 view 实现并返回结果", async () => {
    const view = stubView();
    const channel = createLocalChannel({ view, host: stubHost() });

    const result = await channel.callView("loadSnapshot", {
      context: { contextId: "c1" } as never,
      snapshot: { content: "# x" } as never,
    });

    expect(result).toEqual({ renderedVersionIdx: 0 });
    expect(view.loadSnapshot).toHaveBeenCalledOnce();
  });

  it("view 拿到的是拷贝，不与调用方共享引用", async () => {
    const view = stubView();
    const channel = createLocalChannel({ view, host: stubHost() });
    const snapshot = { content: "# x" };

    await channel.callView("loadSnapshot", { context: { contextId: "c1" } as never, snapshot: snapshot as never });

    const received = (view.loadSnapshot as ReturnType<typeof vi.fn>).mock.calls[0][0].snapshot;
    expect(received).toEqual(snapshot);
    expect(received).not.toBe(snapshot);
  });

  it("view 侧调 host 时同样被转发", async () => {
    const host = stubHost();
    let callHost: Parameters<ViewImplementation["initialize"]>[1] | undefined;
    const view: ViewImplementation = {
      ...stubView(),
      initialize: async (_request, hostApi) => {
        callHost = hostApi;
        return { acceptedProtocol: "unidocs-view-host/v1" };
      },
    };
    const channel = createLocalChannel({ view, host });

    await channel.callView("initialize", { protocol: "unidocs-view-host/v1", context: {} as never, mode: { kind: "interactive" } });
    await callHost!.createThread({ baseVersionIdx: 0, content: { text: "x", richContent: null, attachments: [] }, location: null });

    expect(host.createThread).toHaveBeenCalledOnce();
  });

  it("dispose 之后再调用被拒绝", async () => {
    const channel = createLocalChannel({ view: stubView(), host: stubHost() });
    channel.dispose();

    await expect(channel.callView("setViewport", { revision: 1, state: null })).rejects.toThrow(/disposed/);
  });
});

describe("toProtocolMarkers", () => {
  it("剥掉本地的 role 字段，只留协议形状", () => {
    const roled: RoledMarker[] = [{
      threadId: "th-1", commentIdx: 0, open: true, role: "ping",
      location: { documentContractIdx: 0, locationType: "unidocs.markdown.text-range/v1", payload: { start: 0, end: 1, quote: "x" } },
    }];

    const markers = toProtocolMarkers(roled);

    expect(markers[0]).not.toHaveProperty("role");
    expect(markers[0]).toMatchObject({ threadId: "th-1", commentIdx: 0, open: true });
  });
});
