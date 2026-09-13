/**
 * knowledge.js — Disor Bot v7.3 "Sentinel"
 * ═══════════════════════════════════════════════════════════
 * قاعدة معرفة RAG لكل وكيل — الوحدة الوحيدة لمجموعة agent_knowledge.
 *
 * التدفق: ملف نصي → تنظيف → تقطيع واعٍ بالفقرات (~900 حرف، تداخل 120)
 *        → فهرسة بالكلمات (نفس tokenizer الذاكرة) → بحث بالصلة.
 *
 * وثيقة: { agent_id, guild_id, source, chunk_index, content, tokens, size, created_at }
 * إعادة رفع نفس المصدر تستبدل قطعه القديمة (idempotent per source).
 *
 * كل الدوال آمنة بدون MongoDB (نتائج فارغة — لا أخطاء مرمية).
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const CHUNK_SIZE = 900;          // الحرفي الهدف لكل قطعة
const CHUNK_OVERLAP = 120;       // تداخل بين القطع لحفظ السياق
const MAX_TEXT_CHARS = 200_000;  // حد أمان للنص الواحد
const MAX_CHUNKS_PER_SOURCE = 400;

function col() {
    try {
        const cfg = require('./config');
        return cfg.knowledge_col || null;
    } catch (_) {
        return null;
    }
}

// ── tokenizer — نفس روح memory.js (تطبيع عربي + كلمات توقف) ──
const STOP_WORDS = new Set([
    'في', 'من', 'على', 'عن', 'الى', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي',
    'هو', 'هي', 'انا', 'انت', 'كان', 'كانت', 'مع', 'كل', 'بعد', 'قبل',
    'لكن', 'ان', 'ما', 'لا', 'او', 'ثم', 'قد', 'the', 'and', 'for', 'with',
    'that', 'this', 'from', 'have', 'has',
]);

function normalizeText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[\u064B-\u0652\u0670]/g, '')
        .replace(/[أإآ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .replace(/ة/g, 'ه')
        .replace(/\s+/g, ' ')
        .trim();
}

function tokenize(text) {
    return normalizeText(text)
        .split(/[^\p{L}\p{N}]+/u)
        .filter(w => w.length >= 2)
        .filter(w => !STOP_WORDS.has(w));
}

// ═══════════════════════════════════════════════════════════
//  التقطيع — واعٍ بالفقرات مع تداخل
// ═══════════════════════════════════════════════════════════

/** قصّ ذيل قطعة عند حدود كلمة للحفاظ على تداخل نظيف */
function overlapTail(chunk, overlap) {
    if (overlap <= 0 || chunk.length <= overlap) return '';
    let tail = chunk.slice(-overlap);
    const sp = tail.indexOf(' ');
    if (sp > 0) tail = tail.slice(sp + 1); // نبدأ من كلمة كاملة
    return tail.trim();
}

/**
 * تقطيع نص إلى قطع: تجميع الفقرات حتى CHUNK_SIZE، ثم فصل القطع بتداخل.
 * الفقرة الطويلة وحدها تُقصّ عند حدود الجمل ثم الكلمات.
 * @param {string} text
 * @param {{size?: number, overlap?: number}} opts
 * @returns {string[]}
 */
function chunkText(text, opts = {}) {
    const size = Math.max(200, Math.min(4000, Number(opts.size) || CHUNK_SIZE));
    const overlap = Math.max(0, Math.min(size - 100, Number(opts.overlap) ?? CHUNK_OVERLAP));

    const clean = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (!clean) return [];

    const paragraphs = clean.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

    const chunks = [];
    let current = '';

    const pushCurrent = () => {
        const c = current.trim();
        if (c) chunks.push(c);
        current = '';
    };

    for (const para of paragraphs) {
        // فقرة أطول من الحجم — تُقصّ داخلياً
        if (para.length > size) {
            if (current) pushCurrent();
            // قصّ عند حدود الجمل أولاً
            const sentences = para.split(/(?<=[.!?؟।\n])\s+/);
            let buf = '';
            for (const sent of sentences) {
                if (sent.length > size) {
                    // جملة أطول من الحجم نفسه — قصّ قسري بالكلمات
                    if (buf) { chunks.push(buf.trim()); buf = ''; }
                    for (let i = 0; i < sent.length; i += size) {
                        chunks.push(sent.slice(i, i + size).trim());
                    }
                    continue;
                }
                if ((buf + ' ' + sent).trim().length > size) {
                    if (buf) chunks.push(buf.trim());
                    buf = sent;
                } else {
                    buf = (buf ? buf + ' ' : '') + sent;
                }
            }
            if (buf) chunks.push(buf.trim());
            continue;
        }

        if ((current + '\n\n' + para).trim().length > size) {
            pushCurrent();
        }
        current = current ? current + '\n\n' + para : para;
    }
    pushCurrent();

    // إعادة بناء القطع بالحجم + التداخل (الفقرات القصيرة قد تكون مجتمعة أصلاً)
    const sized = [];
    for (const c of chunks) {
        if (c.length <= size) { sized.push(c); continue; }
        // احتياط نظري — القطع المبنية أعلاه لا تتجاوز الحجم
        for (let i = 0; i < c.length; i += size - overlap) {
            sized.push(c.slice(i, i + size).trim());
        }
    }

    // إضافة التداخل: كل قطعة تبدأ بذيل القطعة السابقة
    const withOverlap = [];
    for (let i = 0; i < sized.length; i++) {
        if (i === 0 || !overlap) { withOverlap.push(sized[i]); continue; }
        const tail = overlapTail(sized[i - 1], overlap);
        const merged = tail ? `${tail}\n${sized[i]}` : sized[i];
        withOverlap.push(merged.length > size + overlap ? sized[i] : merged);
    }

    return withOverlap.slice(0, MAX_CHUNKS_PER_SOURCE);
}

