-- =====================================================================
-- Monitor JCF — Migración v2.2
-- Frecuencias configurables por plan, baja/reactivación de cuentas,
-- purga tras 3 periodos inactivo, bloqueo de login, y bitácora de
-- fallos silenciosos (crons, Telegram, correo).
-- Corre esto DESPUÉS de 001, 002 y 003.
-- =====================================================================

-- 1) Frecuencia de revisión configurable por plan, sin necesitar
--    redeploy — el cron de Netlify sigue corriendo cada 5 min (el tick
--    más fino), pero solo actúa por plan cuando ya pasaron estos minutos.
alter table configuracion
  add column if not exists vip_frecuencia_min int not null default 10,
  add column if not exists free_frecuencia_min int not null default 120;

-- 2) Ciclo de vida de cuentas archivadas: cuántos cierres de periodo
--    consecutivos lleva sin reactivarse, y cuándo se archivó la última vez
--    (para poder exportar "quién se archivó en tal cierre" desde el admin).
alter table suscriptores
  add column if not exists periodos_inactivo int not null default 0,
  add column if not exists archivado_en timestamptz;

-- 3) Bloqueo de login tras intentos fallidos repetidos.
alter table suscriptores
  add column if not exists intentos_fallidos int not null default 0;

-- 4) Bitácora de fallos silenciosos — crons que truenan, Telegram o
--    correo que no se pudo entregar. Visible desde una pestaña nueva del
--    panel admin.
create table if not exists fallos_sistema (
  id bigint generated always as identity primary key,
  tipo text not null,               -- 'cron' | 'telegram' | 'correo'
  origen text,                      -- nombre de la función/cron donde ocurrió
  detalle text,
  suscriptor_id bigint references suscriptores(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_fallos_sistema_created on fallos_sistema(created_at desc);
