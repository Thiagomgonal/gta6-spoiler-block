// User settings shared by the content script, popup and service worker.
(() => {
  const defaults = Object.freeze({
    enabled: true,
    strict: true,
    telemetry: true,
    pausedSites: [],
    customTerms: [],
  });

  const TERM_MIN_LENGTH = 3;
  const TERM_MAX_LENGTH = 60;
  const TERMS_MAX = 100;

  function sanitizeTerms(terms) {
    const unique = new Set();
    for (const term of Array.isArray(terms) ? terms : []) {
      if (typeof term !== "string") continue;
      const clean = term.trim().replace(/\s+/g, " ");
      if (clean.length >= TERM_MIN_LENGTH && clean.length <= TERM_MAX_LENGTH) unique.add(clean);
      if (unique.size >= TERMS_MAX) break;
    }
    return [...unique];
  }

  function siteOf(url) {
    try {
      const { protocol, hostname } = new URL(url);
      return protocol === "http:" || protocol === "https:" ? hostname.replace(/^www\./, "") : null;
    } catch {
      return null;
    }
  }

  globalThis.GSBSettings = Object.freeze({ defaults, sanitizeTerms, siteOf });
})();
