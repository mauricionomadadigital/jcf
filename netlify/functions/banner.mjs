// netlify/functions/banner.mjs
// Sirve el banner N (1-6) de la página de registro: el que el admin
// guardó en landing_banners (base64), o si no hay, la imagen original
// estática /img/bannerN.webp. El CDN de Netlify lo guarda 5 minutos, así
// que un cambio desde el admin se ve en la página en ≤5 min sin redeploy.

import { TOTAL_BANNERS, FORMATOS } from './lib/banners.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const CACHE = {
  'Cache-Control': 'public, max-age=300',
  'Netlify-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=86400'
};

export default async (req) => {
  const n = Number(new URL(req.url).searchParams.get('n'));
  if (!Number.isInteger(n) || n < 1 || n > TOTAL_BANNERS) {
    return new Response('Banner no válido', { status: 400 });
  }
  const original = new Response(null, { status: 302, headers: { Location: `/img/banner${n}.webp`, ...CACHE } });

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/landing_banners?slot=eq.${n}&select=data_uri,formato&limit=1`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    if (!res.ok) return original; // p. ej. migración 008 aún sin correr
    const [fila] = await res.json();
    if (!fila) return original;
    const base64 = fila.data_uri.slice(fila.data_uri.indexOf(',') + 1);
    return new Response(Buffer.from(base64, 'base64'), {
      status: 200,
      headers: { 'Content-Type': FORMATOS[fila.formato] || 'image/webp', ...CACHE }
    });
  } catch {
    return original;
  }
};
