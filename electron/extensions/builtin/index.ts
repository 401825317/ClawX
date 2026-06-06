import { registerBuiltinExtension } from '../loader';
import { createClawHubMarketplaceExtension } from './clawhub-marketplace';
import { createDiagnosticsExtension } from './diagnostics';

export function registerAllBuiltinExtensions(): void {
  registerBuiltinExtension('builtin/diagnostics', createDiagnosticsExtension);
  registerBuiltinExtension('builtin/clawhub-marketplace', createClawHubMarketplaceExtension);
}
