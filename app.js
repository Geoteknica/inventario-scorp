/* Inventario SCORP · mapa web
   Los datos viven en Supabase. Las reglas de la base de datos (supabase/01_esquema.sql) son las que
   deciden qué puede ver y cambiar cada cuenta; las validaciones de aquí solo dan avisos más rápidos. */
"use strict";

const CFG = window.SCORP_CONFIG;
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);

const TITULARIDAD = ["Federal", "Estatal", "Municipal", "Comunitario", "Privado", "Desconocido", "Otro"];
const COLS = "id,creado_por,nombre,tipos,tipo_otro,titularidad,titularidad_otro,descripcion,municipio_id,lat,lng," +
  "creado_por_correo,creado_en,modificado_por_correo,modificado_en,eliminado,eliminado_por_correo,eliminado_en";
const FUNDING = "Este proyecto es liderado por Estudios Técnicos, Inc., bajo el contrato (2026-000333) con el Departamento de Recreación y Deportes (DRD). Es posible gracias a una subvención para planificación a través del programa Land and Water Conservation Fund (LWCF, por sus siglas en inglés) del Servicio de Parques Nacionales (NPS, por sus siglas en inglés) mediante la aportación P24AP01415 (proyecto 72-00178).";

/* ---------- utilidades ---------- */
const $ = id => document.getElementById(id);
const plain = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const fmt = iso => iso ? new Date(iso).toLocaleString("es-PR", { dateStyle: "medium", timeStyle: "short" }) : "";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ewkt = ll => `SRID=4326;POINT(${ll.lng.toFixed(6)} ${ll.lat.toFixed(6)})`;

function mensajeError(error) {
  if (!error) return "";
  const m = `${error.message || ""} ${error.details || ""}`;
  if (/Failed to fetch|NetworkError|network/i.test(m)) return "No se pudo conectar con el servidor. Revise su conexión a Internet e intente de nuevo.";
  if (/tipo_otro_requerido/.test(m)) return "Especifique el tipo en el campo «Especifique el tipo».";
  if (/titularidad_otro_requerida/.test(m)) return "Especifique la titularidad en el campo «Especifique la titularidad».";
  if (/polideportivo_con_otro_tipo/.test(m)) return "Un polideportivo necesita al menos otro tipo marcado: las instalaciones que contiene.";
  if (/JWT|token|session/i.test(m)) return "Su sesión expiró. Cierre sesión y vuelva a entrar.";
  if (error.code === "PGRST116") return "No se pudo guardar: la instalación ya no está disponible para su cuenta.";
  if (/permission denied|row-level security/i.test(m)) return "Su cuenta no tiene permiso para hacer este cambio.";
  return error.message || "Ocurrió un error inesperado.";
}

/* ---------- estado ---------- */
let perfil = null;             // { correo, rol, municipio_id }
let myId = null;
let TIPOS = [];
let MUNIS = null;              // límites simplificados (todos)
let propio = null;             // límite completo del municipio propio
let recs = [];                 // instalaciones visibles para la cuenta
let vecinos = [];              // ubicaciones de municipios vecinos
let map, muniLayer, pointsLayer;
let mode = "idle";             // idle | adding | form | moving
let draft = null;
let tempMarker = null, moveMarker = null;
let showDeleted = false;
let busy = false;

const isAdmin = () => perfil && perfil.rol === "admin";
const isColab = () => perfil && perfil.rol === "colaborador";
const isla = () => isAdmin() || isColab();          // ven toda la isla
const soloLectura = rec => isColab() && rec.creado_por !== myId;
const muniById = id => MUNIS && MUNIS.features.find(f => f.properties.id === id);
const recById = id => recs.find(r => r.id === id);

/* ---------- inicio de sesión ---------- */
document.querySelectorAll("[data-funding]").forEach(el => el.textContent = FUNDING);

$("login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("email").value.trim().toLowerCase();
  const password = $("password").value;
  const err = $("login-err");
  err.hidden = true;
  if (!email || !password) { err.textContent = "Escriba el correo y la contraseña."; err.hidden = false; return; }
  setBusy($("login-btn"), true, "Entrando…");
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    setBusy($("login-btn"), false, "Entrar");
    err.textContent = /invalid|credentials/i.test(error.message)
      ? "El correo o la contraseña no coinciden. Revise ambos e intente de nuevo."
      : mensajeError(error);
    err.hidden = false;
    return;
  }
  await entrar();
  setBusy($("login-btn"), false, "Entrar");
});

