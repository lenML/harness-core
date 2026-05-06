import type {
  CoreContext,
  AgentPlugin,
  ToolDef,
  ContentConverter,
} from "../../../types";
import { html2mdConverter } from "./html2md.converter";
import fetch from "node-fetch";
import { ProxyAgent } from "proxy-agent";
import { jsonConverter } from "./json.converter";
import { browser_like } from "./browser-like";

class WebFetchService {
  private converters = new Map<string, ContentConverter>();

  init() {
    this.initConverters();
    return this;
  }

  private initConverters() {
    const converters = [
      ["text/html", html2mdConverter],
      ["application/json", jsonConverter],
    ] as const;
    for (const [contentType, converter] of converters) {
      this.registerConverter(contentType, converter);
    }
  }

  registerConverter(contentType: string, converter: ContentConverter): void {
    this.converters.set(contentType, converter);
  }

  removeConverter(contentType: string): void {
    this.converters.delete(contentType);
  }

  async fetch(url: string, timeout = 30000): Promise<string> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | null = setTimeout(() => controller.abort(), timeout);

    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          ...browser_like.headers,
        },
        agent: new ProxyAgent(),
      });

      // 请求成功，清除超时定时器
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      if (!resp.ok) {
        return `Error: HTTP ${resp.status} ${resp.statusText}`;
      }

      const contentType = resp.headers.get("content-type") || "text/plain";
      const text = await resp.text();

      // Try matching converters
      for (const [type, converter] of this.converters) {
        if (contentType.includes(type)) {
          try {
            return await converter(text, contentType, url);
          } catch (convErr: any) {
            return `Error converting content (${contentType}): ${convErr.message}`;
          }
        }
      }

      // Default: return as-is with truncation
      if (text.length > 50000) {
        return text.slice(0, 50000) + "\n... [truncated]";
      }
      return text;
    } catch (err: any) {
      if (err.name === "AbortError") {
        return `Error: Request timed out after ${timeout}ms`;
      }
      return `Error: ${err.message}`;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export class WebFetchPlugin implements AgentPlugin {
  name = "webfetch";
  async install(ctx: CoreContext) {
    const service = new WebFetchService().init();
    ctx.provide("webFetch", service);

    ctx.registerTool({
      definition: {
        type: "function",
        function: {
          name: "web_fetch",
          description:
            "Fetch content from a URL. Supports HTML, JSON, plain text. HTML is automatically converted to clean markdown.",
          parameters: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "The URL to fetch",
              },
              timeout: {
                type: "number",
                description: "Request timeout in seconds (default 30)",
              },
            },
            required: ["url"],
          },
        },
      },
      handler: async (args) => {
        if (!args.url) return "Error: url is required";
        const timeout = (args.timeout || 30) * 1000;
        return service.fetch(args.url, timeout);
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      interruptible: true, // Web fetches can be safely interrupted
    } as ToolDef);
  }
}
