/**
 * Lê um ZIP no navegador sem carregar ele inteiro: lista as bibliotecas Linux (.so) e extrai a escolhida.
 * O ZIP do plugin do Stereo Tool passa de 300 MB (traz todas as plataformas) e proxies/Cloudflare recusam envios
 * tão grandes (erro 502/413); a biblioteca sozinha é pequena.
 */

export interface ZipLib {
  name: string;
  size: number;
  score: number;
  method: number;
  compSize: number;
  offset: number;
}

/** Quanto mais alto, mais provável de ser a biblioteca de plugin (Linux, 64 bits, sem interface gráfica). */
function libScore(name: string): number {
  const n = name.toLowerCase();
  let score = 1;
  if (/libstereotool/.test(n)) score += 2;
  if (/intel64|x86[_-]?64|amd64|x64/.test(n)) score += 5;
  else if (/64/.test(n)) score += 1;
  if (/arm|aarch|armhf|pi\d|i386|i686|intel32|x86(?![_-]?64)|32/.test(n)) score -= 7;
  if (/x11|gui|gtk|qt|ui\b/.test(n)) score -= 4;
  if (/linux/.test(n)) score += 1;
  return score;
}

const u16 = (d: DataView, o: number) => d.getUint16(o, true);
const u32 = (d: DataView, o: number) => d.getUint32(o, true);

/** Todas as bibliotecas Linux (.so) dentro do ZIP, da mais provável para a menos provável. Null = não deu para ler o ZIP. */
export async function listZipLibs(zip: File): Promise<ZipLib[] | null> {
  try {
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
    if (cdSize === 0xffffffff || cdOffset === 0xffffffff || entries === 0xffff) return null; // ZIP64: o servidor trata

    const cd = new DataView(await zip.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const dec = new TextDecoder();
    const out: ZipLib[] = [];
    let p = 0;
    for (let i = 0; i < entries && p + 46 <= cd.byteLength; i++) {
      if (u32(cd, p) !== 0x02014b50) break;
      const method = u16(cd, p + 10);
      const compSize = u32(cd, p + 20);
      const size = u32(cd, p + 24);
      const nameLen = u16(cd, p + 28);
      const extraLen = u16(cd, p + 30);
      const commentLen = u16(cd, p + 32);
      const offset = u32(cd, p + 42);
      const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
      if (/\.so(\.\d+)*$/i.test(name) && !/__macosx|\/\._/i.test(name) && (method === 0 || method === 8)) {
        out.push({ name, size, score: libScore(name), method, compSize, offset });
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  } catch {
    return null;
  }
}

/** Extrai uma entrada (biblioteca) do ZIP como arquivo. */
export async function extractZipLib(zip: File, lib: ZipLib): Promise<File | null> {
  try {
    const lh = new DataView(await zip.slice(lib.offset, lib.offset + 30).arrayBuffer());
    if (u32(lh, 0) !== 0x04034b50) return null;
    const start = lib.offset + 30 + u16(lh, 26) + u16(lh, 28);
    const raw = zip.slice(start, start + lib.compSize);
    const blob = lib.method === 0 ? raw : await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    const base = lib.name.split(/[\\/]/).pop() ?? 'libStereoTool.so';
    return new File([blob], base, { type: 'application/octet-stream' });
  } catch {
    return null;
  }
}
