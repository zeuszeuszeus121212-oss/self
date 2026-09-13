/**
 * providers/qwen.js — Disor Bot v7.4 "Nexus"
 * ═══════════════════════════════════════════════════════════
 * مزود Qwen — منفصل تماماً عن DeepSeek.
 * نقل حقيقي ومنذم لـ qwen.py v10.0 (Universal AI Proxy) إلى JavaScript:
 *   • يتصل مباشرة بـ chat.qwen.ai/api/v2 (تطبيق Qwen للاندرويد)
 *   • جلسات حقيقية: chats/new + parent_id threading
 *   • Streaming مع كشف RateLimited / Antibot / الحظر
 *   • التفكير العميق (thinking) + البحث المدمج (auto_search) عبر feature_config
 *   • رؤية الصور: رفع صور إلى Qwen OSS (getstsToken → multipart → complete)
 *   • توليد الصور (t2i) — generateImage
 *   • يدعم تبديل النموذج (qwen_model) لكل وكيل
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const crypto = require('crypto');
const axios  = require('axios');

// ══════════════════════════════════════════════════════════════
//  الثوابت — مطابقة لـ qwen.py
// ══════════════════════════════════════════════════════════════

const QWEN_BASE          = 'https://chat.qwen.ai/api/v2';
const DEFAULT_MODEL      = 'qwen3.8-max';
const REQUEST_TIMEOUT_MS = 180_000;
const BAN_CODES          = new Set([403, 429, 451]);

const UA_APP = (
    'Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2) ' +
    'AliApp(QWENCHAT/2.7.2) AppType/Release AplusBridgeLite'
);
const UA_NEW = (
    'Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2),' +
    'Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2) ' +
    'AliApp(QWENCHAT/2.7.2) AppType/Release AplusBridgeLite'
);

const uuid = () => crypto.randomUUID();

// ══════════════════════════════════════════════════════════════
//  Headers — مطابقة لـ _qwen_headers_chat / _qwen_headers_new
// ══════════════════════════════════════════════════════════════

function qwenHeadersChat(token, { stream = false, host = 'chat.qwen.ai' } = {}) {
    return {
        'User-Agent'    : UA_APP,
        'Content-Type'  : 'application/json; charset=UTF-8',
        'Accept'        : stream ? '*/*,text/event-stream' : 'application/json',
        'Accept-Language': 'en-US',
        'Accept-Encoding': 'gzip, deflate',
        'Cache-Control' : 'no-store',
        'Connection'    : 'Keep-Alive',
        'Host'          : host,
        'X-Platform'    : 'android',
        'x-device-id'   : '0',
        'source'        : 'app',
        'Authorization' : `Bearer ${token}`,
        'x-request-id'  : uuid(),
        'Cookie'        : `x-ap=eu-central-1; token=${token}`,
    };
}

function qwenHeadersNew(token, host = 'chat.qwen.ai') {
    return {
        'User-Agent'    : UA_NEW,
        'Content-Type'  : 'application/json',
        'Accept'        : 'application/json',
        'Accept-Language': 'en-US',
        'Accept-Encoding': 'gzip',
        'Connection'    : 'Keep-Alive',
        'Host'          : host,
        'X-Platform'    : 'android',
        'x-device-id'   : '0',
        'source'        : 'app',
        'Authorization' : `Bearer ${token}`,
        'x-request-id'  : uuid(),
        'Cookie'        : `x-ap=eu-central-1; token=${token}`,
    };
}

// ══════════════════════════════════════════════════════════════
//  كشف الأخطاء — مطابقة لـ _qwen_is_rate_limited / _qwen_is_antibot
// ══════════════════════════════════════════════════════════════

function isRateLimited(obj) {
    if (typeof obj === 'string') return obj.includes('RateLimited');
    if (obj && typeof obj === 'object') {
        if (obj.code === 'RateLimited') return true;
        if (obj.data && typeof obj.data === 'object' && obj.data.code === 'RateLimited') return true;
        try { return JSON.stringify(obj).includes('RateLimited'); } catch (_) { return false; }
    }
    return false;
}

function isAntibot(line) {
    return line.includes('_____tmd_____') || line.includes('punish');
}

// ═══════════════════════════════════════════════════════════
//  تحديد عنوان الـ API — الافتراضي chat.qwen.ai، وقابل للتوجيه
//  عبر qwen_base_url في إعدادات الوكيل (مفيد للاختبار والبوابات)
// ═══════════════════════════════════════════════════════════

