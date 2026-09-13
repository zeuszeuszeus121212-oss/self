/**
 * providers/openai.js — Disor Bot v7.1 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * مزود عام متوافق مع OpenAI (Chat Completions API).
 * يعمل مع أي خدمة تتبع مواصفة /chat/completions:
 *   OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio, vLLM...
 * ═══════════════════════════════════════════════════════════
 *
 * الفروقات الجوهرية عن DeepSeek (مقصودة وليست نقصاً):
 *   • الـ API عديم الجلسات (Stateless) — لذلك المزود يحتفظ بذاكرة
 *     محادثة في RAM لكل جلسة قناة (session_id) ويبني messages[]
 *     حقيقية (system + history + user) بدل prompt نصي واحد.
 *   • يُرسل Authorization: Bearer إلى أي base_url يحدده الوكيل.
 *   • Streaming SSE حقيقي مع فك chunks وتجميع النص.
 */

'use strict';

const crypto = require('crypto');
const axios  = require('axios');

const REQUEST_TIMEOUT_MS = 180_000;
const MAX_HISTORY_MESSAGES = 40;      // حد أقصى لرسائل الذاكرة لكل جلسة
const MAX_HISTORY_CHARS    = 60_000;  // حد أحرف إجمالي للحماية من الانفجار

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

// ══════════════════════════════════════════════════════════════
//  ذاكرة المحادثات (RAM) — keyed by sessionId
// ══════════════════════════════════════════════════════════════

/** @type {Map<string, {messages: Array<{role:string,content:string}>, last_used: number}>} */
const conversations = new Map();
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 ساعات مثل DeepSeek

function newSessionId() {
    return `oai:${crypto.randomUUID()}`;
}

function getConversation(sessionId) {
    if (!sessionId) return null;
    return conversations.get(sessionId) || null;
}

function trimConversation(conv) {
    const msgs = conv.messages;
    if (msgs.length > MAX_HISTORY_MESSAGES) {
        // احتفظ بأول رسالة system ثم آخر N رسائل
        const isSystemFirst = msgs[0] && msgs[0].role === 'system';
        const head = isSystemFirst ? [msgs[0]] : [];
        const body = msgs.slice(-(MAX_HISTORY_MESSAGES - head.length));
        conv.messages = [...head, ...body];
    }
    const totalChars = conv.messages.reduce((acc, m) => acc + (m.content ? m.content.length : 0), 0);
    if (totalChars > MAX_HISTORY_CHARS) {
        const isSystemFirst = conv.messages[0] && conv.messages[0].role === 'system';
        const head = isSystemFirst ? [conv.messages[0]] : [];
        let acc = head.reduce((s, m) => s + m.content.length, 0);
        const kept = [];
        for (let i = conv.messages.length - 1; i >= head.length; i--) {
            const len = conv.messages[i].content ? conv.messages[i].content.length : 0;
            if (acc + len > MAX_HISTORY_CHARS && kept.length > 2) break;
            acc += len;
            kept.unshift(conv.messages[i]);
        }
        conv.messages = [...head, ...kept];
    }
}

function evictOldConversations() {
    const now = Date.now();
    for (const [key, conv] of conversations) {
        if (now - conv.last_used > SESSION_TTL_MS) conversations.delete(key);
    }
}

// ══════════════════════════════════════════════════════════════
//  تنظيف النص (نفس روح _strip في utils.js)
// ══════════════════════════════════════════════════════════════

