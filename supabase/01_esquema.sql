-- =====================================================================
-- Inventario SCORP · esquema de la base de datos (Supabase)
-- Ejecútelo una sola vez en Supabase → SQL Editor → New query → Run.
-- Crea: PostGIS, tablas, catálogo de tipos, reglas de seguridad (RLS)
-- y las funciones para eliminar, restaurar y ver puntos vecinos.
-- =====================================================================

create extension if not exists postgis with schema extensions;

-- ---------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------

-- Límites municipales del Censo (con el agua costera). Se cargan con el
-- script de configuración mediante cargar_municipio().
create table public.municipios (
  id     text primary key,                 -- GEOID del Censo, p. ej. 72025
  nombre text not null unique,             -- con acentos, p. ej. Mayagüez
  geom   extensions.geometry(MultiPolygon, 4326) not null
);
create index municipios_geom_idx on public.municipios using gist (geom);

-- Lista de tipos de instalación que muestra el formulario.
create table public.catalogo_tipos (
  nombre text primary key,
  orden  integer not null unique
);

-- Una fila por cuenta: su rol y, si es municipal, su municipio.
create table public.perfiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  correo       text not null,
  rol          text not null check (rol in ('municipio', 'admin')),
  municipio_id text unique references public.municipios (id),
  constraint perfil_municipio_segun_rol check (
    (rol = 'admin' and municipio_id is null) or
    (rol = 'municipio' and municipio_id is not null))
);

-- Las instalaciones. municipio_id y los campos de auditoría los llena la
-- base de datos; lo que envíe el navegador en esos campos se ignora.
create table public.instalaciones (
  id                    uuid primary key default gen_random_uuid(),
  nombre                text not null check (length(btrim(nombre)) > 0),
  tipos                 text[] not null check (cardinality(tipos) > 0),
  tipo_otro             text,
  titularidad           text not null check (titularidad in
                          ('Federal', 'Estatal', 'Municipal', 'Comunitario', 'Privado', 'Desconocido', 'Otro')),
  titularidad_otro      text,
  descripcion           text,
  municipio_id          text not null references public.municipios (id),
  geom                  extensions.geometry(Point, 4326) not null,
  lat                   double precision generated always as (extensions.st_y(geom)) stored,
  lng                   double precision generated always as (extensions.st_x(geom)) stored,
  creado_por            uuid,
  creado_por_correo     text,
  creado_en             timestamptz,
  modificado_por        uuid,
  modificado_por_correo text,
  modificado_en         timestamptz,
  eliminado             boolean not null default false,
  eliminado_por         uuid,
  eliminado_por_correo  text,
  eliminado_en          timestamptz,
  constraint tipo_otro_requerido check (
    ('Otro' = any (tipos)) = (coalesce(btrim(tipo_otro), '') <> '')),
  constraint titularidad_otro_requerida check (
    (titularidad = 'Otro') = (coalesce(btrim(titularidad_otro), '') <> '')),
  constraint polideportivo_con_otro_tipo check (
    not ('Polideportivo' = any (tipos)) or cardinality(tipos) > 1)
);
create index instalaciones_geom_idx on public.instalaciones using gist (geom);
create index instalaciones_municipio_idx on public.instalaciones (municipio_id) where not eliminado;

-- ---------------------------------------------------------------------
-- Funciones de apoyo
-- ---------------------------------------------------------------------

create function public.es_admin() returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from perfiles where user_id = auth.uid() and rol = 'admin') $$;

create function public.mi_municipio() returns text
language sql stable security definer set search_path = public
as $$ select municipio_id from perfiles where user_id = auth.uid() $$;

-- Valida y completa cada instalación antes de guardarla.
create function public.instalaciones_antes_de_guardar() returns trigger
language plpgsql security definer set search_path = public, extensions
as $$
declare
  uid     uuid    := auth.uid();
  correo  text    := coalesce(auth.jwt() ->> 'email', current_user);
  admin   boolean := uid is null or public.es_admin();   -- uid nulo = SQL Editor o script con clave secreta
  via_rpc boolean := coalesce(current_setting('scorp.via_funcion', true), '') = 'si';
  muni    text;
  t       text;
