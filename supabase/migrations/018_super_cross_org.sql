-- ============================================================
-- Maze Sales Tracker IA — Super-admins operan en CUALQUIER org
-- Políticas permisivas aditivas: en Postgres varias policies
-- permisivas para el mismo comando se combinan con OR, así que
-- esto NO afecta a los no-super (sus policies siguen intactas) y
-- solo agrega acceso a quien pasa st_is_super(). Idempotente.
-- st_integrations NO se toca (tokens; deny-all / service-role).
-- ============================================================

-- Lectura + escritura (for all) en las tablas que la app edita:
drop policy if exists st_orgs_super on public.st_orgs;
create policy st_orgs_super on public.st_orgs
  for all using (public.st_is_super()) with check (public.st_is_super());

drop policy if exists st_prof_super on public.st_profiles;
create policy st_prof_super on public.st_profiles
  for all using (public.st_is_super()) with check (public.st_is_super());

drop policy if exists st_ent_super on public.st_entries;
create policy st_ent_super on public.st_entries
  for all using (public.st_is_super()) with check (public.st_is_super());

drop policy if exists st_goal_super on public.st_goals;
create policy st_goal_super on public.st_goals
  for all using (public.st_is_super()) with check (public.st_is_super());

drop policy if exists st_sale_super on public.st_sales;
create policy st_sale_super on public.st_sales
  for all using (public.st_is_super()) with check (public.st_is_super());

drop policy if exists st_cuo_super on public.st_cuotas;
create policy st_cuo_super on public.st_cuotas
  for all using (public.st_is_super()) with check (public.st_is_super());

drop policy if exists st_kcfg_super on public.st_kpi_config;
create policy st_kcfg_super on public.st_kpi_config
  for all using (public.st_is_super()) with check (public.st_is_super());

-- Solo lectura (la escritura de shadow sigue siendo service-role):
drop policy if exists st_shadow_super on public.st_shadow_metrics;
create policy st_shadow_super on public.st_shadow_metrics
  for select using (public.st_is_super());

notify pgrst, 'reload schema';
