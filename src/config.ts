import fs from "node:fs";
import type {
  AppConfig,
  ProviderConfig,
  ModelEntry,
  ModelConfig,
} from "./types";

const DEFAULT_CONFIG: AppConfig = {
  providers: {
    openai: {
      baseUrl: "",
      apiKey: "",
    },
  },
  models: {
    default: {
      provider: "openai",
      modelId: "gpt-4o",
      maxTokens: 8096,
    },
  },
  activeModel: "default",
  channels: {
    cli: { ephemeral: true },
    telegram: { ephemeral: false },
    websocket: { ephemeral: false },
    background: { ephemeral: true },
  },
  agents: {},
  defaults: {
    maxTokens: 8096,
    toolConcurrency: 10,
    maxLoopIterations: 500,
    heartbeatIntervalSeconds: 1800,
    gatewayPort: 8765,
    streamBuffer: {
      enabled: true,
      flushIntervalMs: 100,
      flushOnNewline: true,
    },
  },
};

function isOldFormat(raw: any): boolean {
  if (!raw.models) return false;
  const values = Object.values(raw.models);
  if (values.length === 0) return false;
  return typeof values[0] === "string";
}

function migrateOldConfig(raw: any): AppConfig {
  const providers: Record<string, ProviderConfig> = {
    openai: {
      baseUrl: process.env.OPENAI_BASE_URL || "",
      apiKey: process.env.OPENAI_API_KEY || "",
    },
  };

  const models: Record<string, ModelEntry> = {};
  for (const [key, value] of Object.entries(raw.models || {})) {
    const str = String(value);
    if (str.includes("://") && str.includes("@")) {
      const atIndex = str.lastIndexOf("@");
      const baseUrl = str.substring(0, atIndex);
      const modelId = str.substring(atIndex + 1);
      const providerKey = `migrated_${key}`;
      providers[providerKey] = { baseUrl, apiKey: "" };
      models[key] = { provider: providerKey, modelId };
    } else {
      models[key] = { provider: "openai", modelId: str };
    }
  }

  return {
    providers,
    models,
    activeModel: raw.activeModel || "default",
    channels: DEFAULT_CONFIG.channels,
    agents: DEFAULT_CONFIG.agents,
    defaults: DEFAULT_CONFIG.defaults,
  };
}

export function loadConfig(configPath: string): AppConfig {
  if (!fs.existsSync(configPath)) {
    saveConfig(configPath, DEFAULT_CONFIG);
    return structuredClone(DEFAULT_CONFIG);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    if (isOldFormat(raw)) {
      const migrated = migrateOldConfig(raw);
      saveConfig(configPath, migrated);
      console.log("[Config] Migrated config.json to new format.");
      return migrated;
    }

    return {
      providers: raw.providers || DEFAULT_CONFIG.providers,
      models: raw.models || DEFAULT_CONFIG.models,
      activeModel: raw.activeModel || DEFAULT_CONFIG.activeModel,
      channels: { ...DEFAULT_CONFIG.channels, ...(raw.channels || {}) },
      agents: raw.agents || DEFAULT_CONFIG.agents,
      defaults: {
        ...DEFAULT_CONFIG.defaults,
        ...(raw.defaults || {}),
        streamBuffer: {
          ...DEFAULT_CONFIG.defaults.streamBuffer,
          ...((raw.defaults || {}).streamBuffer || {}),
        },
      },
    };
  } catch (err: any) {
    console.error(
      `[Config] Failed to parse config.json: ${err.message}. Using defaults.`
    );
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(configPath: string, config: AppConfig): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export function resolveModelConfig(
  config: AppConfig,
  modelKey?: string
): ModelConfig {
  const key = modelKey || config.activeModel;
  const modelEntry = config.models[key];
  if (!modelEntry) throw new Error(`Model key '${key}' not found in config.`);

  const provider = config.providers[modelEntry.provider];
  if (!provider)
    throw new Error(`Provider '${modelEntry.provider}' not found in config.`);

  // Resolve apiKey: provider config → provider env → global env
  let apiKey = provider.apiKey || "";
  if (!apiKey) {
    const envKey = `${modelEntry.provider
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
    apiKey = process.env[envKey] || process.env.OPENAI_API_KEY || "";
  }

  // Resolve baseUrl: provider config → provider env → global env
  let baseUrl = provider.baseUrl || "";
  if (!baseUrl) {
    const envBase = `${modelEntry.provider
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "_")}_BASE_URL`;
    baseUrl = process.env[envBase] || process.env.OPENAI_BASE_URL || "";
  }

  return {
    modelId: modelEntry.modelId,
    baseUrl: baseUrl || undefined,
    apiKey: apiKey || undefined,
    maxTokens: modelEntry.maxTokens || config.defaults.maxTokens,
  };
}

export function getDefaultConfig(): AppConfig {
  return structuredClone(DEFAULT_CONFIG);
}
