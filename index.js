import {
    chat,
    characters,
    chat_metadata,
    eventSource,
    event_types,
    getCurrentChatId,
    getThumbnailUrl,
    reloadCurrentChat,
    saveMetadata,
    saveSettingsDebounced,
    selectCharacterById,
} from '../../../../script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
import { getChatCompletionModel, oai_settings, promptManager } from '../../../openai.js';
import { INJECTION_POSITION } from '../../../PromptManager.js';
import { power_user } from '../../../power-user.js';
import { getPresetManager } from '../../../preset-manager.js';
import { executeSlashCommandsWithOptions } from '../../../slash-commands.js';
import { download, getCharaFilename, getFileText, uuidv4 } from '../../../utils.js';
import {
    charSetAuxWorlds,
    charUpdatePrimaryWorld,
    getWorldInfoSettings,
    loadWorldInfo,
    METADATA_KEY,
    openWorldInfoEditor,
    saveWorldInfo,
    selected_world_info,
    setWIOriginalDataValue,
    updateWorldInfoSettings,
    world_info,
    world_names,
} from '../../../world-info.js';
import {
    getRegexScripts,
    getScriptsByType,
    saveScriptsByType,
    SCRIPT_TYPES,
} from '../../regex/engine.js';

const MODULE_NAME = 'sillyLinkify';
const EXTENSION_PATH = 'third-party/silly-linkify';
const SCHEMA_VERSION = 2;
const DEFAULT_EVALUATION_DELAY_MS = 75;
const DEFAULT_RECIPE_DEBOUNCE_MS = 75;
const { SillyTavern, toastr, jQuery } = globalThis;
const $ = jQuery;

const defaultSettings = Object.freeze({
    enabled: true,
    debug: false,
    schemaVersion: SCHEMA_VERSION,
    recipes: [],
    lastApplied: {},
});

const runtime = {
    isApplying: false,
    pendingEvaluation: false,
    evaluateTimer: null,
    recipeTimers: new Map(),
    activeRecipes: new Set(),
    selectedRecipeId: null,
    builderDrafts: {
        condition: null,
        result: null,
    },
    lorebookEntryTargets: [],
    lorebookEntryTargetsLoading: false,
};

const categories = [
    { id: 'preset', label: 'Preset', icon: 'fa-sliders' },
    { id: 'regex', label: 'Regex', icon: 'fa-code' },
    { id: 'character', label: 'Character / Chat', icon: 'fa-address-card' },
    { id: 'api', label: 'API / Model', icon: 'fa-plug' },
    { id: 'lorebook', label: 'Lorebook', icon: 'fa-book' },
    { id: 'quickReply', label: 'Quick Reply', icon: 'fa-reply' },
    { id: 'userSettings', label: 'User Settings', icon: 'fa-user-gear' },
    { id: 'custom', label: 'Custom', icon: 'fa-wand-magic-sparkles' },
];

function getContext() {
    return SillyTavern.getContext();
}

function clone(value) {
    return structuredClone(value);
}

function getSettings() {
    if (!extension_settings[MODULE_NAME] || extension_settings[MODULE_NAME].schemaVersion !== SCHEMA_VERSION) {
        extension_settings[MODULE_NAME] = clone(defaultSettings);
    }

    const settings = extension_settings[MODULE_NAME];
    settings.enabled = settings.enabled ?? true;
    settings.debug = settings.debug ?? false;
    settings.schemaVersion = SCHEMA_VERSION;
    settings.recipes = Array.isArray(settings.recipes) ? settings.recipes : [];
    settings.lastApplied = settings.lastApplied && typeof settings.lastApplied === 'object'
        ? settings.lastApplied
        : {};

    settings.recipes = settings.recipes.map(normalizeRecipe);
    return settings;
}

function logDebug(...args) {
    if (getSettings().debug) {
        console.debug('[Silly Linkify]', ...args);
    }
}

function warn(message) {
    console.warn('[Silly Linkify]', message);
    toastr.warning(message, 'Silly Linkify');
}

function saveSettings() {
    saveSettingsDebounced();
}

function normalizeRecipe(recipe) {
    return {
        id: recipe.id || uuidv4(),
        name: recipe.name || 'Untitled link',
        enabled: recipe.enabled ?? true,
        conditions: Array.isArray(recipe.conditions) ? recipe.conditions.map(normalizeBlock) : [],
        results: Array.isArray(recipe.results) ? recipe.results.map(normalizeBlock) : [],
        autoInverse: recipe.autoInverse ?? true,
    };
}

function normalizeBlock(block) {
    return {
        id: block.id || uuidv4(),
        adapter: block.adapter || 'custom.dom',
        target: block.target ?? '',
        value: block.value,
        label: block.label || '',
        reloadChat: block.reloadChat ?? false,
    };
}

