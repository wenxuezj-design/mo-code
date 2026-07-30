import type { Tool } from "./types.ts";

export const webFetchTool: Tool = {
  name: "web_fetch",
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

export async function webFetch(
  input: { url: string; max_length?: number },
  signal?: AbortSignal,
): Promise<string> {
  if (!input.url.startsWith("http://") && !input.url.startsWith("https://")) {
    return "Error: only http(s) URLs are supported";
  }

  const maxLength = input.max_length || 50000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const abortFromParent = () => controller.abort();
  signal?.addEventListener("abort", abortFromParent, { once: true });
  if (signal?.aborted) abortFromParent();

  try {
    const response = await fetch(input.url, {
      signal: controller.signal,
      headers: { "User-Agent": "mini-claude/1.0" },
    });

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
