/**
 * Library entry for `@n3ary/gtfs-adapter-cluj-napoca`.
 *
 * This file is the default export of the published package
 * (`exports["."]`). The CLI binary lives in `dist/cli.js` (per the
 * package.json `bin` field) and is separate from the library
 * surface here.
 *
 * Subpaths:
 *   @n3ary/gtfs-adapter-cluj-napoca          → this file
 *   @n3ary/gtfs-adapter-cluj-napoca/static   → ./static (StaticExtension for gtfs-static)
 *   @n3ary/gtfs-adapter-cluj-napoca/rt       → ./rt (RT quirks for gtfs-rt)
 */

export * from './static/index';
export * from './rt/index';