$("logout").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.reload();
});

async function entrar() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return;
  const { data: p, error } = await sb.from("perfiles").select("correo,rol,municipio_id").eq("user_id", user.id).maybeSingle();
  if (error || !p) {
    await sb.auth.signOut();
    $("login-err").textContent = error ? mensajeError(error)
      : "Su cuenta no tiene un municipio asignado. Comuníquese con Roberto Moyano.";
    $("login-err").hidden = false;
    return;
  }
  perfil = p;
  myId = user.id;
  try {
    const [cat, munis] = await Promise.all([
      sb.from("catalogo_tipos").select("nombre").order("orden"),
      fetch("data/municipios.json").then(r => { if (!r.ok) throw new Error("municipios"); return r.json(); }),
    ]);
    if (cat.error) throw cat.error;
    TIPOS = cat.data.map(r => r.nombre);
    MUNIS = munis;
    if (!isla()) {
      propio = await fetch(`data/limites/${perfil.municipio_id}.json`).then(r => { if (!r.ok) throw new Error("limite"); return r.json(); });
    }
  } catch (e) {
    $("login-err").textContent = "No se pudieron cargar los datos del mapa. Recargue la página e intente de nuevo.";
    $("login-err").hidden = false;
    return;
  }
  startApp();
  await cargarPuntos();
}

/* ---------- datos ---------- */
async function todas(query) {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await query().range(desde, desde + 999);
    if (error) throw error;
    filas.push(...data);
    if (data.length < 1000) return filas;
  }
}

async function cargarPuntos() {
  $("count").textContent = "Cargando…";
  try {
    recs = await todas(() => sb.from("instalaciones").select(COLS).order("creado_en"));
    if (!isla()) {
      const { data, error } = await sb.rpc("puntos_vecinos");
      if (error) throw error;
      vecinos = data || [];
    }
  } catch (e) {
    toast(mensajeError(e));
  }
  renderPoints();
}

/* ---------- mapa ---------- */
function startApp() {
  $("login").hidden = true;
  $("app").hidden = false;
  const own = isla() ? null : muniById(perfil.municipio_id);
  $("muni-title").textContent = isAdmin() ? "Administración · Puerto Rico" : isColab() ? "Colaboración · Puerto Rico" : "Municipio de " + own.properties.nombre;
  $("who").textContent = perfil.correo;
  ["toggle-deleted", "export-scope", "export"].forEach(id => $(id).hidden = !isAdmin());
  $("admin-muni").hidden = !isla();

  map = L.map("map", { zoomControl: true, attributionControl: true });
  map.attributionControl.addAttribution("Estudios Técnicos, Inc.");
  const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" });
  const esri = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imágenes © Esri" });
  osm.addTo(map);
  L.control.layers({ "Mapa (OpenStreetMap)": osm, "Imágenes (Esri)": esri }, null, { collapsed: false, position: "topright" }).addTo(map);

  if (isla()) {
    muniLayer = L.geoJSON(MUNIS, { style: { color: "#0f6e5a", weight: 1, fillOpacity: 0 }, interactive: false }).addTo(map);
    map.fitBounds(muniLayer.getBounds(), { padding: [10, 10] });
    const sel = $("admin-muni");
    sel.innerHTML = '<option value="">Toda la isla</option>' + [...MUNIS.features]
      .sort((a, b) => a.properties.nombre.localeCompare(b.properties.nombre, "es"))
      .map(f => `<option value="${f.properties.id}">${esc(f.properties.nombre)}</option>`).join("");
    sel.addEventListener("change", () => {
      const f = sel.value ? muniById(sel.value) : null;
      map.fitBounds(f ? L.geoJSON(f).getBounds() : muniLayer.getBounds(), { padding: [10, 10] });
    });
  } else {
    muniLayer = L.geoJSON(MUNIS, {
      filter: f => f.properties.id !== perfil.municipio_id,
      style: { color: "#4a5551", weight: 1, fillColor: "#5e6965", fillOpacity: .6 },
      interactive: false,
    }).addTo(map);
    const ownLayer = L.geoJSON(propio, { style: { color: "#0f6e5a", weight: 3, fillOpacity: 0 }, interactive: false }).addTo(map);
    const b = ownLayer.getBounds();
    map.fitBounds(b, { padding: [8, 8] });
    map.setMaxBounds(b.pad(0.08));
    map.options.maxBoundsViscosity = 1.0;
    map.setMinZoom(map.getZoom());
  }

  pointsLayer = L.layerGroup().addTo(map);
  map.on("click", onMapClick);
}

