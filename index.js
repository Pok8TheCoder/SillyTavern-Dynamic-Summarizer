/**
 * Dynamic Summarizer — SillyTavern Extension
 *
 * A fully standalone summarizer extension with:
 *  - Snippet-based summary history (per-chat, stored in chatMetadata)
 *  - Three API sources: Main API, WebLLM, Custom API
 *  - Three auto-trigger modes: manual / every-N-messages / context-pct
 *  - Summarization start-point control (last-end / beginning / custom / pick-from-chat)
 *  - Story Focus Prompt always appended to summarizer system prompt
 *  - Previous snippets shown to AI as context
 *  - Summarize Now button always visible with loading spinner
 *  - Snippet list with enable/disable, preview, load, delete
 */

import {
    getContext,
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../extensions.js';
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    substituteParamsExtended,
    generateRaw,
    getMaxPromptTokens,
    setExtensionPrompt,
    streamingProcessor,
    animation_duration,
    animation_easing,
    extension_prompt_types,
    extension_prompt_roles,
} from '../../../script.js';
import { is_group_generating, selected_group } from '../../group-chats.js';
import { loadMovingUIState, power_user } from '../../power-user.js';
import { dragElement } from '../../RossAscends-mods.js';
import { getTokenCountAsync } from '../../tokenizers.js';
import { debounce_timeout } from '../../constants.js';
import { debounce, waitUntilCondition, getStringHash, extractAllWords } from '../../utils.js';
import { generateWebLlmChatPrompt, getWebLlmContextSize, isWebLlmSupported } from '../shared.js';
import { removeReasoningFromString } from '../../reasoning.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../slash-commands/SlashCommandArgument.js';
import { macros, MacroCategory } from '../../macros/macro-system.js';
import { MacrosParser } from '/scripts/macros.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MODULE_NAME = 'dynamic_summarizer';
export { MODULE_NAME };

const TRIGGER_MODES = /** @type {const} */ ({
    MANUAL: 'manual',
    MESSAGES: 'messages',
    CONTEXT_PCT: 'context_pct',
});

const START_MODES = /** @type {const} */ ({
    LAST_END: 'last_end',
    BEGINNING: 'beginning',
    CUSTOM: 'custom',
});

const API_SOURCES = /** @type {const} */ ({
    MAIN: 'main',
    WEBLLM: 'webllm',
    CUSTOM: 'custom',
});

const DEFAULT_PROMPT =
    'Summarize the most important facts, events, and character moments from the conversation below. ' +
    'If previous summaries are provided, you may extend the most recent one or write a new summary focused only on the new content — do not repeat what is already covered. ' +
    'Limit your response to {{words}} words or less. Output only the summary text, nothing else.';

const DEFAULT_TEMPLATE = '[Summary: {{summary}}]';

// ─────────────────────────────────────────────────────────────────────────────
// Default settings (saved in extension_settings.dynamic_summarizer)
// ─────────────────────────────────────────────────────────────────────────────

