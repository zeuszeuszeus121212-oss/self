/**
 * ui.js — Disor Design System على Components V2
 * ═══════════════════════════════════════════════════════════
 * لماذا؟ الإيمبدات القديمة تبدو مكسّرة: خطوط ━━━ مرسومة يدوياً،
 * عناوين صغيرة، لا شريط لوني جانبي، والأزرار خارج الإطار.
 * Components V2 يعطينا: Container بشريط لوني كامل الارتفاع، فواصل
 * حقيقية، ترويسة Markdown (#/##)، وأزرار داخل الإطار — شكل تطبيق
 * حقيقي داخل ديسكورد وليس رسالة نصية.
 *
 * القواعد:
 *   - كل الصفحات تُبنى بدوال هذا الملف — لا EmbedBuilder في اللوحة إطلاقاً.
 *   - الرسائل من نوع { flags: IsComponentsV2, components: [Container] } —
 *     يُمنع خلط content/embeds معها (ديسكورد يرفض ذلك صراحة).
 *   - نص واحد ≤ 4000 حرف لكل رسالة؛ هذا الملف يقسّم الطويل تلقائياً.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const {
    MessageFlags,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    ActionRowBuilder,
} = require('discord.js');

// ---------- لوحة الألوان (نفس هوية البوت) ----------
const ACCENTS = Object.freeze({
    primary : 0x5865F2,
    success : 0x57F287,
    danger  : 0xED4245,
    warning : 0xFEE75C,
    info    : 0x3498DB,
    dark    : 0x2B2D31,
    live    : 0x9B59B6,
});

const BRAND = 'Disor Control Center';

// رسالة خاصة (Ephemeral) بنمط V2 — يُمنع خلط content/embeds معها أيضاً
const V2_EPHEMERAL_FLAGS = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

// سقف آمن للنص داخل حاوية واحدة (حد ديسكورد 4000 حرف نص لكل رسالة — بهامش)
const MAX_BODY_CHARS = 3820;

/** اقتطاع آمن للجسم الطويل مع ملاحظة واضحة بدل رفض ديسكورد الصامت */
function safeBody(content) {
    const text = String(content || '');
    if (text.length <= MAX_BODY_CHARS) return text;
    return text.slice(0, MAX_BODY_CHARS - 1) + '\n-# … اقتُطع الجزء المتبقي — حد ديسكورد لعرض النص (4000)';
}

// ---------- بنّائات أولية ----------

function textDisplay(content) {
    return new TextDisplayBuilder().setContent(String(content || '—'));
}

function separator(strong = true) {
    return new SeparatorBuilder()
        .setSpacing(strong ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small)
        .setDivider(true);
}

/**
 * تقسيم نص طويل إلى TextDisplays متعددة (لكل TextDisplay حد 4000،
 * نترك هامشاً للأمان). يُحافظ على الأسطر كاملة قدر الممكن.
 * للاستخدام في الرسائل متعددة الحاويات — الحاوية الواحدة تستخدم safeBody.
 */
