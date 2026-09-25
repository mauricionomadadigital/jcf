// netlify/functions/lib/banners.mjs
// Banners de la página de registro (6 slots), editables desde el panel
// admin pegando su código base64. Tabla: landing_banners (sql/008).

export const TOTAL_BANNERS = 6;
// Peso máximo de la imagen ya decodificada. 300 KB por banner deja la
// página completa en ~2 MB en el peor caso — razonable con datos móviles.
export const MAX_BYTES_BANNER = 300 * 1024;
export const FORMATOS = { webp: 'image/webp', jpeg: 'image/jpeg', png: 'image/png' };

// Detecta el formato real por los primeros bytes (no por lo que diga el
// prefijo): así una imagen mal etiquetada no se sirve con el tipo equivocado.
function formatoPorFirma(buf) {
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

// Acepta "data:image/webp;base64,AAAA..." o solo el base64 pelón.
// Devuelve { formato, bytes, dataUri } normalizado, o lanza un Error con
// un mensaje claro para mostrar en el admin.
export function validarBase64Imagen(entrada) {
  let texto = String(entrada || '').trim();
  if (!texto) throw new Error('Pega el código base64 de la imagen.');
  const m = texto.match(/^data:([^;,]+);base64,(.*)$/s);
  if (m) texto = m[2];
  texto = texto.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(texto)) throw new Error('El código no es base64 válido (revisa que se haya copiado completo).');
  const buf = Buffer.from(texto, 'base64');
  const formato = formatoPorFirma(buf);
  if (!formato) throw new Error('Formato no permitido: solo WebP, JPG o PNG.');
  if (buf.length > MAX_BYTES_BANNER) {
    throw new Error(`La imagen pesa ${Math.round(buf.length / 1024)} KB; el máximo es ${MAX_BYTES_BANNER / 1024} KB. Usa "Elegir archivo", que la comprime sola.`);
  }
  return { formato, bytes: buf.length, dataUri: `data:${FORMATOS[formato]};base64,${texto}` };
}