const defaultSettings = {
    // API source
    source: API_SOURCES.MAIN,
    customApiUrl: '',
    customApiKey: '',
    customModel: '',
    // Trigger
    triggerMode: TRIGGER_MODES.MESSAGES,
    interval: 10,
    contextPctThreshold: 75,
    // Start point
    startMode: START_MODES.LAST_END,
    startCustomIndex: 0,
    // Prompts
    prompt: DEFAULT_PROMPT,
    promptWords: 200,
    responseLength: 0,
    focusPrompt: '',
    // Previous snippets fed to AI
    prevSnippetsCount: 2,
    // Injection
    template: DEFAULT_TEMPLATE,
    position: extension_prompt_types.IN_PROMPT,   // 0
    depth: 2,
    role: extension_prompt_roles.SYSTEM,           // 0
    wiScan: false,
    // State
    frozen: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Runtime state
// ─────────────────────────────────────────────────────────────────────────────

let inApiCall = false;
let lastMsgId = null;
let lastMsgHash = null;
let pickingFromChat = false;

// ─────────────────────────────────────────────────────────────────────────────
// Settings helpers
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {typeof defaultSettings} */
function cfg() {
    return extension_settings.dynamic_summarizer;
}

function ensureSettings() {
    if (!extension_settings.dynamic_summarizer) {
        extension_settings.dynamic_summarizer = {};
    }
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (extension_settings.dynamic_summarizer[k] === undefined) {
            extension_settings.dynamic_summarizer[k] = v;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Snippet management (per-chat in chatMetadata.dynsumSnippets)
// ─────────────────────────────────────────────────────────────────────────────

function genId() {
    return `ds_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** @returns {Array<object>} */
function loadSnippets() {
    const ctx = getContext();
    if (!ctx || !ctx.chatMetadata) return [];
    return ctx.chatMetadata.dynsumSnippets || [];
}

function saveSnippets(snippets) {
    const ctx = getContext();
    if (!ctx || !ctx.chatMetadata) return;
    ctx.chatMetadata.dynsumSnippets = snippets;
    ctx.saveChat();
}

/**
 * Add a new snippet and persist.
 * @param {string} text
 * @param {number} startMsgIdx
 * @param {number} endMsgIdx
 * @returns {object} The new snippet
 */
function addSnippet(text, startMsgIdx, endMsgIdx) {
    const snippets = loadSnippets();
    const snippet = {
        id: genId(),
        text: text.trim(),
        timestamp: Date.now(),
        enabled: true,
        startMsgIdx,
        endMsgIdx,
    };
    snippets.push(snippet);
    saveSnippets(snippets);
    return snippet;
}

function deleteSnippet(id) {
    const snippets = loadSnippets().filter(s => s.id !== id);
    saveSnippets(snippets);
    reinsertSummary();
    renderSnippetList();
}

function toggleSnippet(id) {
    const snippets = loadSnippets();
    const s = snippets.find(x => x.id === id);
    if (s) {
        s.enabled = !s.enabled;
        saveSnippets(snippets);
        reinsertSummary();
        renderSnippetList();
    }
}

function setAllSnippets(enabled) {
    const snippets = loadSnippets().map(s => ({ ...s, enabled }));
    saveSnippets(snippets);
    reinsertSummary();
    renderSnippetList();
}

function clearAllSnippets() {
    saveSnippets([]);
    reinsertSummary();
    renderSnippetList();
}

/**
 * Get concatenated text of all enabled snippets (oldest first by default).
 * @returns {string}
 */
function getEnabledText() {
    const enabled = loadSnippets().filter(s => s.enabled);
    return enabled.map(s => s.text).join('\n\n');
}

/**
 * Get the N most recent enabled snippets (for feeding to the AI).
 * @param {number} n
 * @returns {Array<object>}
 */
function getLastNEnabled(n) {
    if (!n || n <= 0) return [];
    return loadSnippets().filter(s => s.enabled).slice(-n);
}

/**
 * Determine the next summarization start index.
 * @returns {number}
 */
function getSummarizationStart() {
    const mode = cfg().startMode;
    if (mode === START_MODES.BEGINNING) return 0;
    if (mode === START_MODES.CUSTOM) return Math.max(0, cfg().startCustomIndex || 0);

    // LAST_END: find endMsgIdx of the most recent enabled snippet
    const enabled = loadSnippets().filter(s => s.enabled);
    if (enabled.length > 0) {
        const last = enabled.reduce((a, b) => (b.endMsgIdx > a.endMsgIdx ? b : a));
        return last.endMsgIdx + 1;
    }
    return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// UI – snippet list
// ─────────────────────────────────────────────────────────────────────────────

function renderSnippetList() {
    const $list = $('#dynsum_snippet_list');
    if (!$list.length) return;
    $list.empty();

    const snippets = loadSnippets();
    if (!snippets.length) {
        updateCombinedPreview();
        return;
    }

    // Newest first in UI
    [...snippets].reverse().forEach(snippet => {
        const date = new Date(snippet.timestamp).toLocaleString([], {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        const preview = snippet.text.replace(/\n/g, ' ').trim();
        const range = `msg ${snippet.startMsgIdx}–${snippet.endMsgIdx}`;

        const $item = $(`
            <div class="dynsum-snippet ${snippet.enabled ? '' : 'disabled'}" data-id="${snippet.id}">
                <input type="checkbox" class="dynsum-snippet-toggle" ${snippet.enabled ? 'checked' : ''}
                    title="${snippet.enabled ? 'Disable this snippet' : 'Enable this snippet'}">
                <div class="dynsum-snippet-body">
                    <div class="dynsum-snippet-meta">${date}&nbsp;·&nbsp;${range}</div>
                    <div class="dynsum-snippet-preview">${$('<span>').text(preview).html()}</div>
                </div>
                <div class="dynsum-snippet-btns">
                    <button class="dynsum-snippet-btn load" title="Load this snippet into a popup for editing/viewing">
                        <i class="fa-solid fa-eye"></i>
                    </button>
                    <button class="dynsum-snippet-btn delete" title="Delete this snippet permanently">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        `);

        $item.find('.dynsum-snippet-toggle').on('change', () => toggleSnippet(snippet.id));

        $item.find('.dynsum-snippet-btn.delete').on('click', async () => {
            const ok = await callConfirmPopup('Delete this summary snippet?', 'dynsum_del');
            if (ok) deleteSnippet(snippet.id);
        });

        $item.find('.dynsum-snippet-btn.load').on('click', () => {
            callGenericPopup(
                `<div style="max-height:60vh;overflow-y:auto;white-space:pre-wrap;font-size:0.9em;">${$('<span>').text(snippet.text).html()}</div>`,
                POPUP_TYPE.TEXT,
                '',
                { wide: true, large: true, okButton: 'Close' },
            );
        });

        $item.find('.dynsum-snippet-preview').on('click', function () {
            $(this).toggleClass('expanded');
        });

        $list.append($item);
    });

    updateCombinedPreview();
}

function updateCombinedPreview() {
    const text = getEnabledText();
    $('#dynsum_combined_preview').val(text || '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Popup helpers (use ST's built-in popup if available, fallback to confirm)
// ─────────────────────────────────────────────────────────────────────────────

async function callConfirmPopup(text) {
    if (typeof callGenericPopup !== 'undefined' && typeof POPUP_TYPE !== 'undefined') {
        const result = await callGenericPopup(text, POPUP_TYPE.CONFIRM);
        return !!result;
    }
    return confirm(text);
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt injection
// ─────────────────────────────────────────────────────────────────────────────

function formatSummaryValue(text) {
    if (!text) return '';
    const template = cfg().template || DEFAULT_TEMPLATE;
    return substituteParamsExtended(template, { summary: text });
}

function reinsertSummary() {
    const text = getEnabledText();
    setExtensionPrompt(
        MODULE_NAME,
        formatSummaryValue(text),
        cfg().position,
        cfg().depth,
        cfg().wiScan,
        cfg().role,
    );
    updateCombinedPreview();
}

// ─────────────────────────────────────────────────────────────────────────────
// System prompt builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the full system prompt for the summarizer.
 * @param {string} basePrompt Already has {{words}} substituted
 * @returns {string}
 */
function buildSystemPrompt(basePrompt) {
    const parts = [basePrompt];

    // Feed previous snippets as context
    const n = cfg().prevSnippetsCount ?? 2;
    const prev = getLastNEnabled(n);
    if (prev.length > 0) {
        const block = prev.map((s, i) => `[Previous Summary ${i + 1}]:\n${s.text}`).join('\n\n');
        parts.push(
            `--- Previous Summaries (context only) ---\n${block}\n--- End Previous Summaries ---\n\n` +
            `Note: Do NOT repeat or paraphrase content already covered above. Summarize only new content.`,
        );
    }

    // Story focus guidance
    const focus = (cfg().focusPrompt || '').trim();
    if (focus) {
        parts.push(`--- Story Focus Guidance ---\n${focus}`);
    }

    return parts.join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Token counting
// ─────────────────────────────────────────────────────────────────────────────

async function countTokens(text, padding = 0) {
    if (cfg().source === API_SOURCES.WEBLLM) {
        // WebLLM doesn't expose a standalone counter; approximate via GPT-2 ratio
        return Math.ceil(text.length / 3.5) + padding;
    }
    return getTokenCountAsync(text, padding);
}

async function getContextSize() {
    if (cfg().source === API_SOURCES.WEBLLM) {
        const max = await getWebLlmContextSize();
        return Math.round(max * 0.75);
    }
    return getMaxPromptTokens(cfg().responseLength || null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-trigger logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check context-pct condition.
 * @param {object} ctx ST context
 * @returns {boolean}
 */
function shouldTriggerContextPct(ctx) {
    const lastInCtx = ctx.chatMetadata?.lastInContextMessageId ?? ctx.chat.length;
    const startIdx = getSummarizationStart();
    const totalSince = ctx.chat.length - startIdx;
    if (totalSince <= 0) return false;
    const outOfCtx = Math.max(0, lastInCtx - startIdx);
    const pct = (outOfCtx / totalSince) * 100;
    const threshold = cfg().contextPctThreshold ?? 75;
    console.debug(`[DynSum] context_pct: ${outOfCtx}/${totalSince} = ${pct.toFixed(1)}% (threshold ${threshold}%)`);
    return pct >= threshold;
}

/**
 * Check messages-interval condition.
 * @param {object} ctx ST context
 * @returns {boolean}
 */
function shouldTriggerMessages(ctx) {
    const interval = cfg().interval || 0;
    if (interval === 0) return false;
    const startIdx = getSummarizationStart();
    let msgsSince = 0;
    let wordsSince = 0;
    for (let i = ctx.chat.length - 1; i >= startIdx; i--) {
        msgsSince++;
        wordsSince += extractAllWords(ctx.chat[i]?.mes || '').length;
    }
    console.debug(`[DynSum] messages trigger: ${msgsSince} msgs since start (interval ${interval})`);
    return msgsSince >= interval;
}

/**
 * Decide whether to run and return the fully built system prompt, or '' to skip.
 * @param {object} ctx
 * @param {boolean} force
 * @returns {Promise<string>}
 */
async function getPromptIfShouldRun(ctx, force) {
    const mode = cfg().triggerMode;

    if (!force) {
        if (mode === TRIGGER_MODES.MANUAL) return '';
        if (mode === TRIGGER_MODES.MESSAGES && !shouldTriggerMessages(ctx)) return '';
        if (mode === TRIGGER_MODES.CONTEXT_PCT && !shouldTriggerContextPct(ctx)) return '';
    }

    // Wait for group/send to settle
    try {
        if (selected_group) {
            await waitUntilCondition(() => is_group_generating === false, 1000, 10);
        }
        await waitUntilCondition(() => !window.is_send_press, 30000, 100);
    } catch {
        return '';
    }

    if (!ctx.chat.length) return '';

    const base = substituteParamsExtended(cfg().prompt || DEFAULT_PROMPT, { words: cfg().promptWords });
    if (!base) return '';

    return buildSystemPrompt(base);
}

// ─────────────────────────────────────────────────────────────────────────────
// Build chat content to summarize
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the user content (chat messages) to send to the summarizer.
 * Returns the text plus the last included message index.
 * @param {object} ctx
 * @param {string} sysPrompt
 * @returns {Promise<{content: string, endIdx: number} | null>}
 */
async function buildChatContent(ctx, sysPrompt) {
    const chat = ctx.chat.slice();
    chat.pop(); // always exclude the last (just-received) message

    const startIdx = getSummarizationStart();
    const PADDING = 64;
    const PROMPT_SIZE = await getContextSize();

    const buffer = [];
    let lastUsed = null;

    for (let i = startIdx; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg || msg.is_system || !msg.mes) continue;

        buffer.push(`${msg.name}:\n${msg.mes}`);

        const combined = [sysPrompt, ...buffer].join('\n\n');
        const tokens = await countTokens(combined, PADDING);

        if (tokens > PROMPT_SIZE) {
            buffer.pop();
            break;
        }

        lastUsed = { msg, idx: i };

        if (cfg().maxMessages > 0 && buffer.length >= cfg().maxMessages) break;
    }

    if (!lastUsed) return null;

    return {
        content: buffer.join('\n\n'),
        endIdx: lastUsed.idx,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// API calls
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Call the main ST API (same as chat).
 * @param {string} sysPrompt
 * @param {string} userContent
 * @returns {Promise<string>}
 */
async function callMainApi(sysPrompt, userContent) {
    const raw = await generateRaw({
        prompt: userContent,
        systemPrompt: sysPrompt,
        responseLength: cfg().responseLength || null,
    });
    return removeReasoningFromString(raw);
}

/**
 * Call WebLLM.
 * @param {string} sysPrompt
 * @param {string} userContent
 * @returns {Promise<string>}
 */
async function callWebLlmApi(sysPrompt, userContent) {
    const messages = [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: userContent },
    ].filter(m => m.content);

    const params = cfg().responseLength > 0 ? { max_tokens: cfg().responseLength } : {};
    return await generateWebLlmChatPrompt(messages, params);
}

/**
 * Call a custom OpenAI-compatible API.
 * @param {string} sysPrompt
 * @param {string} userContent
 * @returns {Promise<string>}
 */
async function callCustomApi(sysPrompt, userContent) {
    const url = (cfg().customApiUrl || '').replace(/\/$/, '') + '/chat/completions';
    const key = cfg().customApiKey || '';
    const model = cfg().customModel || 'gpt-4o-mini';

    const body = {
        model,
        messages: [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: userContent },
        ].filter(m => m.content),
    };
    if (cfg().responseLength > 0) body.max_tokens = cfg().responseLength;

    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(key ? { 'Authorization': `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const err = await resp.text().catch(() => resp.statusText);
        throw new Error(`Custom API error ${resp.status}: ${err}`);
    }

    const data = await resp.json();
    return (data.choices?.[0]?.message?.content || '').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Context integrity guard
// ─────────────────────────────────────────────────────────────────────────────

function isContextChanged(snapshot) {
    const now = getContext();
    return (
        now.groupId !== snapshot.groupId ||
        now.chatId !== snapshot.chatId ||
        (!now.groupId && now.characterId !== snapshot.characterId)
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main summarize routine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run summarization. If force=true, ignores trigger conditions.
 * @param {boolean} [force]
 * @returns {Promise<string>} The generated summary text, or ''
 */
async function runSummarize(force = false) {
    if (inApiCall) {
        console.debug('[DynSum] Already in API call, skipping.');
        return '';
    }

    const source = cfg().source;

    if (source === API_SOURCES.WEBLLM && !isWebLlmSupported()) {
        toastr.warning('WebLLM extension is not loaded or not supported.');
        return '';
    }

    const ctx = getContext();
    const sysPrompt = await getPromptIfShouldRun(ctx, force);
    if (!sysPrompt) return '';

    const chatContent = await buildChatContent(ctx, sysPrompt);
    if (!chatContent) {
        if (force) {
            toastr.info('No new messages to summarize since last snippet.');
        }
        return '';
    }

    let summary = '';
    inApiCall = true;

    try {
        switch (source) {
            case API_SOURCES.MAIN:
                summary = await callMainApi(sysPrompt, chatContent.content);
                break;
            case API_SOURCES.WEBLLM:
                summary = await callWebLlmApi(sysPrompt, chatContent.content);
                break;
            case API_SOURCES.CUSTOM:
                summary = await callCustomApi(sysPrompt, chatContent.content);
                break;
            default:
                toastr.error('Unknown API source configured.');
                return '';
        }
    } catch (err) {
        console.error('[DynSum] Summarization failed:', err);
        toastr.error(String(err), 'Summarization failed');
        return '';
    } finally {
        inApiCall = false;
    }

    if (!summary) {
        console.warn('[DynSum] Empty summary received.');
        return '';
    }

    if (isContextChanged(ctx)) {
        console.log('[DynSum] Context changed during summarization, discarding result.');
        return '';
    }

    // Save as a new snippet
    const snippet = addSnippet(summary, getSummarizationStart(), chatContent.endIdx);
    console.log(`[DynSum] New snippet created: ${snippet.id} (msg ${snippet.startMsgIdx}–${snippet.endMsgIdx})`);

    reinsertSummary();
    renderSnippetList();

    return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat event handlers
// ─────────────────────────────────────────────────────────────────────────────

function onChatChanged() {
    renderSnippetList();
    reinsertSummary();
    lastMsgId = null;
    lastMsgHash = null;
}

const saveChatDebounced = debounce(() => getContext().saveChat(), debounce_timeout.relaxed);

async function onChatEvent() {
    if (streamingProcessor && !streamingProcessor.isFinished) return;
    if (inApiCall || cfg().frozen) return;
    if (cfg().triggerMode === TRIGGER_MODES.MANUAL) return;

    const ctx = getContext();
    if (!ctx.chat.length) return;

    const lastMsg = ctx.chat[ctx.chat.length - 1];
    const msgHash = getStringHash(lastMsg.mes || '');

    // No change
    if (lastMsgId === ctx.chat.length && msgHash === lastMsgHash) return;

    lastMsgId = ctx.chat.length;
    lastMsgHash = msgHash;

    runSummarize(false).catch(console.error);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pick-from-chat mode
// ─────────────────────────────────────────────────────────────────────────────

function enterPickMode() {
    pickingFromChat = true;
    $('body').addClass('dynsum_picking');
    $('#dynsum_pick_bar').removeClass('hidden');

    $('#chat').one('click.dynsum_pick', '.mes', function () {
        const mesId = Number($(this).attr('mesid'));
        if (!isNaN(mesId)) {
            extension_settings.dynamic_summarizer.startCustomIndex = mesId;
            $('#dynsum_start_index').val(mesId);
            saveSettingsDebounced();
            toastr.info(`Summarization start set to message #${mesId}.`);
        }
        exitPickMode();
    });
}

function exitPickMode() {
    pickingFromChat = false;
    $('body').removeClass('dynsum_picking');
    $('#dynsum_pick_bar').addClass('hidden');
    $('#chat').off('click.dynsum_pick');
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings load / save
// ─────────────────────────────────────────────────────────────────────────────

function loadSettings() {
    ensureSettings();
    const s = cfg();

    $('#dynsum_source').val(s.source).trigger('change');
    $('#dynsum_custom_api_url').val(s.customApiUrl || '');
    $('#dynsum_custom_api_key').val(s.customApiKey || '');
    $('#dynsum_custom_model').val(s.customModel || '');

    $(`input[name="dynsum_trigger_mode"][value="${s.triggerMode}"]`).prop('checked', true);
    applyTriggerModeUI(s.triggerMode);

    $('#dynsum_interval').val(s.interval);
    $('#dynsum_interval_val').text(s.interval);
    $('#dynsum_context_pct').val(s.contextPctThreshold);
    $('#dynsum_context_pct_val').text(s.contextPctThreshold);

    $(`input[name="dynsum_start_mode"][value="${s.startMode}"]`).prop('checked', true);
    applyStartModeUI(s.startMode);
    $('#dynsum_start_index').val(s.startCustomIndex || 0);

    $('#dynsum_prompt').val(s.prompt);
    $('#dynsum_prompt_words').val(s.promptWords);
    $('#dynsum_prompt_words_val').text(s.promptWords);
    $('#dynsum_response_length').val(s.responseLength);
    $('#dynsum_response_length_val').text(s.responseLength);

    $('#dynsum_focus_prompt').val(s.focusPrompt || '');
    $('#dynsum_prev_snippets').val(s.prevSnippetsCount ?? 2);
    $('#dynsum_prev_snippets_val').text(s.prevSnippetsCount ?? 2);

    $('#dynsum_template').val(s.template);
    $(`input[name="dynsum_position"][value="${s.position}"]`).prop('checked', true);
    $('#dynsum_depth').val(s.depth);
    $('#dynsum_role').val(s.role);
    $('#dynsum_wi_scan').prop('checked', s.wiScan);
    $('#dynsum_frozen').prop('checked', s.frozen);

    renderSnippetList();
    reinsertSummary();
}

function applyTriggerModeUI(mode) {
    $('#dynsum_messages_row').toggle(mode === TRIGGER_MODES.MESSAGES);
    $('#dynsum_pct_row').toggle(mode === TRIGGER_MODES.CONTEXT_PCT);
}

function applyStartModeUI(mode) {
    $('#dynsum_custom_start_row').toggle(mode === START_MODES.CUSTOM);
}

// ─────────────────────────────────────────────────────────────────────────────
// Event listener wiring
// ─────────────────────────────────────────────────────────────────────────────

function setupListeners() {
    // Source
    $('#dynsum_source').off('change').on('change', function () {
        cfg().source = $(this).val();
        $('#dynsum_custom_api_row').toggle(cfg().source === API_SOURCES.CUSTOM);
        saveSettingsDebounced();
    });

    $('#dynsum_custom_api_url').off('input').on('input', function () {
        cfg().customApiUrl = $(this).val();
        saveSettingsDebounced();
    });
    $('#dynsum_custom_api_key').off('input').on('input', function () {
        cfg().customApiKey = $(this).val();
        saveSettingsDebounced();
    });
    $('#dynsum_custom_model').off('input').on('input', function () {
        cfg().customModel = $(this).val();
        saveSettingsDebounced();
    });

    // Trigger mode
    $('input[name="dynsum_trigger_mode"]').off('change').on('change', function () {
        cfg().triggerMode = $(this).val();
        applyTriggerModeUI(cfg().triggerMode);
        saveSettingsDebounced();
    });

    $('#dynsum_interval').off('input').on('input', function () {
        cfg().interval = Number($(this).val());
        $('#dynsum_interval_val').text(cfg().interval);
        saveSettingsDebounced();
    });

    $('#dynsum_context_pct').off('input').on('input', function () {
        cfg().contextPctThreshold = Number($(this).val());
        $('#dynsum_context_pct_val').text(cfg().contextPctThreshold);
        saveSettingsDebounced();
    });

    // Start mode
    $('input[name="dynsum_start_mode"]').off('change').on('change', function () {
        cfg().startMode = $(this).val();
        applyStartModeUI(cfg().startMode);
        saveSettingsDebounced();
    });

    $('#dynsum_start_index').off('input').on('input', function () {
        cfg().startCustomIndex = Number($(this).val());
        saveSettingsDebounced();
    });

    $('#dynsum_pick_from_chat').off('click').on('click', () => {
        enterPickMode();
    });

    $('#dynsum_pick_cancel').off('click').on('click', () => exitPickMode());

    // Prompts
    $('#dynsum_prompt').off('input').on('input', function () {
        cfg().prompt = $(this).val();
        saveSettingsDebounced();
    });

    $('#dynsum_prompt_restore').off('click').on('click', () => {
        cfg().prompt = DEFAULT_PROMPT;
        $('#dynsum_prompt').val(DEFAULT_PROMPT);
        saveSettingsDebounced();
    });

    $('#dynsum_prompt_words').off('input').on('input', function () {
        cfg().promptWords = Number($(this).val());
        $('#dynsum_prompt_words_val').text(cfg().promptWords);
        saveSettingsDebounced();
    });

    $('#dynsum_response_length').off('input').on('input', function () {
        cfg().responseLength = Number($(this).val());
        $('#dynsum_response_length_val').text(cfg().responseLength);
        saveSettingsDebounced();
    });

    $('#dynsum_focus_prompt').off('input').on('input', function () {
        cfg().focusPrompt = $(this).val();
        saveSettingsDebounced();
    });

    $('#dynsum_prev_snippets').off('input').on('input', function () {
        cfg().prevSnippetsCount = Number($(this).val());
        $('#dynsum_prev_snippets_val').text(cfg().prevSnippetsCount);
        saveSettingsDebounced();
    });

    // Injection
    $('#dynsum_template').off('input').on('input', function () {
        cfg().template = $(this).val();
        reinsertSummary();
        saveSettingsDebounced();
    });

    $('input[name="dynsum_position"]').off('change').on('change', function () {
        cfg().position = $(this).val();
        reinsertSummary();
        saveSettingsDebounced();
    });

    $('#dynsum_depth').off('input').on('input', function () {
        cfg().depth = Number($(this).val());
        reinsertSummary();
        saveSettingsDebounced();
    });

    $('#dynsum_role').off('change').on('change', function () {
        cfg().role = Number($(this).val());
        reinsertSummary();
        saveSettingsDebounced();
    });

    $('#dynsum_wi_scan').off('change').on('change', function () {
        cfg().wiScan = $(this).prop('checked');
        reinsertSummary();
        saveSettingsDebounced();
    });

    $('#dynsum_frozen').off('change').on('change', function () {
        cfg().frozen = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // Summarize Now
    $('#dynsum_summarize_now').off('click').on('click', async () => {
        if (inApiCall) return;
        $('#dynsum_summarize_now').addClass('summarizing');
        try {
            await runSummarize(true);
        } finally {
            $('#dynsum_summarize_now').removeClass('summarizing');
        }
    });

    // Snippet bulk actions
    $('#dynsum_snippets_all_on').off('click').on('click', () => setAllSnippets(true));
    $('#dynsum_snippets_all_off').off('click').on('click', () => setAllSnippets(false));
    $('#dynsum_snippets_clear').off('click').on('click', async () => {
        const ok = await callConfirmPopup('Delete ALL summary snippets? This cannot be undone.');
        if (ok) clearAllSnippets();
    });

    // Settings toggle
    $('#dynsum_settings_toggle').off('click').on('click', () => {
        $('#dynsum_settings_block').slideToggle(200, 'swing');
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Popout support
// ─────────────────────────────────────────────────────────────────────────────

function doPopout(e) {
    const target = e.target;
    if ($('#dynsum_popout').length === 0) {
        const originalContent = $(target).parent().parent().parent().find('.inline-drawer-content');
        const htmlClone = originalContent.html();
        const template = $('#zoomed_avatar_template').html();

        const controlBar = `<div class="panelControlBar flex-container">
            <div id="dynsum_popout_header" class="fa-solid fa-grip drag-grabber hoverglow"></div>
            <div id="dynsum_popout_close" class="fa-solid fa-circle-xmark hoverglow dragClose"></div>
        </div>`;

        const newEl = $(template);
        newEl.attr('id', 'dynsum_popout')
            .css('opacity', 0)
            .removeClass('zoomed_avatar')
            .addClass('draggable')
            .empty();

        originalContent.empty().html('<div class="flex-container alignitemscenter justifyCenter wide100p"><small>Currently popped out</small></div>');
        newEl.append(controlBar).append(htmlClone);
        $('#movingDivs').append(newEl);
        newEl.transition({ opacity: 1, duration: animation_duration, easing: animation_easing });

        $('#dynsum_drawer_contents').addClass('scrollableInnerFull');
        setupListeners();
        loadSettings();
        loadMovingUIState();
        dragElement(newEl);

        $('#dynsum_popout_close').off('click').on('click', () => {
            $('#dynsum_drawer_contents').removeClass('scrollableInnerFull');
            const popoutHtml = $('#dynsum_drawer_contents');
            $('#dynsum_popout').fadeOut(animation_duration, () => {
                originalContent.empty().append(popoutHtml);
                $('#dynsum_popout').remove();
            });
            loadSettings();
        });
    } else {
        $('#dynsum_popout').fadeOut(animation_duration, () => $('#dynsum_popout_close').trigger('click'));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Slash command + macro
// ─────────────────────────────────────────────────────────────────────────────

async function summarizeSlashCommand(args, text) {
    text = text.trim();

    // If text is provided, summarize that text directly using the configured source
    if (text) {
        const basePrompt = substituteParamsExtended(cfg().prompt || DEFAULT_PROMPT, { words: cfg().promptWords });
        const sysPrompt = buildSystemPrompt(basePrompt);
        try {
            switch (cfg().source) {
                case API_SOURCES.MAIN:
                    return await callMainApi(sysPrompt, text);
                case API_SOURCES.WEBLLM:
                    return await callWebLlmApi(sysPrompt, text);
                case API_SOURCES.CUSTOM:
                    return await callCustomApi(sysPrompt, text);
            }
        } catch (err) {
            toastr.error(String(err), 'Summarization failed');
            return '';
        }
    }

    // Otherwise force-summarize current chat
    const quiet = String(args.quiet || 'false').toLowerCase() === 'true';
    if (!quiet) toastr.info('Summarizing chat...', 'Dynamic Summarizer', { timeOut: 0, extendedTimeOut: 0 });

    $('#dynsum_summarize_now').addClass('summarizing');
    try {
        return await runSummarize(true);
    } finally {
        $('#dynsum_summarize_now').removeClass('summarizing');
        if (!quiet) toastr.clear();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────

export async function init() {
    ensureSettings();

    // Render settings HTML into the extensions panel
    const html = await renderExtensionTemplateAsync('dynamic-summarizer', 'settings', {});
    $('#summarize_container').append(html);

    setupListeners();
    loadSettings();

    // Popout button
    $('#dynsum_popout_btn').off('click').on('click', function (e) {
        doPopout(e);
        e.stopPropagation();
    });

    // Chat events
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onChatEvent);
    for (const ev of [event_types.MESSAGE_DELETED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_SWIPED]) {
        eventSource.on(ev, onChatEvent);
    }

    // Slash command
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'dynsum',
        callback: summarizeSlashCommand,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'quiet',
                description: 'suppress toast notifications',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument('text to summarize (optional)', [ARGUMENT_TYPE.STRING], false),
        ],
        helpString: 'Dynamic Summarizer: summarize the current chat, or provide text to summarize inline.',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // Macro {{dynsum}} → current combined snippet text
    const macroHandler = () => getEnabledText() || '';

    if (power_user?.experimental_macro_engine) {
        macros.register('dynsum', {
            category: MacroCategory.CHAT,
            description: 'Returns the current Dynamic Summarizer combined summary text.',
            handler: macroHandler,
        });
    } else {
        MacrosParser.registerMacro('dynsum', macroHandler, 'Returns the current Dynamic Summarizer summary.');
    }

    console.log('[DynSum] Dynamic Summarizer extension initialized.');
}
