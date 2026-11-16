// Inventario SCORP · crear o actualizar una cuenta de colaborador
//
// Un colaborador ve todas las instalaciones activas, añade instalaciones en cualquier municipio
// y edita o mueve solo las que él añadió. No elimina, no restaura y no exporta.
// Requiere haber ejecutado supabase/02_rol_colaborador.sql.
//
// Con --consulta crea en cambio una cuenta de solo ver: ve todas las instalaciones activas con sus datos,
// pero no añade, edita, mueve, elimina ni exporta. Requiere haber ejecutado supabase/03_rol_consulta.sql.
//
// Uso (desde la carpeta setup, con el mismo .env de configurar.mjs):
//   node crear_colaborador.mjs correo@ejemplo.com "contraseña de al menos 10 caracteres"
//   node crear_colaborador.mjs correo@ejemplo.com "contraseña de al menos 10 caracteres" --consulta
//
// Si la cuenta ya existe, actualiza su contraseña y su rol.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
function salir(msg) { console.error("\n✗ " + msg + "\n"); process.exit(1); }

const args = process.argv.slice(2);
const ROL = args.includes("--consulta") ? "consulta" : "colaborador";
const [correoArg, password] = args.filter(a => a !== "--consulta");
const correo = (correoArg || "").trim().toLowerCase();
if (!correo.includes("@") || !password) salir('Uso: node crear_colaborador.mjs correo@ejemplo.com "contraseña" [--consulta]');
if (password.length < 10) salir("La contraseña debe tener al menos 10 caracteres.");

const envPath = join(AQUI, ".env");
if (!existsSync(envPath)) salir("No encontré setup/.env (el mismo que usa configurar.mjs).");
const env = Object.fromEntries(
  readFileSync(envPath, "utf8").split(/\r?\n/)
    .map(l => l.trim()).filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; })
);
const URL_BASE = (env.SUPABASE_URL || "").replace(/\/(rest|auth)\/v1\/?$/, "").replace(/\/$/, "");
const SECRETA = env.SUPABASE_SECRET_KEY || "";
if (!SECRETA) salir("Falta SUPABASE_SECRET_KEY en .env.");
const HDR = SECRETA.startsWith("eyJ") ? { apikey: SECRETA, Authorization: `Bearer ${SECRETA}` } : { apikey: SECRETA };

async function api(metodo, ruta, cuerpo, extra = {}) {
  const r = await fetch(URL_BASE + ruta, {
    method: metodo, headers: { ...HDR, "Content-Type": "application/json", ...extra },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  let datos = null; try { datos = texto ? JSON.parse(texto) : null; } catch { datos = texto; }
  if (!r.ok) { const e = new Error(`${metodo} ${ruta} → ${r.status}: ${typeof datos === "string" ? datos : JSON.stringify(datos)}`); e.status = r.status; throw e; }
  return datos;
}

try {
  let usuario = null;
  for (let p = 1; !usuario; p++) {
    const { users = [] } = await api("GET", `/auth/v1/admin/users?page=${p}&per_page=500`);
    usuario = users.find(u => (u.email || "").toLowerCase() === correo) || null;
    if (users.length < 500) break;
  }
  let nuevo = false;
  if (usuario) {
    await api("PUT", `/auth/v1/admin/users/${usuario.id}`, { password, email_confirm: true });
  } else {
    const d = await api("POST", "/auth/v1/admin/users", { email: correo, password, email_confirm: true });
    usuario = { id: d.id || (d.user && d.user.id) };
    nuevo = true;
  }
  await api("POST", "/rest/v1/perfiles?on_conflict=user_id",
    { user_id: usuario.id, correo, rol: ROL, municipio_id: null },
    { Prefer: "resolution=merge-duplicates,return=minimal" });
  console.log(`\n✓ Cuenta de ${ROL === "consulta" ? "consulta (solo ver)" : "colaborador"} ${nuevo ? "creada" : "actualizada"}: ${correo}\n`);
} catch (e) {
  if (/perfiles_rol_check|perfil_municipio_segun_rol/.test(e.message)) salir(`La base de datos aún no conoce el rol «${ROL}». Ejecute primero ${ROL === "consulta" ? "supabase/03_rol_consulta.sql" : "supabase/02_rol_colaborador.sql"} en el SQL Editor.`);
  if (e.status === 401 || e.status === 403) salir("Supabase rechazó la clave. Revise SUPABASE_SECRET_KEY en .env.");
  salir(e.message);
}
