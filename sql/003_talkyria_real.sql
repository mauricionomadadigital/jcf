-- =====================================================================
-- Monitor JCF — Migración v2.1 (Talkyria real: llamada async + webhook)
-- Corre esto DESPUÉS de 002_comercial_v2.sql.
-- =====================================================================

alter table llamadas
  add column if not exists call_id text,
  add column if not exists event_type text,
  add column if not exists outcome text,
  add column if not exists summary text,
  add column if not exists recording_url text;

-- No es único porque los intentos fallidos (sin respuesta de Talkyria)
-- se guardan con call_id nulo, y Postgres permite varios NULL en un
-- índice único sin problema — pero si SÍ hay call_id, debe ser único
-- para poder ubicar la fila exacta cuando llegue el webhook.
create unique index if not exists idx_llamadas_call_id on llamadas(call_id) where call_id is not null;
