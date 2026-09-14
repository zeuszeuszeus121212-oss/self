/**
 * providers/deepseek.js — Disor Bot v7.1 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * مزود DeepSeek — المسار الأصلي الذي يعمل منذ البداية.
 * هذا الملف لا يعيد اختراع أي شيء: يغلف دوال utils.js الموجودة
 * (_stream_ds, _new_ds_session, _get_pow) بواجهة المزودين الموحدة
 * بدون أي تغيير في السلوك — ديبسيك يعمل كما هو بالضبط.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const {
    _stream_ds,
} = require('../utils');

const deepseekProvider = {
    id       : 'deepseek',
    label    : 'DeepSeek',
    emoji    : '🐋',
    description: 'DeepSeek الأصلي عبر chat.deepseek.com (توكن حساب DeepSeek + POW) — نفس الإعدادات والسلوك القديم تماماً',

    /** حقول نوافذ الإنشاء/التعديل الخاصة بهذا المزود */
    modalFields: [
        // 🔑 v7.11: يمكن إدخال أكثر من توكن في نفس الحقل (كل توكن في سطر، أو فاصله بـ | أو ,) —
        // يتبدل المحرك تلقائياً للمفتاح التالي عند فشل الحالي.
        { id: 'deepseek_token', label: 'DeepSeek Token (عدة توكنات كل بسطر)', style: 'paragraph', required: true },
    ],

    validate(config = {}) {
        const missing = [];
        if (!config.deepseek_token) missing.push('deepseek_token');
        return { ok: missing.length === 0, missing };
    },

    describe(config = {}) {
        const { describeKeys } = require('./index');
        return `Token: ${describeKeys(this.id, config)} | POW: مفعّل (نفس السلوك الأصلي)`;
    },

    /**
     * إرسال prompt والحصول على الرد — تمرير مباشر (passthrough) إلى _stream_ds
     * بنفس ترتيب المعاملات الأصلي حرفياً.
     * @param {object} opts - search: البحث المدمج للنموذج (search_enabled في payload)
     * @returns {Promise<{fullText: string, sessionId: string, newParentMessageId: string|null}>}
     */
    async chat({ prompt, guildId, sessionId = null, parentMessageId = null, mode = 'default', thinking = false, search = false, config = {}, agentId = 'default' }) {
        const token = config.deepseek_token;
        if (!token) throw new Error('deepseek_token مفقود لهذا الوكيل');

        const result = await _stream_ds(
            prompt,
            guildId,
            sessionId,
            parentMessageId,
            mode,
            thinking,
            token,
            agentId || 'default',
            Boolean(search), // 🔍 البحث المدمج — search_enabled في payload
        );

        return {
            fullText           : result.fullText,
            sessionId          : result.sessionId,
            newParentMessageId : result.newParentMessageId,
        };
    },

    /** اختبار اتصال حقيقي — إنشاء جلسة DeepSeek جديدة */
    async testConnection(config = {}) {
        const token = config.deepseek_token;
        if (!token) throw new Error('deepseek_token مفقود');
        const { _new_ds_session } = require('../utils');
        const sid = await _new_ds_session(token);
        return `✅ اتصال DeepSeek ناجح — تم إنشاء جلسة اختبار (${String(sid).slice(0, 12)}…)`;
    },
};

module.exports = deepseekProvider;