function splitText(content, chunkSize = 1900) {
    const text = String(content || '');
    if (text.length <= chunkSize) return [text];
    const chunks = [];
    let current = '';
    for (const line of text.split('\n')) {
        // سطر واحد أطول من الحد نفسه يُقصّ قسرياً
        const safeLine = line.length > chunkSize ? line.slice(0, chunkSize - 1) + '…' : line;
        if ((current + '\n' + safeLine).length > chunkSize && current) {
            chunks.push(current);
            current = safeLine;
        } else {
            current = current ? current + '\n' + safeLine : safeLine;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

// ---------- الحاوية الأم (شكل كل صفحة) ----------

/**
 * container — الهيكل البصري الموحد:
 *   ترويسة (## عنوان) → فاصل → جسم (نص حر) → فاصل → أزرار/قوائم داخل الإطار
 * @param {object} opts
 *   accent    - لون الشريط الجانبي (ACCENTS)
 *   title     - الترويسة (Markdown ## تُضاف تلقائياً)
 *   body      - نص الجسم (string) — يقسّم تلقائياً إن طال
 *   rows      - مصفوفة ActionRowBuilder تُثبّت أسفل الصفحة داخل الإطار
 *   footer    - سطر ختامي صغير اختياري (اختصار النص الطويل إن وجد)
 */
function container({ accent = ACCENTS.primary, title, body, rows = [], footer }) {
    const c = new ContainerBuilder().setAccentColor(accent);
    if (title) c.addTextDisplayComponents(textDisplay(`## ${title}`));
    if (title && (body || rows.length || footer)) c.addSeparatorComponents(separator(true));
    if (body) c.addTextDisplayComponents(textDisplay(safeBody(body)));
    if (footer) {
        c.addSeparatorComponents(separator(false));
        c.addTextDisplayComponents(textDisplay(`-# ${footer}`));
    }
    if (rows.length) {
        c.addSeparatorComponents(separator(true));
        for (const row of rows) {
            if (row) c.addActionRowComponents(row);
        }
    }
    return c;
}

/**
 * payload — غلاف الرسالة النهائي:
 *   V2Payload(container) → { flags, components: [container] }
 *   V2Payload(container1, container2) → رسالة متعددة حاويات (مثل صفحة + تنبيه)
 * يُمنع أي مفاتيح content/embeds بجانب هذا الغلاف.
 */
function v2Payload(...containers) {
    return {
        flags: MessageFlags.IsComponentsV2,
        components: containers.filter(Boolean),
    };
}

/** إلحاق صفوف أزرار بحاوية جاهزة — بفاصل علوي موحّد (للمسار التحويلي) */
function withRows(cont, rows = []) {
    const list = (rows || []).filter(Boolean);
    if (list.length) cont.addSeparatorComponents(separator(true));
    for (const row of list) cont.addActionRowComponents(row);
    return cont;
}

// ---------- مكونات نصية سريعة ----------

/** سطر مفتاح: قيمة — عناصر اللوحة كلها بهذا الإيقاع */
function kv(label, value) {
    return `**${label}:** ${value === undefined || value === null || value === '' ? '—' : value}`;
}

/** قائمة نقطية مضغوطة */
function bullets(items) {
    return items.filter(Boolean).map(i => `• ${i}`).join('\n');
}

/** اقتباس/ملاحظة جانبية */
function note(text) {
    return `> ${text}`;
}

// ---------- صفحات جاهزة (بدائل الإيمبدات القديمة) ----------

/** صفحة خطأ — شريط أحمر + شرح + سبب تقني اختياري */
function errorPage(title, lines, { footer } = {}) {
    return container({
        accent: ACCENTS.danger,
        title: `⛔ ${title}`,
        body: Array.isArray(lines) ? lines.filter(Boolean).join('\n') : String(lines || ''),
        footer,
    });
}

/** صفحة نجاح */
function successPage(title, lines, { footer } = {}) {
    return container({
        accent: ACCENTS.success,
        title: `✅ ${title}`,
        body: Array.isArray(lines) ? lines.filter(Boolean).join('\n') : String(lines || ''),
        footer,
    });
}

/** صفحة معلومات */
function infoPage(title, lines, { footer } = {}) {
    return container({
        accent: ACCENTS.info,
        title: `ℹ️ ${title}`,
        body: Array.isArray(lines) ? lines.filter(Boolean).join('\n') : String(lines || ''),
        footer,
    });
}

/** صفحة تحذير */
function warningPage(title, lines, { footer } = {}) {
    return container({
        accent: ACCENTS.warning,
        title: `⚠️ ${title}`,
        body: Array.isArray(lines) ? lines.filter(Boolean).join('\n') : String(lines || ''),
        footer,
    });
}

module.exports = {
    ACCENTS,
    BRAND,
    V2_EPHEMERAL_FLAGS,
    safeBody,
    MessageFlags,
    textDisplay,
    separator,
    splitText,
    container,
    v2Payload,
    withRows,
    kv,
    bullets,
    note,
    errorPage,
    successPage,
    infoPage,
    warningPage,
};
