-- =====================================================================
-- Monitor JCF — Migración v2.3
-- Nombre del suscriptor, prefijo telefónico editable, y límite de
-- 3 cambios de estado/municipio por cuenta (1 al registrarse + 2 desde
-- el panel).
-- Corre esto DESPUÉS de 001, 002, 003 y 004.
-- =====================================================================

alter table suscriptores
  add column if not exists nombre text,
  add column if not exists telefono_prefijo text not null default '+52',
  add column if not exists cambios_municipio_restantes int not null default 2;
