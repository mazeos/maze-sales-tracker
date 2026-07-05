-- 003_integrations.sql
-- Integraciones externas por org (Fase 1: conexión OAuth con GoHighLevel).
--
-- Guarda los tokens OAuth de la subcuenta GHL de cada org. DECISIÓN DE SEGURIDAD:
-- esta tabla tiene RLS habilitada SIN policies y SIN permisos para authenticated/anon.
-- Eso la deja en deny-all para cualquier rol no privilegiado vía PostgREST: los
-- tokens (access_token / refresh_token) solo los lee y escribe la service role
-- de la mini-API (que bypassea RLS). El estado de conexión se expone al browser
-- únicamente vía GET /api/integrations/ghl, que hace un select explícito SIN las
-- columnas de tokens. Los tokens jamás llegan al cliente ni a PostgREST directo.
--
-- El UNIQUE en org_id permite el UPSERT (on_conflict=org_id) del callback OAuth:
-- una sola integración GHL por org.
--
-- Idempotente: se puede correr múltiples veces sin error.
create table if not exists public.st_integrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid unique not null references public.st_orgs(id) on delete cascade,
  provider text not null default 'ghl',
  location_id text,
  location_name text,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  company_id text,
  scopes text,
  connected_by uuid references public.st_profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- RLS habilitada SIN policies = deny-all para roles no privilegiados.
-- NO crear policies ni otorgar permisos a authenticated/anon en esta tabla.
alter table public.st_integrations enable row level security;
