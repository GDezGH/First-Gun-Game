/**
 * three.js re-export shim.
 *
 * The engine itself lives in /vendor/three.module.js (r160, vendored so the
 * game works fully offline with no CDN dependency). Re-exporting it here
 * keeps every other module's import line short and makes upgrading the
 * engine a one-line change.
 */
export * from '../vendor/three.module.js';
