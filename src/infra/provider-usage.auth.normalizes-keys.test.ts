import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles.js";
import { NON_ENV_SECRETREF_MARKER } from "../agents/model-auth-markers.js";

const resolveProviderUsageAuthWithPluginMock = vi.fn(async (..._args: unknown[]) => null);

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderUsageAuthWithPlugin: resolveProviderUsageAuthWithPluginMock,
}));

vi.mock("../agents/cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readQwenCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
}));

let resolveProviderAuths: typeof import("./provider-usage.auth.js").resolveProviderAuths;
type ProviderAuth = import("./provider-usage.auth.js").ProviderAuth;
type AuthProfileStore = import("../agents/auth-profiles.js").AuthProfileStore;
type OpenClawConfig = Parameters<typeof resolveProviderAuths>[0]["config"];

function normalizeProviderForTest(provider: string) {
  const normalized = provider.trim().toLowerCase();
  return normalized === "z-ai" || normalized === "z.ai" ? "zai" : normalized;
}

describe("resolveProviderAuths key normalization", () => {
  let suiteRoot = "";
  let suiteCase = 0;
  const EMPTY_PROVIDER_ENV = {
    ZAI_API_KEY: undefined,
    Z_AI_API_KEY: undefined,
    MINIMAX_API_KEY: undefined,
    MINIMAX_CODE_PLAN_KEY: undefined,
    XIAOMI_API_KEY: undefined,
  } satisfies Record<string, string | undefined>;

  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-provider-auth-suite-"));
    ({ resolveProviderAuths } = await import("./provider-usage.auth.js"));
  });

  afterAll(async () => {
    await fs.rm(suiteRoot, { recursive: true, force: true });
    suiteRoot = "";
    suiteCase = 0;
  });

  beforeEach(() => {
    resolveProviderUsageAuthWithPluginMock.mockReset();
    resolveProviderUsageAuthWithPluginMock.mockResolvedValue(null);
  });

  async function withSuiteHome<T>(
    fn: (home: string, env: NodeJS.ProcessEnv) => Promise<T>,
    env: Record<string, string | undefined>,
  ): Promise<T> {
    const base = path.join(suiteRoot, `case-${++suiteCase}`);
    await fs.mkdir(base, { recursive: true });
    await fs.mkdir(path.join(base, ".openclaw", "agents", "main", "sessions"), { recursive: true });

    const keysToRestore = new Set<string>([
      "HOME",
      "USERPROFILE",
      "HOMEDRIVE",
      "HOMEPATH",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
    ]);
    const snapshot: Record<string, string | undefined> = {};
    for (const key of keysToRestore) {
      snapshot[key] = process.env[key];
    }

    process.env.HOME = base;
    process.env.USERPROFILE = base;
    if (process.platform === "win32") {
      const match = base.match(/^([A-Za-z]:)(.*)$/);
      if (match) {
        process.env.HOMEDRIVE = match[1];
        process.env.HOMEPATH = match[2] || "\\";
      }
    }
    delete process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_STATE_DIR = path.join(base, ".openclaw");
    const runtimeEnv: NodeJS.ProcessEnv = {
      ...process.env,
    };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete runtimeEnv[key];
      } else {
        runtimeEnv[key] = value;
      }
    }
    replaceRuntimeAuthProfileStoreSnapshots([{ store: { version: 1, profiles: {} } }]);
    try {
      return await fn(base, runtimeEnv);
    } finally {
      clearRuntimeAuthProfileStoreSnapshots();
      for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  async function writeAuthProfiles(home: string, profiles: AuthProfileStore["profiles"]) {
    const agentDir = path.join(home, ".openclaw", "agents", "main", "agent");
    const store = { version: 1, profiles } satisfies AuthProfileStore;
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      `${JSON.stringify(store, null, 2)}\n`,
      "utf8",
    );
    replaceRuntimeAuthProfileStoreSnapshots([{ store }]);
  }

  async function writeConfig(home: string, config: Record<string, unknown>) {
    const stateDir = path.join(home, ".openclaw");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      `${JSON.stringify(config, null, 2)}\n`,
      "utf8",
    );
  }

  async function loadConfigForSuiteHome(home: string): Promise<OpenClawConfig> {
    try {
      return JSON.parse(
        await fs.readFile(path.join(home, ".openclaw", "openclaw.json"), "utf8"),
      ) as OpenClawConfig;
    } catch {
      return {} as OpenClawConfig;
    }
  }

  async function writeProfileOrder(home: string, provider: string, profileIds: string[]) {
    const agentDir = path.join(home, ".openclaw", "agents", "main", "agent");
    const parsed = JSON.parse(
      await fs.readFile(path.join(agentDir, "auth-profiles.json"), "utf8"),
    ) as Record<string, unknown>;
    const order = (parsed.order && typeof parsed.order === "object" ? parsed.order : {}) as Record<
      string,
      unknown
    >;
    order[provider] = profileIds;
    parsed.order = order;
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      `${JSON.stringify(parsed, null, 2)}\n`,
    );
    replaceRuntimeAuthProfileStoreSnapshots([{ store: parsed as AuthProfileStore }]);
  }

  async function writeLegacyPiAuth(home: string, raw: string) {
    const legacyDir = path.join(home, ".pi", "agent");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, "auth.json"), raw, "utf8");
  }

  function createTestModelDefinition() {
    return {
      id: "test-model",
      name: "Test Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1024,
      maxTokens: 256,
    };
  }

  async function resolveMinimaxAuthFromConfiguredKey(apiKey: string) {
    return await withSuiteHome(
      async (home, env) => {
        await writeConfig(home, {
          models: {
            providers: {
              minimax: {
                baseUrl: "https://api.minimaxi.com",
                models: [createTestModelDefinition()],
                apiKey,
              },
            },
          },
        });
        const config = await loadConfigForSuiteHome(home);

        return await resolveProviderAuths({
          providers: ["minimax"],
          config,
          env,
        });
      },
      {
        ...EMPTY_PROVIDER_ENV,
      },
    );
  }

  async function resolveProviderAuthsWithIsolatedStore(params: {
    providers: Parameters<typeof resolveProviderAuths>[0]["providers"];
    env?: NodeJS.ProcessEnv;
    config?: OpenClawConfig;
    store?: AuthProfileStore;
    order?: Record<string, string[]>;
  }) {
    const store = params.store ?? { version: 1, profiles: {} };
    const listProfilesForProvider = (provider: string) =>
      Object.entries(store.profiles)
        .filter(([, credential]) => {
          const providerId =
            credential && typeof credential === "object" && "provider" in credential
              ? credential.provider
              : undefined;
          return (
            typeof providerId === "string" &&
            normalizeProviderForTest(providerId) === normalizeProviderForTest(provider)
          );
        })
        .map(([profileId]) => profileId);
    vi.resetModules();
    vi.doMock("../plugins/provider-runtime.js", () => ({
      resolveProviderUsageAuthWithPlugin: async () => null,
    }));
    vi.doMock("../agents/auth-profiles.js", () => ({
      dedupeProfileIds: (profileIds: string[]) => [...new Set(profileIds)],
      ensureAuthProfileStore: () => store,
      listProfilesForProvider: (_store: AuthProfileStore, provider: string) =>
        listProfilesForProvider(provider),
      resolveApiKeyForProfile: async ({ profileId }: { profileId: string }) => {
        const credential = store.profiles[profileId];
        if (!credential || typeof credential !== "object" || !("type" in credential)) {
          return null;
        }
        if (
          credential.type === "oauth" &&
          "access" in credential &&
          typeof credential.access === "string"
        ) {
          return { apiKey: credential.access };
        }
        if (
          credential.type === "api_key" &&
          "key" in credential &&
          typeof credential.key === "string"
        ) {
          return { apiKey: credential.key };
        }
        if (
          credential.type === "token" &&
          "token" in credential &&
          typeof credential.token === "string"
        ) {
          return { apiKey: credential.token };
        }
        return null;
      },
      resolveAuthProfileOrder: ({ provider }: { provider: string }) =>
        params.order?.[provider] ?? listProfilesForProvider(provider),
    }));
    vi.doMock("../config/config.js", () => ({
      loadConfig: () => params.config ?? {},
    }));
    try {
      const { resolveProviderAuths: isolatedResolveProviderAuths } =
        await import("./provider-usage.auth.js");
      return await isolatedResolveProviderAuths({
        providers: params.providers,
        config: params.config ?? ({} as OpenClawConfig),
        env: params.env,
      });
    } finally {
      vi.doUnmock("../plugins/provider-runtime.js");
      vi.doUnmock("../agents/auth-profiles.js");
      vi.doUnmock("../config/config.js");
      vi.resetModules();
    }
  }

  async function expectResolvedAuthsFromSuiteHome(params: {
    providers: Parameters<typeof resolveProviderAuths>[0]["providers"];
    expected: Awaited<ReturnType<typeof resolveProviderAuths>>;
    env?: Record<string, string | undefined>;
    setup?: (home: string) => Promise<void>;
  }) {
    await withSuiteHome(
      async (home, env) => {
        await params.setup?.(home);
        const config = await loadConfigForSuiteHome(home);
        const auths = await resolveProviderAuths({
          providers: params.providers,
          config,
          env,
        });
        expect(auths).toEqual(params.expected);
      },
      {
        ...EMPTY_PROVIDER_ENV,
        ...params.env,
      },
    );
  }

  it.each([
    {
      name: "strips embedded CR/LF from env keys",
      providers: ["zai", "minimax", "xiaomi"] as const,
      env: {
        ZAI_API_KEY: "zai-\r\nkey",
        MINIMAX_API_KEY: "minimax-\r\nkey",
        XIAOMI_API_KEY: "xiaomi-\r\nkey",
      },
      expected: [
        { provider: "zai", token: "zai-key" },
        { provider: "minimax", token: "minimax-key" },
        { provider: "xiaomi", token: "xiaomi-key" },
      ],
    },
    {
      name: "accepts z-ai env alias and normalizes embedded CR/LF",
      providers: ["zai"] as const,
      env: {
        Z_AI_API_KEY: "zai-\r\nkey",
      },
      expected: [{ provider: "zai", token: "zai-key" }],
    },
    {
      name: "prefers ZAI_API_KEY over the z-ai alias when both are set",
      providers: ["zai"] as const,
      env: {
        ZAI_API_KEY: "direct-zai-key",
        Z_AI_API_KEY: "alias-zai-key",
      },
      expected: [{ provider: "zai", token: "direct-zai-key" }],
    },
    {
      name: "prefers MINIMAX_CODE_PLAN_KEY over MINIMAX_API_KEY",
      providers: ["minimax"] as const,
      env: {
        MINIMAX_CODE_PLAN_KEY: "code-plan-key",
        MINIMAX_API_KEY: "api-key",
      },
      expected: [{ provider: "minimax", token: "code-plan-key" }],
    },
  ] satisfies Array<{
    name: string;
    providers: readonly Parameters<typeof resolveProviderAuths>[0]["providers"][number][];
    env: Record<string, string | undefined>;
    expected: ProviderAuth[];
  }>)("$name", async ({ providers, env, expected }) => {
    const auths = await resolveProviderAuthsWithIsolatedStore({
      providers: [...providers],
      env,
    });
    expect(auths).toEqual(expected);
  });

  it("strips embedded CR/LF from stored auth profiles (token + api_key)", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["minimax", "xiaomi"],
      setup: async (home) => {
        await writeAuthProfiles(home, {
          "minimax:default": { type: "token", provider: "minimax", token: "mini-\r\nmax" },
          "xiaomi:default": { type: "api_key", provider: "xiaomi", key: "xiao-\r\nmi" },
        });
      },
      expected: [
        { provider: "minimax", token: "mini-max" },
        { provider: "xiaomi", token: "xiao-mi" },
      ],
    });
  });

  it("returns injected auth values unchanged", async () => {
    const auths = await resolveProviderAuths({
      providers: ["anthropic"],
      auth: [{ provider: "anthropic", token: "token-1", accountId: "acc-1" }],
    });
    expect(auths).toEqual([{ provider: "anthropic", token: "token-1", accountId: "acc-1" }]);
  });

  it("falls back to legacy .pi auth file for zai keys even after os.homedir() is primed", async () => {
    // Prime os.homedir() to simulate long-lived workers that may have touched it before HOME changes.
    os.homedir();
    await withSuiteHome(
      async (home, env) => {
        await writeLegacyPiAuth(
          home,
          `${JSON.stringify({ "z-ai": { access: "legacy-zai-key" } }, null, 2)}\n`,
        );
        const auths = await resolveProviderAuthsWithIsolatedStore({
          providers: ["zai"],
          env,
        });
        expect(auths).toEqual([{ provider: "zai", token: "legacy-zai-key" }]);
      },
      {
        ...EMPTY_PROVIDER_ENV,
      },
    );
  });

  it.each([
    {
      name: "extracts google oauth token from JSON payload in token profiles",
      token: '{"token":"google-oauth-token"}',
      expectedToken: "google-oauth-token",
    },
    {
      name: "keeps raw google token when token payload is not JSON",
      token: "plain-google-token",
      expectedToken: "plain-google-token",
    },
  ])("$name", async ({ token, expectedToken }) => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["google-gemini-cli"],
      setup: async (home) => {
        await writeAuthProfiles(home, {
          "google-gemini-cli:default": {
            type: "token",
            provider: "google-gemini-cli",
            token,
          },
        });
      },
      expected: [{ provider: "google-gemini-cli", token: expectedToken }],
    });
  });

  it("uses config api keys when env and profiles are missing", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai", "minimax", "xiaomi"],
      setup: async (home) => {
        const modelDef = {
          id: "test-model",
          name: "Test Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1024,
          maxTokens: 256,
        };
        await writeConfig(home, {
          models: {
            providers: {
              zai: {
                baseUrl: "https://api.z.ai",
                models: [modelDef],
                apiKey: "cfg-zai-key", // pragma: allowlist secret
              },
              minimax: {
                baseUrl: "https://api.minimaxi.com",
                models: [modelDef],
                apiKey: "cfg-minimax-key", // pragma: allowlist secret
              },
              xiaomi: {
                baseUrl: "https://api.xiaomi.example",
                models: [modelDef],
                apiKey: "cfg-xiaomi-key", // pragma: allowlist secret
              },
            },
          },
        });
      },
      expected: [
        { provider: "zai", token: "cfg-zai-key" },
        { provider: "minimax", token: "cfg-minimax-key" },
        { provider: "xiaomi", token: "cfg-xiaomi-key" },
      ],
    });
  });

  it("returns no auth when providers have no configured credentials", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai", "minimax", "xiaomi"],
      expected: [],
    });
  });

  it("uses zai api_key auth profiles when env and config are missing", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai"],
      setup: async (home) => {
        await writeAuthProfiles(home, {
          "zai:default": { type: "api_key", provider: "zai", key: "profile-zai-key" },
        });
      },
      expected: [{ provider: "zai", token: "profile-zai-key" }],
    });
  });

  it("ignores invalid legacy z-ai auth files", async () => {
    await expectResolvedAuthsFromSuiteHome({
      providers: ["zai"],
      setup: async (home) => {
        await writeLegacyPiAuth(home, "{not-json");
      },
      expected: [],
    });
  });

  it("discovers oauth provider from config but skips mismatched profile providers", async () => {
    await withSuiteHome(async (home, env) => {
      await writeConfig(home, {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "token" },
          },
        },
      });
      await writeAuthProfiles(home, {
        "anthropic:default": {
          type: "token",
          provider: "zai",
          token: "mismatched-provider-token",
        },
      });
      const config = await loadConfigForSuiteHome(home);

      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
        config,
        env,
      });
      expect(auths).toEqual([]);
    }, {});
  });

  it("skips providers without oauth-compatible profiles", async () => {
    await withSuiteHome(async (home, env) => {
      const config = await loadConfigForSuiteHome(home);
      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
        config,
        env,
      });
      expect(auths).toEqual([]);
    }, {});
  });

  it("skips oauth profiles that resolve without an api key and uses later profiles", async () => {
    await withSuiteHome(async (home, env) => {
      await writeAuthProfiles(home, {
        "anthropic:empty": {
          type: "token",
          provider: "anthropic",
          token: "expired-token",
          expires: Date.now() - 60_000,
        },
        "anthropic:valid": { type: "token", provider: "anthropic", token: "anthropic-token" },
      });
      await writeProfileOrder(home, "anthropic", ["anthropic:empty", "anthropic:valid"]);
      const config = await loadConfigForSuiteHome(home);

      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
        config,
        env,
      });
      expect(auths).toEqual([{ provider: "anthropic", token: "anthropic-token" }]);
    }, {});
  });

  it("skips api_key entries in oauth token resolution order", async () => {
    await withSuiteHome(async (home, env) => {
      await writeAuthProfiles(home, {
        "anthropic:api": { type: "api_key", provider: "anthropic", key: "api-key-1" },
        "anthropic:token": { type: "token", provider: "anthropic", token: "token-1" },
      });
      await writeProfileOrder(home, "anthropic", ["anthropic:api", "anthropic:token"]);
      const config = await loadConfigForSuiteHome(home);

      const auths = await resolveProviderAuths({
        providers: ["anthropic"],
        config,
        env,
      });
      expect(auths).toEqual([{ provider: "anthropic", token: "token-1" }]);
    }, {});
  });

  it("ignores marker-backed config keys for provider usage auth resolution", async () => {
    const auths = await resolveMinimaxAuthFromConfiguredKey(NON_ENV_SECRETREF_MARKER);
    expect(auths).toEqual([]);
  });

  it("keeps all-caps plaintext config keys eligible for provider usage auth resolution", async () => {
    const auths = await resolveMinimaxAuthFromConfiguredKey("ALLCAPS_SAMPLE");
    expect(auths).toEqual([{ provider: "minimax", token: "ALLCAPS_SAMPLE" }]);
  });
});
