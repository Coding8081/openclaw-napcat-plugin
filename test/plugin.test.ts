/**
 * Tests for the NapCat OpenClaw plugin
 *
 * Covers:
 * 1. Plugin registration – api.registerHttpHandler guard (new API / old API / missing)
 * 2. gateway.startAccount – fallback to registerPluginHttpRoute when available
 * 3. handleNapCatWebhook – URL routing, method validation, meta_event, allowlist
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock the openclaw SDK so index.ts can be imported without the package installed
vi.mock("openclaw/plugin-sdk", () => ({
  emptyPluginConfigSchema: () => ({}),
}));

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal IncomingMessage-like mock */
function makeReq(
  method: string,
  url: string,
  bodyJson?: object
): any {
  const emitter = new EventEmitter() as any;
  emitter.method = method;
  emitter.url = url;
  if (bodyJson !== undefined) {
    const data = JSON.stringify(bodyJson);
    process.nextTick(() => {
      emitter.emit("data", data);
      emitter.emit("end");
    });
  } else {
    process.nextTick(() => emitter.emit("end"));
  }
  return emitter;
}

/** Build a minimal ServerResponse-like mock */
function makeRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    ended: false,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(data = "") {
      this.body = data;
      this.ended = true;
    },
  };
}

// ── module imports ────────────────────────────────────────────────────────────

import { setNapCatRuntime, setNapCatConfig } from "../src/runtime.js";
import { handleNapCatWebhook } from "../src/webhook.js";
import { napcatPlugin } from "../src/channel.js";

// ── 1. Plugin registration ────────────────────────────────────────────────────

describe("plugin.register()", () => {
  it("calls registerHttpHandler when the method exists on the api (new OpenClaw)", async () => {
    const { default: plugin } = await import("../index.ts");

    const registeredHandlers: any[] = [];
    const mockRuntime = { config: { loadConfig: () => ({}) } };
    const api: any = {
      runtime: mockRuntime,
      registerChannel: vi.fn(),
      registerHttpHandler: vi.fn((h) => registeredHandlers.push(h)),
    };

    plugin.register(api);

    expect(api.registerChannel).toHaveBeenCalledOnce();
    expect(api.registerHttpHandler).toHaveBeenCalledOnce();
    expect(registeredHandlers[0]).toBeTypeOf("function");
  });

  it("does NOT throw when registerHttpHandler is absent (old OpenClaw)", async () => {
    const { default: plugin } = await import("../index.ts");

    const mockRuntime = { config: { loadConfig: () => ({}) } };
    const api: any = {
      runtime: mockRuntime,
      registerChannel: vi.fn(),
    };

    expect(() => plugin.register(api)).not.toThrow();
    expect(api.registerChannel).toHaveBeenCalledOnce();
  });
});

// ── 2. gateway.startAccount – old-API fallback ────────────────────────────────

describe("napcatPlugin.gateway.startAccount()", () => {
  beforeEach(() => {
    setNapCatRuntime({ config: { loadConfig: () => ({}) } });
  });

  it("returns stop() without error when registerPluginHttpRoute is absent", async () => {
    const result = await napcatPlugin.gateway.startAccount({});
    expect(result).toHaveProperty("stop");
    expect(() => result.stop()).not.toThrow();
  });

  it("registers /napcat and /napcat/media routes when registerPluginHttpRoute is present (old API)", async () => {
    const registered: string[] = [];
    const unregFns: Array<ReturnType<typeof vi.fn>> = [];

    const mockRuntime = {
      config: { loadConfig: () => ({}) },
      channel: {
        registerPluginHttpRoute: vi.fn(({ path }: { path: string }) => {
          registered.push(path);
          const unregFn = vi.fn();
          unregFns.push(unregFn);
          return unregFn;
        }),
      },
    };
    setNapCatRuntime(mockRuntime);

    const ctx = { account: { accountId: "default" } };
    const result = await napcatPlugin.gateway.startAccount(ctx);

    expect(registered).toContain("/napcat");
    expect(registered).toContain("/napcat/media");
    expect(mockRuntime.channel.registerPluginHttpRoute).toHaveBeenCalledTimes(2);

    result.stop();
    for (const fn of unregFns) {
      expect(fn).toHaveBeenCalledOnce();
    }
  });
});

// ── 3. handleNapCatWebhook ────────────────────────────────────────────────────

describe("handleNapCatWebhook()", () => {
  beforeEach(() => {
    setNapCatConfig({ enableInboundLogging: false });
    setNapCatRuntime({ config: { loadConfig: () => ({}) } });
  });

  it("returns false for URLs not starting with /napcat", async () => {
    const req = makeReq("POST", "/other/path");
    const res = makeRes();
    const result = await handleNapCatWebhook(req as any, res as any);
    expect(result).toBe(false);
    expect(res.ended).toBe(false);
  });

  it("returns 405 for non-GET/POST methods on /napcat", async () => {
    const req = makeReq("DELETE", "/napcat");
    const res = makeRes();
    const result = await handleNapCatWebhook(req as any, res as any);
    expect(result).toBe(true);
    expect(res.statusCode).toBe(405);
  });

  it("returns 200 for meta_event heartbeats", async () => {
    const req = makeReq("POST", "/napcat", {
      post_type: "meta_event",
      meta_event_type: "heartbeat",
    });
    const res = makeRes();
    const result = await handleNapCatWebhook(req as any, res as any);
    expect(result).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "ok" });
  });

  it("ignores a message from a user NOT in the allowlist", async () => {
    setNapCatConfig({ enableInboundLogging: false, allowUsers: ["111111"] });

    const req = makeReq("POST", "/napcat", {
      post_type: "message",
      message_type: "private",
      user_id: 999999,
      raw_message: "hello",
      message_id: "1",
      sender: {},
    });
    const res = makeRes();
    const result = await handleNapCatWebhook(req as any, res as any);
    expect(result).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "ok" });
  });

  it("ignores a group message when enableGroupMessages is false", async () => {
    setNapCatConfig({ enableInboundLogging: false, enableGroupMessages: false });

    const req = makeReq("POST", "/napcat", {
      post_type: "message",
      message_type: "group",
      group_id: 100001,
      user_id: 123456,
      raw_message: "hello group",
      message_id: "2",
      sender: {},
    });
    const res = makeRes();
    const result = await handleNapCatWebhook(req as any, res as any);
    expect(result).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "ok" });
  });

  it("returns 404 for GET /napcat/media when mediaProxyEnabled is false", async () => {
    setNapCatConfig({ enableInboundLogging: false, mediaProxyEnabled: false });
    const req = makeReq("GET", "/napcat/media?url=http://example.com/img.png");
    const res = makeRes();
    const result = await handleNapCatWebhook(req as any, res as any);
    expect(result).toBe(true);
    expect(res.statusCode).toBe(404);
  });
});
