-- =====================================================================
-- Monitor JCF — Migración v2.9
-- Mensajes masivos también por CORREO (Admin > Mensajes): la tabla
-- difusiones guarda por qué canal salió cada envío y, en correo, el asunto.
-- Corre esto DESPUÉS de 001 a 010.
-- =====================================================================

alter table difusiones
  add column if not exists canal text not null default 'telegram' check (canal in ('telegram', 'correo')),
  add column if not exists asunto text;
