-- =====================================================================
-- Monitor JCF — Migración v2.6
-- Banners de la página de registro editables desde el panel admin.
-- Cada fila reemplaza uno de los 6 banners (slot 1 a 6). Si un slot no
-- tiene fila, la página usa la imagen original de /img/bannerN.webp.
-- La imagen se guarda como data URI base64 (data:image/webp;base64,...).
-- Corre esto DESPUÉS de 001 a 007.
-- =====================================================================

create table if not exists landing_banners (
  slot int primary key check (slot between 1 and 6),
  data_uri text not null,
  formato text not null check (formato in ('webp', 'jpeg', 'png')),
  bytes int not null,
  updated_at timestamptz not null default now()
);

grant all on landing_banners to service_role;
