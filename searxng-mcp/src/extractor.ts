import { Readability } from "@mozilla/readability";
import { DOMParser } from "linkedom";
import type { HTMLElement } from "linkedom";
import TurndownService from "turndown";

export interface ExtractedContent {
  markdown: string;
  isThin: boolean;
  isPaywalled: boolean;
  isBotProtected: boolean;
  isSpa: boolean;
}

const PAYWALL_PATTERNS = [
  "subscribe to read",
  "sign in to continue",
  "free articles remaining",
  "subscribe now",
  "subscription required",
  "already have access",
];

const PAYWALL_DOMAINS = ["wsj.com", "ft.com", "bloomberg.com", "reuters.com", "nytimes.com"];

const CLOUDFLARE_PATTERNS = [
  "<title>Just a moment...</title>",
  "cf-browser-verification",
  "challenge-platform",
  "cloudflare-challenge",
];

const CONSENT_PATTERNS = ["cookie", "consent", "gdpr", "privacy-banner", "cc-banner", "onetrust"];

function stripConsentBanners(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html") as unknown as Document & { documentElement: HTMLElement };

  const allElements = doc.querySelectorAll("*");
  for (const el of Array.from(allElements) as unknown as HTMLElement[]) {
    const id = (el.getAttribute("id") || "").toLowerCase();
    const cls = (el.getAttribute("class") || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    const text = (el.textContent || "").toLowerCase().slice(0, 100);

    const isConsent =
      CONSENT_PATTERNS.some((p) => id.includes(p) || cls.includes(p)) ||
      (role === "dialog" && CONSENT_PATTERNS.some((p) => text.includes(p)));

    if (isConsent && el.parentNode) {
      el.parentNode.removeChild(el);
    }
  }

  return doc.documentElement.outerHTML;
}

function isPaywalled(html: string, text: string): boolean {
  if (PAYWALL_PATTERNS.some((p) => text.toLowerCase().includes(p))) return true;
  if (text.length < 200 && text.includes("sign in")) return true;

  try {
    const hrefMatch = html.match(/href="([^"]+)"/);
    if (hrefMatch) {
      const url = new URL(hrefMatch[1]);
      const hostname = url.hostname.replace("www.", "");
      if (PAYWALL_DOMAINS.some((d) => hostname.endsWith(d))) return true;
    }
  } catch {
    // ignore
  }

  return false;
}

function isBotProtected(html: string): boolean {
  return CLOUDFLARE_PATTERNS.some((p) => html.includes(p));
}

export function extractHtml(html: string, url: string): ExtractedContent {
  const cleanHtml = stripConsentBanners(html);
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

  const doc = new DOMParser().parseFromString(cleanHtml, "text/html") as unknown as Document & { documentElement: HTMLElement };

  // Remove script, style, nav, header, footer, iframe, noscript
  for (const tag of ["script", "style", "nav", "header", "footer", "iframe", "noscript"]) {
    for (const el of Array.from(doc.querySelectorAll(tag)) as unknown as HTMLElement[]) {
      el.remove();
    }
  }

  // Extract with Readability
  const article = new Readability(doc as unknown as Document).parse();

  if (!article?.content) {
    return {
      markdown: "[Failed to extract content from page]",
      isThin: true,
      isPaywalled: false,
      isBotProtected: false,
      isSpa: false,
    };
  }

  const markdown = turndown.turndown(article.content);
  const text = article.textContent || "";
  const isThin = text.length < 200 && html.length > 50000;
  const isSpa = text.length < 100 && html.length > 50000;

  return {
    markdown: markdown.trim(),
    isThin,
    isPaywalled: isPaywalled(html, text),
    isBotProtected: isBotProtected(html),
    isSpa,
  };
}
