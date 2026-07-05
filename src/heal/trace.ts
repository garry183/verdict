// ─────────────────────────────────────────────────────────────────────────────
// Read the live page URL out of a Playwright trace.zip.
//
// The JSON report does NOT carry the page URL, but the heal explorer needs it to
// know where to re-discover the locator. We deliberately read ONLY plain string
// fields (frameUrl / goto url) from the .trace NDJSON stream — never the serialized
// DOM snapshot tree. Those plain fields are stable across Playwright releases; the
// snapshot encoding is internal and fragile. (See HANDOFF: robust > clever.)
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';

export interface TraceContext {
  url: string | null;
}

// A trace event is loosely typed — we only touch a few known-stable fields.
interface TraceEvent {
  type?: string;
  apiName?: string;
  params?: { url?: string };
  snapshot?: { frameUrl?: string; isMainFrame?: boolean };
}

/** Extract the main-frame page URL from a trace.zip. Returns null if unreadable. */
export function extractTraceContext(tracePath: string): TraceContext {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(readFileSync(tracePath));
  } catch {
    return { url: null };
  }

  // The DOM/action stream lives in *.trace files (there can be several).
  const traceFiles = Object.keys(entries).filter(n => n.endsWith('.trace'));

  // A trace opens on about:blank before the first navigation; treat that (and empty)
  // as "no URL" so we don't heal against a blank page. Take the LAST meaningful URL —
  // where the page ended up is where the failing locator lived.
  const isBlank = (u: string | undefined): boolean => !u || /^about:blank$/i.test(u);

  let mainFrameUrl: string | null = null;
  let gotoUrl: string | null = null;
  let anyFrameUrl: string | null = null;

  for (const name of traceFiles) {
    const text = strFromU8(entries[name]);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev: TraceEvent;
      try { ev = JSON.parse(line) as TraceEvent; } catch { continue; }

      const url = ev.snapshot?.frameUrl;
      if (!isBlank(url)) {
        if (ev.snapshot?.isMainFrame) mainFrameUrl = url!; // last main-frame wins
        anyFrameUrl = url!;
      }

      // page.goto / navigation actions carry the target URL directly (last wins).
      if (!isBlank(ev.params?.url) && /goto|navigat/i.test(ev.apiName ?? '')) {
        gotoUrl = ev.params!.url!;
      }
    }
  }

  return { url: mainFrameUrl ?? gotoUrl ?? anyFrameUrl };
}
