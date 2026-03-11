import { Daytona, type Image } from "@daytonaio/sdk";

export interface DaytonaSandbox {
  id: string;
  state?: string;
  snapshot?: string;
  labels?: Record<string, string>;
}

export interface DaytonaCreateSandboxOptions {
  image: string | Image;
  envVars?: Record<string, string>;
  labels?: Record<string, string>;
  autoStopInterval?: number;
}

export interface DaytonaPreviewEndpoint {
  url: string;
  token?: string;
}

export interface DaytonaClientOptions {
  apiUrl?: string;
  apiKey?: string;
  target?: string;
}

function normalizeApiUrl(input?: string): string | undefined {
  if (!input) return undefined;
  const trimmed = input.replace(/\/+$/, "");
  if (trimmed.endsWith("/api")) {
    return trimmed;
  }
  return `${trimmed}/api`;
}

export class DaytonaClient {
  private readonly daytona: Daytona;

  constructor(options: DaytonaClientOptions) {
    const apiUrl = normalizeApiUrl(options.apiUrl);
    this.daytona = new Daytona({
      _experimental: {},
      ...(apiUrl ? { apiUrl } : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.target ? { target: options.target } : {}),
    });
  }

  async createSandbox(options: DaytonaCreateSandboxOptions): Promise<DaytonaSandbox> {
    const sandbox = await this.daytona.create({
      image: options.image,
      envVars: options.envVars,
      labels: options.labels,
      ...(options.autoStopInterval !== undefined ? { autoStopInterval: options.autoStopInterval } : {}),
    });

    return {
      id: sandbox.id,
      state: sandbox.state,
      snapshot: sandbox.snapshot,
      labels: (sandbox as any).labels,
    };
  }

  async getSandbox(sandboxId: string): Promise<DaytonaSandbox> {
    const sandbox = await this.daytona.get(sandboxId);
    return {
      id: sandbox.id,
      state: sandbox.state,
      snapshot: sandbox.snapshot,
      labels: (sandbox as any).labels,
    };
  }

  async startSandbox(sandboxId: string, timeoutSeconds?: number): Promise<void> {
    const sandbox = await this.daytona.get(sandboxId);
    await sandbox.start(timeoutSeconds);
  }

  async stopSandbox(sandboxId: string, timeoutSeconds?: number): Promise<void> {
    const sandbox = await this.daytona.get(sandboxId);
    await sandbox.stop(timeoutSeconds);
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    const sandbox = await this.daytona.get(sandboxId);
    await this.daytona.delete(sandbox);
  }

  async executeCommand(sandboxId: string, command: string): Promise<{ exitCode: number; result: string }> {
    const sandbox = await this.daytona.get(sandboxId);
    const response = await sandbox.process.executeCommand(command);
    return {
      exitCode: response.exitCode,
      result: response.result,
    };
  }

  async getPreviewEndpoint(sandboxId: string, port: number): Promise<DaytonaPreviewEndpoint> {
    const sandbox = await this.daytona.get(sandboxId);
    // Use signed preview URLs for server-to-sandbox communication.
    // The standard preview link may redirect to an interactive Auth0 flow from non-browser clients.
    // Signed preview URLs work for direct HTTP access.
    //
    // Request a longer-lived URL so sessions can run for several minutes without refresh.
    const preview = await sandbox.getSignedPreviewUrl(port, 6 * 60 * 60);
    return {
      url: preview.url,
      token: preview.token,
    };
  }
}