// ═══════════════════════════════════════════════════════════
//  الإدخال — استبدال مصدر كاملاً بقطعه الجديدة
// ═══════════════════════════════════════════════════════════

/**
 * إدخال مستند نصي إلى معرفة وكيل.
 * @param {{agentId, guildId?, source, text}} p
 * @returns {Promise<{ok: boolean, chunks?: number, chars?: number, error?: string}>}
 */
async function ingestDocument({ agentId, guildId = null, source, text } = {}) {
    const c = col();
    if (!c) return { ok: false, error: 'قاعدة البيانات غير متصلة' };
    const src = String(source || '').trim().slice(0, 120) || 'مستند';
    const body = String(text || '');
    if (!body.trim()) return { ok: false, error: 'النص فارغ' };

    const trimmed = body.length > MAX_TEXT_CHARS ? body.slice(0, MAX_TEXT_CHARS) : body;
    const pieces = chunkText(trimmed);
    if (!pieces.length) return { ok: false, error: 'لم يُنتج النص أي قطع' };

    // استبدال: قطع المصدر القديمة تُحذف
    await c.deleteMany({ agent_id: String(agentId || 'default'), source: src });

    const now = new Date();
    const docs = pieces.map((content, i) => ({
        agent_id   : String(agentId || 'default'),
        guild_id   : guildId ? String(guildId) : null,
        source     : src,
        chunk_index: i,
        content,
        tokens     : [...new Set(tokenize(content))].slice(0, 60),
        size       : content.length,
        created_at : now,
    }));

    await c.insertMany(docs);
    return { ok: true, chunks: docs.length, chars: trimmed.length };
}

// ═══════════════════════════════════════════════════════════
//  البحث — تطابق كلمات + تغطية، مثل روح الذاكرة
// ═══════════════════════════════════════════════════════════

/**
 * بحث في معرفة وكيل.
 * @param {{agentId, query, limit?, source?}} p
 * @returns {Promise<{ok: boolean, results: Array<{source, chunk_index, content, score}>, error?: string}>}
 */
async function searchKnowledge({ agentId, query, limit = 6, source = null } = {}) {
    const c = col();
    if (!c) return { ok: false, error: 'قاعدة البيانات غير متصلة', results: [] };

    const filter = { agent_id: String(agentId || 'default') };
    if (source) filter.source = String(source);

    const docs = await c.find(filter).limit(2000).toArray();
    if (!docs.length) return { ok: true, results: [] };

    const qTokens = [...new Set(tokenize(query))];
    if (!qTokens.length) return { ok: true, results: [] };

    const scored = [];
    for (const doc of docs) {
        const docTokens = doc.tokens && doc.tokens.length ? doc.tokens : [...new Set(tokenize(doc.content))];
        const docSet = new Set(docTokens);
        let match = 0;
        let hits = 0;
        for (const q of qTokens) {
            if (docSet.has(q)) { match += 3; hits++; continue; }
            // مطابقة جزئية (أحرف الجر الملتصقة)
            for (const t of docTokens) {
                if (q.length >= 3 && (t.includes(q) || q.includes(t))) { match += 1; hits++; break; }
            }
        }
        if (match === 0) continue;
        // تغطية الاستعلام تعزز الصلة
        const coverage = hits / qTokens.length;
        scored.push({
            source      : doc.source,
            chunk_index : doc.chunk_index,
            content     : doc.content,
            score       : match + coverage * 2,
        });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, Math.max(1, Math.min(20, Number(limit) || 6)));
    return { ok: true, results: top };
}

// ═══════════════════════════════════════════════════════════
//  إدارة المصادر
// ═══════════════════════════════════════════════════════════

/** قائمة المصادر مع إحصائياتها */
async function listSources(agentId) {
    const c = col();
    if (!c) return [];
    const docs = await c.aggregate([
        { $match: { agent_id: String(agentId || 'default') } },
        { $group: {
            _id: '$source',
            chunks: { $sum: 1 },
            chars : { $sum: '$size' },
            added : { $max: '$created_at' },
        } },
        { $sort: { added: -1 } },
        { $limit: 50 },
    ]).toArray();
    return docs.map(d => ({ source: d._id, chunks: d.chunks, chars: d.chars || 0, added_at: d.added }));
}

/** حذف مصدر كامل */
async function deleteSource(agentId, source) {
    const c = col();
    if (!c) return { ok: false, deleted: 0 };
    const r = await c.deleteMany({ agent_id: String(agentId || 'default'), source: String(source) });
    return { ok: true, deleted: r.deletedCount || 0 };
}

/** مسح معرفة الوكيل كاملة (من اللوحة) */
async function clearKnowledge(agentId) {
    const c = col();
    if (!c) return { ok: false, deleted: 0 };
    const r = await c.deleteMany({ agent_id: String(agentId || 'default') });
    return { ok: true, deleted: r.deletedCount || 0 };
}

/** إحصائيات لسريعة للوحة */
async function knowledgeStats(agentId) {
    const c = col();
    if (!c) return { ok: false, chunks: 0, sources: 0 };
    const chunks = await c.countDocuments({ agent_id: String(agentId || 'default') });
    const sources = await c.distinct('source', { agent_id: String(agentId || 'default') });
    return { ok: true, chunks, sources: sources.length };
}

module.exports = {
    CHUNK_SIZE,
    CHUNK_OVERLAP,
    MAX_TEXT_CHARS,
    normalizeText,
    tokenize,
    chunkText,
    ingestDocument,
    searchKnowledge,
    listSources,
    deleteSource,
    clearKnowledge,
    knowledgeStats,
};
