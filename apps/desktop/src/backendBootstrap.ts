export interface BackendObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

export interface DesktopBackendBootstrapEnvelope {
  readonly mode: "desktop";
  readonly noBrowser: true;
  readonly port: number;
  readonly t3Home: string;
  readonly authToken: string;
  readonly otlpTracesUrl?: string;
  readonly otlpMetricsUrl?: string;
}

export function createDesktopBackendBootstrapEnvelope(input: {
  readonly port: number;
  readonly t3Home: string;
  readonly authToken: string;
  readonly observability: BackendObservabilitySettings;
}): DesktopBackendBootstrapEnvelope {
  return {
    mode: "desktop",
    noBrowser: true,
    port: input.port,
    t3Home: input.t3Home,
    authToken: input.authToken,
    ...(input.observability.otlpTracesUrl
      ? { otlpTracesUrl: input.observability.otlpTracesUrl }
      : {}),
    ...(input.observability.otlpMetricsUrl
      ? { otlpMetricsUrl: input.observability.otlpMetricsUrl }
      : {}),
  };
}

export function serializeDesktopBackendBootstrapEnvelope(
  envelope: DesktopBackendBootstrapEnvelope,
): string {
  return `${JSON.stringify(envelope)}\n`;
}
