import qrcode from "qrcode-generator";

/**
 * CC 2.1.271 (H12) — render a QR code as an inline SVG string, for the
 * `/mobile` overlay (scan with a phone to open the Claude mobile app page).
 * `qrcode-generator` is a tiny, pure-JS, zero-native-binding library, so it's
 * safe in both the browser bundle and the packaged Electron build. Type `0`
 * auto-selects the smallest QR version that fits; error-correction "M" is the
 * standard middle ground.
 */
export function qrSvgTag(text: string, cellSize = 4): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize, margin: 2, scalable: true });
}
