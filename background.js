const requestStartTimes = new Map();

// These defaults reflect the STORAGE format. Domain lists are stored as newline-separated strings.
const DEFAULT_SETTINGS = {
    longRequestThreshold: 10,
    domainFilterMode: "all",
    whitelistDomains: "",
    blacklistDomains: "",
    soundVolume: 0.7,
    customSoundDataUrl: null,
    customSoundFileName: null,
    showOsNotifications: false
};

// This holds the live, in-memory settings, with domains parsed into an array for efficient use.
let currentSettings = {
    longRequestThreshold: DEFAULT_SETTINGS.longRequestThreshold,
    domainFilterMode: DEFAULT_SETTINGS.domainFilterMode,
    whitelistDomains: [], // Parsed from string
    blacklistDomains: [], // Parsed from string
    soundVolume: DEFAULT_SETTINGS.soundVolume,
    customSoundDataUrl: DEFAULT_SETTINGS.customSoundDataUrl,
    customSoundFileName: DEFAULT_SETTINGS.customSoundFileName,
    showOsNotifications: DEFAULT_SETTINGS.showOsNotifications
};

const notificationSound = new Audio();
let lastSoundPlayTime = 0;
const SOUND_COOLDOWN_MS = 3000;

// Parses a newline-separated string of patterns into an array of strings.
function parseDomainListFromString(domainString) {
    if (!domainString || typeof domainString !== 'string') return [];
    return domainString.split(/\r?\n/).map(d => d.trim()).filter(d => d.length > 0);
}

function updateSoundSource() {
    notificationSound.volume = currentSettings.soundVolume;
    if (currentSettings.customSoundDataUrl) {
        notificationSound.src = currentSettings.customSoundDataUrl;
    } else {
        notificationSound.src = browser.runtime.getURL("sounds/notification.mp3");
    }
    notificationSound.load();
}

async function loadSettings() {
    try {
        const storedSettings = await browser.storage.local.get(DEFAULT_SETTINGS);

        // Update live settings from stored values, with type checks and fallbacks.
        currentSettings.longRequestThreshold = storedSettings.longRequestThreshold ?? DEFAULT_SETTINGS.longRequestThreshold;
        currentSettings.domainFilterMode = storedSettings.domainFilterMode ?? DEFAULT_SETTINGS.domainFilterMode;
        currentSettings.soundVolume = (typeof storedSettings.soundVolume === 'number') ? storedSettings.soundVolume : DEFAULT_SETTINGS.soundVolume;
        currentSettings.customSoundDataUrl = storedSettings.customSoundDataUrl ?? null;
        currentSettings.customSoundFileName = storedSettings.customSoundFileName ?? null;
        currentSettings.showOsNotifications = (typeof storedSettings.showOsNotifications === 'boolean') ? storedSettings.showOsNotifications : DEFAULT_SETTINGS.showOsNotifications;

        // Parse domain strings from storage into arrays for in-memory use.
        currentSettings.whitelistDomains = parseDomainListFromString(storedSettings.whitelistDomains);
        currentSettings.blacklistDomains = parseDomainListFromString(storedSettings.blacklistDomains);

        updateSoundSource();
        console.log("LNR: Settings loaded:", { ...currentSettings, customSoundDataUrl: currentSettings.customSoundDataUrl ? "Custom Sound Present" : null });
    } catch (error) {
        console.error(`LNR: Error loading settings: ${error}. Using defaults.`);
        // Reset to defaults on error.
        Object.assign(currentSettings, DEFAULT_SETTINGS);
        currentSettings.whitelistDomains = [];
        currentSettings.blacklistDomains = [];
        updateSoundSource();
    }
}

browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
        let settingsChanged = false;
        let soundSettingsChanged = false;

        for (const [key, { newValue }] of Object.entries(changes)) {
            settingsChanged = true;
            switch (key) {
                case 'longRequestThreshold':
                    currentSettings.longRequestThreshold = newValue ?? DEFAULT_SETTINGS.longRequestThreshold;
                    break;
                case 'domainFilterMode':
                    currentSettings.domainFilterMode = newValue ?? DEFAULT_SETTINGS.domainFilterMode;
                    break;
                case 'whitelistDomains':
                    currentSettings.whitelistDomains = parseDomainListFromString(newValue ?? "");
                    break;
                case 'blacklistDomains':
                    currentSettings.blacklistDomains = parseDomainListFromString(newValue ?? "");
                    break;
                case 'soundVolume':
                    currentSettings.soundVolume = (typeof newValue === 'number') ? newValue : DEFAULT_SETTINGS.soundVolume;
                    soundSettingsChanged = true;
                    break;
                case 'customSoundDataUrl':
                    currentSettings.customSoundDataUrl = newValue ?? null;
                    soundSettingsChanged = true;
                    break;
                case 'customSoundFileName':
                    currentSettings.customSoundFileName = newValue ?? null;
                    break;
                case 'showOsNotifications':
                    currentSettings.showOsNotifications = (typeof newValue === 'boolean') ? newValue : DEFAULT_SETTINGS.showOsNotifications;
                    break;
            }
        }

        if (soundSettingsChanged) {
            updateSoundSource();
        }
        if (settingsChanged) {
            console.log("LNR: Settings updated via storage.onChanged:", { ...currentSettings, customSoundDataUrl: currentSettings.customSoundDataUrl ? "Custom Sound Present" : null });
        }
    }
});

