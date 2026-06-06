declare module 'qrcode-terminal/vendor/QRCode/index.js' {
  type QrCodeMatrix = {
    addData(input: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  };

  const QRCode: new (typeNumber: number, errorCorrectionLevel: unknown) => QrCodeMatrix;
  export default QRCode;
}

declare module 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js' {
  const QRErrorCorrectLevel: {
    L: unknown;
    M: unknown;
    Q: unknown;
    H: unknown;
  };
  export default QRErrorCorrectLevel;
}
