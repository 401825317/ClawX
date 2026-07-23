/** Normalized customer-service contact exposed to the Renderer. */
export type SupportContact = {
  id: string;
  label?: string;
  description?: string;
  qrCodeUrl: string;
  workHours?: string;
  wechatId?: string;
  extraNote?: string;
};

/** Read-only Help & Support configuration supplied by UClaw. */
export type SupportContactConfig = {
  enabled: true;
  title?: string;
  description?: string;
  contacts: SupportContact[];
};
