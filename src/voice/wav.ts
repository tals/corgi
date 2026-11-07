/** Mono signed 16-bit PCM as a WAV file, for whisper-server's /inference. */
export function encode(pcm: Int16Array, rate = 16000): Uint8Array {
  const bytes = pcm.length * 2,
    out = new Uint8Array(44 + bytes),
    view = new DataView(out.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, bytes, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
  return out;
}
