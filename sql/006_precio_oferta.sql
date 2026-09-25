-- =====================================================================
-- Monitor JCF — Migración v2.4
-- Precio VIP configurable desde el panel admin, con precio "normal"
-- tachado opcional y dos textos de aviso editables (oferta y escasez).
-- Los textos son libres: el administrador es responsable de que lo que
-- digan sea cierto (no hay contador ni límite automático detrás).
-- Corre esto DESPUÉS de 001 a 005.
-- =====================================================================

alter table configuracion
  add column if not exists vip_precio numeric(10,2) not null default 100,
  add column if not exists vip_precio_regular numeric(10,2),
  add column if not exists vip_oferta_texto text,
  add column if not exists vip_escasez_texto text;
