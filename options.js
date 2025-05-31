const thresholdInput = document.getElementById('threshold');
const filterModeSelect = document.getElementById('filterMode');
const whitelistTextarea = document.getElementById('whitelistDomains');
const blacklistTextarea = document.getElementById('blacklistDomains');
const volumeSlider = document.getElementById('volume');
const volumeValueSpan = document.getElementById('volumeValue');
const customSoundFileInput = document.getElementById('customSoundFile');
const currentSoundNameSpan = document.getElementById('currentSoundName');
const resetSoundButton = document.getElementById('resetSound');
const testSoundButton = document.getElementById('testSound');
const showOsNotificationsCheckbox = document.getElementById('showOsNotifications');
const saveButton = document.getElementById('save');
const statusDiv = document.getElementById('status');

const MAX_SOUND_FILE_SIZE_MB = 1;
const MAX_SOUND_FILE_SIZE_BYTES = MAX_SOUND_FILE_SIZE_MB * 1024 * 1024;
const ALLOWED_SOUND_TYPES = ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/mp4'];

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

function localizeHtmlPage() {
    document.querySelectorAll('[data-i18n-content]').forEach(element => {
        element.textContent = browser.i18n.getMessage(element.getAttribute('data-i18n-content'));
    });
    document.querySelectorAll('[data-i18n-html]').forEach(element => {
        element.innerHTML = browser.i18n.getMessage(element.getAttribute('data-i18n-html'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
        element.placeholder = browser.i18n.getMessage(element.getAttribute('data-i18n-placeholder'));
    });
    document.querySelectorAll('[data-i18n-title]').forEach(element => {
        element.title = browser.i18n.getMessage(element.getAttribute('data-i18n-title'));
    });
}

function domainsTextareaToStorageString(domainsString) {
    if (!domainsString) return "";
    return domainsString.split(/[\n,]+/).map(d => d.trim()).filter(d => d.length > 0).join(',');
}

function domainsStorageStringToTextarea(domainsStorageString) {
    if (!domainsStorageString) return "";
    return domainsStorageString.split(',').join('\n');
}

function updateCurrentSoundDisplay(fileName) {
    if (fileName) {
        currentSoundNameSpan.textContent = `${browser.i18n.getMessage("customSoundName")} (${fileName})`;
    } else {
        currentSoundNameSpan.textContent = browser.i18n.getMessage("defaultSoundName");
    }
}

function showStatus(messageKey, type = 'success', duration = 3000, placeholders) {
    let message = browser.i18n.getMessage(messageKey, placeholders);
    statusDiv.textContent = message;
    statusDiv.className = type === 'success' ? 'status-success' : 'status-error';
    if (duration > 0) {
        setTimeout(() => { statusDiv.textContent = ''; statusDiv.className = ''; }, duration);
    }
}

async function loadOptions() {
    try {
        const result = await browser.storage.local.get(DEFAULT_SETTINGS);
        thresholdInput.value = result.longRequestThreshold;
        filterModeSelect.value = result.domainFilterMode;
        whitelistTextarea.value = domainsStorageStringToTextarea(result.whitelistDomains);
        blacklistTextarea.value = domainsStorageStringToTextarea(result.blacklistDomains);
        volumeSlider.value = result.soundVolume;
        volumeValueSpan.textContent = `${Math.round(result.soundVolume * 100)}%`;
        updateCurrentSoundDisplay(result.customSoundFileName);
        showOsNotificationsCheckbox.checked = result.showOsNotifications;
    } catch (error) {
        console.error(`LNR: Error loading settings: ${error}`);
        showStatus("statusErrorSaving", 'error', 0, [error.message || String(error)]);
    }
}

async function saveGeneralSettings() {
    const newThreshold = parseInt(thresholdInput.value, 10);
    if (isNaN(newThreshold) || newThreshold < 1) {
        showStatus("statusInvalidThreshold", 'error');
        return false;
    }

    const settingsToSave = {
        longRequestThreshold: newThreshold,
        domainFilterMode: filterModeSelect.value,
        whitelistDomains: domainsTextareaToStorageString(whitelistTextarea.value),
        blacklistDomains: domainsTextareaToStorageString(blacklistTextarea.value),
        soundVolume: parseFloat(volumeSlider.value),
        showOsNotifications: showOsNotificationsCheckbox.checked
    };

    try {
        await browser.storage.local.set(settingsToSave);
        showStatus("statusSaved", 'success');
        return true;
    } catch (error) {
        showStatus("statusErrorSaving", 'error', 0, [error.message || String(error)]);
        console.error(`LNR: Error saving general settings: ${error}`);
        return false;
    }
}

function handleCustomSoundUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (file.size > MAX_SOUND_FILE_SIZE_BYTES) {
        showStatus("statusSoundFileErrorTooLarge", 'error', 0, [MAX_SOUND_FILE_SIZE_MB.toString()]);
        customSoundFileInput.value = '';
        return;
    }

    if (!ALLOWED_SOUND_TYPES.includes(file.type)) {
        console.warn("LNR: Invalid sound file type selected:", file.type, file.name);
        showStatus("statusSoundFileErrorInvalidType", 'error');
        customSoundFileInput.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            await browser.storage.local.set({
                customSoundDataUrl: e.target.result,
                customSoundFileName: file.name
            });
            updateCurrentSoundDisplay(file.name);
            showStatus("statusSoundUploaded", 'success');
        } catch (storageError) {
            console.error("LNR: Error saving custom sound to storage:", storageError);
            showStatus("statusErrorSaving", 'error', 0, [storageError.message || String(storageError)]);
        }
        customSoundFileInput.value = '';
    };
    reader.onerror = () => {
        console.error("LNR: Error reading sound file.");
        showStatus("statusSoundFileErrorReading", 'error');
        customSoundFileInput.value = '';
    };
    reader.readAsDataURL(file);
}

async function handleResetSound() {
    try {
        await browser.storage.local.set({
            customSoundDataUrl: null,
            customSoundFileName: null
        });
        updateCurrentSoundDisplay(null);
        showStatus("statusSoundReset", 'success');
    } catch (error) {
        console.error("LNR: Error resetting sound:", error);
        showStatus("statusErrorSaving", 'error', 0, [error.message || String(error)]);
    }
}

function handleTestSound() {
    browser.runtime.sendMessage({ type: "playSound" })
        .catch(err => console.error("LNR: Error sending playSound message:", err));
}

volumeSlider.addEventListener('input', () => {
    volumeValueSpan.textContent = `${Math.round(volumeSlider.value * 100)}%`;
});

document.addEventListener('DOMContentLoaded', () => {
    localizeHtmlPage();
    loadOptions();
});

saveButton.addEventListener('click', saveGeneralSettings);
customSoundFileInput.addEventListener('change', handleCustomSoundUpload);
resetSoundButton.addEventListener('click', handleResetSound);
testSoundButton.addEventListener('click', handleTestSound);
