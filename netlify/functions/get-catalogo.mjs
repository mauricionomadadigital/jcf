// netlify/functions/get-catalogo.mjs
// Sirve la lista real de estados y municipios directo del gobierno,
// para que el checkout siempre use los mismos nombres que compara el monitor.

import { descargarCatalogo } from './lib/dtmlp.mjs';

export default async () => {
  try {
    const { inicio, detmun } = await descargarCatalogo();

    const estados = (inicio || [])
      .map(e => ({ idedo: e.idedo, edo: e.edo, status: e.status }))
      .sort((a, b) => a.edo.localeCompare(b.edo, 'es'));

    const municipios = (detmun || [])
      .map(m => ({ idedo: Number(m.edo), lmun: m.lmun }))
      .sort((a, b) => a.lmun.localeCompare(b.lmun, 'es'));

    return new Response(JSON.stringify({ ok: true, estados, municipios }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
