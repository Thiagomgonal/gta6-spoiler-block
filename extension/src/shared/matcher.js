(() => {
  const SEPARATOR = "[\\s._+\\-']*";
  const WORD_START = "(?<![a-z0-9])";
  const WORD_END = "(?![a-z0-9])";

  // Lowercase, strip accents and fold compatibility characters ("Ⅵ" -> "vi",
  // full-width letters -> ASCII) so every comparison happens on plain text.
  function normalize(text) {
    return text
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[‘’ʼ`´]/g, "'")
      .toLowerCase();
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function phraseSource(phrase) {
    const tokens = normalize(phrase).split(/[\s._+\-']+/).filter(Boolean);
    return tokens.length ? tokens.map(escapeRegExp).join(SEPARATOR) : null;
  }

  function compile(phrases, patterns = []) {
    const sources = [...patterns];
    const words = phrases.map(phraseSource).filter(Boolean);
    if (words.length) sources.push(`${WORD_START}(?:${words.join("|")})${WORD_END}`);
    return sources.length ? new RegExp(sources.join("|")) : /(?!)/;
  }

  function createMatcher({ strict = true, customTerms = [] } = {}) {
    const keywords = globalThis.GSB_KEYWORDS;
    const custom = globalThis.GSBSettings.sanitizeTerms(customTerms);

    const strong = compile([...keywords.strong, ...custom], keywords.strongPatterns);
    const context = compile(keywords.context, keywords.contextPatterns);
    const weak = compile(keywords.weak);
    const trigger = compile(
      [...keywords.strong, ...custom, ...keywords.context],
      [...keywords.strongPatterns, ...keywords.contextPatterns],
    );

    return Object.freeze({
      // Cheap test for a single text fragment: is the surrounding block worth a look?
      mayMatch: (text) => trigger.test(text),

      // Full decision for a block of (normalized) text.
      matches(text) {
        if (strong.test(text)) return true;
        if (!context.test(text)) return false;
        return strict || weak.test(text);
      },
    });
  }

  globalThis.GSBMatcher = Object.freeze({ normalize, createMatcher });
})();
