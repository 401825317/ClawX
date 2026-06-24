const WORKER_STORE_CWD_ENV = 'CLAWX_ELECTRON_STORE_CWD';

type StoreOptionsBase = {
  cwd?: string;
};

export function getElectronStoreUserDataEnvKey(): string {
  return WORKER_STORE_CWD_ENV;
}

export function withElectronStoreProcessOptions<T extends StoreOptionsBase>(options: T): T {
  const cwd = process.env[WORKER_STORE_CWD_ENV]?.trim();
  if (!cwd || options.cwd) {
    return options;
  }

  return {
    ...options,
    cwd,
  };
}
