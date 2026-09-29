-- =====================================================================
-- Monitor JCF — Migración v2.11
-- 1) Línea de tiempo del panel: saber si el cliente ya abrió el correo de
--    bienvenida (el botón del correo pasa por ir-telegram.mjs, que anota
--    la fecha) — o si se registró con Google (correo ya verificado).
-- 2) Admin > Pagos: marcar los pagos aplicados o forzados a mano.
-- Corre esto DESPUÉS de 001 a 012.
-- =====================================================================

alter table suscriptores
  add column if not exists correo_verificado_at timestamptz;

alter table pagos
  add column if not exists forzado_manual boolean not null default false,
  add column if not exists nota text;