function pointStyle(rec) {
  if (rec.eliminado) return { radius: 7, color: "#b42318", weight: 2, dashArray: "3 3", fillColor: "#ffffff", fillOpacity: .8 };
  return { radius: 8, color: "#ffffff", weight: 2, fillColor: "#e8590c", fillOpacity: 1 };
}

function renderPoints() {
  if (!pointsLayer) return;
  pointsLayer.clearLayers();
  vecinos.forEach(v => L.circleMarker([v.lat, v.lng], { radius: 5, color: "#ffffff", weight: 1, fillColor: "#6c7a76", fillOpacity: .9, interactive: false }).addTo(pointsLayer));
  let shown = 0;
  recs.forEach(rec => {
    if (rec.eliminado && !(isAdmin() && showDeleted)) return;
    if (draft && draft.id === rec.id && mode === "moving") return;
    const m = L.circleMarker([rec.lat, rec.lng], pointStyle(rec));
    m.bindTooltip(esc(rec.nombre), { direction: "top", offset: [0, -6] });
    m.on("click", ev => { L.DomEvent.stopPropagation(ev); if (mode === "idle" || mode === "form") openEdit(rec.id); });
    if (!rec.eliminado) shown++;
    m.addTo(pointsLayer);
  });
  const label = isla() ? "instalaciones en total" : "instalaciones en su municipio";
  $("count").textContent = `${shown} ${shown === 1 ? label.replace("instalaciones", "instalación") : label}`;
}

/* ---------- regla de ubicación (aviso rápido; la base de datos decide) ---------- */
function checkLocation(latlng) {
  const pt = turf.point([latlng.lng, latlng.lat]);
  if (isla()) {
    const hit = MUNIS.features.find(f => turf.booleanPointInPolygon(pt, f));
    return hit ? { ok: true, municipio_id: hit.properties.id }
      : { ok: false, msg: "Ese punto está fuera de los límites de los municipios. Elija una ubicación en tierra o cerca de la costa." };
  }
  const dentro = (propio.type === "FeatureCollection" ? propio.features : [propio]).some(f => turf.booleanPointInPolygon(pt, f));
  return dentro ? { ok: true, municipio_id: perfil.municipio_id }
    : { ok: false, msg: "Solo puede añadir instalaciones dentro de su municipio, incluida su costa." };
}

/* ---------- añadir / mover ---------- */
$("add").addEventListener("click", () => {
  if (mode === "adding") return cancelAll();
  cancelAll();
  mode = "adding";
  $("add").setAttribute("aria-pressed", "true");
  $("map").classList.add("adding");
  showBanner("Haga clic en el mapa donde está la instalación.", [["Cancelar", cancelAll]]);
});

function onMapClick(e) {
  if (mode !== "adding") return;
  const chk = checkLocation(e.latlng);
  if (!chk.ok) return toast(chk.msg);
  mode = "form";
  $("map").classList.remove("adding");
  $("add").setAttribute("aria-pressed", "false");
  hideBanner();
  tempMarker = L.circleMarker(e.latlng, { radius: 9, color: "#ffffff", weight: 3, fillColor: "#e8590c", fillOpacity: 1 }).addTo(map);
  draft = { id: null, latlng: e.latlng, municipio_id: chk.municipio_id, values: { nombre: "", tipos: [], tipo_otro: "", titularidad: "", titularidad_otro: "", descripcion: "" } };
  renderForm();
}