function stripOpenAI(text) {
    return String(text || '')
        .replace(/\bFINISHEDSEARCH\b|\bFINISHED\b/gi, '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .trim();
}

// ══════════════════════════════════════════════════════════════
//  Streaming SSE حقيقي
// ══════════════════════════════════════════════════════════════

async function streamChatCompletion({ baseUrl, apiKey, model, messages, temperature }) {
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const payload = {
        model,
        messages,
        stream: true,
    };
    if (typeof temperature === 'number' && !Number.isNaN(temperature)) {
        payload.temperature = temperature;
    }

    const resp = await axios.post(url, payload, {
        headers: {
            'Content-Type' : 'application/json',
            'Accept'       : 'text/event-stream',
            'Authorization': `Bearer ${apiKey}`,
            'User-Agent'   : 'DisorBot/7.1 (OpenAI-compatible provider)',
        },
        timeout: REQUEST_TIMEOUT_MS,
        responseType: 'stream',
        validateStatus: () => true,
    });

    if (resp.status === 401) throw new Error('OpenAI Provider: مفتاح API غير صالح (401)');
    if (resp.status === 404) throw new Error(`OpenAI Provider: النموذج أو المسار غير موجود (404) — تحقق من base_url وmodel`);
    if (resp.status === 429) throw new Error('⏳ مزود OpenAI مزدحم حالياً (429)، حاول بعد لحظة.');
    if (resp.status !== 200) {
        let detail = '';
        try { detail = JSON.stringify(resp.data).slice(0, 200); } catch (_) {}
        throw new Error(`OpenAI Provider HTTP ${resp.status} ${detail}`);
    }

    let fullText = '';
    await new Promise((resolve, reject) => {
        let buf = '';
        resp.data.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (data === '[DONE]') { resolve(); return; }
                try {
                    const obj = JSON.parse(data);
                    const choice = obj.choices && obj.choices[0];
                    if (!choice) continue;
                    // دعم reasoning models (delta.reasoning_content يُتجاهل) والنص العادي
                    const piece = choice.delta && choice.delta.content ? choice.delta.content : '';
                    if (piece) fullText += piece;
                    if (choice.message && choice.message.content) fullText += choice.message.content;
                } catch (_) { continue; }
            }
        });
        resp.data.on('end', resolve);
        resp.data.on('error', reject);
    });

    return fullText;
}

// ══════════════════════════════════════════════════════════════
//  تعريف المزود
// ══════════════════════════════════════════════════════════════

