/**
 * Extrai a biblioteca Linux x86_64 do Stereo Tool (libStereoTool_*.so) de dentro do ZIP direto no navegador.
 * O ZIP do plugin passa de 300 MB (traz todas as plataformas) e proxies/Cloudflare recusam envios tão grandes
 * (erro 502/413); a biblioteca sozinha é pequena. Só lê o que precisa do arquivo (fatias), sem carregar o ZIP inteiro.
 * Devolve null se não conseguir (ZIP64, formato incomum…): aí o ZIP original é enviado como está.
 */

function libScore(name: string): number {
  const n = name.toLowerCase();
  if (!/\.so(\.\d+)*$/.test(n) || /__macosx|\/\._/.test(n)) return -1;
  if (!/libstereotool/.test(n)) return -1;
  let score = 1;
  if (/x64|x86[_-]?64|amd64|64/.test(n)) score += 4;
  if (/arm|aarch|armhf|i386|i686|x86(?![_-]?64)|32/.test(n)) score -= 6;
  if (/linux/.test(n)) score += 1;
  return score;
}

const u16 = (d: DataView, o: number) => d.getUint16(o, true);
const u32 = (d: DataView, o: number) => d.getUint32(o, true);

export async function extractStereoLib(zip: File): Promise<File | null> {
  try {
    // 1) Fim do arquivo: registro "End Of Central Directory".
    const tailLen = Math.min(zip.size, 70_000);
    const tail = new DataView(await zip.slice(zip.size - tailLen).arrayBuffer());
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (u32(tail, i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    const entries = u16(tail, eocd + 10);
    const cdSize = u32(tail, eocd + 12);
    const cdOffset = u32(tail, eocd + 16);
    if (cdSize === 0xffffffff || cdOffset === 0xffffffff || entries === 0xffff) return null; // ZIP64: deixa o servidor tratar

    // 2) Diretório central: acha a melhor biblioteca.
    const cd = new DataView(await zip.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const dec = new TextDecoder();
    let best: { score: number; name: string; method: number; compSize: number; offset: number } | null = null;
    let p = 0;
    for (let i = 0; i < entries && p + 46 <= cd.byteLength; i++) {
      if (u32(cd, p) !== 0x02014b50) break;
      const method = u16(cd, p + 10);
      const compSize = u32(cd, p + 20);
      const nameLen = u16(cd, p + 28);
      const extraLen = u16(cd, p + 30);
      const commentLen = u16(cd, p + 32);
      const offset = u32(cd, p + 42);
      const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
      const score = name.endsWith('/') ? -1 : libScore(name);
      if (score >= 0 && (!best || score > best.score)) best = { score, name, method, compSize, offset };
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (!best || (best.method !== 0 && best.method !== 8)) return null;

    // 3) Dados da entrada (cabeçalho local + conteúdo comprimido).
    const lh = new DataView(await zip.slice(best.offset, best.offset + 30).arrayBuffer());
    if (u32(lh, 0) !== 0x04034b50) return null;
    const start = best.offset + 30 + u16(lh, 26) + u16(lh, 28);
    const raw = zip.slice(start, start + best.compSize);
    const blob =
      best.method === 0
        ? raw
        : await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    const base = best.name.split(/[\/]/).pop() ?? 'libStereoTool.so';
    return new File([blob], base, { type: 'application/octet-stream' });
  } catch {
    return null;
  }
}
