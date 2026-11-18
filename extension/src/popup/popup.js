(async () => {
  const { defaults: DEFAULTS, sanitizeTerms, siteOf } = globalThis.GSBSettings;
  const ENDPOINT = globalThis.GSBConfig.telemetryEndpoint;

  const $ = (id) => document.getElementById(id);
  const t = (key, substitutions) => chrome.i18n.getMessage(key, substitutions) || key;
  const formatNumber = new Intl.NumberFormat(chrome.i18n.getUILanguage()).format;

  function localize() {
    document.documentElement.lang = chrome.i18n.getUILanguage();
    for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
    for (const node of document.querySelectorAll("[data-i18n-title]")) node.title = t(node.dataset.i18nTitle);
    for (const node of document.querySelectorAll("[data-i18n-placeholder]")) node.placeholder = t(node.dataset.i18nPlaceholder);
    for (const node of document.querySelectorAll("[data-i18n-alt]")) node.alt = t(node.dataset.i18nAlt);
  }

  localize();
  $("version").textContent = `v${chrome.runtime.getManifest().version}`;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = siteOf(tab?.url ?? "");
  const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(null)) };

  function isPaused() {
    return Boolean(site) && settings.pausedSites.includes(site);
  }

  function renderStatus() {
    const status = $("status");
    const state = !settings.enabled ? "off" : isPaused() ? "paused" : "on";
    status.dataset.state = state;
    status.textContent = t({ on: "popupStatusOn", paused: "popupStatusPaused", off: "popupStatusOff" }[state]);
  }

  async function renderCounts() {
    const { stats } = await chrome.storage.local.get("stats");
    $("totalCount").textContent = formatNumber(stats?.totalHidden ?? 0);
    if (!tab?.id) return;
    const key = `tab:${tab.id}`;
    const { [key]: frames = {} } = await chrome.storage.session.get(key);
    $("pageCount").textContent = formatNumber(Object.values(frames).reduce((sum, value) => sum + value, 0));
  }

  function save(changes) {
    Object.assign(settings, changes);
    renderStatus();
    return chrome.storage.sync.set(changes);
  }

  // Master switch
  $("enabled").checked = settings.enabled;
  $("enabled").addEventListener("change", (event) => save({ enabled: event.target.checked }));

  // Per-site pause
  if (site) {
    $("siteTitle").textContent = t("popupPauseSite", [site]);
    $("pauseSite").checked = isPaused();
    $("pauseSite").addEventListener("change", (event) => {
      const others = settings.pausedSites.filter((entry) => entry !== site);
      save({ pausedSites: event.target.checked ? [...others, site] : others });
    });
  } else {
    $("siteTitle").textContent = t("popupSiteUnavailable");
    $("pauseSite").disabled = true;
    $("siteRow").classList.add("disabled");
  }

  // Strict mode
  $("strict").checked = settings.strict;
  $("strict").addEventListener("change", (event) => save({ strict: event.target.checked }));

  // Anonymous statistics (only shown in builds that report anywhere)
  if (ENDPOINT) {
    $("telemetryRow").hidden = false;
    $("telemetry").checked = settings.telemetry;
    $("telemetry").addEventListener("change", (event) => save({ telemetry: event.target.checked }));
  }

  // Custom terms
  const termsField = $("customTerms");
  const saveButton = $("saveTerms");
  termsField.value = settings.customTerms.join("\n");
  saveButton.addEventListener("click", async () => {
    const terms = sanitizeTerms(termsField.value.split("\n"));
    termsField.value = terms.join("\n");
    await save({ customTerms: terms });
    saveButton.textContent = t("popupSaved");
    saveButton.disabled = true;
    setTimeout(() => {
      saveButton.textContent = t("popupSave");
      saveButton.disabled = false;
    }, 1500);
  });

  // Pix QR: small by default, enlarged on click so a phone can scan it
  $("pixQr").addEventListener("click", () => {
    const expanded = $("donate").classList.toggle("expanded");
    $("pixQr").setAttribute("aria-expanded", String(expanded));
  });

  renderStatus();
  await renderCounts();
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "local" || area === "session") renderCounts();
  });
})();