const openaiProvider = {
    id       : 'openai',
    label    : 'OpenAI-Compatible',
    emoji    : '🔗',
    description: 'أي مزود متوافق مع OpenAI Chat Completions (OpenAI/OpenRouter/Groq/Ollama...) عبر base_url + api_key + model',

    modalFields: [
        { id: 'openai_base_url', label: 'Base URL (مثل https://api.openai.com/v1)', style: 'short', required: true },
        { id: 'openai_api_key', label: 'API Key (Bearer)', style: 'short', required: true },
        { id: 'openai_model', label: 'اسم النموذج (مثل gpt-4o-mini)', style: 'short', required: true },
    ],

    validate(config = {}) {
        const missing = [];
        if (!config.openai_base_url) missing.push('openai_base_url');
        if (!config.openai_api_key) missing.push('openai_api_key');
        if (!config.openai_model) missing.push('openai_model');
        return { ok: missing.length === 0, missing };
    },

    describe(config = {}) {
        const base = config.openai_base_url || DEFAULT_BASE_URL;
        return `Base: ${base} | Model: ${config.openai_model || '—'} | Key: ${config.openai_api_key ? 'موجود ✅' : 'مفقود ❌'}`;
    },

    /**
     * إرسال prompt والحصول على الرد.
     * بنية الجلسة: sessionId = oai:<uuid> — يُخزن في نفس حقل جلسة القناة.
     * الـ prompt الوارد هنا = "system + سياق + User: ..." كسلسلة واحدة،
     * نقسمها: أول جزء قبل "User:" يوضع كرسالة system، والتاريخ يُدار داخلياً.
     */
    async chat({ prompt, sessionId = null, config = {}, agentId = 'default' }) {
        const baseUrl = (config.openai_base_url || DEFAULT_BASE_URL).trim();
        const apiKey  = config.openai_api_key;
        const model   = config.openai_model;
        const temperature = typeof config.openai_temperature === 'string' && config.openai_temperature.trim() !== ''
            ? Number(config.openai_temperature)
            : undefined;

        if (!apiKey) throw new Error('openai_api_key مفقود لهذا الوكيل');
        if (!model) throw new Error('openai_model مفقود لهذا الوكيل');

        evictOldConversations();

        // جلسة موجودة؟
        let sessionKey = (sessionId && String(sessionId).startsWith('oai:')) ? String(sessionId) : null;
        let conv = getConversation(sessionKey);
        if (!conv) {
            sessionKey = sessionKey || newSessionId();
            conv = { messages: [], last_used: Date.now() };
            conversations.set(sessionKey, conv);
        }

        // تقسيم الـ prompt: كل ما قبل "User: <آخر رسالة>" يعامل كسياق
        // (الوكيل يبني prompt كسلسلة واحدة؛ نحافظ على فاصل المستخدم الأخير)
        const lastUserIdx = prompt.lastIndexOf('User: ');
        let systemPart = prompt;
        let userPart   = '';
        if (lastUserIdx !== -1) {
            systemPart = prompt.slice(0, lastUserIdx).trim();
            userPart   = prompt.slice(lastUserIdx + 'User: '.length).trim();
        }

        // بناء messages: system ثابت لكل الجلسة + التاريخ + رسالة المستخدم الجديدة
        if (!conv.messages.length) {
            if (systemPart) conv.messages.push({ role: 'system', content: systemPart });
        } else if (systemPart && conv.messages[0] && conv.messages[0].role === 'system') {
            // تحديث السياق بأحدث نسخة (buildBotContext يتغير مع كل رسالة)
            conv.messages[0].content = systemPart;
        }

        // متابعة سلسلة نتائج الأدوات: إذا لم توجد رسالة مستخدم جديدة (نتائج أدوات)،
        // يبقى الـ prompt كامل النص — نضيفه كرسالة مستخدم عادية.
        const content = userPart || prompt;
        conv.messages.push({ role: 'user', content });

        const fullText = await streamChatCompletion({
            baseUrl, apiKey, model,
            messages: conv.messages.slice(),
            temperature,
        });

        const text = stripOpenAI(fullText);
        if (!text) throw new Error('مزود OpenAI أرجع رداً فارغاً.');

        conv.messages.push({ role: 'assistant', content: text });
        trimConversation(conv);
        conv.last_used = Date.now();

        return {
            fullText           : text,
            sessionId          : sessionKey,
            newParentMessageId : null, // عديم الجلسات — لا threading
        };
    },

    /** اختبار اتصال حقيقي (طلب models أو completion مصغر) */
    async testConnection(config = {}) {
        const baseUrl = (config.openai_base_url || DEFAULT_BASE_URL).replace(/\/+$/, '');
        const apiKey  = config.openai_api_key;
        const model   = config.openai_model;
        if (!apiKey || !model) throw new Error('openai_api_key أو openai_model مفقود');

        try {
            const resp = await axios.get(`${baseUrl}/models`, {
                headers: { Authorization: `Bearer ${apiKey}` },
                timeout: 20_000,
                validateStatus: () => true,
            });
            if (resp.status === 200) {
                return `✅ اتصال ناجح بـ ${baseUrl} — متاح ${Array.isArray(resp.data?.data) ? resp.data.data.length : '?'} نموذج (المطلوب: ${model})`;
            }
            // بعض الخدمات لا توفر /models — نجرب completion مصغر
            const resp2 = await axios.post(`${baseUrl}/chat/completions`, {
                model,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 5,
            }, {
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                timeout: 30_000,
                validateStatus: () => true,
            });
            if (resp2.status === 200) return `✅ اتصال ناجح بـ ${baseUrl} بالنموذج ${model}`;
            throw new Error(`HTTP ${resp2.status}: ${JSON.stringify(resp2.data).slice(0, 150)}`);
        } catch (e) {
            throw new Error(`فشل اتصال OpenAI Provider: ${e.message}`);
        }
    },
};

module.exports = openaiProvider;