begin
  new.nombre           := btrim(new.nombre);
  new.tipo_otro        := nullif(btrim(new.tipo_otro), '');
  new.titularidad_otro := nullif(btrim(new.titularidad_otro), '');
  new.descripcion      := nullif(btrim(new.descripcion), '');

  if cardinality(new.tipos) <> (select count(distinct x) from unnest(new.tipos) x) then
    raise exception 'Hay tipos de instalación repetidos.' using errcode = '22023';
  end if;
  foreach t in array new.tipos loop
    if not exists (select 1 from catalogo_tipos where nombre = t) then
      raise exception 'Tipo de instalación desconocido: %', t using errcode = '22023';
    end if;
  end loop;

  -- El municipio lo decide la ubicación, con los límites completos del Censo.
  if extensions.st_srid(new.geom) = 0 then new.geom := extensions.st_setsrid(new.geom, 4326); end if;
  select id into muni from municipios where extensions.st_intersects(geom, new.geom) order by id limit 1;
  if muni is null then
    raise exception 'El punto está fuera de los límites de los municipios.' using errcode = '22023';
  end if;
  if not admin and muni is distinct from public.mi_municipio() then
    raise exception 'Solo puede añadir o mover instalaciones dentro de su municipio, incluida su costa.' using errcode = '42501';
  end if;
  new.municipio_id := muni;

  if tg_op = 'INSERT' then
    new.creado_por := uid;  new.creado_por_correo := correo;  new.creado_en := now();
    new.modificado_por := null;  new.modificado_por_correo := null;  new.modificado_en := null;
    new.eliminado := false;
    new.eliminado_por := null;  new.eliminado_por_correo := null;  new.eliminado_en := null;
    return new;
  end if;

  -- UPDATE: la creación no cambia nunca.
  new.id := old.id;
  new.creado_por := old.creado_por;  new.creado_por_correo := old.creado_por_correo;  new.creado_en := old.creado_en;

  if new.eliminado is distinct from old.eliminado then
    if not via_rpc and not (uid is null) then
      raise exception 'Use las funciones eliminar_instalacion o restaurar_instalacion.' using errcode = '42501';
    end if;
    if new.eliminado then
      new.eliminado_por := uid;  new.eliminado_por_correo := correo;  new.eliminado_en := now();
      new.modificado_por := old.modificado_por;  new.modificado_por_correo := old.modificado_por_correo;  new.modificado_en := old.modificado_en;
      return new;
    end if;
    -- restauración
    new.eliminado_por := null;  new.eliminado_por_correo := null;  new.eliminado_en := null;
  else
    new.eliminado_por := old.eliminado_por;  new.eliminado_por_correo := old.eliminado_por_correo;  new.eliminado_en := old.eliminado_en;
  end if;

  new.modificado_por := uid;  new.modificado_por_correo := correo;  new.modificado_en := now();
  return new;
end $$;

create trigger instalaciones_antes_de_guardar
  before insert or update on public.instalaciones
  for each row execute function public.instalaciones_antes_de_guardar();

