type HardwareAccelerationOptions = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  hasSwitch: (name: string) => boolean;
};

function truthyFlag(value: string | undefined): boolean {
  const normalized = (value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export function shouldDisableHardwareAcceleration(options: HardwareAccelerationOptions): boolean {
  const envRequestsDisable = truthyFlag(options.env.CLAWX_DISABLE_GPU)
    || truthyFlag(options.env.UCLAW_DISABLE_GPU);
  const cliRequestsDisable = options.hasSwitch('disable-gpu')
    || options.hasSwitch('disable-hardware-acceleration');
  if (envRequestsDisable || cliRequestsDisable) {
    return true;
  }

  const explicitEnable = truthyFlag(options.env.CLAWX_ENABLE_GPU)
    || truthyFlag(options.env.UCLAW_ENABLE_GPU)
    || options.hasSwitch('enable-gpu');
  if (explicitEnable) {
    return false;
  }

  return options.platform !== 'win32';
}