function isDomainMatch(hostname, domainPatternList) {
    if (!hostname) return false;
    for (const pattern of domainPatternList) {
        if (!pattern) continue;
        try {
            const regex = new RegExp(pattern, 'i');
            if (regex.test(hostname)) {
                return true;
            }
        } catch (e) {
            console.error(`LNR: Invalid regex in domain list: "${pattern}". Error: ${e}`);
        }
    }
    return false;
}

function shouldMonitorRequest(urlString) {
    if (!urlString || (!urlString.startsWith("http:") && !urlString.startsWith("https:"))) {
        return false;
    }
    let hostname;
    try {
        const url = new URL(urlString);
        hostname = url.hostname;
        if (!hostname) return false;
    } catch (e) { return false; }

    switch (currentSettings.domainFilterMode) {
        case "whitelist":
            return currentSettings.whitelistDomains.length > 0 && isDomainMatch(hostname, currentSettings.whitelistDomains);
        case "blacklist":
            return !isDomainMatch(hostname, currentSettings.blacklistDomains);
        case "all": default: return true;
    }
}

browser.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.tabId === -1 || !shouldMonitorRequest(details.url)) {
            return;
        }
        if (details.type === "main_frame" || details.type === "xmlhttprequest" || details.type === "fetch") {
            requestStartTimes.set(details.requestId, {
                startTime: details.timeStamp, tabId: details.tabId, url: details.url
            });
        }
    },
    { urls: ["<all_urls>"] }
);

async function handleRequestEnd(details) {
    if (!requestStartTimes.has(details.requestId)) { return; }
    const requestInfo = requestStartTimes.get(details.requestId);
    requestStartTimes.delete(details.requestId);
    const durationMs = details.timeStamp - requestInfo.startTime;
    const durationSeconds = durationMs / 1000;

    if (durationSeconds >= currentSettings.longRequestThreshold) {
        let tabIsActive = true;
        if (requestInfo.tabId && requestInfo.tabId !== browser.tabs.TAB_ID_NONE) {
            try {
                const tab = await browser.tabs.get(requestInfo.tabId);
                tabIsActive = tab.active && tab.windowFocused;
            } catch (e) { tabIsActive = false; }
        } else { tabIsActive = false; }

        if (!tabIsActive) {
            const now = Date.now();
            if (now - lastSoundPlayTime > SOUND_COOLDOWN_MS) {
                notificationSound.play().catch(e => console.error("LNR: Error playing sound:", e));
                lastSoundPlayTime = now;
            }

            if (currentSettings.showOsNotifications) {
                try {
                    const notificationUrl = new URL(requestInfo.url);
                    const hostname = notificationUrl.hostname;
                    await browser.notifications.create(`long-request-${details.requestId}-${Date.now()}`, {
                        type: "basic", iconUrl: browser.runtime.getURL("icons/icon-96.png"),
                        title: browser.i18n.getMessage("notificationTitle"),
                        message: browser.i18n.getMessage("notificationMessage", [hostname, durationSeconds.toFixed(2)]),
                        priority: 0
                    });
                } catch (e) { console.error("LNR: Failed to create OS notification:", e); }
            }
        }
    }
}

browser.webRequest.onCompleted.addListener(handleRequestEnd, { urls: ["<all_urls>"] });
browser.webRequest.onErrorOccurred.addListener(handleRequestEnd, { urls: ["<all_urls>"] });

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "playSound") {
        if (notificationSound.src) {
            notificationSound.play().catch(e => console.error("LNR: Error playing test sound:", e));
        } else {
            console.warn("LNR: Test sound requested, but notificationSound.src is not set.");
        }
        return false;
    }
});

loadSettings();
console.log("LNR: Background script loaded and initialized.");