-- Eliminar: marca la instalación como eliminada (no se borra).
create function public.eliminar_instalacion(p_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Debe iniciar sesión.' using errcode = '42501'; end if;
  perform set_config('scorp.via_funcion', 'si', true);
  update instalaciones set eliminado = true
   where id = p_id and not eliminado and (public.es_admin() or municipio_id = public.mi_municipio());
  if not found then raise exception 'No se encontró la instalación o no puede eliminarla.' using errcode = '42501'; end if;
  perform set_config('scorp.via_funcion', '', true);
end $$;

-- Restaurar: solo la administración.
create function public.restaurar_instalacion(p_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.es_admin() then raise exception 'Solo la administración puede restaurar instalaciones.' using errcode = '42501'; end if;
  perform set_config('scorp.via_funcion', 'si', true);
  update instalaciones set eliminado = false where id = p_id and eliminado;
  if not found then raise exception 'No se encontró una instalación eliminada con ese identificador.' using errcode = '22023'; end if;
  perform set_config('scorp.via_funcion', '', true);
end $$;

-- Puntos de municipios vecinos: solo la ubicación, sin ningún otro dato.
create function public.puntos_vecinos()
returns table (id uuid, lat double precision, lng double precision)
language sql stable security definer set search_path = public, extensions
as $$
  select i.id, i.lat, i.lng
    from instalaciones i, municipios m
   where m.id = public.mi_municipio()
     and not i.eliminado
     and i.municipio_id <> m.id
     and i.geom && st_expand(m.geom, 0.05)
$$;

-- Carga de límites (solo para el script de configuración con la clave secreta).
create function public.cargar_municipio(p_id text, p_nombre text, p_geojson jsonb) returns void
language sql security definer set search_path = public, extensions
as $$
  insert into municipios (id, nombre, geom)
  values (p_id, p_nombre,
          st_multi(st_collectionextract(st_makevalid(st_force2d(st_setsrid(st_geomfromgeojson(p_geojson::text), 4326))), 3)))
  on conflict (id) do update set nombre = excluded.nombre, geom = excluded.geom
$$;

-- ---------------------------------------------------------------------
-- Permisos y reglas de seguridad (RLS)
-- ---------------------------------------------------------------------

alter table public.municipios     enable row level security;
alter table public.catalogo_tipos enable row level security;
alter table public.perfiles       enable row level security;
alter table public.instalaciones  enable row level security;

revoke all on public.municipios, public.catalogo_tipos, public.perfiles, public.instalaciones from anon, authenticated;
grant select on public.municipios, public.catalogo_tipos, public.perfiles to authenticated;
grant select, insert, update on public.instalaciones to authenticated;   -- sin DELETE: nada se borra

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.es_admin(), public.mi_municipio(), public.eliminar_instalacion(uuid),
  public.restaurar_instalacion(uuid), public.puntos_vecinos() to authenticated;
grant execute on function public.cargar_municipio(text, text, jsonb) to service_role;

create policy "municipios: lectura" on public.municipios
  for select to authenticated using (true);

create policy "catalogo: lectura" on public.catalogo_tipos
  for select to authenticated using (true);

create policy "perfiles: el propio o admin" on public.perfiles
  for select to authenticated using (user_id = auth.uid() or public.es_admin());

create policy "instalaciones: ver" on public.instalaciones
  for select to authenticated
  using (public.es_admin() or (municipio_id = public.mi_municipio() and not eliminado));

create policy "instalaciones: añadir" on public.instalaciones
  for insert to authenticated
  with check (public.es_admin() or municipio_id = public.mi_municipio());

create policy "instalaciones: editar" on public.instalaciones
  for update to authenticated
  using (public.es_admin() or (municipio_id = public.mi_municipio() and not eliminado))
  with check (public.es_admin() or municipio_id = public.mi_municipio());

-- ---------------------------------------------------------------------
-- Catálogo de tipos (orden alfabético, «Otro» al final)
-- ---------------------------------------------------------------------
insert into public.catalogo_tipos (nombre, orden) values
  ('Área de caza', 1),
  ('Área para acampar', 2),
  ('Área para vehículos todoterreno (ATV)', 3),
  ('Balneario', 4),
  ('Bandera de Puerto Rico', 5),
  ('Boya de amarre', 6),
  ('Campamento para casas rodantes o cabañas', 7),
  ('Campo de fútbol', 8),
  ('Campo de golf', 9),
  ('Cancha de baloncesto', 10),
  ('Cancha de pickleball o pádel', 11),
  ('Cancha de tenis', 12),
  ('Cancha de voleibol', 13),
  ('Cascadas y charcas', 14),
  ('Ciclovía', 15),
  ('Concierto, teatro o cine al aire libre', 16),
  ('Equipo de ejercicio al aire libre', 17),
  ('Estadio o coliseo', 18),
  ('Faro', 19),
  ('Frente marítimo y malecón', 20),
  ('Gazebo', 21),
  ('Instalación de pesca en aguas interiores (muelles y embarcaderos)', 22),
  ('Jardín botánico o público', 23),
  ('Lagunas costeras o bahías bioluminiscentes', 24),
  ('Marina y club náutico', 25),
  ('Mirador, hacienda y casita del caminero', 26),
  ('Muelle y embarcadero', 27),
  ('Otras playas públicas', 28),
  ('Parque acuático o piscina pública', 29),
  ('Parque comunitario o área de juego', 30),
  ('Parque de patinetas (skate park)', 31),
  ('Parque de sóftbol o béisbol', 32),
  ('Parque ecuestre', 33),
  ('Parque lineal', 34),
  ('Pista para correr o caminar', 35),
  ('Plaza pública', 36),
  ('Polideportivo', 37),
  ('Rampa para botes', 38),
  ('Senderos submarinos', 39),
  ('Sitio de exploración de cuevas', 40),
  ('Sitio histórico', 41),
  ('Sitio para escalar roca', 42),
  ('Torre de observación de vida silvestre o paisaje', 43),
  ('Velódromo', 44),
  ('Vereda para bicicleta de montaña (MTB)', 45),
  ('Vereda para caminata', 46),
  ('Otro', 47);
