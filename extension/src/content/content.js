(() => {
  if (globalThis.__gsbContentLoaded) return;
  globalThis.__gsbContentLoaded = true;

  const { normalize, createMatcher } = globalThis.GSBMatcher;
  const { defaults: DEFAULTS, siteOf } = globalThis.GSBSettings;

  // Post/card elements on popular sites. Hiding one of them hides the whole
  // post: text, thumbnail and video together.
  const SITE_CARDS = [
    // X
    'article[data-testid="tweet"]',
    '[data-testid="trend"]',
    // YouTube
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-reel-item-renderer",
    "ytd-playlist-renderer",
    "ytd-playlist-panel-video-renderer",
    "ytd-radio-renderer",
    "ytd-comment-thread-renderer",
    "ytd-comment-view-model",
    "ytd-post-renderer",
    "ytd-backstage-post-thread-renderer",
    "ytd-notification-renderer",
    "ytd-watch-metadata",
    "yt-lockup-view-model",
    "ytm-shorts-lockup-view-model",
    "ytm-shorts-lockup-view-model-v2",
    // Reddit
    "shreddit-post",
    "shreddit-comment",
    ".thing",
    // Facebook, Threads
    '[data-pagelet^="FeedUnit"]',
    "div[data-pressable-container]",
    // Bluesky
    '[data-testid^="feedItem-"]',
    '[data-testid^="postThreadItem-"]',
    // Discord, Twitch
    'li[id^="chat-messages-"]',
    ".chat-line__message",
    // LinkedIn
    ".feed-shared-update-v2",
    // TikTok
    '[data-e2e="recommend-list-item-container"]',
    // Google Search
    "div.g",
    "div.MjjYud",
    "g-inner-card",
  ].join(",");

  const GENERIC_CARDS = "article, [role='article'], li, [role='listitem'], [role='row'], figure";
  const IGNORED = "head, script, style, noscript, template, textarea, select, svg, math, gsb-overlay, gsb-shield";
  const SKIP_TEXT_PARENTS = new Set(["script", "style", "noscript", "template", "textarea", "title", "option"]);
  const LABELLED = "img, a[title], a[aria-label], [role='img'][aria-label], video[title], iframe[title]";
  const MEDIA = "img, picture, video, canvas, iframe, [style*='background-image']";
  const REPLACED = "img, picture, video, audio, canvas, iframe, embed, object, input, br, hr, source";

  const MAX_SITE_CARD_TEXT = 20000;
  const MAX_CARD_TEXT = 3000;
  const MAX_MEDIA_TEXT = 1500;
  const STABLE_PREFIX_LENGTH = 80;
  const REPORT_DELAY_MS = 1000;

  const OBSERVER_OPTIONS = {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["alt", "title", "aria-label"],
  };

  const host = topSite();
  const t = (key) => chrome.i18n.getMessage(key) || key;

  // Start with the defaults so nothing slips through while storage loads.
  let settings = { ...DEFAULTS };
  let matcher = createMatcher(settings);
  let active = true;
  let appliedKey = stateKey(active);
  let revealedHref = null;
  let lastHref = location.href;
  let lastTitle = null;
  let shield = null;
  let shieldCountedHref = null;
  let pendingDelta = 0;
  let reportTimer = 0;

  const candidates = new Set();
  const rechecks = new Set();
  const counted = new WeakSet();
  const revealedPrefix = new WeakMap();

  // ---------------------------------------------------------------------------
  // Settings

  function topSite() {
    const ancestors = location.ancestorOrigins;
    const origin = ancestors && ancestors.length ? ancestors[ancestors.length - 1] : location.href;
    return siteOf(origin) ?? siteOf(location.href) ?? "";
  }

  function isPausedSite() {
    const sites = Array.isArray(settings.pausedSites) ? settings.pausedSites : [];
    return sites.some((site) => host === site || host.endsWith(`.${site}`));
  }

  function computeActive() {
    return Boolean(settings.enabled) && !isPausedSite() && revealedHref !== location.href;
  }

  function stateKey(isActive) {
    return JSON.stringify([isActive, Boolean(settings.strict), settings.customTerms ?? []]);
  }

  function refresh() {
    const nextActive = computeActive();
    const key = stateKey(nextActive);
    if (key === appliedKey) return;
    appliedKey = key;

    resetPage();
    matcher = createMatcher(settings);
    active = nextActive;
    if (active && document.body) {
      scanNode(document.body);
      processQueue();
    }
    lastTitle = null;
    checkPageTitle();
    reportSoon();
  }

  function resetPage() {
    for (const container of document.querySelectorAll("[data-gsb]")) clear(container);
    removeShield();
    candidates.clear();
    rechecks.clear();
  }

  // ---------------------------------------------------------------------------
  // Scanning

  function isOwnNode(node) {
    return node.localName === "gsb-overlay" || node.localName === "gsb-shield";
  }

  function scanNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return scanText(node);
    if (node.nodeType !== Node.ELEMENT_NODE || isOwnNode(node)) return;

    scanLabels(node);
    for (const element of node.querySelectorAll(LABELLED)) scanLabels(element);

    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) scanText(text);
  }

  function scanText(node) {
    const parent = node.parentElement;
    if (!parent || SKIP_TEXT_PARENTS.has(parent.localName)) return;
    const value = node.nodeValue;
    if (value.length >= 2 && matcher.mayMatch(normalize(value))) candidates.add(parent);
  }

  function scanLabels(element) {
    if (element.matches?.(LABELLED) && matcher.mayMatch(normalize(labelOf(element)))) {
      candidates.add(element);
    }
  }

  function labelOf(element) {
    const parts = [element.getAttribute("alt"), element.getAttribute("title"), element.getAttribute("aria-label")];
    if (element.localName === "img") parts.push(fileNameOf(element));
    return parts.filter(Boolean).join(" ");
  }

  // "gta-6-lucia-trailer.jpg" -> "gta 6 lucia trailer jpg"
  function fileNameOf(image) {
    const src = image.getAttribute("src");
    if (!src || src.startsWith("data:")) return "";
    try {
      const path = new URL(src, location.href).pathname;
      return decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)).replace(/[-_.+]/g, " ");
    } catch {
      return "";
    }
  }

  // Joins text nodes with spaces: textContent would glue "<div>novo</div><div>Leonida</div>"
  // into "novoLeonida" and break word boundaries.
  function readText(container) {
    const parts = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!SKIP_TEXT_PARENTS.has(node.parentElement?.localName)) parts.push(node.nodeValue);
    }
    for (const element of container.querySelectorAll(LABELLED)) parts.push(labelOf(element));
    return normalize(parts.join(" "));
  }

  function stablePrefix(text) {
    return text.replace(/[\s\d]+/g, "").slice(0, STABLE_PREFIX_LENGTH);
  }

  function processQueue() {
    if (candidates.size) {
      const seen = new Set();
      for (const element of candidates) {
        if (!element.isConnected || isIgnored(element) || element.closest("[data-gsb]")) continue;
        const container = findContainer(element);
        if (!container || seen.has(container)) continue;
        seen.add(container);
        if (canHide(container) && matcher.matches(readText(container))) hide(container);
      }
      candidates.clear();
    }

    if (rechecks.size) {
      for (const container of rechecks) recheck(container);
      rechecks.clear();
    }
  }

  // Sites recycle DOM nodes (YouTube, X), so a processed container may now
  // show something else.
  function recheck(container) {
    if (!container.isConnected) return;
    const state = container.getAttribute("data-gsb");
    const text = readText(container);
    if (state === "hidden") {
      if (!matcher.matches(text)) clear(container);
    } else if (state === "revealed" && stablePrefix(text) !== revealedPrefix.get(container)) {
      clear(container);
      if (matcher.matches(text)) hide(container);
    }
  }

  function queueRecheck(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    const container = element?.closest("[data-gsb]");
    if (container) rechecks.add(container);
  }

  // ---------------------------------------------------------------------------
  // Choosing what to hide

  function isIgnored(element) {
    return element.closest(IGNORED) !== null || element.isContentEditable;
  }

  function isBox(element) {
    const { display } = getComputedStyle(element);
    return display !== "inline" && display !== "contents";
  }

  function nearestBox(element) {
    let node = element;
    while (node.parentElement && (node.matches(REPLACED) || !isBox(node))) node = node.parentElement;
    return node;
  }

  // Prefer the whole post/card around the match so its image goes with it:
  // a known site card, then a generic card (article, list item...), then the
  // closest small block that also contains media, then the text block itself.
  function findContainer(start) {
    const siteCard = start.closest(SITE_CARDS);
    if (siteCard && siteCard.textContent.length <= MAX_SITE_CARD_TEXT) return siteCard;

    const box = nearestBox(start);
    const mediaLimit = Math.min(MAX_MEDIA_TEXT, Math.max(400, box.textContent.length * 4));
    let best = box;
    let foundMedia = false;

    for (let node = box, depth = 0; node && depth < 10; node = node.parentElement, depth++) {
      if (node === document.body || node === document.documentElement) break;
      const length = node.textContent.length;
      if (length > MAX_CARD_TEXT) break;
      if (node.matches(GENERIC_CARDS)) return node;
      if (!foundMedia && length <= mediaLimit && node.querySelector(MEDIA)) {
        best = node;
        foundMedia = true;
      }
    }
    return best;
  }

  function canHide(container) {
    if (container === document.body || container === document.documentElement) return false;
    if (container.closest("[data-gsb]") || isIgnored(container)) return false;
    if (container.textContent.length > MAX_SITE_CARD_TEXT) return false;
    // Never cover a box the user is typing in.
    const focused = document.activeElement;
    return !(focused && container.contains(focused) && (focused.isContentEditable || focused.matches("input, textarea")));
  }

  // ---------------------------------------------------------------------------
  // Hiding and revealing

  function hide(container) {
    for (const inner of container.querySelectorAll("[data-gsb]")) clear(inner);

    if (getComputedStyle(container).position === "static") container.setAttribute("data-gsb-static", "");
    for (const child of container.children) {
      if (!child.inert) {
        child.inert = true;
        child.setAttribute("data-gsb-inert", "");
      }
    }
    for (const media of container.querySelectorAll("video, audio")) media.pause();

    container.setAttribute("data-gsb", "hidden");
    container.append(createOverlay(container));

    if (!counted.has(container)) {
      counted.add(container);
      countHidden();
    }
  }

  function clear(container) {
    for (const overlay of container.querySelectorAll(":scope > gsb-overlay")) overlay.remove();
    for (const child of container.querySelectorAll(":scope > [data-gsb-inert]")) {
      child.inert = false;
      child.removeAttribute("data-gsb-inert");
    }
    container.removeAttribute("data-gsb");
    container.removeAttribute("data-gsb-static");
  }

  function reveal(container) {
    clear(container);
    container.setAttribute("data-gsb", "revealed");
    revealedPrefix.set(container, stablePrefix(readText(container)));
    reportSoon();
  }

  function onMediaPlay(event) {
    const media = event.target;
    if (!(media instanceof HTMLMediaElement)) return;
    if (shield || media.closest('[data-gsb="hidden"]')) media.pause();
  }

  // ---------------------------------------------------------------------------
  // UI (closed shadow roots keep page styles out and spoiler text off the DOM)

  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  const OVERLAY_STYLE = `
    :host { all: initial; }
    .frame {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      container-type: size;
      overflow: hidden;
      cursor: pointer;
      background: linear-gradient(160deg, rgba(92, 95, 102, 0.93), rgba(38, 40, 44, 0.97));
      backdrop-filter: blur(24px) saturate(0.6);
    }
    .pill {
      all: unset;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 14px;
      border-radius: 999px;
      background: rgba(12, 12, 14, 0.85);
      color: #fff;
      font: 700 13px/1 ${FONT};
      letter-spacing: 0.06em;
      text-transform: uppercase;
      white-space: nowrap;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
      transition: transform 0.15s ease, background-color 0.15s ease;
    }
    .frame:hover .pill { background: #000; transform: scale(1.05); }
    .pill:focus-visible { outline: 2px solid #ff6b9a; outline-offset: 2px; }
    svg {
      width: 16px;
      height: 16px;
      flex: none;
      fill: none;
      stroke: currentColor;
      stroke-width: 2.2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    @container (max-height: 46px) {
      .pill { padding: 3px 9px; gap: 4px; font-size: 10px; }
      svg { width: 12px; height: 12px; }
    }
    @container (max-height: 24px) {
      .pill { padding: 1px 7px; font-size: 9px; }
      svg { display: none; }
    }
    @container (max-width: 110px) {
      .label { display: none; }
      .pill { padding: 5px; }
      svg { display: block; }
    }
  `;

  const SHIELD_STYLE = `
    :host { all: initial; }
    .backdrop {
      position: fixed;
      inset: 0;
      box-sizing: border-box;
      display: grid;
      place-items: center;
      padding: 16px;
      overflow: auto;
      container-type: size;
      background: rgba(18, 19, 22, 0.9);
      backdrop-filter: blur(28px) saturate(0.5);
      color: #f2f3f5;
      font-family: ${FONT};
    }
    .card {
      box-sizing: border-box;
      width: 100%;
      max-width: 420px;
      padding: 28px 24px 22px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 16px;
      background: linear-gradient(160deg, #3a3c42, #232428);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      text-align: center;
    }
    .icon {
      display: grid;
      place-items: center;
      width: 56px;
      height: 56px;
      margin: 0 auto 14px;
      border-radius: 50%;
      background: linear-gradient(135deg, #ff5e8a, #ff9e44);
      color: #17181c;
    }
    svg {
      width: 28px;
      height: 28px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2.2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    h2 { margin: 0 0 8px; font-size: 20px; font-weight: 700; line-height: 1.25; }
    p { margin: 0 0 20px; font-size: 14px; line-height: 1.5; color: #b5bac1; }
    .actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
    button {
      all: unset;
      box-sizing: border-box;
      padding: 10px 18px;
      border-radius: 10px;
      font: 600 14px/1 ${FONT};
      cursor: pointer;
    }
    button:hover { filter: brightness(1.12); }
    button:focus-visible { outline: 2px solid #ff6b9a; outline-offset: 2px; }
    .primary { background: #f2f3f5; color: #17181c; }
    .secondary { background: rgba(255, 255, 255, 0.08); color: #f2f3f5; }
    @container (max-height: 260px) {
      .icon, p { display: none; }
      .card { padding: 14px; }
      h2 { margin-bottom: 10px; font-size: 15px; }
    }
  `;

  const BLOCKED_EVENTS = ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "dblclick", "contextmenu"];

  // Built with DOM APIs instead of innerHTML so pages that enforce Trusted
  // Types (YouTube) accept it.
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function eyeOffIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attributes] of [
      ["path", { d: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" }],
      ["circle", { cx: "12", cy: "12", r: "3" }],
      ["path", { d: "M4 4l16 16" }],
    ]) {
      const shape = document.createElementNS(ns, tag);
      for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
      svg.append(shape);
    }
    return svg;
  }

  function shadowHost(tag, css) {
    const hostElement = document.createElement(tag);
    const root = hostElement.attachShadow({ mode: "closed" });
    root.append(element("style", null, css));
    for (const type of BLOCKED_EVENTS) hostElement.addEventListener(type, (event) => event.stopPropagation());
    return { hostElement, root };
  }

  function createOverlay(container) {
    const { hostElement, root } = shadowHost("gsb-overlay", OVERLAY_STYLE);
    const frame = element("div", "frame");
    const pill = element("button", "pill");
    pill.type = "button";
    pill.setAttribute("aria-label", t("overlayLabel"));
    pill.append(eyeOffIcon(), element("span", "label", t("overlayText")));
    frame.append(pill);
    root.append(frame);

    hostElement.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      reveal(container);
    });
    hostElement.addEventListener("auxclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    return hostElement;
  }

  function showShield() {
    if (shield || !document.documentElement) return;
    const { hostElement, root } = shadowHost("gsb-shield", SHIELD_STYLE);
    const backdrop = element("div", "backdrop");
    const card = element("div", "card");
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "gsb-title");

    const icon = element("div", "icon");
    icon.append(eyeOffIcon());
    const title = element("h2", null, t("shieldTitle"));
    title.id = "gsb-title";

    const actions = element("div", "actions");
    if (window === window.top) {
      const back = element("button", "secondary", t("shieldBack"));
      back.type = "button";
      back.addEventListener("click", goBack);
      actions.append(back);
    }
    const show = element("button", "primary", t("shieldShow"));
    show.type = "button";
    show.addEventListener("click", revealPage);
    actions.append(show);

    card.append(icon, title, element("p", null, t("shieldText")), actions);
    backdrop.append(card);
    root.append(backdrop);

    shield = hostElement;
    document.documentElement.append(shield);
    for (const media of document.querySelectorAll("video, audio")) media.pause();

    if (shieldCountedHref !== location.href) {
      shieldCountedHref = location.href;
      countHidden();
    }
  }

  function removeShield() {
    shield?.remove();
    shield = null;
  }

  function goBack() {
    if (history.length > 1) history.back();
    else send({ type: "close-tab" });
  }

  function revealPage() {
    revealedHref = location.href;
    refresh();
  }

  // Search results pages are left to per-item hiding: the user typed the term.
  function isUserSearch() {
    try {
      return matcher.mayMatch(normalize(decodeURIComponent(location.search.replace(/\+/g, " "))));
    } catch {
      return false;
    }
  }

  function checkPageTitle() {
    const title = document.title;
    if (title === lastTitle) return;
    lastTitle = title;
    if (active && title && matcher.matches(normalize(title)) && !isUserSearch()) showShield();
    else removeShield();
  }

  // ---------------------------------------------------------------------------
  // Reporting to the service worker (badge and anonymous counters)

  function countHidden() {
    pendingDelta++;
    reportSoon();
  }

  function reportSoon() {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(report, REPORT_DELAY_MS);
  }

  function report() {
    const pageCount = document.querySelectorAll("[data-gsb]").length + (shield ? 1 : 0);
    const delta = pendingDelta;
    pendingDelta = 0;
    send({ type: "hidden", delta, pageCount });
  }

  function send(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // The extension was updated or removed; this copy of the script is orphaned.
      observer.disconnect();
    }
  }

  // ---------------------------------------------------------------------------
  // Wiring

  function onUrlChange() {
    lastHref = location.href;
    if (revealedHref !== null && revealedHref !== location.href) revealedHref = null;
    refresh();
    lastTitle = null;
    reportSoon();
  }

  function handleMutation(mutation) {
    const { type, target } = mutation;
    if (type === "childList") {
      const added = [...mutation.addedNodes];
      if (added.every(isOwnNode) && [...mutation.removedNodes].every(isOwnNode)) return;
      for (const node of added) if (!isOwnNode(node)) scanNode(node);
      queueRecheck(target);
    } else if (type === "characterData") {
      scanText(target);
      queueRecheck(target);
    } else {
      scanLabels(target);
      queueRecheck(target);
    }
  }

  // Mutation callbacks run before the next paint, so matches are covered
  // before they are ever shown.
  const observer = new MutationObserver((mutations) => {
    if (location.href !== lastHref) onUrlChange();
    if (active) {
      for (const mutation of mutations) handleMutation(mutation);
      processQueue();
    }
    checkPageTitle();
  });

  document.addEventListener("play", onMediaPlay, true);
  observer.observe(document, OBSERVER_OPTIONS);
  if (document.body) {
    scanNode(document.body);
    processQueue();
  }
  checkPageTitle();

  chrome.storage.sync
    .get(null)
    .then((stored) => {
      settings = { ...DEFAULTS, ...stored };
      refresh();
    })
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    for (const [key, { newValue }] of Object.entries(changes)) settings[key] = newValue ?? DEFAULTS[key];
    refresh();
  });
})();
