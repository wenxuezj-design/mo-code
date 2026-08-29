import type { Tool } from "./types.ts";

const MAX_REDIRECTS = 10;

export const webFetchTool: Tool = {
  name: "web_fetch",
  getPermissionDescriptor: (input) => {
    const rawUrl = String(input.url ?? "");
    const parsedUrl = parseHttpUrl(rawUrl);
    return {
      permissionKind: "network",
      permissionTarget: parsedUrl?.href ?? rawUrl,
      ...(parsedUrl
        ? {
          grant: {
            scope: "persistent" as const,
            key: `web_fetch:${parsedUrl.origin}`,
            rule: `web_fetch(${parsedUrl.origin}/*)`,
            label: `不再询问 ${parsedUrl.origin}`,
          },
        }
        : {}),
    };
  },
  description: "Fetch a URL and return its content as text. For HTML pages, tags are stripped to return readable text. For JSON/text responses, content is returned directly.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch" },
      max_length: {
        type: "number",
        description: "Maximum content length in characters (default 50000)",
      },
    },
    required: ["url"],
  },
  isConcurrencySafe: () => true,
  execute(input, context) {
    return webFetch({
      url: String(input.url ?? ""),
      max_length: input.max_length === undefined ? undefined : Number(input.max_length),
    }, context.signal);
  },
};

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

export async function webFetch(
  input: { url: string; max_length?: number },
  signal?: AbortSignal,
): Promise<string> {
  const initialUrl = parseHttpUrl(input.url);
  if (!initialUrl) {
    return "Error: only http(s) URLs are supported";
  }

  const maxLength = input.max_length || 50000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const abortFromParent = () => controller.abort();
  signal?.addEventListener("abort", abortFromParent, { once: true });
  if (signal?.aborted) abortFromParent();

  try {
    let currentUrl = initialUrl;
    let response: Response;
    let redirectCount = 0;

    while (true) {
      response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "User-Agent": "mini-claude/1.0" },
      });

      if (!isRedirectResponse(response)) break;
      if (redirectCount >= MAX_REDIRECTS) {
        return `Error: too many redirects (maximum ${MAX_REDIRECTS})`;
      }

      const location = response.headers.get("location");
      if (!location) return "Error: redirect response is missing Location";

      const nextUrl = parseRedirectUrl(location, currentUrl);
      if (!nextUrl) return "Error: redirect target must use http(s)";
      if (nextUrl.origin !== initialUrl.origin) {
        return `Error: cross-origin redirect blocked (${initialUrl.origin} -> ${nextUrl.origin})`;
      }

      currentUrl = nextUrl;
      redirectCount++;
    }

    if (!response.ok) {
      return `HTTP error: ${response.status} ${response.statusText}`;
    }

    const contentType = response.headers.get("content-type") || "";
    let text = await response.text();

    if (contentType.includes("html")) {
      text = stripHtml(text);
    }

    if (text.length > maxLength) {
      text = text.slice(0, maxLength) + `\n\n[... truncated at ${maxLength} characters]`;
    }

    return text || "(empty response)";
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      return "Error: Request timed out (30s)";
    }
    return `Error fetching ${input.url}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

function isRedirectResponse(response: Response): boolean {
  return response.status === 301
    || response.status === 302
    || response.status === 303
    || response.status === 307
    || response.status === 308;
}

function parseRedirectUrl(location: string, baseUrl: URL): URL | undefined {
  try {
    return parseHttpUrl(new URL(location, baseUrl).href);
  } catch {
    return undefined;
  }
}

function stripHtml(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
