/**
 * tests/_polyfill_child.js — عملية فرعية تحاكي Node < 19
 * تُحذف globalThis.crypto (إن كانت قابلة للحذف) ثم تُطلب polyfills.js
 * ويُجرَّب نفس السطر الذي ينهار فيه درايفر mongodb 7.x (lib/utils.js randomBytes).
 * الخرج: OK | SKIP | FAIL
 */
'use strict';
if ('crypto' in globalThis) {
    const d = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    if (d && d.configurable) delete globalThis.crypto;
}
if ('crypto' in globalThis) {
    console.log('SKIP');
} else {
    require('../polyfills');
    const c = globalThis.crypto;
    const probe = (c && c.getRandomValues) ? c.getRandomValues(new Uint8Array(32)) : null;
    console.log(c && typeof c.getRandomValues === 'function' && probe && probe.length === 32 ? 'OK' : 'FAIL');
}