function startMove() {
  const rec = recById(draft.id);
  mode = "moving";
  $("panel").hidden = true;
  renderPoints();
  moveMarker = L.marker([rec.lat, rec.lng], { draggable: true, icon: L.divIcon({ className: "", html: '<div class="move-handle"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(map);
  showBanner("Arrastre el punto a su nueva ubicación.", [["Confirmar ubicación", confirmMove, true], ["Cancelar", () => { endMove(); openEdit(rec.id); }]]);
}

async function confirmMove() {
  if (busy) return;
  const ll = moveMarker.getLatLng();
  const chk = checkLocation(ll);
  if (!chk.ok) return toast(chk.msg);
  const id = draft.id;
  busy = true;
  const { data, error } = await sb.from("instalaciones").update({ geom: ewkt(ll) }).eq("id", id).select(COLS).single();
  busy = false;
  if (error) return toast(mensajeError(error));
  replaceRec(data);
  endMove();
  toast("Ubicación actualizada.");
  openEdit(id);
}

function endMove() { if (moveMarker) { map.removeLayer(moveMarker); moveMarker = null; } hideBanner(); mode = "idle"; renderPoints(); }

function cancelAll() {
  if (tempMarker) { map.removeLayer(tempMarker); tempMarker = null; }
  if (moveMarker) { map.removeLayer(moveMarker); moveMarker = null; }
  mode = "idle"; draft = null;
  $("map").classList.remove("adding");
  $("add").setAttribute("aria-pressed", "false");
  $("panel").hidden = true;
  hideBanner();
  renderPoints();
  map && map.invalidateSize();
}

function replaceRec(row) {
  const i = recs.findIndex(r => r.id === row.id);
  if (i >= 0) recs[i] = row; else recs.push(row);
}

/* ---------- formulario ---------- */
function openEdit(id) {
  const rec = recById(id);
  if (!rec) return;
  if (tempMarker) { map.removeLayer(tempMarker); tempMarker = null; }
  mode = "form";
  draft = { id, latlng: L.latLng(rec.lat, rec.lng), municipio_id: rec.municipio_id,
    values: { nombre: rec.nombre, tipos: [...rec.tipos], tipo_otro: rec.tipo_otro || "", titularidad: rec.titularidad, titularidad_otro: rec.titularidad_otro || "", descripcion: rec.descripcion || "" } };
  renderForm(rec);
}

function renderForm(rec) {
  const v = draft.values;
  const isNew = !draft.id;
  const p = $("panel");
  const muniName = muniById(draft.municipio_id)?.properties.nombre || "";
  if (rec && (rec.eliminado || soloLectura(rec))) {
    const restaurable = rec.eliminado && isAdmin();
    p.innerHTML = `
      <div class="panel-head">${rec.eliminado ? '<span class="deleted-tag">Eliminada</span>' : ""}<h2>${esc(rec.nombre)}</h2>
        <span class="coords">${esc(muniName)} · ${rec.lat.toFixed(5)}, ${rec.lng.toFixed(5)}</span></div>
      <div class="panel-body readonly"><dl>
        <div><dt>Tipo de instalación</dt><dd>${rec.tipos.map(esc).join("; ")}${rec.tipo_otro ? " (" + esc(rec.tipo_otro) + ")" : ""}</dd></div>
        <div><dt>Titularidad</dt><dd>${esc(rec.titularidad)}${rec.titularidad_otro ? " (" + esc(rec.titularidad_otro) + ")" : ""}</dd></div>
        ${rec.descripcion ? `<div><dt>Descripción</dt><dd>${esc(rec.descripcion)}</dd></div>` : ""}
      </dl>${metaHtml(rec)}</div>
      <div class="panel-foot">${restaurable ? '<button class="btn primary" id="f-restore">Restaurar</button>' : '<span class="loading">Solo puede editar las instalaciones que usted añadió.</span>'}<span class="spacer"></span><button class="btn" id="f-close">Cerrar</button></div>`;
    p.hidden = false;
    if (restaurable) $("f-restore").onclick = async () => {
      if (busy) return;
      busy = true; setBusy($("f-restore"), true, "Restaurando…");
      const { error } = await sb.rpc("restaurar_instalacion", { p_id: rec.id });
      busy = false;
      if (error) { setBusy($("f-restore"), false, "Restaurar"); return toast(mensajeError(error)); }
      const { data } = await sb.from("instalaciones").select(COLS).eq("id", rec.id).single();
      if (data) replaceRec(data);
      toast("Instalación restaurada.");
      openEdit(rec.id); renderPoints();
    };
    $("f-close").onclick = cancelAll;
    map.invalidateSize();
    return;
  }
  p.innerHTML = `
    <div class="panel-head">
      <h2>${isNew ? "Nueva instalación" : "Editar instalación"}</h2>
      <span class="coords">${esc(muniName)} · ${draft.latlng.lat.toFixed(5)}, ${draft.latlng.lng.toFixed(5)}</span>
    </div>
    <form class="panel-body" id="f" novalidate>
      <div class="field"><label for="f-nombre">Nombre <span class="req">*</span></label>
        <input id="f-nombre" value="${esc(v.nombre)}" maxlength="150" placeholder="Ej.: Parque Pasivo Villa Blanca"></div>
      <div class="field">
        <span class="label" id="tipos-label">Tipo de instalación <span class="req">*</span></span>
        <div class="chosen" id="f-chosen"></div>
        <div class="types" role="group" aria-labelledby="tipos-label">
          <input class="types-search" id="f-buscar" type="search" placeholder="Buscar tipo (ej.: cancha)" aria-label="Buscar tipo">
          <div class="types-list" id="f-tipos">
            ${TIPOS.map((t, i) => `<label data-t="${esc(plain(t).toLowerCase())}"><input type="checkbox" id="tipo-${i}" value="${esc(t)}" ${v.tipos.includes(t) ? "checked" : ""}><span>${esc(t)}</span></label>`).join("")}
            <div class="types-empty" id="f-noresult" hidden>Ningún tipo coincide con la búsqueda.</div>
          </div>
        </div>
        <div class="hint" id="f-poli" hidden>Marque también cada instalación que forma parte del polideportivo (por ejemplo: estadio, parque de béisbol, pista para correr o caminar).</div>
      </div>
      <div class="field" id="f-tipo-otro-wrap" hidden><label for="f-tipo-otro">Especifique el tipo <span class="req">*</span></label>
        <input id="f-tipo-otro" value="${esc(v.tipo_otro)}" maxlength="150"></div>
      <div class="field"><label for="f-tit">Titularidad <span class="req">*</span></label>
        <select id="f-tit"><option value="">Seleccione…</option>${TITULARIDAD.map(t => `<option ${v.titularidad === t ? "selected" : ""}>${t}</option>`).join("")}</select></div>
      <div class="field" id="f-tit-otro-wrap" hidden><label for="f-tit-otro">Especifique la titularidad <span class="req">*</span></label>
        <input id="f-tit-otro" value="${esc(v.titularidad_otro)}" maxlength="150"></div>
      <div class="field"><label for="f-desc">Descripción</label>
        <textarea id="f-desc" maxlength="1000">${esc(v.descripcion)}</textarea></div>
      <div class="err" id="f-err" hidden></div>
      <div id="f-confirm"></div>
      ${rec ? metaHtml(rec) : ""}
    </form>
    <div class="panel-foot">
      <button class="btn primary" id="f-save">Guardar</button>
      <button class="btn" id="f-cancel">Cancelar</button>
      ${isNew ? "" : '<button class="btn" id="f-move">Mover</button>'}
      <span class="spacer"></span>
      ${isNew || isColab() ? "" : '<button class="btn danger" id="f-del">Eliminar</button>'}
    </div>`;
  p.hidden = false;
  map.invalidateSize();

  const sync = () => {
    const checked = [...p.querySelectorAll("#f-tipos input:checked")].map(i => i.value);
    $("f-chosen").innerHTML = checked.map(t => `<span class="chip">${esc(t)}</span>`).join("");
    $("f-tipo-otro-wrap").hidden = !checked.includes("Otro");
    $("f-poli").hidden = !checked.includes("Polideportivo");
    $("f-tit-otro-wrap").hidden = $("f-tit").value !== "Otro";
  };
  p.querySelectorAll("#f-tipos input").forEach(i => i.addEventListener("change", sync));
  $("f-tit").addEventListener("change", sync);
  $("f-buscar").addEventListener("input", e => {
    const q = plain(e.target.value).toLowerCase().trim();
    let n = 0;
    p.querySelectorAll("#f-tipos label").forEach(l => { const show = !q || l.dataset.t.includes(q); l.hidden = !show; if (show) n++; });
    $("f-noresult").hidden = n > 0;
  });
  $("f").addEventListener("submit", e => { e.preventDefault(); save(); });
  $("f-save").onclick = save;
  $("f-cancel").onclick = cancelAll;
  if (!isNew) {
    $("f-move").onclick = startMove;
    if ($("f-del")) $("f-del").onclick = () => {
      $("f-confirm").innerHTML = `<div class="confirm"><span>¿Eliminar «${esc(v.nombre)}»? Dejará de aparecer en el mapa.</span>
        <div><button class="btn danger solid" type="button" id="f-del-yes">Eliminar</button><button class="btn" type="button" id="f-del-no">No eliminar</button></div></div>`;
      $("f-del-yes").onclick = async () => {
        if (busy) return;
        busy = true; setBusy($("f-del-yes"), true, "Eliminando…");
        const id = draft.id;
        const { error } = await sb.rpc("eliminar_instalacion", { p_id: id });
        busy = false;
        if (error) { setBusy($("f-del-yes"), false, "Eliminar"); return toast(mensajeError(error)); }
        const r = recById(id);
        if (isAdmin()) {
          const { data } = await sb.from("instalaciones").select(COLS).eq("id", id).single();
          if (data) replaceRec(data);
        } else if (r) {
          recs = recs.filter(x => x.id !== id);
        }
        cancelAll(); toast("Instalación eliminada.");
      };
      $("f-del-no").onclick = () => { $("f-confirm").innerHTML = ""; };
    };
  }
  sync();
  if (isNew) $("f-nombre").focus();
}

function metaHtml(rec) {
  return `<div class="meta">Creada por <b>${esc(rec.creado_por_correo)}</b> · ${fmt(rec.creado_en)}
    ${rec.modificado_en ? `<br>Última edición: <b>${esc(rec.modificado_por_correo)}</b> · ${fmt(rec.modificado_en)}` : ""}
    ${rec.eliminado ? `<br>Eliminada por <b>${esc(rec.eliminado_por_correo)}</b> · ${fmt(rec.eliminado_en)}` : ""}</div>`;
}

async function save() {
  if (busy) return;
  const p = $("panel");
  const vals = {
    nombre: $("f-nombre").value.trim(),
    tipos: [...p.querySelectorAll("#f-tipos input:checked")].map(i => i.value),
    tipo_otro: $("f-tipo-otro").value.trim(),
    titularidad: $("f-tit").value,
    titularidad_otro: $("f-tit-otro").value.trim(),
    descripcion: $("f-desc").value.trim()
  };
  const errs = [];
  if (!vals.nombre) errs.push("Escriba el nombre de la instalación.");
  if (!vals.tipos.length) errs.push("Marque al menos un tipo de instalación.");
  if (vals.tipos.includes("Otro") && !vals.tipo_otro) errs.push("Especifique el tipo en el campo «Especifique el tipo».");
  if (vals.tipos.includes("Polideportivo") && vals.tipos.filter(t => t !== "Polideportivo").length === 0) errs.push("Un polideportivo necesita al menos otro tipo marcado: las instalaciones que contiene.");
  if (!vals.titularidad) errs.push("Seleccione la titularidad.");
  if (vals.titularidad === "Otro" && !vals.titularidad_otro) errs.push("Especifique la titularidad en el campo «Especifique la titularidad».");
  const errBox = $("f-err");
  if (errs.length) { errBox.innerHTML = errs.map(esc).join("<br>"); errBox.hidden = false; return; }
  errBox.hidden = true;
  const row = {
    nombre: vals.nombre, tipos: vals.tipos,
    tipo_otro: vals.tipos.includes("Otro") ? vals.tipo_otro : null,
    titularidad: vals.titularidad,
    titularidad_otro: vals.titularidad === "Otro" ? vals.titularidad_otro : null,
    descripcion: vals.descripcion || null,
  };
  const isNew = !draft.id;
  busy = true; setBusy($("f-save"), true, "Guardando…");
  const q = isNew
    ? sb.from("instalaciones").insert({ ...row, municipio_id: draft.municipio_id, geom: ewkt(draft.latlng) })
    : sb.from("instalaciones").update(row).eq("id", draft.id);
  const { data, error } = await q.select(COLS).single();
  busy = false;
  if (error) {
    setBusy($("f-save"), false, "Guardar");
    errBox.textContent = mensajeError(error); errBox.hidden = false;
    return;
  }
  replaceRec(data);
  cancelAll();
  toast(isNew ? "Instalación guardada." : "Cambios guardados.");
}

/* ---------- administración ---------- */
$("toggle-deleted").addEventListener("click", () => {
  showDeleted = !showDeleted;
  $("toggle-deleted").setAttribute("aria-pressed", String(showDeleted));
  $("toggle-deleted").textContent = showDeleted ? "Ocultar eliminados" : "Mostrar eliminados";
  renderPoints();
});

$("export").addEventListener("click", async () => {
  const btn = $("export");
  setBusy(btn, true, "Exportando…");
  try {
    recs = await todas(() => sb.from("instalaciones").select(COLS).order("creado_en"));   // datos al día
    renderPoints();
  } catch (e) {
    setBusy(btn, false, "Exportar GeoJSON");
    return toast(mensajeError(e));
  }
  setBusy(btn, false, "Exportar GeoJSON");
  const scope = $("export-scope").value;
  const sel = recs.filter(r => scope === "todos" || !r.eliminado);
  const fc = { type: "FeatureCollection", features: sel.map(r => ({
    type: "Feature", geometry: { type: "Point", coordinates: [r.lng, r.lat] },
    properties: {
      id: r.id, nombre: r.nombre,
      tipos: r.tipos.join("; "),           // texto: «;» porque un tipo contiene una coma
      tipo_otro: r.tipo_otro, titularidad: r.titularidad, titularidad_otro: r.titularidad_otro,
      descripcion: r.descripcion, municipio_id: r.municipio_id,
      municipio: muniById(r.municipio_id)?.properties.nombre || null,
      lat: r.lat, lng: r.lng,
      creado_por: r.creado_por_correo, creado_en: r.creado_en,
      modificado_por: r.modificado_por_correo, modificado_en: r.modificado_en,
      eliminado: r.eliminado, eliminado_por: r.eliminado_por_correo, eliminado_en: r.eliminado_en,
    }
  })) };
  const blob = new Blob([JSON.stringify(fc, null, 2)], { type: "application/geo+json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `instalaciones_scorp_${scope}_${new Date().toISOString().slice(0, 10)}.geojson`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`${sel.length} ${sel.length === 1 ? "punto exportado" : "puntos exportados"}.`);
});

/* ---------- interfaz ---------- */
function setBusy(btn, on, label) {
  if (!btn) return;
  btn.setAttribute("aria-busy", on ? "true" : "false");
  btn.textContent = label;
}
function showBanner(text, actions) {
  const b = $("banner");
  b.innerHTML = `<span>${esc(text)}</span>`;
  actions.forEach(([label, fn, primary]) => { const btn = document.createElement("button"); btn.className = "btn" + (primary ? " primary" : ""); btn.textContent = label; btn.onclick = fn; b.appendChild(btn); });
  b.hidden = false;
  map && map.invalidateSize();
}
function hideBanner() { $("banner").hidden = true; map && map.invalidateSize(); }
let toastTimer;
function toast(msg) {
  const t = $("toast");
  if ($("app").hidden) { const e = $("login-err"); e.textContent = msg; e.hidden = false; return; }
  t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 4000);
}
document.addEventListener("keydown", e => { if (e.key === "Escape" && mode !== "idle") cancelAll(); });

/* ---------- ayuda ---------- */
let helpReturn = null;
function openHelp(e) { helpReturn = e && e.currentTarget; $("help").hidden = false; $("help-close").focus(); }
function closeHelp() { $("help").hidden = true; if (helpReturn) helpReturn.focus(); }
document.querySelectorAll("[data-open-help]").forEach(b => b.addEventListener("click", openHelp));
$("help-close").addEventListener("click", closeHelp);
$("help").addEventListener("click", e => { if (e.target === $("help")) closeHelp(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("help").hidden) { e.stopImmediatePropagation(); closeHelp(); } }, true);

/* ---------- sesión guardada ---------- */
sb.auth.getSession().then(({ data }) => { if (data.session) entrar(); });