function resolveBaseUrl(config = {}) {
    const custom = String(config.qwen_base_url || '').trim().replace(/\/+$/, '');
    return custom || QWEN_BASE;
}

function hostOf(baseUrl) {
    try { return new URL(baseUrl).host; } catch (_) { return 'chat.qwen.ai'; }
}

// ══════════════════════════════════════════════════════════════
//  إنشاء محادثة Qwen — مطابقة لـ _qwen_create_chat
// ══════════════════════════════════════════════════════════════

async function createQwenChat(token, baseUrl = QWEN_BASE) {
    const url = `${baseUrl}/chats/new`;
    const payload = { chat_mode: 'normal', project_id: '' };
    const resp = await axios.post(url, payload, {
        headers: qwenHeadersNew(token, hostOf(baseUrl)),
        timeout: 60_000,
        validateStatus: () => true,
    });
    if (BAN_CODES.has(resp.status)) {
        const err = new Error(`QWEN_BANNED HTTP ${resp.status}`);
        err.qwenBanned = true;
        throw err;
    }
    const data = resp.data || {};
    const cid = data.chat_id || data.id
        || (data.data && (data.data.chat_id || data.data.id));
    if (!cid) {
        throw new Error(`فشل إنشاء محادثة Qwen: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return String(cid);
}

// ══════════════════════════════════════════════════════════════
//  بناء الحمولة — مطابقة لـ _qwen_build_payload
// ══════════════════════════════════════════════════════════════

function buildQwenPayload(chatId, prompt, parentId, { thinking = false, modelId = DEFAULT_MODEL, autoSearch = false, chatType = 't2t', files = [], size = '1:1' } = {}) {
    const ts  = Math.floor(Date.now() / 1000);
    const fid = uuid();
    return {
        stream                : true,
        incremental_output    : true,
        chatId                : chatId,
        chat_id               : chatId,
        chat_mode             : 'normal',
        model                 : modelId,
        messages              : [{
            id        : null,
            fid       : fid,
            chat_type : chatType,
            content   : prompt,
            role      : 'user',
            feature_config : {
                output_schema    : 'phase',
                thinking_enabled : thinking,
                thinking_format  : 'summary',
                auto_thinking    : thinking,
                auto_search      : Boolean(autoSearch),
            },
            timestamp     : ts,
            sub_chat_type : chatType,
            models        : [modelId],
            model         : '',
            files,
            user_action   : 'chat',
            extra         : { meta: { subChatType: chatType } },
            parentId      : parentId || '',
            parent_id     : parentId || '',
        }],
        timestamp               : ts,
        size                    : size,
        share_id                : '',
        version                 : '2.1',
        origin_branch_message_id: '',
        parentId                : parentId || '',
        parent_id               : parentId || '',
    };
}

// ══════════════════════════════════════════════════════════════
//  جمع الرد المتدفق — مطابقة لـ _qwen_stream_collect
// ══════════════════════════════════════════════════════════════

async function streamQwenChat(token, chatId, payload, baseUrl = QWEN_BASE) {
    const url = `${baseUrl}/chat/completions`;
    let fullText  = '';
    let responseId = null;
    let errorNote  = null;

    const resp = await axios.post(url, payload, {
        headers: qwenHeadersChat(token, { stream: true, host: hostOf(baseUrl) }),
        params : { chat_id: chatId },
        timeout: REQUEST_TIMEOUT_MS,
        responseType: 'stream',
        validateStatus: () => true,
    });

    if (BAN_CODES.has(resp.status)) {
        const err = new Error(`QWEN_BANNED HTTP ${resp.status}`);
        err.qwenBanned = true;
        throw err;
    }
    if (resp.status !== 200) {
        throw new Error(`QWEN HTTP ${resp.status}`);
    }

    await new Promise((resolve, reject) => {
        let buf = '';
        resp.data.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
                const rawLine = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!rawLine) continue;
                if (isAntibot(rawLine)) { resolve(); return; }
                if (isRateLimited(rawLine)) { errorNote = 'RateLimited'; continue; }
                if (!rawLine.startsWith('data: ')) continue;
                const ds = rawLine.slice(6).trim();
                if (ds === '[DONE]') { resolve(); return; }
                try {
                    const obj = JSON.parse(ds);
                    if (isRateLimited(obj)) { errorNote = 'RateLimited'; continue; }
                    const rid = obj.response_id
                        || (obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.response_id);
                    if (rid) responseId = String(rid);
                    const choices = obj.choices || [];
                    if (!choices.length) continue;
                    const delta = choices[0].delta || {};
                    const phase = delta.phase || '';
                    if (phase && phase !== 'answer') continue; // تجاهل phase التفكير — مطابق للبايثون
                    const content = delta.content || '';
                    if (content) fullText += content;
                } catch (_) { continue; }
            }
        });
        resp.data.on('end', resolve);
        resp.data.on('error', reject);
    });

    if (errorNote === 'RateLimited' && !fullText) {
        throw new Error('⏳ Qwen مزدحم حالياً (RateLimited)، حاول بعد لحظة.');
    }

    return { fullText, responseId };
}

// ══════════════════════════════════════════════════════════════
//  تنظيف النص — إزالة وسوم التفكير إن ظهرت
// ══════════════════════════════════════════════════════════════

function stripQwen(text) {
    return String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .trim();
}

// ═════════════════════════════════════════════════════════
//  رفع الصور إلى Qwen OSS — من qwen.py/البروكسي v10
//  (getstsToken → توقيع OSS → multipart upload → complete)
// ═════════════════════════════════════════════════════════

function ossSignature(secretKey, method, contentMd5, contentType, date, canonicalHeaders, canonicalResource) {
    const stringToSign = `${method}\n${contentMd5}\n${contentType}\n${date}\n${canonicalHeaders}${canonicalResource}`;
    return crypto.createHmac('sha1', secretKey).update(stringToSign, 'utf8').digest('base64');
}

function gmtNow() {
    return new Date().toUTCString();
}

async function uploadImageToQwenOss(token, imageBuffer, filename, baseUrl = QWEN_BASE) {
    filename = filename || `${uuid()}_IMG.jpg`;
    const fileSize = String(imageBuffer.length);

    // ── 1. STS token
    const stsResp = await axios.post(
        `${baseUrl}/files/getstsToken`,
        { filename, filetype: 'image', filesize: fileSize },
        {
            headers: {
                'User-Agent'   : UA_APP,
                'Content-Type' : 'application/json',
                'Authorization': `Bearer ${token}`,
                'x-device-id'  : '0',
                'source'       : 'app',
                'x-request-id' : uuid(),
                'Cookie'       : `x-ap=eu-central-1; token=${token}`,
            },
            timeout: 60_000,
            validateStatus: () => true,
        },
    );
    const res = stsResp.data || {};
    if (!res.data) throw new Error(`Qwen OSS STS فشل: ${JSON.stringify(res).slice(0, 200)}`);
    const sts = res.data;
    const accessKeyId = sts.access_key_id;
    const accessKeySecret = sts.access_key_secret;
    const securityToken = sts.security_token;
    const filePath = sts.file_path;
    const fileId = sts.file_id;
    const bucket = sts.bucketname;
    const host = `${bucket}.${sts.endpoint}`;
    const canonSecHeader = `x-oss-security-token:${securityToken}\n`;

    const ossBaseHeaders = (method, contentMd5, contentType, canonResource, contentLength = '0') => {
        const gmt = gmtNow();
        const sig = ossSignature(accessKeySecret, method, contentMd5, contentType, gmt, canonSecHeader, canonResource);
        return {
            'Authorization'        : `OSS ${accessKeyId}:${sig}`,
            'User-Agent'           : 'aliyun-sdk-android/2.9.21',
            'Host'                 : host,
            'x-oss-security-token' : securityToken,
            'Date'                 : gmt,
            'Content-Type'         : contentType,
            'Content-Length'       : contentLength,
        };
    };

    // ── 2. Initiate multipart upload
    const initResp = await axios.post(`https://${host}/${filePath}?uploads`, null, {
        headers: ossBaseHeaders('POST', '', 'image/jpeg', `/${bucket}/${filePath}?uploads`),
        timeout: 60_000,
        validateStatus: () => true,
    });
    const initText = String(initResp.data || '');
    const uploadIdMatch = initText.match(/<UploadId>([^<]+)<\/UploadId>/);
    if (!uploadIdMatch) throw new Error('Qwen OSS: لم أجد UploadId في رد البدء');
    const uploadId = uploadIdMatch[1];

    // ── 3. رفع الجزء الوحيد
    const contentMd5 = crypto.createHash('md5').update(imageBuffer).digest('base64');
    const partResp = await axios.put(
        `https://${host}/${filePath}?uploadId=${encodeURIComponent(uploadId)}&partNumber=1`,
        imageBuffer,
        {
            headers: {
                ...ossBaseHeaders('PUT', contentMd5, 'image/jpeg', `/${bucket}/${filePath}?partNumber=1&uploadId=${encodeURIComponent(uploadId)}`, fileSize),
                'Content-MD5': contentMd5,
            },
            timeout: 120_000,
            validateStatus: () => true,
        },
    );
    const etag = String(partResp.headers && partResp.headers.etag || '').replace(/"/g, '');

    // ── 4. Complete multipart upload
    const completeBody = `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag}</ETag></Part></CompleteMultipartUpload>`;
    await axios.post(
        `https://${host}/${filePath}?uploadId=${encodeURIComponent(uploadId)}`,
        completeBody,
        {
            headers: ossBaseHeaders('POST', '', 'image/jpeg', `/${bucket}/${filePath}?uploadId=${encodeURIComponent(uploadId)}`, String(completeBody.length)),
            timeout: 60_000,
            validateStatus: () => true,
        },
    );

    const signedUrl = sts.file_url || `https://${host}/${filePath}`;
    return {
        type: 'image',
        file: { data: {}, filename, id: fileId, meta: { name: filename } },
        id  : fileId,
        filename,
        name: filename,
        url : signedUrl,
        image_width : 1024,
        image_height: 1024,
    };
}

// ── نقطة حقن للاختبارات (تُستبدل دوال الشبكة دون تلمس السلوك) ──
const internals = { uploadImage: uploadImageToQwenOss };

/**
 * استخراج كل روابط الصور من نص الرد (توليد الصور)
 */
function extractImageUrls(text) {
    const out = [];
    const re = /https?:\/\/[^\s"'<>\\]+/g;
    const matches = String(text || '').match(re) || [];
    for (const m of matches) {
        const clean = m.replace(/[),.]+$/, '');
        // نستبعد الفيديو صراحة (توليد الفيديو ت2v منفصل عن الصور)
        if (/\.(mp4|mov|webm|avi)(\?|$)/i.test(clean)) continue;
        if (/(\.png|\.jpe?g|\.webp|\.gif)(\?|$)/i.test(clean) || clean.includes('cdn.qwenlm.ai')) {
            if (!out.includes(clean)) out.push(clean);
        }
    }
    return out;
}

// ══════════════════════════════════════════════════════════════
//  تعريف المزود — نفس عقد DeepSeek بالضبط
// ══════════════════════════════════════════════════════════════

const qwenProvider = {
    id       : 'qwen',
    label    : 'Qwen',
    emoji    : '🌐',
    description: 'Qwen عبر chat.qwen.ai (توكن حساب Qwen) — جلسات حقيقية وStreaming وتفكير وبحث مدمج ورؤية وتوليد صور',

    /** حقول نوافذ الإنشاء/التعديل الخاصة بهذا المزود */
    modalFields: [
        { id: 'qwen_token', label: 'Qwen Token (Bearer من chat.qwen.ai)', style: 'short', required: true },
        { id: 'qwen_model', label: 'معرّف النموذج (اختياري — افتراضي qwen3.8-max)', style: 'short', required: false },
    ],

    /**
     * يتحقق من اكتمال إعدادات المزود
     * @returns {{ok: boolean, missing: string[]}}
     */
    validate(config = {}) {
        const missing = [];
        if (!config.qwen_token) missing.push('qwen_token');
        return { ok: missing.length === 0, missing };
    },

    /** سطر حالة مختصر لعرضه في اللوحة */
    describe(config = {}) {
        const model = config.qwen_model || DEFAULT_MODEL;
        return `Token: ${config.qwen_token ? 'موجود ✅' : 'مفقود ❌'} | Model: ${model}`;
    },

    /**
     * إرسال prompt والحصول على الرد — نفس عقد _stream_ds
     * @param {object} opts
     * @param {Array}  opts.images - [{url, name}] صور مرفقة (رؤية النموذج — تُرفع OSS)
     * @param {boolean} opts.search - البحث المدمج للنموذج (feature_config.auto_search)
     * @returns {Promise<{fullText: string, sessionId: string, newParentMessageId: string|null}>}
     */
    async chat({ prompt, sessionId = null, parentMessageId = null, thinking = false, search = false, images = [], config = {}, agentId = 'default' }) {
        const token = config.qwen_token;
        if (!token) throw new Error('qwen_token مفقود لهذا الوكيل');

        const modelId = config.qwen_model || DEFAULT_MODEL;
        const baseUrl = resolveBaseUrl(config);

        // 🖼️ رفع الصور إلى OSS (رؤية النموذج) — الفشل هنا لا يعطل الرد النصي
        let files = [];
        if (Array.isArray(images) && images.length) {
            for (const img of images.slice(0, 4)) { // حد 4 صور لكل رسالة
                try {
                    const resp = await axios.get(img.url, {
                        responseType: 'arraybuffer',
                        timeout: 60_000,
                        maxContentLength: 10 * 1024 * 1024,
                        validateStatus: () => true,
                    });
                    if (resp.status !== 200) continue;
                    const payload = await internals.uploadImage(token, Buffer.from(resp.data), img.name, baseUrl);
                    files.push(payload);
                } catch (e) {
                    console.warn(`[Qwen] فشل رفع صورة (${img.name}): ${e.message}`);
                }
            }
        }

        // جلسة Qwen الحقيقية: sessionId = qwen chat_id (يُخزن في نفس مكان جلسة DeepSeek)
        let chatId = sessionId && !String(sessionId).includes(':') ? String(sessionId) : null;
        if (!chatId) {
            chatId = await createQwenChat(token, baseUrl);
        }

        const payload = buildQwenPayload(chatId, prompt, parentMessageId, {
            thinking,
            modelId,
            autoSearch : Boolean(search), // 🔍 البحث المدمج — النموذج يبحث بواجهته
            files,
        });
        const { fullText, responseId } = await streamQwenChat(token, chatId, payload, baseUrl);

        const text = stripQwen(fullText);
        if (!text) throw new Error('Qwen أرجع رداً فارغاً (قد يكون التوكن منتهياً أو حجب خادم الطلب).');

        return {
            fullText           : text,
            sessionId          : chatId,
            newParentMessageId : responseId || parentMessageId,
        };
    },

    /**
     * 🎨 توليد صورة من وصف نصي (t2i) — من qwen.py/البروكسي v10
     * @returns {Promise<{ok: boolean, urls: string[], error?: string}>}
     */
    async generateImage({ prompt, size = '1:1', config = {}, agentId = 'default' }) {
        const token = config.qwen_token;
        if (!token) throw new Error('qwen_token مفقود لهذا الوكيل');
        const modelId = config.qwen_model || DEFAULT_MODEL;
        const baseUrl = resolveBaseUrl(config);

        const chatId = await createQwenChat(token, baseUrl);
        const payload = buildQwenPayload(chatId, String(prompt || ''), null, {
            thinking : false,
            modelId,
            chatType : 't2i',
            size     : /^(1:1|16:9|9:16)$/.test(String(size)) ? String(size) : '1:1',
        });
        const { fullText } = await streamQwenChat(token, chatId, payload, baseUrl);

        const urls = extractImageUrls(fullText);
        if (!urls.length) {
            return { ok: false, error: 'لم أجد رابط صورة في رد Qwen — قد يكون الوصف مرفوضاً أو الخدمة مشغولة', urls: [] };
        }
        return { ok: true, urls };
    },

    /** اختبار اتصال حقيقي — يُستخدم من أمر /المزود ولوحة التحكم */
    async testConnection(config = {}) {
        const token = config.qwen_token;
        if (!token) throw new Error('qwen_token مفقود');
        const baseUrl = resolveBaseUrl(config);
        const chatId = await createQwenChat(token, baseUrl);
        return `✅ اتصال Qwen ناجح — تم إنشاء جلسة اختبار (${chatId.slice(0, 12)}…) بالنموذج ${config.qwen_model || DEFAULT_MODEL}`;
    },
};

module.exports = qwenProvider;
module.exports.__internals = internals; // للاختبارات فقط
module.exports.extractImageUrls = extractImageUrls;
module.exports.buildQwenPayload = buildQwenPayload;
