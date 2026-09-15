/**
 * games/engines.js — سجل محركات الألعاب (v7.14)
 * ═══════════════════════════════════════════════════════════
 * نقل حرفي لمفهوم engineRegistry من مستودع Auto (zeus12345king/Auto)
 * المالك: «اعتقد اننا سوف ناخذ كل شيء منه بالكامل فيما يخص الألعاب
 * وكيفية دخولها والتفاصيل الأخرى».
 *
 * أربعة محركات كما في Auto:
 *   zar      — زر/عجلة الروليت التلقائية (إرسال الأمر + الضغط على الزر الأخضر)
 *   roulette — الانضمام للوبيات (ضغط رقم شاغر عشوائي بتأخير بشري)
 *   karasi   — كراسي (دخول من إيمبد + ضغط عشوائي سريع عند «اضغط على الزر»)
 *   replka   — ريبلكا (دخول من إيمبد + إجابة أسئلة الفئة والحرف)
 *
 * كل محرك: id + displayName + إعداداته الافتراضية + وصف عربي.
 * محرك جديد = كائن جديد هنا + معالجاته في events.js — لا شيء آخر يتغير.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const engines = [
    {
        id        : 'zar',
        displayName: 'زر',
        icon      : '🎰',
        description: 'دورة روليت تلقائية: يرسل الأمر ويضغط الزر الأخضر عند ظهوره',
        // إعدادات كل وكيل+سيرفر لهذا المحرك (نمط Auto defaultSettings)
        defaultSettings: { delay: 0, roundTimeout: 30 },
    },
    {
        id        : 'roulette',
        displayName: 'روليت',
        icon      : '🎡',
        description: 'الانضمام التلقائي للوبيات: يضغط رقماً شاغراً عشوائياً بتأخير بشري',
        defaultSettings: { delay: 0, roundTimeout: 60 },
    },
    {
        id        : 'karasi',
        displayName: 'كراسي',
        icon      : '🪑',
        description: 'يدخل لوبيات الكراسي ويضغط عشوائياً بأسرع وقت عند بدء الجولة',
        defaultSettings: { delay: 0, roundTimeout: 60 },
    },
    {
        id        : 'replka',
        displayName: 'ريبلكا',
        icon      : '🧠',
        description: 'يدخل لوبيات ريبلكا ويجيب أسئلة الفئة والحرف (قاموس + ذكاء اختياري)',
        defaultSettings: { delay: 0, roundTimeout: 60 },
    },
];

const engineMap = new Map(engines.map(engine => [engine.id, engine]));

function getEngines() {
    return engines.map(engine => ({ ...engine, defaultSettings: { ...engine.defaultSettings } }));
}

function getEngine(engineId) {
    return engineMap.get(String(engineId || '')) || null;
}

function requireEngine(engineId) {
    const engine = getEngine(engineId);
    if (!engine) throw new Error(`محرك ألعاب غير معروف: ${engineId}`);
    return engine;
}

function engineIds() {
    return engines.map(engine => engine.id);
}

module.exports = { getEngines, getEngine, requireEngine, engineIds };