function quoteSlashValue(value) {
    return `"${String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function getByPath(source, path, fallback = undefined) {
    if (!path) {
        return source;
    }

    let current = source;
    for (const part of String(path).split('.').filter(Boolean)) {
        if (current === null || current === undefined) {
            return fallback;
        }
        current = current[part];
    }
    return current === undefined ? fallback : current;
}

function setByPath(source, path, value) {
    const parts = String(path).split('.').filter(Boolean);
    if (!source || !parts.length) {
        return false;
    }

    let current = source;
    for (const part of parts.slice(0, -1)) {
        if (!current[part] || typeof current[part] !== 'object') {
            current[part] = {};
        }
        current = current[part];
    }

    current[parts.at(-1)] = value;
    return true;
}

function valuesEqual(actual, expected) {
    if (Array.isArray(actual) || Array.isArray(expected)) {
        const actualArray = Array.isArray(actual) ? actual : String(actual ?? '').split(',').map(item => item.trim()).filter(Boolean);
        const expectedArray = Array.isArray(expected) ? expected : String(expected ?? '').split(',').map(item => item.trim()).filter(Boolean);
        return JSON.stringify(actualArray) === JSON.stringify(expectedArray);
    }
    if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
        return Object.entries(expected).every(([key, value]) => valuesEqual(actual[key], value));
    }
    if (typeof actual === 'boolean') {
        return actual === parseBoolean(expected);
    }
    return String(actual ?? '') === String(expected ?? '');
}

function parseBoolean(value) {
    if (typeof value === 'boolean') {
        return value;
    }
    return ['true', '1', 'on', 'enabled', 'yes'].includes(String(value).toLowerCase());
}

function getSelectedPresetName(apiId = '') {
    return getPresetManager(apiId)?.getSelectedPresetName?.() ?? '';
}

function getConnectionProfiles() {
    return extension_settings.connectionManager?.profiles ?? [];
}

function getConnectionProfileLabel(id) {
    return getConnectionProfiles().find(profile => profile.id === id)?.name || id || 'No profile';
}

function getSelectOptions(selectorOrElement, fallback = []) {
    const element = typeof selectorOrElement === 'string'
        ? document.querySelector(selectorOrElement)
        : selectorOrElement;
    if (!(element instanceof HTMLSelectElement)) {
        return fallback;
    }

    const options = Array.from(element.options)
        .map(option => makeTarget(option.value, option.textContent?.trim() || option.value))
        .filter(option => String(option.id ?? '').length > 0);

    return options.length ? options : fallback;
}

function renderOptionHtml(options, selectedValue = '') {
    const renderOption = option => `<option value="${escapeHtml(option.id)}" ${String(option.id) === String(selectedValue) ? 'selected' : ''}>${escapeHtml(option.label)}</option>`;
    const groups = new Map();
    const ungrouped = [];

    for (const option of options) {
        if (option.group) {
            groups.set(option.group, [...(groups.get(option.group) ?? []), option]);
        } else {
            ungrouped.push(option);
        }
    }

    return [
        ...ungrouped.map(renderOption),
        ...Array.from(groups.entries()).map(([group, groupOptions]) => `<optgroup label="${escapeHtml(group)}">${groupOptions.map(renderOption).join('')}</optgroup>`),
    ].join('');
}

function getThemeOptions() {
    return getSelectOptions('#themes', power_user.theme ? [makeTarget(power_user.theme, power_user.theme)] : []);
}

function getLorebookOptions(includeNone = false) {
    const options = (world_names ?? []).map(name => makeTarget(name, name));
    return includeNone ? [makeTarget('', 'None'), ...options] : options;
}

function getLorebookLabel(value) {
    return value ? String(value) : 'None';
}

function getCurrentCharacter() {
    return characters[Number(getContext().characterId)] ?? null;
}

function getCurrentCharacterFileName() {
    const characterId = Number(getContext().characterId);
    if (!Number.isFinite(characterId)) {
        return '';
    }
    try {
        return getCharaFilename(characterId);
    } catch {
        return getCurrentCharacter()?.avatar || '';
    }
}

function getCurrentCharacterExtraLorebooks() {
    const fileName = getCurrentCharacterFileName();
    if (!fileName) {
        return [];
    }
    return world_info.charLore?.find(entry => entry.name === fileName)?.extraBooks ?? [];
}

function setWorldInfoSelectValues(values) {
    const selected = new Set(values);
    $('#world_info option').each((_, option) => {
        const index = Number(option.value);
        const name = (world_names ?? [])[index];
        option.selected = selected.has(name);
    });
}

function setGlobalLorebookEnabled(name, enabled) {
    if (!name || !(world_names ?? []).includes(name)) {
        warn(`Lorebook not found: ${name}`);
        return false;
    }

    const next = selected_world_info.filter(book => book !== name);
    if (enabled) {
        next.push(name);
    }

    if (selected_world_info.length === next.length && selected_world_info.every((book, index) => book === next[index])) {
        return false;
    }

    updateWorldInfoSettings(getWorldInfoSettings(), next);
    setWorldInfoSelectValues(next);
    eventSource.emit(event_types.WORLDINFO_SETTINGS_UPDATED);
    return false;
}

function getOpenLorebookName() {
    const selectedIndex = Number($('#world_editor_select').val());
    return Number.isFinite(selectedIndex) ? (world_names ?? [])[selectedIndex] || '' : '';
}

function getLorebookEntryLabel(entry) {
    const keys = Array.isArray(entry.key) ? entry.key.filter(Boolean).join(', ') : '';
    const comment = String(entry.comment || '').trim();
    return comment || keys || `Entry ${entry.uid}`;
}

function getLorebookEntryTargetId(book, uid) {
    return `${book}::${uid}`;
}

function parseLorebookEntryTarget(target) {
    if (typeof target === 'object') {
        return {
            book: target.book || String(target.id || '').split('::')[0],
            uid: target.uid ?? String(target.id || '').split('::').slice(1).join('::'),
        };
    }

    const [book, ...uidParts] = String(target || '').split('::');
    return { book, uid: uidParts.join('::') };
}

function findLorebookEntry(data, uid) {
    if (!data?.entries) {
        return null;
    }
    return data.entries[uid] ?? Object.values(data.entries).find(entry => String(entry.uid) === String(uid)) ?? null;
}

async function refreshLorebookEntryTargets() {
    if (runtime.lorebookEntryTargetsLoading || !world_names?.length) {
        return;
    }

    runtime.lorebookEntryTargetsLoading = true;
    try {
        const books = await Promise.all((world_names ?? []).map(async name => {
            try {
                return { name, data: await loadWorldInfo(name) };
            } catch (error) {
                console.warn('[Silly Linkify] Failed to load lorebook entries', name, error);
                return { name, data: null };
            }
        }));

        runtime.lorebookEntryTargets = books.flatMap(({ name, data }) => Object.values(data?.entries ?? {}).map(entry => makeTarget(
            getLorebookEntryTargetId(name, entry.uid),
            `${name}: ${getLorebookEntryLabel(entry)}`,
            { book: name, uid: entry.uid },
        )));
    } finally {
        runtime.lorebookEntryTargetsLoading = false;
    }
}

function getCurrentPresetOptions() {
    const manager = getPresetManager();
    const managerOptions = (manager?.getAllPresets?.() ?? []).map(name => makeTarget(name, name));
    if (managerOptions.length) {
        return managerOptions;
    }

    const activeApi = String(manager?.apiId || getContext().mainApi || '').replace('koboldhorde', 'kobold');
    const fallbackSelect = Array.from(document.querySelectorAll('select[data-preset-manager-for]'))
        .find(select => String(select.dataset.presetManagerFor || '').split(',').includes(activeApi));

    return getSelectOptions(fallbackSelect);
}

const presetParameterDefinitions = [
    {
        id: 'temperature',
        label: 'Temperature',
        type: 'number',
        selectors: {
            openai: '#temp_openai',
            textgenerationwebui: '#temp_textgenerationwebui',
            kobold: '#temp',
            koboldhorde: '#temp',
            novel: '#temp_novel',
        },
    },
    {
        id: 'top_p',
        label: 'Top P',
        type: 'number',
        selectors: {
            openai: '#top_p_openai',
            textgenerationwebui: '#top_p_textgenerationwebui',
            kobold: '#top_p',
            koboldhorde: '#top_p',
            novel: '#top_p_novel',
        },
    },
    {
        id: 'top_k',
        label: 'Top K',
        type: 'number',
        selectors: {
            openai: '#top_k_openai',
            textgenerationwebui: '#top_k_textgenerationwebui',
            kobold: '#top_k',
            koboldhorde: '#top_k',
            novel: '#top_k_novel',
        },
    },
    {
        id: 'repetition_penalty',
        label: 'Repetition penalty',
        type: 'number',
        selectors: {
            openai: '#repetition_penalty_openai',
            textgenerationwebui: '#rep_pen_textgenerationwebui',
            kobold: '#rep_pen',
            koboldhorde: '#rep_pen',
            novel: '#rep_pen_novel',
        },
    },
    {
        id: 'streaming',
        label: 'Streaming',
        type: 'boolean',
        selectors: {
            openai: '#stream_toggle',
            textgenerationwebui: '#streaming_textgenerationwebui',
            kobold: '#streaming_kobold',
            koboldhorde: '#streaming_kobold',
            novel: '#streaming_novel',
        },
    },
];

const userSettingDefinitions = [
    { group: 'UI Theme', id: 'theme', label: 'UI Theme', type: 'select', selector: '#themes' },
    { group: 'UI Theme', id: 'avatar_style', label: 'Avatars', type: 'select', selector: '#avatar_style' },
    { group: 'UI Theme', id: 'chat_display', label: 'Chat Style', type: 'select', selector: '#chat_display' },
    { group: 'UI Theme', id: 'media_display', label: 'Media Style', type: 'select', selector: '#media_display' },
    { group: 'UI Theme', id: 'toastr_position', label: 'Notifications', type: 'select', selector: '#toastr_position' },
    { group: 'Theme Colors', id: 'main_text_color', label: 'Main Text', type: 'text', selector: '#main-text-color-picker', attribute: 'color' },
    { group: 'Theme Colors', id: 'italics_text_color', label: 'Italic Text', type: 'text', selector: '#italics-color-picker', attribute: 'color' },
    { group: 'Theme Colors', id: 'underline_text_color', label: 'Underlined Text', type: 'text', selector: '#underline-color-picker', attribute: 'color' },
    { group: 'Theme Colors', id: 'quote_text_color', label: 'Quote Text', type: 'text', selector: '#quote-color-picker', attribute: 'color' },
    { group: 'Theme Colors', id: 'shadow_color', label: 'Text Shadow', type: 'text', selector: '#shadow-color-picker', attribute: 'color' },
    { group: 'Theme Colors', id: 'chat_tint_color', label: 'Chat Background', type: 'text', selector: '#chat-tint-color-picker', attribute: 'color' },
    { group: 'Theme Colors', id: 'blur_tint_color', label: 'UI Background', type: 'text', selector: '#blur-tint-color-picker', attribute: 'color' },
    { group: 'Theme Colors', id: 'border_color', label: 'UI Border', type: 'text', selector: '#border-color-picker', attribute: 'color' },
    { group: 'Theme Colors', id: 'user_mes_blur_tint_color', label: 'User Message', type: 'text', selector: '#user-mes-blur-tint-color-picker', attribute: 'color' },
    { group: 'Theme Colors', id: 'bot_mes_blur_tint_color', label: 'AI Message', type: 'text', selector: '#bot-mes-blur-tint-color-picker', attribute: 'color' },
    { group: 'Interface', id: 'chat_width', label: 'Chat Width', type: 'number', selector: '#chat_width_slider' },
    { group: 'Interface', id: 'font_scale', label: 'Font Scale', type: 'number', selector: '#font_scale' },
    { group: 'Interface', id: 'blur_strength', label: 'Blur Strength', type: 'number', selector: '#blur_strength' },
    { group: 'Interface', id: 'shadow_width', label: 'Shadow Width', type: 'number', selector: '#shadow_width' },
    { group: 'Interface', id: 'reduced_motion', label: 'Reduced Motion', type: 'boolean', selector: '#reduced_motion' },
    { group: 'Interface', id: 'fast_ui_mode', label: 'No Blur Effect', type: 'boolean', selector: '#fast_ui_mode' },
    { group: 'Interface', id: 'noShadows', label: 'No Text Shadows', type: 'boolean', selector: '#noShadowsmode' },
    { group: 'Interface', id: 'waifuMode', label: 'Visual Novel Mode', type: 'boolean', selector: '#waifuMode' },
    { group: 'Interface', id: 'expand_message_actions', label: 'Expand Message Actions', type: 'boolean', selector: '#expandMessageActions' },
    { group: 'Interface', id: 'enableZenSliders', label: 'Zen Sliders', type: 'boolean', selector: '#enableZenSliders' },
    { group: 'Interface', id: 'enableLabMode', label: 'Mad Lab Mode', type: 'boolean', selector: '#enableLabMode' },
    { group: 'Interface', id: 'timer_enabled', label: 'Message Timer', type: 'boolean', selector: '#messageTimerEnabled' },
    { group: 'Interface', id: 'timestamps_enabled', label: 'Chat Timestamps', type: 'boolean', selector: '#messageTimestampsEnabled' },
    { group: 'Interface', id: 'timestamp_model_icon', label: 'Model Icons', type: 'boolean', selector: '#messageModelIconEnabled' },
    { group: 'Interface', id: 'mesIDDisplay_enabled', label: 'Message IDs', type: 'boolean', selector: '#mesIDDisplayEnabled' },
    { group: 'Interface', id: 'hideChatAvatars_enabled', label: 'Hide Chat Avatars', type: 'boolean', selector: '#hideChatAvatarsEnabled' },
    { group: 'Interface', id: 'message_token_count_enabled', label: 'Message Token Count', type: 'boolean', selector: '#messageTokensEnabled' },
    { group: 'Interface', id: 'compact_input_area', label: 'Compact Input Area', type: 'boolean', selector: '#compact_input_area' },
    { group: 'Interface', id: 'show_swipe_num_all_messages', label: 'Swipe # for All Messages', type: 'boolean', selector: '#show_swipe_num_all_messages' },
    { group: 'Interface', id: 'hotswap_enabled', label: 'Characters Hotswap', type: 'boolean', selector: '#hotswapEnabled' },
    { group: 'Interface', id: 'zoomed_avatar_magnification', label: 'Avatar Hover Magnification', type: 'boolean', selector: '#zoomed_avatar_magnification' },
    { group: 'Interface', id: 'bogus_folders', label: 'Tags as Folders', type: 'boolean', selector: '#bogus_folders' },
    { group: 'Interface', id: 'click_to_edit', label: 'Click to Edit', type: 'boolean', selector: '#click_to_edit' },
    { group: 'Character Handling', id: 'aux_field', label: 'Char List Subheader', type: 'select', selector: '#aux_field' },
    { group: 'Character Handling', id: 'tag_import_setting', label: 'Import Card Tags', type: 'select', selector: '#tag_import_setting' },
    { group: 'Character Handling', id: 'fuzzy_search', label: 'Advanced Character Search', type: 'boolean', selector: '#fuzzy_search_checkbox' },
    { group: 'Character Handling', id: 'prefer_character_prompt', label: 'Prefer Char. Prompt', type: 'boolean', selector: '#prefer_character_prompt' },
    { group: 'Character Handling', id: 'prefer_character_jailbreak', label: 'Prefer Char. Instructions', type: 'boolean', selector: '#prefer_character_jailbreak' },
    { group: 'Character Handling', id: 'never_resize_avatars', label: 'Never resize avatars', type: 'boolean', selector: '#never_resize_avatars' },
    { group: 'Character Handling', id: 'background_thumbnails_animation', label: 'Animated background thumbnails', type: 'boolean', selector: '#background_thumbnails_animation' },
    { group: 'Character Handling', id: 'show_card_avatar_urls', label: 'Show avatar filenames', type: 'boolean', selector: '#show_card_avatar_urls' },
    { group: 'Character Handling', id: 'spoiler_free_mode', label: 'Spoiler Free Mode', type: 'boolean', selector: '#spoiler_free_mode' },
    { group: 'Miscellaneous', id: 'smooth_streaming', label: 'Smooth Streaming', type: 'boolean', selector: '#smooth_streaming' },
    { group: 'Miscellaneous', id: 'smooth_streaming_no_think', label: 'Exclude Thinking from Smooth Streaming', type: 'boolean', selector: '#smooth_streaming_no_think' },
    { group: 'Miscellaneous', id: 'smooth_streaming_speed', label: 'Smooth Streaming Speed', type: 'number', selector: '#smooth_streaming_speed' },
    { group: 'Miscellaneous', id: 'stream_fade_in', label: 'Stream Fade-In', type: 'boolean', selector: '#stream_fade_in' },
    { group: 'Miscellaneous', id: 'play_message_sound', label: 'Message Sound', type: 'boolean', selector: '#play_message_sound' },
    { group: 'Miscellaneous', id: 'play_sound_unfocused', label: 'Background Sound Only', type: 'boolean', selector: '#play_sound_unfocused' },
    { group: 'Miscellaneous', id: 'relaxed_api_urls', label: 'Relaxed API URLs', type: 'boolean', selector: '#relaxed_api_urls' },
    { group: 'Miscellaneous', id: 'world_import_dialog', label: 'Lorebook Import Dialog', type: 'boolean', selector: '#world_import_dialog' },
    { group: 'Miscellaneous', id: 'enable_auto_select_input', label: 'Auto-select Input Text', type: 'boolean', selector: '#enable_auto_select_input' },
    { group: 'Miscellaneous', id: 'enable_md_hotkeys', label: 'Markdown Hotkeys', type: 'boolean', selector: '#enable_md_hotkeys' },
    { group: 'Miscellaneous', id: 'restore_user_input', label: 'Restore User Input', type: 'boolean', selector: '#restore_user_input' },
    { group: 'Miscellaneous', id: 'movingUI', label: 'MovingUI', type: 'boolean', selector: '#movingUImode' },
    { group: 'Miscellaneous', id: 'movingUIPreset', label: 'MovingUI Preset', type: 'select', selector: '#movingUIPresets' },
    { group: 'Miscellaneous', id: 'custom_css', label: 'Custom CSS', type: 'text', selector: '#customCSS' },
    { group: 'Chat / Message Handling', id: 'chat_truncation', label: '# Msg. to Load', type: 'number', selector: '#chat_truncation' },
    { group: 'Chat / Message Handling', id: 'streaming_fps', label: 'Streaming FPS', type: 'number', selector: '#streaming_fps' },
    { group: 'Chat / Message Handling', id: 'example_messages_behavior', label: 'Example Messages Behavior', type: 'select', selector: '#example_messages_behavior' },
    { group: 'Chat / Message Handling', id: 'image_overswipe', label: 'Image Swipe Behavior', type: 'select', selector: '#image_overswipe' },
    { group: 'Chat / Message Handling', id: 'send_on_enter', label: 'Enter to Send', type: 'select', selector: '#send_on_enter' },
    { group: 'Chat / Message Handling', id: 'continue_on_send', label: '"Send" to Continue', type: 'boolean', selector: '#continue_on_send' },
    { group: 'Chat / Message Handling', id: 'quick_continue', label: 'Quick "Continue" button', type: 'boolean', selector: '#quick_continue' },
    { group: 'Chat / Message Handling', id: 'quick_impersonate', label: 'Quick "Impersonate" button', type: 'boolean', selector: '#quick_impersonate' },
    { group: 'Chat / Message Handling', id: 'swipes', label: 'Swipes', type: 'boolean', selector: '#swipes-checkbox' },
    { group: 'Chat / Message Handling', id: 'gestures', label: 'Gestures', type: 'boolean', selector: '#gestures-checkbox' },
    { group: 'Chat / Message Handling', id: 'auto_load_chat', label: 'Auto-load Last Chat', type: 'boolean', selector: '#auto-load-chat-checkbox' },
    { group: 'Chat / Message Handling', id: 'auto_scroll_chat_to_bottom', label: 'Auto-scroll Chat', type: 'boolean', selector: '#auto_scroll_chat_to_bottom' },
    { group: 'Chat / Message Handling', id: 'auto_save_msg_edits', label: 'Auto-save Message Edits', type: 'boolean', selector: '#auto_save_msg_edits' },
    { group: 'Chat / Message Handling', id: 'confirm_message_delete', label: 'Confirm message deletion', type: 'boolean', selector: '#confirm_message_delete' },
    { group: 'Chat / Message Handling', id: 'auto_fix_generated_markdown', label: 'Auto-fix Markdown', type: 'boolean', selector: '#auto_fix_generated_markdown' },
    { group: 'Chat / Message Handling', id: 'forbid_external_media', label: 'Forbid External Media', type: 'boolean', selector: '#forbid_external_media' },
    { group: 'Chat / Message Handling', id: 'allow_name2_display', label: 'Show {{char}}: in responses', type: 'boolean', selector: '#allow_name2_display' },
    { group: 'Chat / Message Handling', id: 'allow_name1_display', label: 'Show {{user}}: in responses', type: 'boolean', selector: '#allow_name1_display' },
    { group: 'Chat / Message Handling', id: 'encode_tags', label: 'Show <tags> in responses', type: 'boolean', selector: '#encode_tags' },
    { group: 'Chat / Message Handling', id: 'experimental_macro_engine', label: 'Experimental Macro Engine', type: 'boolean', selector: '#experimental_macro_engine' },
    { group: 'Chat / Message Handling', id: 'disable_group_trimming', label: 'Relax message trim in Groups', type: 'boolean', selector: '#disable_group_trimming' },
    { group: 'Chat / Message Handling', id: 'console_log_prompts', label: 'Log prompts to console', type: 'boolean', selector: '#console_log_prompts' },
    { group: 'Chat / Message Handling', id: 'request_token_probabilities', label: 'Request token probabilities', type: 'boolean', selector: '#request_token_probabilities' },
    { group: 'Chat / Message Handling', id: 'show_group_chat_queue', label: 'Show group chat queue', type: 'boolean', selector: '#show_group_chat_queue' },
    { group: 'Chat / Message Handling', id: 'pin_styles', label: 'Pin greeting message styles', type: 'boolean', selector: '#pin_styles' },
    { group: 'Auto-swipe', id: 'auto_swipe', label: 'Auto-swipe', type: 'boolean', selector: '#auto_swipe' },
    { group: 'Auto-swipe', id: 'auto_swipe_minimum_length', label: 'Minimum generated length', type: 'number', selector: '#auto_swipe_minimum_length' },
    { group: 'Auto-swipe', id: 'auto_swipe_blacklist', label: 'Blacklist words', type: 'text', selector: '#auto_swipe_blacklist' },
    { group: 'Auto-swipe', id: 'auto_swipe_blacklist_threshold', label: 'Blacklist threshold', type: 'number', selector: '#auto_swipe_blacklist_threshold' },
    { group: 'Auto-Continue', id: 'auto_continue.enabled', label: 'Auto-Continue', type: 'boolean', selector: '#auto_continue_enabled' },
    { group: 'Auto-Continue', id: 'auto_continue.allow_chat_completions', label: 'Allow Chat Completion', type: 'boolean', selector: '#auto_continue_allow_chat_completions' },
    { group: 'Auto-Continue', id: 'auto_continue.target_length', label: 'Target length', type: 'number', selector: '#auto_continue_target_length' },
    { group: 'Advanced Formatting', id: 'single_line', label: 'Single line mode', type: 'boolean', selector: '#single_line' },
    { group: 'Advanced Formatting', id: 'trim_spaces', label: 'Trim spaces', type: 'boolean', selector: '#trim_spaces' },
    { group: 'Advanced Formatting', id: 'collapse_newlines', label: 'Collapse newlines', type: 'boolean', selector: '#collapse-newlines-checkbox' },
    { group: 'Advanced Formatting', id: 'always_force_name2', label: 'Always force character name', type: 'boolean', selector: '#always-force-name2-checkbox' },
    { group: 'Advanced Formatting', id: 'trim_sentences', label: 'Trim incomplete sentences', type: 'boolean', selector: '#trim_sentences_checkbox' },
    { group: 'Advanced Formatting', id: 'markdown_escape_strings', label: 'Markdown escape strings', type: 'text', selector: '#markdown_escape_strings' },
    { group: 'Advanced Formatting', id: 'start_reply_with', label: 'Start reply with', type: 'text', selector: '#start_reply_with' },
    { group: 'Advanced Formatting', id: 'custom_stopping_strings_macro', label: 'Stopping strings macros', type: 'boolean', selector: '#custom_stopping_strings_macro' },
    { group: 'Tokenization', id: 'tokenizer', label: 'Tokenizer', type: 'select', selector: '#tokenizer' },
    { group: 'Tokenization', id: 'token_padding', label: 'Token padding', type: 'number', selector: '#token_padding' },
    { group: 'Personas / Tags', id: 'persona_show_notifications', label: 'Persona notifications', type: 'boolean', selector: '#persona_show_notifications' },
    { group: 'Personas / Tags', id: 'persona_allow_multi_connections', label: 'Persona multi-connections', type: 'boolean', selector: '#persona_allow_multi_connections' },
    { group: 'Personas / Tags', id: 'persona_auto_lock', label: 'Persona auto-lock', type: 'boolean', selector: '#persona_auto_lock' },
    { group: 'Personas / Tags', id: 'show_tag_filters', label: 'Show tag filters', type: 'boolean' },
    { group: 'STscript', id: 'stscript.autocomplete.state', label: 'Autocomplete', type: 'select', selector: '#stscript_autocomplete_state' },
    { group: 'STscript', id: 'stscript.autocomplete.autoHide', label: 'Automatically hide details', type: 'boolean', selector: '#stscript_autocomplete_autoHide' },
    { group: 'STscript', id: 'stscript.autocomplete.showInAllMacroFields', label: 'Show in all macro fields', type: 'boolean', selector: '#stscript_autocomplete_showInAllMacroFields' },
    { group: 'STscript', id: 'stscript.matching', label: 'Matching', type: 'select', selector: '#stscript_matching' },
    { group: 'STscript', id: 'stscript.autocomplete.style', label: 'Autocomplete style', type: 'select', selector: '#stscript_autocomplete_style' },
    { group: 'STscript', id: 'stscript.autocomplete.select', label: 'Autocomplete keyboard', type: 'select', selector: '#stscript_autocomplete_select' },
    { group: 'STscript', id: 'stscript.autocomplete.font.scale', label: 'Autocomplete font scale', type: 'number', selector: '#stscript_autocomplete_font_scale' },
    { group: 'STscript', id: 'stscript.autocomplete.width.left', label: 'Autocomplete width left', type: 'number', selector: '#stscript_autocomplete_width_left' },
    { group: 'STscript', id: 'stscript.autocomplete.width.right', label: 'Autocomplete width right', type: 'number', selector: '#stscript_autocomplete_width_right' },
    { group: 'STscript', id: 'stscript.parser.flags.STRICT_ESCAPING', label: 'Strict escaping', type: 'boolean', selector: '#stscript_parser_flag_strict_escaping' },
    { group: 'STscript', id: 'stscript.parser.flags.REPLACE_GETVAR', label: 'Replace getvar', type: 'boolean', selector: '#stscript_parser_flag_replace_getvar' },
];

function getUserSettingDefinition(target) {
    const id = typeof target === 'object' ? target?.id : target;
    return userSettingDefinitions.find(setting => setting.id === id) ?? null;
}

function getUserSettingTargets() {
    return userSettingDefinitions.map(setting => makeTarget(setting.id, setting.label, {
        group: setting.group,
        type: setting.type,
    }));
}

function getUserSettingValue(target) {
    const setting = getUserSettingDefinition(target);
    if (!setting) {
        return undefined;
    }

    const selector = setting.selector;
    const element = selector ? document.querySelector(selector) : null;
    if (element && setting.attribute) {
        return element.getAttribute(setting.attribute) ?? getByPath(power_user, setting.id);
    }
    if (selector && element) {
        return getDomValue(selector);
    }

    return getByPath(power_user, setting.id);
}

function getUserSettingValues(target) {
    const setting = getUserSettingDefinition(target);
    if (!setting) {
        return [];
    }

    if (setting.writeSelector) {
        return Array.from(document.querySelectorAll(setting.writeSelector))
            .filter(element => element instanceof HTMLInputElement)
            .map(element => makeTarget(element.value, element.closest('label')?.textContent?.trim() || element.value));
    }

    const element = setting.selector ? document.querySelector(setting.selector) : null;
    if (element instanceof HTMLSelectElement) {
        return getSelectOptions(element);
    }

    return [];
}

function setUserSettingValue(target, value) {
    const setting = getUserSettingDefinition(target);
    if (!setting) {
        warn(`User setting not found: ${target?.id ?? target}`);
        return false;
    }

    if (setting.writeSelector && setting.type === 'select') {
        const option = Array.from(document.querySelectorAll(setting.writeSelector))
            .find(element => element instanceof HTMLInputElement && String(element.value) === String(value));
        if (option instanceof HTMLInputElement) {
            option.checked = true;
            option.dispatchEvent(new Event('input', { bubbles: true }));
            option.dispatchEvent(new Event('change', { bubbles: true }));
            return false;
        }
    }

    const element = setting.selector ? document.querySelector(setting.selector) : null;
    if (element && setting.attribute) {
        const nextValue = String(value ?? '');
        if (element.getAttribute(setting.attribute) === nextValue) {
            return false;
        }
        element.setAttribute(setting.attribute, nextValue);
        element.dispatchEvent(new CustomEvent('change', {
            bubbles: true,
            detail: { rgba: nextValue },
        }));
        return false;
    }

    if (setting.selector && element) {
        return setDomValue(setting.selector, value);
    }

    const typedValue = setting.type === 'boolean'
        ? parseBoolean(value)
        : setting.type === 'number'
            ? Number(value)
            : value;
    const changed = setByPath(power_user, setting.id, typedValue);
    if (changed) {
        saveSettings();
        eventSource.emit(event_types.SETTINGS_UPDATED);
    }
    return false;
}

function getCurrentApiId() {
    return String(getContext().mainApi || '');
}

function getPresetParameterDefinition(target) {
    const id = typeof target === 'object' ? target?.id : target;
    return presetParameterDefinitions.find(parameter => parameter.id === id) ?? null;
}

function getPresetParameterSelector(target) {
    const parameter = getPresetParameterDefinition(target);
    if (!parameter) {
        return '';
    }
    return parameter.selectors[getCurrentApiId()] || '';
}

function getPresetParameterTargets() {
    return presetParameterDefinitions
        .filter(parameter => !!getPresetParameterSelector(parameter.id))
        .map(parameter => makeTarget(parameter.id, parameter.label, { type: parameter.type }));
}

function getModelSelectSelector(source = oai_settings.chat_completion_source) {
    const selectors = {
        openai: '#model_openai_select',
        claude: '#model_claude_select',
        openrouter: '#model_openrouter_select',
        ai21: '#model_ai21_select',
        mistralai: '#model_mistralai_select',
        custom: '#model_custom_select',
        cohere: '#model_cohere_select',
        perplexity: '#model_perplexity_select',
        groq: '#model_groq_select',
        siliconflow: '#model_siliconflow_select',
        electronhub: '#model_electronhub_select',
        chutes: '#model_chutes_select',
        nanogpt: '#model_nanogpt_select',
        deepseek: '#model_deepseek_select',
        aimlapi: '#model_aimlapi_select',
        xai: '#model_xai_select',
        pollinations: '#model_pollinations_select',
        moonshot: '#model_moonshot_select',
        fireworks: '#model_fireworks_select',
        cometapi: '#model_cometapi_select',
        makersuite: '#model_google_select',
        vertexai: '#model_vertexai_select',
        zai: '#model_zai_select',
        azure_openai: '#azure_openai_model',
    };

    return selectors[source] || '';
}

function getChatSourceId(target) {
    return typeof target === 'object' ? target?.id ?? '' : target ?? '';
}

function getChatSourceLabel(sourceId) {
    return getSelectOptions('#chat_completion_source')
        .find(source => String(source.id) === String(sourceId))?.label || sourceId || 'Current source';
}

function getModelOptionsForSource(target = '') {
    const source = getChatSourceId(target) || oai_settings.chat_completion_source;
    const currentModel = source === oai_settings.chat_completion_source ? getChatCompletionModel?.() ?? '' : '';
    const fallback = currentModel ? [makeTarget(currentModel, currentModel)] : [];
    return getSelectOptions(getModelSelectSelector(source), fallback);
}

function getRegexScriptType(scriptId) {
    for (const scriptType of Object.values(SCRIPT_TYPES)) {
        if (getScriptsByType(scriptType).some(script => script.id === scriptId)) {
            return scriptType;
        }
    }
    return null;
}

function findRegexScript(target) {
    const targetId = typeof target === 'object' ? target.id : target;
    const targetName = typeof target === 'object' ? target.name : target;
    const targetType = typeof target === 'object' ? target.type : null;
    const scripts = targetType ? getScriptsByType(targetType) : getRegexScripts();
    return scripts.find(script => [script.id, script.scriptName, script.findRegex].includes(targetId) || script.scriptName === targetName);
}

async function saveRegexScript(script) {
    const scriptType = getRegexScriptType(script.id);
    if (scriptType === null) {
        return false;
    }
    await saveScriptsByType(getScriptsByType(scriptType), scriptType);
    return true;
}

function findPromptIdentifierByName(name) {
    if (!promptManager?.activeCharacter || !name) {
        return '';
    }
    const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter) ?? [];
    const prompts = order.map(entry => ({
        identifier: entry.identifier,
        name: getPromptName(entry.identifier),
    }));
    return prompts.find(prompt => prompt.name === name)?.identifier
        || prompts.find(prompt => prompt.name.toLowerCase() === String(name).toLowerCase())?.identifier
        || '';
}

function resolvePromptIdentifier(target) {
    if (typeof target === 'object') {
        const identifier = target?.identifier || String(target?.id || '');
        const name = target?.name || target?.label || '';
        if (target?.matchBy === 'name' && name) {
            return findPromptIdentifierByName(name) || identifier;
        }
        if (identifier && getPromptByIdentifier(identifier)) {
            return identifier;
        }
        return name ? findPromptIdentifierByName(name) || identifier : identifier;
    }
    return target;
}

function getPromptByIdentifier(identifier) {
    return promptManager?.getPromptById?.(identifier) ?? null;
}

function getPromptOrderEntry(target) {
    const identifier = resolvePromptIdentifier(target);
    if (!promptManager || !identifier) {
        return null;
    }
    try {
        return promptManager.getPromptOrderEntry(promptManager.activeCharacter, identifier);
    } catch {
        return null;
    }
}

function getPrompt(target) {
    return getPromptByIdentifier(resolvePromptIdentifier(target));
}

function getPromptName(identifier) {
    const prompt = getPromptByIdentifier(identifier);
    return prompt?.name || identifier;
}

function getPromptTargets() {
    if (!promptManager?.activeCharacter) {
        return [];
    }
    const order = promptManager.getPromptOrderForCharacter(promptManager.activeCharacter) ?? [];
    return order.map(entry => makeTarget(entry.identifier, getPromptName(entry.identifier), {
        identifier: entry.identifier,
        name: getPromptName(entry.identifier),
        matchBy: 'identifier',
    }));
}

const promptSettingDefinitions = [
    {
        id: 'enabled',
        label: 'Enabled',
        type: 'boolean',
        coerce: value => parseBoolean(value),
        display: value => stringifyValue(value),
    },
    {
        id: 'role',
        label: 'Role',
        type: 'select',
        values: [
            makeTarget('system', 'System'),
            makeTarget('user', 'User'),
            makeTarget('assistant', 'AI Assistant'),
        ],
    },
    {
        id: 'injection_position',
        label: 'Position',
        type: 'select',
        values: [
            makeTarget(String(INJECTION_POSITION.RELATIVE), 'Relative'),
            makeTarget(String(INJECTION_POSITION.ABSOLUTE), 'In-chat'),
        ],
        coerce: value => Number(value),
        display: value => Number(value) === INJECTION_POSITION.ABSOLUTE ? 'In-chat' : 'Relative',
    },
    { id: 'injection_depth', label: 'Depth', type: 'number', coerce: value => Number(value) },
    { id: 'injection_order', label: 'Order', type: 'number', coerce: value => Number(value) },
    {
        id: 'injection_trigger',
        label: 'Triggers',
        type: 'text',
        coerce: value => String(value || '').split(',').map(item => item.trim()).filter(Boolean),
        display: value => Array.isArray(value) ? value.join(', ') : String(value ?? ''),
    },
    { id: 'forbid_overrides', label: 'Forbid overrides', type: 'boolean', coerce: value => parseBoolean(value) },
];

function getPromptSettingDefinition(field) {
    return promptSettingDefinitions.find(setting => setting.id === field) ?? null;
}

function getPromptSettingTargets() {
    return getPromptTargets().flatMap(prompt => promptSettingDefinitions.map(setting => makeTarget(
        `${prompt.identifier}.${setting.id}`,
        `${prompt.label}: ${setting.label}`,
        {
            identifier: prompt.identifier,
            field: setting.id,
            group: prompt.label,
        },
    )));
}

function parsePromptSettingTarget(target) {
    if (typeof target === 'object') {
        return {
            identifier: target.identifier || String(target.id || '').split('.')[0],
            field: target.field || String(target.id || '').split('.').slice(1).join('.'),
        };
    }

    const [identifier, ...fieldParts] = String(target || '').split('.');
    return { identifier, field: fieldParts.join('.') };
}

function savePromptManagerSettings() {
    promptManager?.render?.();
    promptManager?.saveServiceSettings?.();
}

function readPromptField(target, field) {
    const prompt = getPrompt(target);
    if (field === 'enabled') {
        return !!getPromptOrderEntry(target)?.enabled;
    }
    const value = prompt?.[field];
    return field === 'injection_trigger'
        ? (Array.isArray(value) ? value.join(', ') : String(value ?? ''))
        : value;
}

function getPromptState(target) {
    return Object.fromEntries(promptSettingDefinitions.map(setting => [setting.id, readPromptField(target, setting.id)]));
}

function writePromptFields(target, fields) {
    const identifier = resolvePromptIdentifier(target);
    const prompt = getPrompt(target);
    const entry = getPromptOrderEntry(target);
    if (!prompt || !entry) {
        warn(`Prompt not found: ${target?.identifier || target?.id || target}`);
        return false;
    }

    let changed = false;
    for (const [field, value] of Object.entries(fields ?? {})) {
        const setting = getPromptSettingDefinition(field);
        if (!setting) {
            continue;
        }
        const nextValue = setting.coerce ? setting.coerce(value) : value;
        if (field === 'enabled') {
            if (!!entry.enabled !== !!nextValue) {
                entry.enabled = !!nextValue;
                changed = true;
            }
            continue;
        }
        const currentValue = prompt[field];
        if (JSON.stringify(currentValue ?? null) !== JSON.stringify(nextValue ?? null)) {
            prompt[field] = nextValue;
            changed = true;
        }
    }

    if (changed) {
        promptManager.updatePromptByIdentifier?.(identifier, prompt);
        savePromptManagerSettings();
    }

    return false;
}

function describePromptFields(value) {
    const description = Object.entries(value ?? {})
        .map(([field, fieldValue]) => {
            const setting = getPromptSettingDefinition(field);
            const label = setting?.label || field;
            const displayValue = setting?.display ? setting.display(fieldValue) : stringifyValue(fieldValue);
            return `${label} = ${displayValue}`;
        })
        .join(', ');
    return description || 'No changes';
}

const messageMatchRoleOptions = [
    makeTarget('any', 'Any message'),
    makeTarget('user', 'User messages'),
    makeTarget('character', 'Character messages'),
    makeTarget('system', 'System messages'),
];

const messageMatchScopeOptions = [
    makeTarget('last', 'Last message'),
    makeTarget('recent', 'Last messages'),
    makeTarget('all', 'Whole chat'),
];

function normalizeMessageMatchValue(value) {
    const source = value && typeof value === 'object' ? value : { pattern: value };
    const depth = Number(source.depth ?? 1);
    const scope = messageMatchScopeOptions.some(option => option.id === source.scope)
        ? source.scope
        : depth === 0
            ? 'all'
            : depth > 1
                ? 'recent'
                : 'last';
    const normalizedDepth = Number.isFinite(depth) && depth > 0 ? Math.floor(depth) : 1;
    return {
        mode: source.mode === 'regex' ? 'regex' : 'text',
        pattern: String(source.pattern ?? ''),
        scope,
        depth: scope === 'recent' ? Math.max(2, normalizedDepth) : normalizedDepth,
        role: messageMatchRoleOptions.some(option => option.id === source.role) ? source.role : 'any',
        caseSensitive: parseBoolean(source.caseSensitive),
    };
}

function messageMatchesRole(message, role) {
    if (role === 'user') {
        return !!message?.is_user;
    }
    if (role === 'character') {
        return !message?.is_user && !message?.is_system;
    }
    if (role === 'system') {
        return !!message?.is_system;
    }
    return true;
}

function parseRegexPattern(pattern, caseSensitive) {
    const source = String(pattern ?? '');
    const lastSlash = source.lastIndexOf('/');
    if (source.startsWith('/') && lastSlash > 0) {
        const body = source.slice(1, lastSlash);
        const flags = source.slice(lastSlash + 1);
        const normalizedFlags = Array.from(new Set((caseSensitive ? flags.replaceAll('i', '') : `${flags}i`).split(''))).join('');
        return new RegExp(body, normalizedFlags);
    }
    return new RegExp(source, caseSensitive ? '' : 'i');
}

function messageTextMatches(messageText, config) {
    if (!config.pattern) {
        return false;
    }
    if (config.mode === 'regex') {
        try {
            return parseRegexPattern(config.pattern, config.caseSensitive).test(messageText);
        } catch (error) {
            logDebug('Invalid message regex', config.pattern, error);
            return false;
        }
    }
    const haystack = config.caseSensitive ? messageText : messageText.toLowerCase();
    const needle = config.caseSensitive ? config.pattern : config.pattern.toLowerCase();
    return haystack.includes(needle);
}

function readMessageMatch(value) {
    const config = normalizeMessageMatchValue(value);
    const depth = config.scope === 'all'
        ? chat.length
        : config.scope === 'recent'
            ? Math.min(config.depth, chat.length)
            : Math.min(1, chat.length);
    const messages = chat.slice(Math.max(0, chat.length - depth));
    const matched = messages.some(message => (
        messageMatchesRole(message, config.role)
        && messageTextMatches(String(message?.mes ?? ''), config)
    ));
    return matched ? value : null;
}

function describeMessageMatch(value) {
    const config = normalizeMessageMatchValue(value);
    const mode = config.mode === 'regex' ? 'regex' : 'text';
    const scope = config.scope === 'all'
        ? 'whole chat'
        : config.scope === 'recent'
            ? `last ${config.depth} messages`
            : 'last message';
    const role = messageMatchRoleOptions.find(option => option.id === config.role)?.label || 'Any message';
    const sensitivity = config.caseSensitive ? ', case sensitive' : '';
    return `${role} in ${scope} contain ${mode} "${config.pattern}"${sensitivity}`;
}

function getDomValue(selector) {
    const element = document.querySelector(selector);
    if (!element) {
        return undefined;
    }

    if (element instanceof HTMLInputElement && element.type === 'checkbox') {
        return element.checked;
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        return element.value;
    }
    if (element.getAttribute('aria-checked') !== null) {
        return element.getAttribute('aria-checked') === 'true';
    }
    return element.textContent?.trim() ?? '';
}

function setDomValue(selector, value) {
    const element = document.querySelector(selector);
    if (!element) {
        warn(`DOM target not found: ${selector}`);
        return false;
    }

    if (element instanceof HTMLInputElement && element.type === 'checkbox') {
        const next = parseBoolean(value);
        if (element.checked === next) {
            return false;
        }
        element.checked = next;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return false;
    }

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        if (String(element.value) === String(value ?? '')) {
            return false;
        }
        element.value = String(value ?? '');
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return false;
    }

    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return false;
}

function makeTarget(id, label, extra = {}) {
    return { id, label: label || id, ...extra };
}

const adapters = new Map();

function registerAdapter(adapter) {
    adapters.set(adapter.id, adapter);
}

function getAdapter(id) {
    return adapters.get(id);
}

function getAdaptersByCategory(category) {
    return Array.from(adapters.values()).filter(adapter => adapter.category === category);
}

function getBlockTargetLabel(block) {
    const adapter = getAdapter(block.adapter);
    if (!adapter) {
        return block.label || String(block.target ?? '');
    }
    return adapter.targetLabel?.(block.target) || block.label || String(block.target?.label ?? block.target?.id ?? block.target ?? '');
}

function describeBlock(block, mode = 'condition') {
    const adapter = getAdapter(block.adapter);
    if (!adapter) {
        return `Unknown block ${block.adapter}`;
    }
    if (adapter.describe) {
        return adapter.describe(block, mode);
    }
    return `${adapter.label}: ${getBlockTargetLabel(block)} = ${stringifyValue(block.value)}`;
}

function stringifyValue(value) {
    if (typeof value === 'boolean') {
        return value ? 'enabled' : 'disabled';
    }
    if (Array.isArray(value)) {
        return value.join(', ');
    }
    if (value && typeof value === 'object') {
        return Object.entries(value).map(([key, entryValue]) => `${key}: ${stringifyValue(entryValue)}`).join(', ');
    }
    return String(value ?? '');
}

function getBlockSnapshotKey(block) {
    const adapter = getAdapter(block.adapter);
    const targetId = adapter?.snapshotKey?.(block) ?? builderTargetId(block.target);
    return `${block.adapter}:${targetId}`;
}

async function captureResultSnapshots(blocks) {
    const snapshots = {};
    const applied = {};

    for (const block of blocks) {
        const adapter = getAdapter(block.adapter);
        if (!adapter?.snapshotBeforeApply || !adapter.read) {
            continue;
        }

        const key = getBlockSnapshotKey(block);
        snapshots[key] = await readBlock(block);
        applied[key] = block.value;
    }

    return { snapshots, applied };
}

function invertBlock(block, appliedState = {}) {
    const adapter = getAdapter(block.adapter);
    const snapshotKey = getBlockSnapshotKey(block);
    if (adapter?.snapshotBeforeApply && Object.hasOwn(appliedState.snapshots ?? {}, snapshotKey)) {
        return {
            ...block,
            value: appliedState.snapshots[snapshotKey],
            snapshotRestore: true,
            snapshotAppliedValue: appliedState.applied?.[snapshotKey] ?? block.value,
        };
    }

    if (!adapter?.invert) {
        return null;
    }
    const inverted = adapter.invert(block);
    return inverted ? normalizeBlock(inverted) : null;
}

async function runSlash(command, value, namedArgs = {}) {
    const args = Object.entries(namedArgs).map(([key, argValue]) => `${key}=${quoteSlashValue(argValue)}`);
    const text = [`/${command}`, ...args, quoteSlashValue(value)].join(' ');
    await executeSlashCommandsWithOptions(text, {
        handleExecutionErrors: true,
        source: 'Silly Linkify',
    });
}

registerAdapter({
    id: 'theme.active',
    category: 'theme',
    label: 'Active theme',
    icon: 'fa-palette',
    writable: true,
    valueType: 'select',
    snapshotBeforeApply: true,
    listTargets: () => [makeTarget('active', 'Active theme')],
    listValues: () => getThemeOptions(),
    read: () => power_user.theme ?? '',
    write: block => setDomValue('#themes', block.value),
    describe: block => `Theme is "${stringifyValue(block.value)}"`,
});

registerAdapter({
    id: 'lorebook.global',
    category: 'lorebook',
    label: 'Global lorebook',
    icon: 'fa-book',
    writable: true,
    reversible: true,
    valueType: 'boolean',
    listTargets: () => getLorebookOptions(),
    read: block => selected_world_info.includes(block.target?.id ?? block.target),
    write: block => setGlobalLorebookEnabled(block.target?.id ?? block.target, parseBoolean(block.value)),
    invert: block => ({ ...block, value: !parseBoolean(block.value) }),
    describe: block => `Global lorebook "${getBlockTargetLabel(block)}" = ${stringifyValue(block.value)}`,
});

registerAdapter({
    id: 'lorebook.chat',
    category: 'lorebook',
    label: 'Chat lorebook',
    icon: 'fa-comments',
    writable: true,
    valueType: 'select',
    snapshotBeforeApply: true,
    listTargets: () => [makeTarget('chat', 'Current chat lorebook')],
    listValues: () => getLorebookOptions(true),
    read: () => chat_metadata[METADATA_KEY] ?? '',
    write: async block => {
        const next = String(block.value || '');
        if (next && !(world_names ?? []).includes(next)) {
            warn(`Lorebook not found: ${next}`);
            return false;
        }
        if (String(chat_metadata[METADATA_KEY] ?? '') === next) {
            return false;
        }
        if (next) {
            chat_metadata[METADATA_KEY] = next;
        } else {
            delete chat_metadata[METADATA_KEY];
        }
        $('.chat_lorebook_button').toggleClass('world_set', !!next);
        await saveMetadata();
        await eventSource.emit(event_types.WORLDINFO_SETTINGS_UPDATED);
        return false;
    },
    describe: block => `Chat lorebook = "${getLorebookLabel(block.value)}"`,
});

registerAdapter({
    id: 'lorebook.characterPrimary',
    category: 'lorebook',
    label: 'Character main lorebook',
    icon: 'fa-address-book',
    writable: true,
    valueType: 'select',
    snapshotBeforeApply: true,
    listTargets: () => getCurrentCharacter() ? [makeTarget('current', 'Current character main lorebook')] : [],
    listValues: () => getLorebookOptions(true),
    read: () => getCurrentCharacter()?.data?.extensions?.world ?? '',
    write: async block => {
        const next = String(block.value || '');
        if (next && !(world_names ?? []).includes(next)) {
            warn(`Lorebook not found: ${next}`);
            return false;
        }
        if (String(getCurrentCharacter()?.data?.extensions?.world ?? '') === next) {
            return false;
        }
        await charUpdatePrimaryWorld(next);
        await eventSource.emit(event_types.WORLDINFO_SETTINGS_UPDATED);
        return false;
    },
    describe: block => `Character main lorebook = "${getLorebookLabel(block.value)}"`,
});

registerAdapter({
    id: 'lorebook.characterExtra',
    category: 'lorebook',
    label: 'Character extra lorebook',
    icon: 'fa-bookmark',
    writable: true,
    reversible: true,
    valueType: 'boolean',
    listTargets: () => getCurrentCharacter() ? getLorebookOptions() : [],
    read: block => getCurrentCharacterExtraLorebooks().includes(block.target?.id ?? block.target),
    write: block => {
        const book = block.target?.id ?? block.target;
        const fileName = getCurrentCharacterFileName();
        if (!fileName || !book || !(world_names ?? []).includes(book)) {
            warn(`Lorebook not found: ${book}`);
            return false;
        }
        const current = getCurrentCharacterExtraLorebooks();
        const enabled = parseBoolean(block.value);
        const next = enabled
            ? Array.from(new Set([...current, book]))
            : current.filter(name => name !== book);
        if (current.length === next.length && current.every((name, index) => name === next[index])) {
            return false;
        }
        charSetAuxWorlds(fileName, next);
        eventSource.emit(event_types.WORLDINFO_SETTINGS_UPDATED);
        return false;
    },
    invert: block => ({ ...block, value: !parseBoolean(block.value) }),
    describe: block => `Character extra lorebook "${getBlockTargetLabel(block)}" = ${stringifyValue(block.value)}`,
});

registerAdapter({
    id: 'lorebook.entryEnabled',
    category: 'lorebook',
    label: 'Lorebook entry',
    icon: 'fa-list-check',
    writable: true,
    reversible: true,
    valueType: 'boolean',
    listTargets: () => runtime.lorebookEntryTargets,
    read: async block => {
        const { book, uid } = parseLorebookEntryTarget(block.target);
        const data = book ? await loadWorldInfo(book) : null;
        const entry = findLorebookEntry(data, uid);
        return entry ? !entry.disable : undefined;
    },
    write: async block => {
        const { book, uid } = parseLorebookEntryTarget(block.target);
        const data = book ? await loadWorldInfo(book) : null;
        const entry = findLorebookEntry(data, uid);
        if (!entry) {
            warn(`Lorebook entry not found: ${getBlockTargetLabel(block)}`);
            return false;
        }
        const nextEnabled = parseBoolean(block.value);
        const currentEnabled = !entry.disable;
        if (currentEnabled === nextEnabled) {
            return false;
        }
        entry.disable = !nextEnabled;
        setWIOriginalDataValue(data, entry.uid, 'enabled', nextEnabled);
        await saveWorldInfo(book, data);
        return false;
    },
    invert: block => ({ ...block, value: !parseBoolean(block.value) }),
    describe: block => `Lorebook entry "${getBlockTargetLabel(block)}" = ${stringifyValue(block.value)}`,
});

registerAdapter({
    id: 'lorebook.openEditor',
    category: 'lorebook',
    label: 'Open lorebook editor',
    icon: 'fa-book-open',
    writable: true,
    valueType: 'select',
    listTargets: () => [makeTarget('editor', 'Lorebook editor')],
    listValues: () => getLorebookOptions(),
    read: () => getOpenLorebookName(),
    write: block => {
        if (!(world_names ?? []).includes(String(block.value || ''))) {
            warn(`Lorebook not found: ${block.value}`);
            return false;
        }
        openWorldInfoEditor(block.value);
        return false;
    },
    describe: block => `Open lorebook "${getLorebookLabel(block.value)}"`,
});

registerAdapter({
    id: 'preset.active',
    category: 'preset',
    label: 'Active preset',
    icon: 'fa-sliders',
    writable: true,
    valueType: 'select',
    listTargets: () => [makeTarget('current', 'Current API preset')],
    listValues: () => getCurrentPresetOptions(),
    read: block => getSelectedPresetName(block.target?.apiId || ''),
    write: async block => runSlash('preset', block.value),
    describe: block => `Preset is "${stringifyValue(block.value)}"`,
});

registerAdapter({
    id: 'preset.prompt',
    category: 'preset',
    label: 'Preset prompt',
    icon: 'fa-toggle-on',
    writable: true,
    valueType: 'custom',
    snapshotBeforeApply: true,
    targetCaption: 'Prompt',
    listTargets: () => getPromptTargets(),
    read: block => getPromptState(block.target),
    write: block => writePromptFields(block.target, block.value),
    renderValuePicker: renderPromptValuePicker,
    getBuilderValue: getPromptBuilderValue,
    describe: block => `Prompt "${getBlockTargetLabel(block)}": ${describePromptFields(block.value)}`,
});

registerAdapter({
    id: 'preset.promptToggle',
    category: 'preset',
    label: 'Preset prompt toggle',
    icon: 'fa-toggle-on',
    hidden: true,
    writable: true,
    reversible: true,
    valueType: 'boolean',
    listTargets: () => getPromptTargets(),
    read: block => !!getPromptOrderEntry(block.target)?.enabled,
    write: block => {
        const entry = getPromptOrderEntry(block.target);
        if (!entry) {
            warn(`Prompt toggle not found: ${block.target?.identifier || block.target?.id}`);
            return false;
        }
        const next = parseBoolean(block.value);
        if (!!entry.enabled === next) {
            return false;
        }
        entry.enabled = next;
        promptManager.render();
        promptManager.saveServiceSettings();
        return false;
    },
    invert: block => ({ ...block, value: !parseBoolean(block.value) }),
    describe: block => `Prompt "${getBlockTargetLabel(block)}" = ${stringifyValue(block.value)}`,
});

registerAdapter({
    id: 'preset.promptSetting',
    category: 'preset',
    label: 'Preset prompt setting',
    icon: 'fa-gear',
    hidden: true,
    writable: true,
    valueType: 'text',
    snapshotBeforeApply: true,
    targetCaption: 'Prompt setting',
    getValueType: target => getPromptSettingDefinition(parsePromptSettingTarget(target).field)?.type || 'text',
    listTargets: () => getPromptSettingTargets(),
    listValues: target => getPromptSettingDefinition(parsePromptSettingTarget(target).field)?.values ?? [],
    read: block => {
        const { field } = parsePromptSettingTarget(block.target);
        const prompt = getPrompt(block.target);
        const setting = getPromptSettingDefinition(field);
        const value = prompt?.[field];
        return field === 'injection_trigger' && setting?.display ? setting.display(value) : value;
    },
    write: block => {
        const { field } = parsePromptSettingTarget(block.target);
        const prompt = getPrompt(block.target);
        const setting = getPromptSettingDefinition(field);
        if (!prompt || !setting) {
            warn(`Prompt setting not found: ${getBlockTargetLabel(block)}`);
            return false;
        }
        const nextValue = setting.coerce ? setting.coerce(block.value) : block.value;
        const currentValue = prompt[field];
        if (JSON.stringify(currentValue ?? null) === JSON.stringify(nextValue ?? null)) {
            return false;
        }
        prompt[field] = nextValue;
        const identifier = resolvePromptIdentifier(block.target);
        promptManager.updatePromptByIdentifier?.(identifier, prompt);
        savePromptManagerSettings();
        return false;
    },
    describe: block => {
        const { field } = parsePromptSettingTarget(block.target);
        const setting = getPromptSettingDefinition(field);
        const value = setting?.display ? setting.display(block.value) : stringifyValue(block.value);
        return `Prompt setting "${getBlockTargetLabel(block)}" = ${value}`;
    },
});

registerAdapter({
    id: 'preset.parameter',
    category: 'preset',
    label: 'Preset parameter',
    icon: 'fa-sliders',
    writable: true,
    reversible: true,
    targetCaption: 'Parameter',
    valueType: 'text',
    getValueType: target => getPresetParameterDefinition(target)?.type || 'text',
    listTargets: () => getPresetParameterTargets(),
    read: block => {
        const selector = getPresetParameterSelector(block.target);
        return selector ? getDomValue(selector) : undefined;
    },
    write: block => {
        const selector = getPresetParameterSelector(block.target);
        return selector ? setDomValue(selector, block.value) : false;
    },
    invert: block => getPresetParameterDefinition(block.target)?.type === 'boolean'
        ? { ...block, value: !parseBoolean(block.value) }
        : null,
    describe: block => `Preset ${getBlockTargetLabel(block)} = ${stringifyValue(block.value)}`,
});

registerAdapter({
    id: 'regex.scriptEnabled',
    category: 'regex',
    label: 'Regex script',
    icon: 'fa-code',
    writable: true,
    reversible: true,
    valueType: 'boolean',
    listTargets: () => getRegexScripts().map(script => makeTarget(script.id, script.scriptName, {
        id: script.id,
        name: script.scriptName,
        type: getRegexScriptType(script.id),
    })),
    read: block => {
        const script = findRegexScript(block.target);
        return script ? !script.disabled : undefined;
    },
    write: async block => {
        const script = findRegexScript(block.target);
        if (!script) {
            warn(`Regex script not found: ${getBlockTargetLabel(block)}`);
            return false;
        }
        const nextEnabled = parseBoolean(block.value);
        const nextDisabled = !nextEnabled;
        if (!!script.disabled === nextDisabled) {
            return false;
        }
        script.disabled = nextDisabled;
        await saveRegexScript(script);
        return true;
    },
    invert: block => ({ ...block, value: !parseBoolean(block.value) }),
    describe: block => `Regex "${getBlockTargetLabel(block)}" = ${stringifyValue(block.value)}`,
});

registerAdapter({
    id: 'regex.preset',
    category: 'regex',
    label: 'Regex preset',
    icon: 'fa-list-check',
    writable: true,
    valueType: 'select',
    listValues: () => (extension_settings.regex_presets ?? []).map(preset => makeTarget(preset.id, preset.name)),
    listTargets: () => [makeTarget('selected', 'Selected regex preset')],
    read: () => (extension_settings.regex_presets ?? []).find(preset => preset.isSelected)?.id ?? '',
    write: async block => runSlash('regex-preset', block.value, { quiet: true }),
    describe: block => `Regex preset is "${getRegexPresetLabel(block.value)}"`,
});

registerAdapter({
    id: 'character.selected',
    category: 'character',
    label: 'Selected character',
    icon: 'fa-address-card',
    writable: true,
    valueType: 'select',
    listTargets: () => [makeTarget('selected', 'Selected character')],
    listValues: () => characters.map((character, index) => makeTarget(String(index), character.name || character.avatar || String(index), {
        avatar: character.avatar,
        avatarUrl: character.avatar ? getThumbnailUrl('avatar', character.avatar) : '',
        creator: character.data?.creator || character.creator || '',
    })),
    read: () => String(getContext().characterId ?? ''),
    write: async block => {
        const id = Number(block.value);
        if (!Number.isFinite(id)) {
            warn(`Invalid character id: ${block.value}`);
            return false;
        }
        if (String(getContext().characterId ?? '') === String(id)) {
            return false;
        }
        await selectCharacterById(id);
        return false;
    },
    describe: block => `Character is "${getCharacterLabel(block.value)}"`,
});

registerAdapter({
    id: 'character.chat',
    category: 'character',
    label: 'Current chat',
    icon: 'fa-comments',
    writable: false,
    valueType: 'text',
    listTargets: () => [makeTarget('chat', 'Current chat id')],
    read: () => getCurrentChatId() ?? '',
    describe: block => `Chat id = ${stringifyValue(block.value)}`,
});

registerAdapter({
    id: 'character.group',
    category: 'character',
    label: 'Selected group',
    icon: 'fa-user-group',
    writable: false,
    valueType: 'text',
    listTargets: () => [makeTarget('group', 'Selected group id')],
    read: () => getContext().groupId ?? '',
    describe: block => `Group id = ${stringifyValue(block.value)}`,
});

registerAdapter({
    id: 'chat.messageMatch',
    category: 'character',
    label: 'Message contains',
    icon: 'fa-magnifying-glass',
    writable: false,
    valueType: 'custom',
    listTargets: () => [makeTarget('recent', 'Recent messages')],
    read: block => readMessageMatch(block.value),
    renderValuePicker: renderMessageMatchValuePicker,
    getBuilderValue: getMessageMatchBuilderValue,
    validateBlock: block => normalizeMessageMatchValue(block.value).pattern ? '' : 'Enter text or regex to match.',
    describe: block => describeMessageMatch(block.value),
});

registerAdapter({
    id: 'api.main',
    category: 'api',
    label: 'Main API',
    icon: 'fa-plug',
    writable: true,
    valueType: 'select',
    listTargets: () => [makeTarget('main', 'Main API')],
    listValues: () => getSelectOptions('#main_api'),
    read: () => getContext().mainApi ?? '',
    write: async block => runSlash('api', block.value, { quiet: true }),
    describe: block => `Main API = ${stringifyValue(block.value)}`,
});

registerAdapter({
    id: 'api.chatSource',
    category: 'api',
    label: 'Chat Completion source',
    icon: 'fa-server',
    writable: true,
    valueType: 'select',
    listTargets: () => [makeTarget('source', 'Chat Completion source')],
    listValues: () => getSelectOptions('#chat_completion_source'),
    read: () => oai_settings.chat_completion_source ?? '',
    write: block => setDomValue('#chat_completion_source', block.value),
    describe: block => `Chat source = ${stringifyValue(block.value)}`,
});

registerAdapter({
    id: 'api.model',
    category: 'api',
    label: 'Chat Completion model',
    icon: 'fa-microchip',
    writable: true,
    valueType: 'select',
    targetCaption: 'Source',
    listTargets: () => getSelectOptions('#chat_completion_source'),
    getDefaultTarget: () => oai_settings.chat_completion_source ?? '',
    listValues: target => getModelOptionsForSource(target),
    read: block => {
        const source = getChatSourceId(block.target);
        if (source && source !== oai_settings.chat_completion_source) {
            return '';
        }
        return getChatCompletionModel?.() ?? '';
    },
    write: async block => {
        const source = getChatSourceId(block.target);
        if (source && source !== oai_settings.chat_completion_source) {
            setDomValue('#chat_completion_source', source);
        }
        return runSlash('model', block.value, { quiet: true });
    },
    describe: block => `Model on ${getChatSourceLabel(getChatSourceId(block.target))} = ${stringifyValue(block.value)}`,
});

registerAdapter({
    id: 'api.connectionProfile',
    category: 'api',
    label: 'Connection profile',
    icon: 'fa-id-badge',
    writable: true,
    valueType: 'select',
    listTargets: () => [makeTarget('profile', 'Loaded connection profile')],
    listValues: () => getConnectionProfiles().map(profile => makeTarget(profile.id, profile.name)),
    read: () => extension_settings.connectionManager?.selectedProfile ?? '',
    write: async block => runSlash('profile', block.value, { await: true }),
    describe: block => `Connection profile = "${getConnectionProfileLabel(block.value)}"`,
});

registerAdapter({
    id: 'quickReply.globalSet',
    category: 'quickReply',
    label: 'Global set',
    icon: 'fa-reply',
    writable: true,
    reversible: true,
    valueType: 'boolean',
    listTargets: () => globalThis.quickReplyApi?.listSets?.().map(name => makeTarget(name, name)) ?? [],
    read: block => globalThis.quickReplyApi?.listGlobalSets?.().includes(block.target?.id ?? block.target) ?? false,
    write: block => {
        const api = globalThis.quickReplyApi;
        if (!api) {
            logDebug('Quick Reply API is not available; skipping block', block);
            return false;
        }
        const name = block.target?.id ?? block.target;
        if (parseBoolean(block.value)) {
            api.addGlobalSet(name, true);
        } else {
            api.removeGlobalSet(name);
        }
        api.settings?.save?.();
        return false;
    },
    invert: block => ({ ...block, value: !parseBoolean(block.value) }),
    describe: block => `Quick Reply global "${getBlockTargetLabel(block)}" = ${stringifyValue(block.value)}`,
});

registerAdapter({
    id: 'quickReply.chatSet',
    category: 'quickReply',
    label: 'Chat set',
    icon: 'fa-comments',
    writable: true,
    reversible: true,
    valueType: 'boolean',
    listTargets: () => globalThis.quickReplyApi?.listSets?.().map(name => makeTarget(name, name)) ?? [],
    read: block => globalThis.quickReplyApi?.listChatSets?.().includes(block.target?.id ?? block.target) ?? false,
    write: block => {
        const api = globalThis.quickReplyApi;
        if (!api) {
            logDebug('Quick Reply API is not available; skipping block', block);
            return false;
        }
        const name = block.target?.id ?? block.target;
        if (parseBoolean(block.value)) {
            api.addChatSet(name, true);
        } else {
            api.removeChatSet(name);
        }
        api.settings?.save?.();
        return false;
    },
    invert: block => ({ ...block, value: !parseBoolean(block.value) }),
    describe: block => `Quick Reply chat "${getBlockTargetLabel(block)}" = ${stringifyValue(block.value)}`,
});

registerAdapter({
    id: 'userSettings.powerUser',
    category: 'userSettings',
    label: 'Tavern setting',
    icon: 'fa-user-gear',
    writable: true,
    valueType: 'text',
    snapshotBeforeApply: true,
    targetCaption: 'Setting',
    getValueType: target => getUserSettingDefinition(target)?.type || 'text',
    listTargets: () => getUserSettingTargets(),
    listValues: target => getUserSettingValues(target),
    read: block => getUserSettingValue(block.target),
    write: block => setUserSettingValue(block.target, block.value),
    describe: block => `User setting "${getBlockTargetLabel(block)}" = ${stringifyValue(block.value)}`,
});

registerAdapter({
    id: 'custom.dom',
    category: 'custom',
    label: 'DOM control',
    icon: 'fa-crosshairs',
    writable: true,
    reversible: true,
    valueType: 'text',
    customTarget: true,
    listTargets: () => [],
    read: block => getDomValue(block.target),
    write: block => setDomValue(block.target, block.value),
    invert: block => typeof block.value === 'boolean' ? ({ ...block, value: !block.value }) : null,
    describe: block => `DOM ${block.target} = ${stringifyValue(block.value)}`,
});

registerAdapter({
    id: 'custom.extensionSettings',
    category: 'custom',
    label: 'Extension settings path',
    icon: 'fa-folder-tree',
    writable: true,
    valueType: 'text',
    customTarget: true,
    listTargets: () => [],
    read: block => getByPath(extension_settings, block.target),
    write: block => {
        const changed = setByPath(extension_settings, block.target, block.value);
        if (changed) {
            saveSettings();
        }
        return false;
    },
    describe: block => `extension_settings.${block.target} = ${stringifyValue(block.value)}`,
});

registerAdapter({
    id: 'custom.context',
    category: 'custom',
    label: 'Context path',
    icon: 'fa-route',
    writable: false,
    valueType: 'text',
    customTarget: true,
    listTargets: () => [],
    read: block => getByPath(getContext(), block.target),
    describe: block => `context.${block.target} = ${stringifyValue(block.value)}`,
});

registerAdapter({
    id: 'custom.slash',
    category: 'custom',
    label: 'Slash command',
    icon: 'fa-terminal',
    writable: true,
    eventOnly: true,
    valueType: 'text',
    customTarget: true,
    listTargets: () => [],
    read: () => undefined,
    write: async block => {
        await executeSlashCommandsWithOptions(String(block.value || block.target || ''), {
            handleExecutionErrors: true,
            source: 'Silly Linkify',
        });
        return false;
    },
    describe: block => `Run ${block.value || block.target}`,
});

function getRegexPresetLabel(value) {
    return (extension_settings.regex_presets ?? []).find(preset => preset.id === value)?.name || value || '';
}

function getCharacterLabel(value) {
    const character = characters[Number(value)];
    return character?.name || character?.avatar || value || '';
}

async function readBlock(block) {
    const adapter = getAdapter(block.adapter);
    if (!adapter?.read) {
        return undefined;
    }
    return await adapter.read(block);
}

async function writeBlock(block) {
    const adapter = getAdapter(block.adapter);
    if (!adapter?.write) {
        warn(`Block is not writable: ${block.adapter}`);
        return false;
    }
    return await adapter.write(block);
}

async function recipeMatches(recipe) {
    if (!recipe.conditions.length) {
        return false;
    }

    for (const condition of recipe.conditions) {
        const adapter = getAdapter(condition.adapter);
        if (!adapter || adapter.eventOnly) {
            return false;
        }
        const actual = await readBlock(condition);
        if (!valuesEqual(actual, condition.value)) {
            return false;
        }
    }
    return true;
}

async function applyBlocks(blocks) {
    let shouldReload = false;
    for (const block of blocks) {
        try {
            if (block.snapshotRestore) {
                const actual = await readBlock(block);
                if (!valuesEqual(actual, block.snapshotAppliedValue)) {
                    logDebug('Skipping snapshot restore because user changed the value', block, actual);
                    continue;
                }
            }
            await writeBlock(block);
            shouldReload = shouldReload || !!block.reloadChat || !!getAdapter(block.adapter)?.reloadsChat;
        } catch (error) {
            console.error('[Silly Linkify] Block failed', block, error);
            toastr.error(String(error?.message ?? error), 'Silly Linkify');
        }
    }

    if (shouldReload && getCurrentChatId()) {
        await reloadCurrentChat();
    }
}

function showLinkApplied(recipe) {
    toastr.success('Link applied', recipe?.name || 'Silly Linkify');
}

async function evaluateRecipe(recipe) {
    const active = await recipeMatches(recipe);
    const wasActive = runtime.activeRecipes.has(recipe.id);

    if (active && !wasActive) {
        const appliedState = await captureResultSnapshots(recipe.results);
        runtime.activeRecipes.add(recipe.id);
        await applyBlocks(recipe.results);
        showLinkApplied(recipe);
        getSettings().lastApplied[recipe.id] = {
            active: true,
            at: Date.now(),
            snapshots: appliedState.snapshots,
            applied: appliedState.applied,
        };
        saveSettings();
        return;
    }

    if (!active && wasActive) {
        runtime.activeRecipes.delete(recipe.id);
        if (recipe.autoInverse) {
            const appliedState = getSettings().lastApplied[recipe.id] ?? {};
            const inverseBlocks = recipe.results.map(block => invertBlock(block, appliedState)).filter(Boolean);
            await applyBlocks(inverseBlocks);
        }
        delete getSettings().lastApplied[recipe.id];
        saveSettings();
    }
}

async function evaluateRecipesNow() {
    const settings = getSettings();
    if (!settings.enabled) {
        return;
    }
    if (runtime.isApplying) {
        runtime.pendingEvaluation = true;
        return;
    }

    runtime.isApplying = true;
    runtime.pendingEvaluation = false;
    try {
        const recipes = settings.recipes.filter(recipe => recipe.enabled);

        for (const recipe of recipes) {
            const run = () => evaluateRecipe(recipe);
            if (DEFAULT_RECIPE_DEBOUNCE_MS > 0) {
                clearTimeout(runtime.recipeTimers.get(recipe.id));
                runtime.recipeTimers.set(recipe.id, setTimeout(() => {
                    run().catch(error => {
                        console.error('[Silly Linkify] Recipe evaluation failed', recipe, error);
                    });
                }, DEFAULT_RECIPE_DEBOUNCE_MS));
            } else {
                await run();
            }
        }
    } finally {
        runtime.isApplying = false;
        if (runtime.pendingEvaluation) {
            scheduleEvaluation(100);
        }
    }
}

function scheduleEvaluation(delay = DEFAULT_EVALUATION_DELAY_MS) {
    clearTimeout(runtime.evaluateTimer);
    runtime.evaluateTimer = setTimeout(evaluateRecipesNow, delay);
}

function getSelectedRecipe() {
    const settings = getSettings();
    let recipe = settings.recipes.find(candidate => candidate.id === runtime.selectedRecipeId);
    if (!recipe && settings.recipes.length) {
        recipe = settings.recipes[0];
        runtime.selectedRecipeId = recipe.id;
    }
    return recipe || null;
}

function createRecipe() {
    const recipe = normalizeRecipe({
        name: 'New link',
        conditions: [],
        results: [],
    });
    getSettings().recipes.push(recipe);
    runtime.selectedRecipeId = recipe.id;
    saveSettings();
    renderSettings();
    openRecipeEditor(recipe.id);
}

function duplicateRecipe(recipe) {
    const duplicate = normalizeRecipe({
        ...clone(recipe),
        id: uuidv4(),
        name: `${recipe.name} copy`,
    });
    getSettings().recipes.push(duplicate);
    runtime.selectedRecipeId = duplicate.id;
    saveSettings();
    renderSettings();
    openRecipeEditor(duplicate.id);
}

function deleteRecipe(recipe) {
    const settings = getSettings();
    settings.recipes = settings.recipes.filter(candidate => candidate.id !== recipe.id);
    runtime.activeRecipes.delete(recipe.id);
    runtime.selectedRecipeId = settings.recipes[0]?.id ?? null;
    saveSettings();
    renderSettings();
    closeRecipeEditor();
}

function blockListHtml(blocks, emptyText) {
    if (!blocks.length) {
        return `<div class="silly-linkify-empty">${emptyText}</div>`;
    }
    return blocks.map(block => `
        <div class="silly-linkify-block" data-block-id="${block.id}">
            <i class="fa-solid ${getAdapter(block.adapter)?.icon || 'fa-cube'}"></i>
            <span>${escapeHtml(describeBlock(block))}</span>
            <button class="menu_button menu_button_icon interactable silly-linkify-remove-block" type="button" title="Remove block">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
    `).join('');
}

function recipeSummary(recipe) {
    const when = recipe.conditions.map(block => describeBlock(block)).join(' + ') || 'No conditions';
    const then = recipe.results.map(block => describeBlock(block, 'result')).join(' + ') || 'No results';
    return `${when} -> ${then}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function renderRecipeList() {
    const list = document.getElementById('silly_linkify_recipes');
    const settings = getSettings();
    if (!list) {
        return;
    }

    if (!settings.recipes.length) {
        list.innerHTML = '<div class="silly-linkify-empty">No links yet</div>';
        return;
    }

    list.innerHTML = settings.recipes
        .slice()
        .map(recipe => `
            <article class="silly-linkify-recipe-row ${recipe.id === runtime.selectedRecipeId ? 'selected' : ''}" data-recipe-id="${recipe.id}">
                <button class="menu_button menu_button_icon interactable silly-linkify-toggle-recipe" type="button" title="${recipe.enabled ? 'Disable' : 'Enable'}">
                    <i class="fa-solid ${recipe.enabled ? 'fa-toggle-on' : 'fa-toggle-off'}"></i>
                </button>
                <button class="silly-linkify-recipe-main silly-linkify-edit-recipe" type="button">
                    <span class="silly-linkify-recipe-name">${escapeHtml(recipe.name)}</span>
                    <span class="silly-linkify-recipe-flow">${escapeHtml(recipeSummary(recipe))}</span>
                </button>
                <div class="silly-linkify-row-actions">
                    <button class="menu_button menu_button_icon interactable silly-linkify-run-recipe" title="Run" type="button">
                        <i class="fa-solid fa-play"></i>
                    </button>
                    <button class="menu_button menu_button_icon interactable silly-linkify-copy-recipe" title="Duplicate" type="button">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                    <button class="menu_button menu_button_icon interactable silly-linkify-delete-recipe" title="Delete" type="button">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </article>
        `)
        .join('');
}

function protectModalLayout() {
    const modal = document.getElementById('silly_linkify_modal');
    const panel = document.getElementById('silly_linkify_editor');
    if (!modal || !panel) {
        return;
    }

    if (modal.parentElement !== document.body) {
        document.body.appendChild(modal);
    }

    modal.style.setProperty('position', 'fixed', 'important');
    modal.style.setProperty('inset', '0', 'important');
    modal.style.setProperty('width', 'auto', 'important');
    modal.style.setProperty('max-width', 'none', 'important');
    modal.style.setProperty('overflow', 'visible', 'important');
    panel.style.setProperty('box-sizing', 'border-box', 'important');
    panel.style.setProperty('width', 'min(1080px, calc(100vw - 28px))', 'important');
    panel.style.setProperty('max-width', 'none', 'important');
}

function renderEditor() {
    const recipe = getSelectedRecipe();
    const modal = document.getElementById('silly_linkify_modal');
    if (!modal || modal.classList.contains('displayNone')) {
        return;
    }

    if (!recipe) {
        closeRecipeEditor();
        return;
    }

    $('#silly_linkify_recipe_name').val(recipe.name);
    $('#silly_linkify_recipe_enabled').prop('checked', recipe.enabled);
    $('#silly_linkify_auto_inverse').prop('checked', recipe.autoInverse);
    $('#silly_linkify_when_blocks').html(blockListHtml(recipe.conditions, 'Add a When block'));
    $('#silly_linkify_then_blocks').html(blockListHtml(recipe.results, 'Add a Then block'));
    $('#silly_linkify_recipe_json').val(JSON.stringify(recipe, null, 4));
}

function openRecipeEditor(recipeId) {
    runtime.selectedRecipeId = recipeId;
    protectModalLayout();
    $('#silly_linkify_modal').removeClass('displayNone');
    renderSettings();
}

function closeRecipeEditor() {
    $('#silly_linkify_modal').addClass('displayNone');
}

function getBuilderDraft(mode = getBuilderMode()) {
    return runtime.builderDrafts[mode] ?? null;
}

function captureBuilderDraft(mode = getBuilderMode()) {
    const adapter = getBuilderAdapter();
    runtime.builderDrafts[mode] = {
        category: String($('#silly_linkify_block_category').val() || ''),
        adapter: adapter?.id || '',
        target: adapter ? getBuilderTarget(adapter) : '',
        value: adapter ? getBuilderValue(adapter) : '',
        characterSearch: String($('#silly_linkify_character_search').val() || ''),
    };
}

function renderCategorySelect(preferredCategory = '') {
    const draft = getBuilderDraft();
    const previous = preferredCategory || draft?.category || String($('#silly_linkify_block_category').val() || '');
    const forResults = getBuilderMode() === 'result';
    const available = categories.filter(category => (
        getAdaptersByCategory(category.id).some(adapter => isAdapterAvailable(adapter, forResults))
    ));
    $('#silly_linkify_block_category').html(available.map(category => `<option value="${category.id}">${escapeHtml(category.label)}</option>`).join(''));
    if (available.some(category => category.id === previous)) {
        $('#silly_linkify_block_category').val(previous);
    }
}

function renderAdapterSelect(preferredAdapter = '') {
    const category = $('#silly_linkify_block_category').val();
    if (!category) {
        $('#silly_linkify_block_adapter').empty();
        renderTargetAndValuePickers();
        return;
    }
    const forResults = getBuilderMode() === 'result';
    const available = getAdaptersByCategory(category).filter(adapter => isAdapterAvailable(adapter, forResults));
    $('#silly_linkify_block_adapter').html(available.map(adapter => `<option value="${adapter.id}">${escapeHtml(adapter.label)}</option>`).join(''));
    const draft = getBuilderDraft();
    const adapterId = preferredAdapter || draft?.adapter || '';
    if (available.some(adapter => adapter.id === adapterId)) {
        $('#silly_linkify_block_adapter').val(adapterId);
    }
    renderTargetAndValuePickers();
}

function isAdapterAvailable(adapter, forResults) {
    if (adapter.hidden) {
        return false;
    }
    if (forResults && !adapter.writable) {
        return false;
    }
    if (!forResults && adapter.eventOnly) {
        return false;
    }
    if (!adapter.customTarget && !adapter.eventOnly && !(adapter.listTargets?.() ?? []).length) {
        return false;
    }
    if (adapter.valueType === 'select' && !(adapter.listValues?.() ?? []).length) {
        return false;
    }
    return true;
}

function getBuilderAdapter() {
    return getAdapter(String($('#silly_linkify_block_adapter').val() || ''));
}

function getAdapterValueType(adapter, target = undefined) {
    if (!adapter) {
        return 'text';
    }
    if (typeof adapter.getValueType === 'function') {
        return adapter.getValueType(target ?? getBuilderTarget(adapter));
    }
    return adapter.valueType || 'text';
}

function getBuilderMode() {
    return String($('#silly_linkify_block_mode').attr('data-mode') || 'condition');
}

function setBuilderMode(mode) {
    $('#silly_linkify_block_mode')
        .attr('data-mode', mode)
        .find('[data-mode]')
        .removeClass('selected');
    $(`#silly_linkify_block_mode [data-mode="${mode}"]`).addClass('selected');
}

function builderTargetId(target) {
    return typeof target === 'object' ? String(target?.id ?? '') : String(target ?? '');
}

function renderTargetAndValuePickers() {
    const adapter = getBuilderAdapter();
    const draft = getBuilderDraft();
    const targetWrap = $('#silly_linkify_block_target_wrap');
    const valueWrap = $('#silly_linkify_block_value_wrap');
    if (!adapter) {
        targetWrap.removeClass('displayNone').html('<span>No available blocks in this category</span>');
        valueWrap.empty();
        return;
    }

    if (adapter.customTarget) {
        const targetCaption = escapeHtml(adapter.targetCaption || 'Target');
        const targetValue = draft?.adapter === adapter.id ? String(draft.target ?? '') : '';
        targetWrap.removeClass('displayNone').html(`<span><i class="fa-solid fa-crosshairs"></i> ${targetCaption}</span><input id="silly_linkify_block_target" class="text_pole" type="text" placeholder="Target selector/path/command" value="${escapeHtml(targetValue)}">`);
    } else {
        const targets = adapter.listTargets?.() ?? [];
        if (targets.length > 1) {
            const targetCaption = escapeHtml(adapter.targetCaption || 'Target');
            let defaultTarget = draft?.adapter === adapter.id
                ? builderTargetId(draft.target)
                : String(adapter.getDefaultTarget?.() ?? '');
            if (adapter.id === 'preset.prompt' && draft?.adapter === adapter.id && draft.target?.matchBy === 'name') {
                defaultTarget = findPromptIdentifierByName(draft.target.name || draft.target.label) || defaultTarget;
            }
            targetWrap.removeClass('displayNone').html(`<span><i class="fa-solid fa-crosshairs"></i> ${targetCaption}</span><select id="silly_linkify_block_target" class="text_pole">${renderOptionHtml(targets, defaultTarget)}</select>`);
            const select = document.getElementById('silly_linkify_block_target');
            for (const option of select.options) {
                const target = targets.find(candidate => String(candidate.id) === option.value);
                option.dataset.target = JSON.stringify(target);
            }
        } else if (targets.length === 1) {
            targetWrap.addClass('displayNone').empty();
        }
    }

    renderValuePicker();
}

function renderValuePicker() {
    const adapter = getBuilderAdapter();
    const draft = getBuilderDraft();
    const valueWrap = $('#silly_linkify_block_value_wrap');
    if (!adapter) {
        valueWrap.empty();
        return;
    }

    if (typeof adapter.renderValuePicker === 'function') {
        adapter.renderValuePicker(valueWrap, getBuilderTarget(adapter), draft);
        return;
    }

    const valueType = getAdapterValueType(adapter);

    if (valueType === 'boolean') {
        const selectedValue = draft?.adapter === adapter.id ? String(parseBoolean(draft.value)) : 'true';
        valueWrap.html(`
            <span><i class="fa-solid fa-toggle-on"></i> State</span>
            <select id="silly_linkify_block_value" class="text_pole">
                <option value="true" ${selectedValue === 'true' ? 'selected' : ''}>enabled</option>
                <option value="false" ${selectedValue === 'false' ? 'selected' : ''}>disabled</option>
            </select>
        `);
        return;
    }

    if (valueType === 'select') {
        const values = adapter.listValues?.(getBuilderTarget(adapter)) ?? [];
        const currentValue = draft?.adapter === adapter.id
            ? String(draft.value ?? '')
            : String(readCurrentBuilderTarget(adapter) ?? '');
        if (adapter.id === 'character.selected') {
            renderCharacterValuePicker(valueWrap, values, currentValue, draft?.characterSearch || '');
            return;
        }
        valueWrap.html(`
            <span><i class="fa-solid fa-circle-dot"></i> Value</span>
            <select id="silly_linkify_block_value" class="text_pole">
                ${renderOptionHtml(values, currentValue)}
            </select>
        `);
        return;
    }

    if (valueType === 'number') {
        const currentValue = draft?.adapter === adapter.id
            ? draft.value
            : readCurrentBuilderTarget(adapter);
        valueWrap.html(`<span><i class="fa-solid fa-circle-dot"></i> Value</span><input id="silly_linkify_block_value" class="text_pole" type="number" step="any" placeholder="Value" value="${escapeHtml(currentValue ?? '')}">`);
        return;
    }

    const currentValue = draft?.adapter === adapter.id
        ? draft.value
        : readCurrentBuilderTarget(adapter);
    valueWrap.html(`<span><i class="fa-solid fa-circle-dot"></i> Value</span><input id="silly_linkify_block_value" class="text_pole" type="text" placeholder="Value" value="${escapeHtml(currentValue ?? '')}">`);
}

function renderCharacterValuePicker(valueWrap, values, preferredValue = '', searchValue = '') {
    const currentId = String(preferredValue || getContext().characterId || values[0]?.id || '');
    const selectedId = values.some(value => String(value.id) === currentId)
        ? currentId
        : String(values[0]?.id ?? '');
    valueWrap.html(`
        <span><i class="fa-solid fa-address-card"></i> Character</span>
        <input id="silly_linkify_block_value" type="hidden" value="${escapeHtml(selectedId)}">
        <input id="silly_linkify_character_search" class="text_pole silly-linkify-character-search" type="search" placeholder="Search character or author" value="${escapeHtml(searchValue)}">
        <div class="silly-linkify-character-picker">
            ${values.map(value => `
                <button class="silly-linkify-character-option ${String(value.id) === selectedId ? 'selected' : ''} ${searchValue && !`${value.label} ${value.creator || ''}`.toLowerCase().includes(searchValue.toLowerCase()) ? 'displayNone' : ''}" data-character-value="${escapeHtml(value.id)}" data-search="${escapeHtml(`${value.label} ${value.creator || ''}`.toLowerCase())}" type="button">
                    <img src="${escapeHtml(value.avatarUrl || '')}" alt="">
                    <span class="silly-linkify-character-copy">
                        <strong>${escapeHtml(value.label)}</strong>
                        ${value.creator ? `<small>${escapeHtml(`by ${value.creator}`)}</small>` : ''}
                    </span>
                </button>
            `).join('')}
        </div>
    `);
}

function renderMessageMatchValuePicker(valueWrap, target, draft) {
    const draftApplies = draft?.adapter === 'chat.messageMatch';
    const config = normalizeMessageMatchValue(draftApplies ? draft.value : {
        mode: 'text',
        pattern: '',
        scope: 'last',
        depth: 1,
        role: 'any',
        caseSensitive: false,
    });

    valueWrap.html(`
        <span><i class="fa-solid fa-magnifying-glass"></i> Message match</span>
        <div id="silly_linkify_block_value" class="silly-linkify-message-match">
            <label class="silly-linkify-builder-item">
                <span>Mode</span>
                <select class="text_pole silly-linkify-message-field" data-message-field="mode">
                    <option value="text" ${config.mode === 'text' ? 'selected' : ''}>text</option>
                    <option value="regex" ${config.mode === 'regex' ? 'selected' : ''}>regex</option>
                </select>
            </label>
            <label class="silly-linkify-builder-item">
                <span>Pattern</span>
                <input class="text_pole silly-linkify-message-field" data-message-field="pattern" type="text" value="${escapeHtml(config.pattern)}" placeholder="text or /regex/i">
            </label>
            <label class="silly-linkify-builder-item">
                <span>Search in</span>
                <select class="text_pole silly-linkify-message-field silly-linkify-message-scope" data-message-field="scope">
                    ${renderOptionHtml(messageMatchScopeOptions, config.scope)}
                </select>
            </label>
            <label class="silly-linkify-builder-item silly-linkify-message-depth ${config.scope === 'recent' ? '' : 'displayNone'}">
                <span>Message count</span>
                <input class="text_pole silly-linkify-message-field" data-message-field="depth" type="number" min="2" step="1" value="${escapeHtml(Math.max(2, config.depth))}">
            </label>
            <label class="silly-linkify-builder-item">
                <span>Role</span>
                <select class="text_pole silly-linkify-message-field" data-message-field="role">
                    ${renderOptionHtml(messageMatchRoleOptions, config.role)}
                </select>
            </label>
            <label class="checkbox_label silly-linkify-message-case" for="silly_linkify_message_case_sensitive">
                <input id="silly_linkify_message_case_sensitive" class="silly-linkify-message-field" data-message-field="caseSensitive" type="checkbox" ${config.caseSensitive ? 'checked' : ''}>
                <span>Case sensitive</span>
            </label>
        </div>
    `);
}

function renderPromptValuePicker(valueWrap, target, draft) {
    const promptState = getPromptState(target);
    const draftApplies = draft?.adapter === 'preset.prompt' && builderTargetId(draft.target) === builderTargetId(target);
    const draftValue = draftApplies && draft.value && typeof draft.value === 'object' ? draft.value : {};
    const matchBy = draftApplies && draft.target && typeof draft.target === 'object'
        ? draft.target.matchBy || 'identifier'
        : target?.matchBy || 'identifier';

    const fieldControl = setting => {
        const isSelected = Object.hasOwn(draftValue, setting.id);
        const value = isSelected ? draftValue[setting.id] : promptState[setting.id];
        const common = `data-prompt-field="${escapeHtml(setting.id)}"`;
        if (setting.type === 'boolean') {
            return `
                <select class="text_pole silly-linkify-prompt-field-value" ${common}>
                    <option value="true" ${parseBoolean(value) ? 'selected' : ''}>enabled</option>
                    <option value="false" ${!parseBoolean(value) ? 'selected' : ''}>disabled</option>
                </select>
            `;
        }
        if (setting.type === 'select') {
            return `
                <select class="text_pole silly-linkify-prompt-field-value" ${common}>
                    ${renderOptionHtml(setting.values ?? [], value)}
                </select>
            `;
        }
        if (setting.type === 'number') {
            return `<input class="text_pole silly-linkify-prompt-field-value" ${common} type="number" step="any" value="${escapeHtml(value ?? '')}">`;
        }
        return `<input class="text_pole silly-linkify-prompt-field-value" ${common} type="text" value="${escapeHtml(value ?? '')}" placeholder="normal, regenerate">`;
    };

    valueWrap.html(`
        <span><i class="fa-solid fa-sliders"></i> Prompt settings</span>
        <div id="silly_linkify_block_value" class="silly-linkify-prompt-settings">
            <label class="silly-linkify-prompt-match-row">
                <span>Link prompt by</span>
                <select id="silly_linkify_prompt_match_by" class="text_pole">
                    <option value="identifier" ${matchBy === 'identifier' ? 'selected' : ''}>identifier</option>
                    <option value="name" ${matchBy === 'name' ? 'selected' : ''}>name</option>
                </select>
            </label>
            ${promptSettingDefinitions.map(setting => `
                <label class="silly-linkify-prompt-setting-row">
                    <input class="silly-linkify-prompt-field-enabled" data-prompt-field="${escapeHtml(setting.id)}" type="checkbox" ${Object.hasOwn(draftValue, setting.id) ? 'checked' : ''}>
                    <span>${escapeHtml(setting.label)}</span>
                    ${fieldControl(setting)}
                </label>
            `).join('')}
        </div>
    `);
}

function getMessageMatchBuilderValue() {
    const value = {};
    $('#silly_linkify_block_value .silly-linkify-message-field').each((_, control) => {
        const field = String(control.dataset.messageField || '');
        if (!field) {
            return;
        }
        if (control instanceof HTMLInputElement && control.type === 'checkbox') {
            value[field] = control.checked;
            return;
        }
        value[field] = $(control).val();
    });
    return normalizeMessageMatchValue(value);
}

function getRawBuilderTarget(adapter) {
    const targetElement = document.getElementById('silly_linkify_block_target');
    if (!targetElement) {
        const targets = adapter.listTargets?.() ?? [];
        return targets.length === 1 ? targets[0] : '';
    }

    if (adapter.customTarget) {
        return targetElement.value;
    }

    if (targetElement instanceof HTMLSelectElement) {
        const selected = targetElement.selectedOptions[0];
        if (selected?.dataset.target) {
            return JSON.parse(selected.dataset.target);
        }
    }

    return targetElement.value;
}

function getBuilderTarget(adapter) {
    const target = getRawBuilderTarget(adapter);
    if (adapter.id === 'preset.prompt' && target && typeof target === 'object') {
        const matchBy = String($('#silly_linkify_prompt_match_by').val() || target.matchBy || 'identifier');
        const identifier = target.identifier || target.id;
        return {
            ...target,
            identifier,
            name: target.name || target.label || getPromptName(identifier),
            matchBy,
        };
    }
    return target;
}

function readCurrentBuilderTarget(adapter) {
    try {
        const target = getBuilderTarget(adapter);
        return adapter.read?.({ adapter: adapter.id, target });
    } catch {
        return '';
    }
}

function getBuilderValue(adapter) {
    if (typeof adapter.getBuilderValue === 'function') {
        return adapter.getBuilderValue();
    }
    const value = $('#silly_linkify_block_value').val();
    const valueType = getAdapterValueType(adapter);
    if (valueType === 'boolean') {
        return parseBoolean(value);
    }
    if (valueType === 'number') {
        const numericValue = Number(value);
        return Number.isFinite(numericValue) ? numericValue : value;
    }
    return value;
}

function getPromptBuilderValue() {
    const value = {};
    $('#silly_linkify_block_value .silly-linkify-prompt-field-enabled:checked').each((_, checkbox) => {
        const field = String(checkbox.dataset.promptField || '');
        const setting = getPromptSettingDefinition(field);
        const control = $(`#silly_linkify_block_value .silly-linkify-prompt-field-value[data-prompt-field="${CSS.escape(field)}"]`);
        if (!setting || !control.length) {
            return;
        }
        const rawValue = control.val();
        value[field] = setting.type === 'boolean'
            ? parseBoolean(rawValue)
            : setting.type === 'number'
                ? Number(rawValue)
                : rawValue;
    });
    return value;
}

function addBuilderBlock() {
    const recipe = getSelectedRecipe();
    const adapter = getBuilderAdapter();
    if (!recipe || !adapter) {
        return;
    }

    const mode = getBuilderMode();
    const block = normalizeBlock({
        adapter: adapter.id,
        target: getBuilderTarget(adapter),
        value: getBuilderValue(adapter),
        reloadChat: !!adapter.reloadsChat,
    });

    if (!block.target && !adapter.eventOnly) {
        warn('Choose a target first.');
        return;
    }
    if (adapter.valueType === 'custom' && (!block.value || !Object.keys(block.value).length)) {
        warn('Choose at least one value.');
        return;
    }
    const validationMessage = adapter.validateBlock?.(block);
    if (validationMessage) {
        warn(validationMessage);
        return;
    }

    if (mode === 'result') {
        recipe.results.push(block);
    } else {
        recipe.conditions.push(block);
    }

    saveSettings();
    renderSettings();
    scheduleEvaluation();
}

function removeBlock(blockId) {
    const recipe = getSelectedRecipe();
    if (!recipe) {
        return;
    }
    recipe.conditions = recipe.conditions.filter(block => block.id !== blockId);
    recipe.results = recipe.results.filter(block => block.id !== blockId);
    saveSettings();
    renderSettings();
    scheduleEvaluation();
}

function renderSettings() {
    const settings = getSettings();
    $('#silly_linkify_enabled').prop('checked', settings.enabled);
    $('#silly_linkify_debug').prop('checked', settings.debug);
    renderRecipeList();
    renderEditor();
}

function importSettings(file) {
    getFileText(file).then(text => {
        const parsed = JSON.parse(text);
        const recipes = Array.isArray(parsed.recipes) ? parsed.recipes : Array.isArray(parsed) ? parsed : [];
        getSettings().recipes = recipes.map(normalizeRecipe);
        runtime.selectedRecipeId = getSettings().recipes[0]?.id ?? null;
        saveSettings();
        renderSettings();
        scheduleEvaluation();
    }).catch(error => {
        console.error('[Silly Linkify] Import failed', error);
        toastr.error(String(error?.message ?? error), 'Silly Linkify import failed');
    });
}

function exportSettings() {
    const payload = {
        schemaVersion: SCHEMA_VERSION,
        recipes: getSettings().recipes,
    };
    download(JSON.stringify(payload, null, 4), 'silly-linkify-v2.json', 'application/json');
}

function applyRecipeJson() {
    const recipe = getSelectedRecipe();
    if (!recipe) {
        return;
    }

    try {
        const parsed = normalizeRecipe(JSON.parse(String($('#silly_linkify_recipe_json').val() || '{}')));
        Object.assign(recipe, parsed, { id: recipe.id });
        saveSettings();
        renderSettings();
        scheduleEvaluation();
    } catch (error) {
        toastr.error(String(error?.message ?? error), 'Invalid recipe JSON');
    }
}

function bindSettingsHandlers() {
    $('#silly_linkify_enabled').on('change', function () {
        getSettings().enabled = !!this.checked;
        saveSettings();
        scheduleEvaluation();
    });
    $('#silly_linkify_debug').on('change', function () {
        getSettings().debug = !!this.checked;
        saveSettings();
    });
    $('#silly_linkify_new').on('click', createRecipe);
    $('#silly_linkify_export').on('click', exportSettings);
    $('#silly_linkify_import').on('click', () => $('#silly_linkify_import_file').trigger('click'));
    $('#silly_linkify_import_file').on('change', function () {
        if (this.files?.[0]) {
            importSettings(this.files[0]);
        }
        this.value = '';
    });

    $('#silly_linkify_recipes').on('click', '.silly-linkify-edit-recipe', function () {
        openRecipeEditor(this.closest('.silly-linkify-recipe-row')?.dataset.recipeId);
    });
    $('#silly_linkify_recipes').on('click', '.silly-linkify-toggle-recipe', function () {
        const recipe = getSettings().recipes.find(candidate => candidate.id === this.closest('.silly-linkify-recipe-row')?.dataset.recipeId);
        if (!recipe) {
            return;
        }
        recipe.enabled = !recipe.enabled;
        if (!recipe.enabled) {
            runtime.activeRecipes.delete(recipe.id);
        }
        saveSettings();
        renderSettings();
        scheduleEvaluation();
    });
    $('#silly_linkify_recipes').on('click', '.silly-linkify-run-recipe', async function () {
        const recipe = getSettings().recipes.find(candidate => candidate.id === this.closest('.silly-linkify-recipe-row')?.dataset.recipeId);
        if (recipe) {
            await applyBlocks(recipe.results);
            showLinkApplied(recipe);
        }
    });
    $('#silly_linkify_recipes').on('click', '.silly-linkify-copy-recipe', function () {
        const recipe = getSettings().recipes.find(candidate => candidate.id === this.closest('.silly-linkify-recipe-row')?.dataset.recipeId);
        if (recipe) {
            duplicateRecipe(recipe);
        }
    });
    $('#silly_linkify_recipes').on('click', '.silly-linkify-delete-recipe', function () {
        const recipe = getSettings().recipes.find(candidate => candidate.id === this.closest('.silly-linkify-recipe-row')?.dataset.recipeId);
        if (recipe) {
            deleteRecipe(recipe);
        }
    });

    $('#silly_linkify_recipe_name').on('input', function () {
        const recipe = getSelectedRecipe();
        if (recipe) {
            recipe.name = String(this.value || 'Untitled link');
            saveSettings();
            renderRecipeList();
        }
    });
    $('#silly_linkify_recipe_enabled').on('change', function () {
        const recipe = getSelectedRecipe();
        if (recipe) {
            recipe.enabled = !!this.checked;
            if (!recipe.enabled) {
                runtime.activeRecipes.delete(recipe.id);
            }
            saveSettings();
            renderSettings();
            scheduleEvaluation();
        }
    });
    $('#silly_linkify_auto_inverse').on('change', function () {
        const recipe = getSelectedRecipe();
        if (recipe) {
            recipe.autoInverse = !!this.checked;
            saveSettings();
        }
    });

    $('#silly_linkify_run').on('click', async () => {
        const recipe = getSelectedRecipe();
        if (recipe) {
            await applyBlocks(recipe.results);
            showLinkApplied(recipe);
        }
    });
    $('#silly_linkify_duplicate').on('click', () => {
        const recipe = getSelectedRecipe();
        if (recipe) {
            duplicateRecipe(recipe);
        }
    });
    $('#silly_linkify_delete').on('click', () => {
        const recipe = getSelectedRecipe();
        if (recipe) {
            deleteRecipe(recipe);
        }
    });
    $('#silly_linkify_close_editor, #silly_linkify_modal_scrim').on('click', closeRecipeEditor);

    $('#silly_linkify_when_blocks, #silly_linkify_then_blocks').on('click', '.silly-linkify-remove-block', function () {
        removeBlock(this.closest('.silly-linkify-block')?.dataset.blockId);
    });

    $('#silly_linkify_block_mode').on('click', '[data-mode]', function () {
        captureBuilderDraft();
        setBuilderMode(String(this.dataset.mode || 'condition'));
        renderCategorySelect();
        renderAdapterSelect();
    });
    $('#silly_linkify_block_category').on('change', function () {
        captureBuilderDraft();
        renderAdapterSelect();
        captureBuilderDraft();
    });
    $('#silly_linkify_block_adapter').on('change', function () {
        captureBuilderDraft();
        renderTargetAndValuePickers();
        captureBuilderDraft();
    });
    $('#silly_linkify_block_target_wrap').on('change input', '#silly_linkify_block_target', function () {
        captureBuilderDraft();
        renderValuePicker();
        captureBuilderDraft();
    });
    $('#silly_linkify_block_value_wrap').on('click', '.silly-linkify-character-option', function () {
        const value = String(this.dataset.characterValue || '');
        $('#silly_linkify_block_value').val(value);
        $(this)
            .addClass('selected')
            .siblings('.silly-linkify-character-option')
            .removeClass('selected');
        captureBuilderDraft();
    });
    $('#silly_linkify_block_value_wrap').on('input', '#silly_linkify_character_search', function () {
        const query = String(this.value || '').trim().toLowerCase();
        $('#silly_linkify_block_value_wrap .silly-linkify-character-option').each((_, option) => {
            const haystack = String(option.dataset.search || '');
            option.classList.toggle('displayNone', !!query && !haystack.includes(query));
        });
        captureBuilderDraft();
    });
    $('#silly_linkify_block_value_wrap').on('change input', '#silly_linkify_block_value', captureBuilderDraft);
    $('#silly_linkify_block_value_wrap').on('change input', '#silly_linkify_prompt_match_by', captureBuilderDraft);
    $('#silly_linkify_block_value_wrap').on('change', '.silly-linkify-message-scope', function () {
        $('#silly_linkify_block_value_wrap .silly-linkify-message-depth').toggleClass('displayNone', String(this.value) !== 'recent');
        captureBuilderDraft();
    });
    $('#silly_linkify_block_value_wrap').on('change input', '.silly-linkify-message-field', captureBuilderDraft);
    $('#silly_linkify_block_value_wrap').on('change input', '.silly-linkify-prompt-field-value', function () {
        const field = String(this.dataset.promptField || '');
        $(`#silly_linkify_block_value .silly-linkify-prompt-field-enabled[data-prompt-field="${CSS.escape(field)}"]`).prop('checked', true);
        captureBuilderDraft();
    });
    $('#silly_linkify_block_value_wrap').on('change input', '.silly-linkify-prompt-field-enabled', captureBuilderDraft);
    $('#silly_linkify_add_block').on('click', addBuilderBlock);
    $('#silly_linkify_apply_json').on('click', applyRecipeJson);
}

function subscribeToEvents() {
    const events = [
        event_types.APP_READY,
        event_types.MAIN_API_CHANGED,
        event_types.PRESET_CHANGED,
        event_types.OAI_PRESET_CHANGED_AFTER,
        event_types.CHATCOMPLETION_SOURCE_CHANGED,
        event_types.CHATCOMPLETION_MODEL_CHANGED,
        event_types.CHAT_CHANGED,
        event_types.MESSAGE_SENT,
        event_types.MESSAGE_RECEIVED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_SWIPED,
        event_types.MESSAGE_DELETED,
        event_types.MORE_MESSAGES_LOADED,
        event_types.CONNECTION_PROFILE_LOADED,
        event_types.SETTINGS_UPDATED,
        event_types.CHARACTER_PAGE_LOADED,
        event_types.CHARACTER_EDITED,
        event_types.WORLDINFO_SETTINGS_UPDATED,
        event_types.WORLDINFO_UPDATED,
        event_types.WORLDINFO_ENTRIES_LOADED,
    ].filter(Boolean);

    for (const eventType of events) {
        eventSource.on(eventType, () => {
            if ([event_types.WORLDINFO_UPDATED, event_types.WORLDINFO_ENTRIES_LOADED].includes(eventType)) {
                refreshLorebookEntryTargets().then(() => {
                    renderCategorySelect();
                    renderAdapterSelect();
                });
            }
            scheduleEvaluation();
        });
    }

    document.addEventListener('input', () => scheduleEvaluation(), true);
    document.addEventListener('change', () => scheduleEvaluation(), true);
}

jQuery(async () => {
    const settingsHtml = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
    $('#extensions_settings2').append(settingsHtml);
    protectModalLayout();

    getSettings();
    await refreshLorebookEntryTargets();
    renderCategorySelect();
    renderAdapterSelect();
    bindSettingsHandlers();
    subscribeToEvents();
    renderSettings();

    scheduleEvaluation(250);
});
