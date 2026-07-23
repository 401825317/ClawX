import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';
import type { BillingErrorCode, BillingPaymentStatus } from '@shared/billing';

export type RechargeErrorCode = BillingErrorCode | 'configuration' | 'invalid_amount';

export function normalizeAmountInput(value: string): string {
  let normalized = '';
  let seenDot = false;
  for (const character of value) {
    if (character >= '0' && character <= '9') {
      normalized += character;
      continue;
    }
    if (character === '.' && !seenDot) {
      normalized += character;
      seenDot = true;
    }
  }
  if (!seenDot) return normalized;
  const [integerPart = '', decimalPart = ''] = normalized.split('.', 2);
  return `${integerPart}.${decimalPart.slice(0, 2)}`;
}

export function parseAmountFen(value: string): number {
  const normalized = normalizeAmountInput(value);
  if (!normalized) return 0;
  const [integerPart = '0', decimalPart = ''] = normalized.split('.', 2);
  const amountFen = Number(integerPart || 0) * 100 + Number((decimalPart + '00').slice(0, 2));
  return Number.isSafeInteger(amountFen) && amountFen > 0 ? amountFen : 0;
}

export function formatNumber(value: number, language: string, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat(language, { maximumFractionDigits }).format(
    Number.isFinite(value) ? value : 0,
  );
}

export function formatCurrency(value: number, language: string): string {
  return new Intl.NumberFormat(language, {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

export function formatDateTime(value: number | undefined, language: string): string {
  if (!value || !Number.isFinite(value)) return '-';
  return new Intl.DateTimeFormat(language, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function paymentStatusTone(status: BillingPaymentStatus): string {
  if (status === 'success') return 'text-emerald-700 dark:text-emerald-400';
  if (status === 'failed') return 'text-red-700 dark:text-red-400';
  if (status === 'cancelled' || status === 'expired') return 'text-muted-foreground';
  return 'text-amber-700 dark:text-amber-400';
}

/** Render backend QR data as deterministic local SVG markup. */
export function renderQrSvgMarkup(input: string): string {
  if (!input || input.length > 4096) return '';
  const qr = new QRCode(-1, QRErrorCorrectLevel.M);
  qr.addData(input);
  qr.make();
  const modules = qr.getModuleCount();
  const margin = 2;
  const size = modules + margin * 2;
  const cells: string[] = [];
  for (let row = 0; row < modules; row += 1) {
    for (let column = 0; column < modules; column += 1) {
      if (!qr.isDark(row, column)) continue;
      cells.push(`<rect x="${column + margin}" y="${row + margin}" width="1" height="1" />`);
    }
  }
  return [
    `<svg viewBox="0 0 ${size} ${size}" role="img" xmlns="http://www.w3.org/2000/svg">`,
    '<rect width="100%" height="100%" fill="#fff" />',
    `<g fill="#111827">${cells.join('')}</g>`,
    '</svg>',
  ].join('');
}
