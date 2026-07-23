import { registerBuiltinExtension } from '../loader';
import { createClawHubMarketplaceExtension } from './clawhub-marketplace';
import { createDiagnosticsExtension } from './diagnostics';
import { createSkillHubMarketplaceExtension } from './skillhub-marketplace';

export function registerAllBuiltinExtensions(): void {
  registerBuiltinExtension('builtin/clawhub-marketplace', createClawHubMarketplaceExtension);
  registerBuiltinExtension('builtin/skillhub-marketplace', createSkillHubMarketplaceExtension);
  registerBuiltinExtension('builtin/diagnostics', createDiagnosticsExtension);
}
