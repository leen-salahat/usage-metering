export interface LevelView {
  planId: string;
  planName: string;
  monthlyAllowance: number;
  maxPerRequest: number;
  consumed: number;
  remaining: number;
}

export interface ConsumeResult {
  requestId: string;
  userId: string;
  units: number;
  accepted: boolean;
  reason: string | null;
  scope: "account" | "user" | null;
  period: string;
  replayed: boolean;
  account: LevelView;
  user: LevelView;
}

export interface Plan {
  id: string;
  kind: "account" | "user";
  name: string;
  monthlyAllowance: number;
  maxPerRequest: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${status} ${code}: ${message}`);
  }
}

/** A thin wrapper over the metering service's HTTP API. It contains no business rules. */
export class MeteringClient {
  private apiKey?: string;

  constructor(private readonly baseUrl: string) {}

  setApiKey(key: string) {
    this.apiKey = key;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new ApiError(res.status, data?.error?.code ?? "UNKNOWN", data?.error?.message ?? res.statusText);
    }
    return data as T;
  }

  async waitUntilReady(attempts = 30, delayMs = 1000): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(`${this.baseUrl}/ready`);
        if (res.ok) return;
      } catch {
        // service not reachable yet
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Service at ${this.baseUrl} did not become ready`);
  }

  createAccount(name: string) {
    return this.call<{ account: { id: string; name: string }; apiKey: string }>("POST", "/v1/accounts", { name });
  }
  createPlan(plan: Omit<Plan, "id">) {
    return this.call<Plan>("POST", "/v1/plans", plan);
  }
  updatePlan(id: string, patch: Partial<Pick<Plan, "name" | "monthlyAllowance" | "maxPerRequest">>) {
    return this.call<Plan>("PATCH", `/v1/plans/${id}`, patch);
  }
  setAccountPlan(planId: string) {
    return this.call<unknown>("PUT", "/v1/account/plan", { planId });
  }
  createUser(userId: string, planId: string) {
    return this.call<unknown>("POST", "/v1/users", { userId, planId });
  }
  setUserPlan(userId: string, planId: string) {
    return this.call<unknown>("PUT", `/v1/users/${userId}/plan`, { planId });
  }
  consume(userId: string, units: number, requestId: string) {
    return this.call<ConsumeResult>("POST", "/v1/consume", { userId, units, requestId });
  }
  accountUsage() {
    return this.call<LevelView & { period: string }>("GET", "/v1/usage");
  }
  userUsage(userId: string) {
    return this.call<{ userId: string; period: string; user: LevelView; account: LevelView }>(
      "GET",
      `/v1/users/${userId}/usage`,
    );
  }
}
