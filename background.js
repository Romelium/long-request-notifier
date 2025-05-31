const requestStartTimes = new Map();
const DEFAULT_SETTINGS = {
    longRequestThreshold: 10,
    domainFilterMode: "all",
    whitelistDomains: [],
    blacklistDomains: [],
    soundVolume: 0.7,
    customSoundDataUrl: null,
    customSoundFileName: null,
    showOsNotifications: false
};
let currentSettings = { ...DEFAULT_SETTINGS };

const notificationSound = new Audio();
let lastSoundPlayTime = 0;
const SOUND_COOLDOWN_MS = 3000;

function parseDomainListFromString(domainString) {
    if (!domainString || typeof domainString !== 'string') return [];
    return domainString.split(',').map(d => d.trim().toLowerCase()).filter(d => d.length > 0);
}

function updateSoundSource() {
    if (currentSettings.customSoundDataUrl) {
        notificationSound.src = currentSettings.customSoundDataUrl;
    } else {
        notificationSound.src = browser.runtime.getURL("sounds/notification.mp3");
    }
    notificationSound.volume = currentSettings.soundVolume;
    notificationSound.load();
}

async function loadSettings() {
    try {
        const result = await browser.storage.local.get(Object.keys(DEFAULT_SETTINGS));
        currentSettings.longRequestThreshold = result.longRequestThreshold || DEFAULT_SETTINGS.longRequestThreshold;
        currentSettings.domainFilterMode = result.domainFilterMode || DEFAULT_SETTINGS.domainFilterMode;
        currentSettings.whitelistDomains = parseDomainListFromString(result.whitelistDomains);
        currentSettings.blacklistDomains = parseDomainListFromString(result.blacklistDomains);
        currentSettings.soundVolume = (typeof result.soundVolume === 'number') ? result.soundVolume : DEFAULT_SETTINGS.soundVolume;
        currentSettings.customSoundDataUrl = result.customSoundDataUrl || null;
        currentSettings.showOsNotifications = (typeof result.showOsNotifications === 'boolean') ? result.showOsNotifications : DEFAULT_SETTINGS.showOsNotifications;

        updateSoundSource();
        console.log("LNR: Settings loaded:", { ...currentSettings, customSoundDataUrl: currentSettings.customSoundDataUrl ? "Custom Sound Present" : null });
    } catch (error) {
        console.error(`LNR: Error loading settings: ${error}. Using defaults.`);
        currentSettings = { ...DEFAULT_SETTINGS };
        currentSettings.whitelistDomains = parseDomainListFromString(DEFAULT_SETTINGS.whitelistDomains);
        currentSettings.blacklistDomains = parseDomainListFromString(DEFAULT_SETTINGS.blacklistDomains);
        updateSoundSource();
    }
}

browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
        let settingsChanged = false;
        let soundSettingsChanged = false;

        if (changes.longRequestThreshold) {
            currentSettings.longRequestThreshold = changes.longRequestThreshold.newValue || DEFAULT_SETTINGS.longRequestThreshold;
            settingsChanged = true;
        }
        if (changes.domainFilterMode) {
            currentSettings.domainFilterMode = changes.domainFilterMode.newValue || DEFAULT_SETTINGS.domainFilterMode;
            settingsChanged = true;
        }
        if (changes.whitelistDomains) {
            currentSettings.whitelistDomains = parseDomainListFromString(changes.whitelistDomains.newValue);
            settingsChanged = true;
        }
        if (changes.blacklistDomains) {
            currentSettings.blacklistDomains = parseDomainListFromString(changes.blacklistDomains.newValue);
            settingsChanged = true;
        }
        if (changes.soundVolume) {
            currentSettings.soundVolume = (typeof changes.soundVolume.newValue === 'number') ? changes.soundVolume.newValue : DEFAULT_SETTINGS.soundVolume;
            soundSettingsChanged = true;
            settingsChanged = true;
        }
        if (changes.customSoundDataUrl) {
            currentSettings.customSoundDataUrl = changes.customSoundDataUrl.newValue || null;
            soundSettingsChanged = true;
            settingsChanged = true;
        }
        if (changes.showOsNotifications) {
            currentSettings.showOsNotifications = (typeof changes.showOsNotifications.newValue === 'boolean') ? changes.showOsNotifications.newValue : DEFAULT_SETTINGS.showOsNotifications;
            settingsChanged = true;
        }

        if (soundSettingsChanged) {
            updateSoundSource();
        }
        if (settingsChanged) {
            console.log("LNR: Settings updated via storage.onChanged:", { ...currentSettings, customSoundDataUrl: currentSettings.customSoundDataUrl ? "Custom Sound Present" : null });
        }
    }
});

function isDomainMatch(hostname, domainList) {
    if (!hostname) return false;
    const lowerHostname = hostname.toLowerCase();
    return domainList.some(domain => lowerHostname === domain || lowerHostname.endsWith("." + domain));
}

function shouldMonitorRequest(urlString) {
    if (!urlString || (!urlString.startsWith("http:") && !urlString.startsWith("https:")) ) {
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
        if (details.tabId === -1) {
            return;
        }
        if (!shouldMonitorRequest(details.url)) {
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
