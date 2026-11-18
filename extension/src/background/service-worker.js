importScripts("../shared/settings.js", "../config.js");

const DEFAULTS = globalThis.GSBSettings.defaults;
const ENDPOINT = globalThis.GSBConfig.telemetryEndpoint;

const REPORT_ALARM = "report-usage";
const REPORT_INTERVAL_MINUTES = 360;
// The server only accepts the current UTC day and the two before it.
const REPORT_WINDOW_DAYS = 2;
const MAX_HIDDEN_PER_DAY = 20000;
const MAX_DELTA_PER_MESSAGE = 1000;
const BADGE_COLOR = "#e8456f";

// Storage updates are read-modify-write; run them one at a time per area.
function createQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}

const statsQueue = createQueue();
const badgeQueue = createQueue();

// -----------------------------------------------------------------------------
// Local counters

function utcDay(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function loadStats() {
  const { stats } = await chrome.storage.local.get("stats");
  return { installId: crypto.randomUUID(), totalHidden: 0, days: {}, ...stats };
}

function saveStats(stats) {
  return chrome.storage.local.set({ stats });
}

async function isTelemetryEnabled() {
  if (!ENDPOINT) return false;
  const { telemetry } = await chrome.storage.sync.get("telemetry");
  return telemetry ?? DEFAULTS.telemetry;
}

function recordHidden(delta) {
  return statsQueue(async () => {
    const stats = await loadStats();
    stats.totalHidden += delta;
    if (await isTelemetryEnabled()) {
      const entry = (stats.days[utcDay()] ??= { hidden: 0, sent: -1 });
      entry.hidden = Math.min(entry.hidden + delta, MAX_HIDDEN_PER_DAY);
    }
    await saveStats(stats);
  });
}

// Opting out drops pending numbers and the old ID, so nothing sent later can
// be tied to what was sent before.
function forgetTelemetry() {
  return statsQueue(async () => {
    const stats = await loadStats();
    await saveStats({ ...stats, installId: crypto.randomUUID(), days: {} });
  });
}

// -----------------------------------------------------------------------------
// Anonymous usage report: one row per install per UTC day with the number of
// items hidden. Re-sending a day is harmless; the server keeps the highest value.

function flushUsage() {
  return statsQueue(async () => {
    if (!(await isTelemetryEnabled())) return;

    const stats = await loadStats();
    const today = utcDay();
    const oldest = utcDay(-REPORT_WINDOW_DAYS);
    stats.days[today] ??= { hidden: 0, sent: -1 };

    for (const [day, entry] of Object.entries(stats.days)) {
      if (day < oldest || day > today) {
        delete stats.days[day];
        continue;
      }
      if (entry.hidden > entry.sent && (await postUsage(stats.installId, day, entry.hidden))) {
        entry.sent = entry.hidden;
      }
    }
    await saveStats(stats);
  });
}

async function postUsage(id, day, hidden) {
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, day, hidden }),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function scheduleReports() {
  if (!(await chrome.alarms.get(REPORT_ALARM))) {
    await chrome.alarms.create(REPORT_ALARM, { delayInMinutes: 1, periodInMinutes: REPORT_INTERVAL_MINUTES });
  }
}

// -----------------------------------------------------------------------------
// Toolbar badge: items hidden in the current tab, summed over its frames.

function badgeText(count) {
  if (!count) return "";
  return count > 999 ? "999+" : String(count);
}

function setFrameCount(tabId, frameId, count) {
  return badgeQueue(async () => {
    const key = `tab:${tabId}`;
    const { [key]: frames = {} } = await chrome.storage.session.get(key);
    if (count) frames[frameId] = count;
    else delete frames[frameId];

    const total = Object.values(frames).reduce((sum, value) => sum + value, 0);
    await chrome.storage.session.set({ [key]: frames });
    await chrome.action.setBadgeText({ tabId, text: badgeText(total) }).catch(() => {});
  });
}

function clearTab(tabId) {
  return badgeQueue(() => chrome.storage.session.remove(`tab:${tabId}`));
}

function styleBadge() {
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  chrome.action.setBadgeTextColor({ color: "#ffffff" });
}

// -----------------------------------------------------------------------------
// Events

function clampInt(value, min, max) {
  return Number.isInteger(value) ? Math.min(Math.max(value, min), max) : min;
}

chrome.runtime.onInstalled.addListener(() => {
  styleBadge();
  statsQueue(async () => saveStats(await loadStats()));
  scheduleReports();
});

chrome.runtime.onStartup.addListener(() => {
  styleBadge();
  scheduleReports();
  flushUsage();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REPORT_ALARM) flushUsage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.telemetry) return;
  if (changes.telemetry.newValue === false) forgetTelemetry();
  else flushUsage();
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== chrome.runtime.id || !sender.tab?.id) return;

  if (message?.type === "hidden") {
    const delta = clampInt(message.delta, 0, MAX_DELTA_PER_MESSAGE);
    if (delta) recordHidden(delta);
    setFrameCount(sender.tab.id, sender.frameId ?? 0, clampInt(message.pageCount, 0, 100_000));
  } else if (message?.type === "close-tab") {
    chrome.tabs.remove(sender.tab.id).catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") clearTab(tabId);
});

chrome.tabs.onRemoved.addListener(clearTab);
