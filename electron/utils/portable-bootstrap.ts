import { applyPortableEnvironment } from './portable-mode';

/** Apply portable environment variables before other Main-process modules evaluate. */
export const portableModeInfo = applyPortableEnvironment();
