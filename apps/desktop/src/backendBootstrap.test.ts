import { describe, expect, it } from "vitest";

import {
  createDesktopBackendBootstrapEnvelope,
  serializeDesktopBackendBootstrapEnvelope,
} from "./backendBootstrap";

describe("backendBootstrap", () => {
  it("includes observability settings only when configured", () => {
    const envelope = createDesktopBackendBootstrapEnvelope({
      port: 3773,
      t3Home: "/tmp/t3",
      authToken: "secret",
      observability: {
        otlpTracesUrl: "https://example.com/traces",
        otlpMetricsUrl: undefined,
      },
    });

    expect(envelope).toEqual({
      mode: "desktop",
      noBrowser: true,
      port: 3773,
      t3Home: "/tmp/t3",
      authToken: "secret",
      otlpTracesUrl: "https://example.com/traces",
    });
  });

  it("serializes the envelope as a single NDJSON line", () => {
    const serialized = serializeDesktopBackendBootstrapEnvelope(
      createDesktopBackendBootstrapEnvelope({
        port: 3773,
        t3Home: "/tmp/t3",
        authToken: "secret",
        observability: {
          otlpTracesUrl: undefined,
          otlpMetricsUrl: undefined,
        },
      }),
    );

    expect(serialized).toBe(
      '{"mode":"desktop","noBrowser":true,"port":3773,"t3Home":"/tmp/t3","authToken":"secret"}\n',
    );
  });
});
