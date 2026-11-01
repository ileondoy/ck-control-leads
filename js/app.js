/* Clínica Kawoq · Control de Leads
   Las reglas de la cadencia (días 1, 3, 7 y 30, domingos, días no hábiles,
   tope de 3 contactos y "No contactar") viven en la base de datos de Supabase,
   para que la app y Lía calculen exactamente igual. */
(function () {
  'use strict';

  const CFG = window.CK_CONFIG;
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

  const ESTADOS_CERRADOS = ['Agendó', 'Cerrado con motivo', 'No contactar', 'Recurrente'];
  const ESTADOS_CADENCIA = ['Nuevo', 'Contacto 1', 'Contacto 2', 'Contacto 3', 'Recordatorio día 30'];
  const ESTADOS_RESULTADO = ['Respondió', 'Quiere agendar', 'Agendó', 'Lista de espera', 'Prioritario', 'Cerrado con motivo'];
  const MOTIVOS = ['Dinero por ahora', 'Sin dinero', 'No le interesa', 'Ubicación'];
  const GUIAS = {
    'Síndrome del túnel carpal': 'Síndrome del túnel carpal',
    'Neuropatía diabética': 'Neuropatía diabética',
    'Dolor de hombro': 'Dolor de hombro'
  };
  const OFFSET_CR = -6; // Costa Rica no cambia de horario

  const estado = {
    personas: [],
    dias: new Set(),
    tab: 'hoy',
    foco: null,          // contador seleccionado en Hoy toca
    busqueda: '',
    filtros: { estado: '', motivo: '', servicio: '', desde: '' },
    editando: null,      // persona en edición
    abierta: null        // persona en la hoja Resultado
  };

  /* ================= Utilidades ================= */
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function enCR(fecha) { // Date "corrida" a hora de Costa Rica (leer con getUTC*)
    return new Date(fecha.getTime() + OFFSET_CR * 3600 * 1000);
  }
  function hoyCR() { return enCR(new Date()).toISOString().slice(0, 10); }
  function fmtDia(iso) { // 'YYYY-MM-DD' → 'dd/mm'
    if (!iso) return '';
    const [, m, d] = iso.slice(0, 10).split('-');
    return `${d}/${m}`;
  }
  function fmtFechaHora(ts) {
    if (!ts) return '';
    const c = enCR(new Date(ts));
    const d = String(c.getUTCDate()).padStart(2, '0');
    const m = String(c.getUTCMonth() + 1).padStart(2, '0');
    let h = c.getUTCHours();
    const min = String(c.getUTCMinutes()).padStart(2, '0');
    const sufijo = h < 12 ? 'a. m.' : 'p. m.';
    h = h % 12 || 12;
    return `${d}/${m} · ${h}:${min} ${sufijo}`;
  }
  function ahoraLocalInput() { // valor para <input type="datetime-local"> en hora CR
    return enCR(new Date()).toISOString().slice(0, 16);
  }
  function inputATimestamp(v) { return v ? `${v}:00-06:00` : null; }
  function timestampAInput(ts) { return ts ? enCR(new Date(ts)).toISOString().slice(0, 16) : ''; }
  function iniciales(p) {
    if (p.codigo) return p.codigo;
    return p.nombre.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0].toUpperCase()).join('');
  }
  function telVisible(t) { return t ? `${t.slice(0, 4)}-${t.slice(4)}` : ''; }

  // Horas de espera de un caso prioritario: solo cuentan las horas del horario
  // de revisión (lun-vie 7:00-20:00, sáb 7:00-18:00); domingos y días no hábiles no cuentan.
  function horasEspera(ts) {
    let t = new Date(ts).getTime();
    const fin = Date.now();
    let horas = 0;
    const paso = 15 * 60 * 1000;
    let guarda = 0;
    while (t < fin && guarda < 20000) {
      const c = enCR(new Date(t));
      const dia = c.getUTCDay();
      const h = c.getUTCHours();
      const iso = c.toISOString().slice(0, 10);
      const habil = dia !== 0 && !estado.dias.has(iso);
      const cierre = dia === 6 ? 18 : 20;
      if (habil && h >= 7 && h < cierre) horas += 0.25;
      t += paso; guarda++;
    }
    return Math.floor(horas);
  }

  function toast(texto, esError = false) {
    const el = $('#toast');
    el.textContent = texto;
    el.classList.toggle('error', esError);
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, esError ? 6000 : 3500);
  }
  function mensajeError(error) {
    const m = (error && (error.message || error.error_description)) || 'Ocurrió un error. Intenta de nuevo.';
    if (/duplicate key|personas_telefono_key/.test(m)) return 'Este teléfono ya está registrado.';
    if (/Failed to fetch|NetworkError/.test(m)) return 'Sin conexión. Revisa el internet e intenta de nuevo.';
    return m;
  }

  /* ================= Sesión ================= */
  function usuarioAEmail(u) {
    u = u.trim().toLowerCase();
    return u.includes('@') ? u : `${u}@${CFG.dominioUsuario}`;
  }

  async function iniciar() {
    const { data } = await sb.auth.getSession();
    if (data.session) mostrarApp(); else mostrarIngreso();
    sb.auth.onAuthStateChange((evento) => {
      if (evento === 'SIGNED_OUT') mostrarIngreso();
    });
  }

  function mostrarIngreso() {
    $('#vista-app').hidden = true;
    $('#vista-ingreso').hidden = false;
    $('#ing-clave').value = '';
    $('#ing-usuario').focus();
  }

  async function mostrarApp() {
    $('#vista-ingreso').hidden = true;
    $('#vista-app').hidden = false;
    $('#aviso-demo').hidden = !CFG.esDemo;
    await cargarDatos();
  }

  $('#form-ingreso').addEventListener('submit', async (e) => {
    e.preventDefault();
    const usuario = $('#ing-usuario').value;
    const clave = $('#ing-clave').value;
    const err = $('#ing-error');
    err.hidden = true;
    if (!usuario.trim() || !clave) {
      err.textContent = 'Escribe tu usuario y tu clave.'; err.hidden = false; return;
    }
    const email = usuarioAEmail(usuario);
    const btn = $('#btn-entrar');
    btn.disabled = true;
    try {
      const { data: minutos } = await sb.rpc('ingreso_bloqueado', { p_usuario: email });
      if (minutos > 0) {
        err.textContent = `Demasiados intentos fallidos. Intenta de nuevo en ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}.`;
        err.hidden = false; return;
      }
      const { error } = await sb.auth.signInWithPassword({ email, password: clave });
      await sb.rpc('registrar_intento', { p_usuario: email, p_exito: !error });
      if (error) {
        err.textContent = 'Usuario o clave incorrectos.'; err.hidden = false; return;
      }
      mostrarApp();
    } catch (ex) {
      err.textContent = mensajeError(ex); err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
  $('#ver-clave').addEventListener('click', () => {
    const i = $('#ing-clave');
    const ver = i.type === 'password';
    i.type = ver ? 'text' : 'password';
    $('#ver-clave').textContent = ver ? 'Ocultar' : 'Ver';
  });
  $('#btn-salir').addEventListener('click', () => sb.auth.signOut());

  /* ================= Datos ================= */
  async function cargarDatos() {
    const [personas, dias] = await Promise.all([
      sb.from('personas').select('*').order('ultimo_mensaje', { ascending: false }),
      sb.from('dias_no_habiles').select('fecha')
    ]);
    if (personas.error) { toast(mensajeError(personas.error), true); return; }
    estado.personas = personas.data || [];
    estado.dias = new Set((dias.data || []).map((d) => d.fecha));
    render();
  }

  function seDebeHoy(p) {
    return p.proximo_contacto && p.proximo_contacto <= hoyCR()
      && ESTADOS_CADENCIA.includes(p.estado) && (!p.importado || p.retomar);
  }
  function estaCerrado(p) {
    return ESTADOS_CERRADOS.includes(p.estado)
      || (p.contactos_hechos >= 3 && !p.proximo_contacto && p.estado === 'Contacto 3');
  }
  function coincideBusqueda(p) {
    const q = estado.busqueda.trim().toLowerCase();
    if (!q) return true;
    const soloNum = q.replace(/\D/g, '');
    return p.nombre.toLowerCase().includes(q) || (soloNum && p.telefono.includes(soloNum));
  }

  /* ================= Contadores ================= */
  function renderContadores() {
    const ps = estado.personas;
    const hoy = hoyCR();
    const mes = hoy.slice(0, 7);
    const quieren = ps.filter((p) => p.estado === 'Quiere agendar').length;
    const prior = ps.filter((p) => p.estado === 'Prioritario').length;
    const toca = ps.filter(seDebeHoy).length;
    const agendaronMes = ps.filter((p) => p.estado === 'Agendó'
      && ((p.agendado_en || p.actualizado_en || '').slice(0, 7) === mes)).length;
    const base = ps.filter((p) => p.estado !== 'Recurrente').length;
    const agendaron = ps.filter((p) => p.estado === 'Agendó').length;
    const conv = base ? (agendaron / base) * 100 : 0;
    const convTxt = conv.toFixed(1).replace('.', ',');
    const ancho = Math.min(100, (conv / CFG.metaConversion) * 100);
    const c = (id, clase, num, txt, extra = '') =>
      `<button class="contador ${clase} ${estado.foco === id ? 'activo' : ''}" data-foco="${id}"><b>${num}</b><span>${txt}</span>${extra}</button>`;
    $('#contadores').innerHTML =
      c('quiere', 'morado', quieren, 'Quieren agendar') +
      c('prioritario', '', prior, 'Prioritarios') +
      c('toca', 'verde', toca, 'Toca hoy') +
      c('agendaron', '', agendaronMes, 'Agendaron este mes') +
      `<div class="contador" title="Personas que agendaron sobre el total de interesadas"><b>${convTxt} %</b><span>Conversión · meta ${CFG.metaConversion} %</span><div class="barra"><i style="width:${ancho}%"></i></div></div>`;
  }

  /* ================= Fichas ================= */
  function lineaToca(p) {
    if (!p.proximo_contacto || !p.proximo_tipo) return '';
    const hoy = hoyCR();
    if (p.proximo_contacto < hoy) return `<span class="atrasado">Atrasado · debía salir el ${fmtDia(p.proximo_contacto)}</span>`;
    if (p.proximo_contacto === hoy) return `<span class="toca">${esc(p.proximo_tipo)} · hoy</span>`;
    return `<span class="toca">${esc(p.proximo_tipo)} · ${fmtDia(p.proximo_contacto)}</span>`;
  }
  function chipEstado(p) {
    const clase = p.estado === 'Quiere agendar' ? 'morado'
      : p.estado === 'Prioritario' || p.estado === 'Agendó' ? 'verde'
      : p.estado === 'No contactar' ? 'rojo'
      : ESTADOS_CERRADOS.includes(p.estado) ? 'gris' : '';
    return `<span class="chip ${clase}">${esc(p.estado)}</span>`;
  }

  function ficha(p, opciones = {}) {
    const compacta = opciones.compacta;
    const clase = p.estado === 'Quiere agendar' ? 'quiere' : p.estado === 'Prioritario' ? 'prioritario'
      : estaCerrado(p) ? 'apagada' : '';
    const etiquetas = [chipEstado(p)];
    if (p.requiere_doctora || p.estado === 'Prioritario') etiquetas.push('<span class="chip morado">Aprueba la doctora</span>');
    if (p.importado) etiquetas.push('<span class="chip gris">Importado</span>');
    const meta = [];
    if (p.estado === 'Quiere agendar') meta.push('<span class="toca">Espera espacio de la doctora</span>');
    if (p.estado === 'Prioritario') meta.push(`<span class="toca">Esperando ${horasEspera(p.ultimo_mensaje)} h</span>`);
    if (p.estado === 'Agendó' && p.fecha_cita) meta.push(`<span class="toca">Cita: ${fmtFechaHora(p.fecha_cita)}</span>`);
    if (p.motivo_no_agendar) meta.push(`<span>Motivo: ${esc(p.motivo_no_agendar)}</span>`);
    const toca = lineaToca(p);
    if (toca && !compacta) meta.push(toca);
    meta.push(`<span>Último mensaje: ${fmtFechaHora(p.ultimo_mensaje)}</span>`);

    let cuerpo = '';
    if (!compacta) {
      const dia30 = p.proximo_tipo === 'Recordatorio día 30';
      cuerpo += p.borrador_lia
        ? `<div class="borrador"><b>BORRADOR DE LÍA</b><p>${esc(p.borrador_lia)}</p></div>`
        : '<div class="borrador sin"><b>BORRADOR DE LÍA</b><p>Sin borrador</p></div>';
      const noContactar = p.estado === 'No contactar';
      const soloComentario = esSoloComentario(p);
      const textoEnviar = soloComentario ? 'Copiar respuesta' : dia30 ? 'Enviar por correo' : p.borrador_lia ? 'Enviar por WhatsApp' : 'Abrir chat';
      if (soloComentario) cuerpo += '<p class="aviso-comentario">Llegó por un comentario público y no dio permiso: responder en el comentario, sin precio. No escribir por WhatsApp.</p>';
      const debe = seDebeHoy(p);
      cuerpo += `<div class="acciones ${debe ? '' : 'dos'}">
        <button class="btn btn-primario" data-accion="enviar" data-id="${p.id}" ${noContactar ? 'disabled' : ''}>${textoEnviar}</button>
        ${debe ? `<button class="btn btn-contorno" data-accion="hecho" data-id="${p.id}">Contacto hecho</button>` : ''}
        <button class="btn btn-claro" data-accion="resultado" data-id="${p.id}">Resultado</button>
      </div>`;
    }
    const tocarParaAbrir = compacta ? `data-accion="resultado" data-id="${p.id}" role="button" tabindex="0" style="cursor:pointer"` : '';
    return `<article class="ficha ${clase}" ${tocarParaAbrir}>
      <div class="ficha-enc">
        <div class="iniciales">${esc(iniciales(p))}</div>
        <div class="ficha-datos">
          <h3>${esc(p.nombre)} ${etiquetas.join(' ')}</h3>
          <p>${esc(p.servicio === 'Otro' && p.servicio_otro ? p.servicio_otro : p.servicio)} · ${telVisible(p.telefono)}</p>
        </div>
      </div>
      <div class="meta">${meta.join('')}</div>
      ${cuerpo}
    </article>`;
  }

  function grupo(titulo, items, clase = '', opciones) {
    let html = `<h2 class="grupo ${clase}">${esc(titulo)} <span class="cuenta">${items.length}</span></h2>`;
    html += items.length ? items.map((p) => ficha(p, opciones)).join('') : '<p class="vacio">Nadie por ahora.</p>';
    return html;
  }

  /* ================= Pestañas ================= */
  function renderHoy() {
    const ps = estado.personas.filter(coincideBusqueda);
    const quieren = ps.filter((p) => p.estado === 'Quiere agendar');
    const prior = ps.filter((p) => p.estado === 'Prioritario');
    const toca = ps.filter(seDebeHoy).sort((a, b) => a.proximo_contacto.localeCompare(b.proximo_contacto));
    const f = estado.foco;
    let html = '';
    if (!f || f === 'quiere') html += grupo('Quieren agendar', quieren, 'morado');
    if (!f || f === 'prioritario') html += grupo('Prioritarios', prior);
    if (!f || f === 'toca') {
      html += `<h2 class="grupo">Seguimiento del día <span class="cuenta">${toca.length}</span></h2>`;
      if (!toca.length) html += '<p class="vacio">No hay contactos pendientes hoy.</p>';
      ['Contacto 1', 'Contacto 2', 'Contacto 3', 'Recordatorio día 30'].forEach((tipo) => {
        const items = toca.filter((p) => p.proximo_tipo === tipo);
        if (items.length) html += `<h3 class="subgrupo">${tipo} · ${items.length}</h3>` + items.map((p) => ficha(p)).join('');
      });
    }
    if (f === 'agendaron') {
      const mes = hoyCR().slice(0, 7);
      html += grupo('Agendaron este mes', ps.filter((p) => p.estado === 'Agendó'
        && ((p.agendado_en || p.actualizado_en || '').slice(0, 7) === mes)), '', { compacta: true });
    }
    return html;
  }

  function renderFiltros() {
    const ps = estado.personas;
    const opt = (lista, val, todos) => `<option value="">${todos}</option>` +
      lista.map((x) => `<option ${x === val ? 'selected' : ''}>${esc(x)}</option>`).join('');
    const estadosUsados = [...new Set(ps.map((p) => p.estado))].sort();
    const servicios = [...new Set(ps.map((p) => p.servicio))].sort();
    const fl = estado.filtros;
    $('#filtros').innerHTML = `
      <div><label for="fl-estado">Estado</label><select id="fl-estado" data-filtro="estado">${opt(estadosUsados, fl.estado, 'Todos')}</select></div>
      <div><label for="fl-motivo">Motivo para no agendar</label><select id="fl-motivo" data-filtro="motivo">${opt(MOTIVOS, fl.motivo, 'Todos')}</select></div>
      <div><label for="fl-servicio">Servicio</label><select id="fl-servicio" data-filtro="servicio">${opt(servicios, fl.servicio, 'Todos')}</select></div>
      <div><label for="fl-desde">Último mensaje desde</label><input id="fl-desde" type="date" data-filtro="desde" value="${esc(fl.desde)}"></div>
      <p class="resumen-filtro" id="resumen-filtro"></p>`;
  }

  function renderTodos() {
    const fl = estado.filtros;
    const items = estado.personas.filter(coincideBusqueda).filter((p) =>
      (!fl.estado || p.estado === fl.estado) &&
      (!fl.motivo || p.motivo_no_agendar === fl.motivo) &&
      (!fl.servicio || p.servicio === fl.servicio) &&
      (!fl.desde || p.ultimo_mensaje.slice(0, 10) >= fl.desde));
    const porEstado = {};
    items.forEach((p) => { porEstado[p.estado] = (porEstado[p.estado] || 0) + 1; });
    const detalle = Object.entries(porEstado).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e}: ${n}`).join(' · ');
    const resumen = $('#resumen-filtro');
    if (resumen) resumen.textContent = `${items.length} ${items.length === 1 ? 'persona' : 'personas'}${detalle ? ' — ' + detalle : ''}`;
    return items.length ? items.map((p) => ficha(p, { compacta: true })).join('') : '<p class="vacio">Ninguna persona coincide con los filtros.</p>';
  }

  function renderCerrados() {
    const items = estado.personas.filter(coincideBusqueda).filter(estaCerrado);
    const html = ['Agendó', 'Cerrado con motivo', 'No contactar', 'Recurrente'].map((e) =>
      grupo(e, items.filter((p) => p.estado === e), '', { compacta: true })).join('');
    const sinResp = items.filter((p) => p.estado === 'Contacto 3');
    return html + grupo('Sin respuesta tras 3 contactos', sinResp, '', { compacta: true });
  }

  function render() {
    renderContadores();
    $$('.pestanas button').forEach((b) => b.classList.toggle('activa', b.dataset.tab === estado.tab));
    $('#filtros').hidden = estado.tab !== 'todos';
    const lista = $('#lista');
    if (estado.tab === 'hoy') lista.innerHTML = renderHoy();
    else if (estado.tab === 'todos') lista.innerHTML = renderTodos();
    else lista.innerHTML = renderCerrados();
  }

  $('.pestanas').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    estado.tab = b.dataset.tab;
    estado.foco = null;
    if (estado.tab === 'todos') renderFiltros();
    render();
  });
  $('#contadores').addEventListener('click', (e) => {
    const b = e.target.closest('[data-foco]');
    if (!b) return;
    estado.tab = 'hoy';
    estado.foco = estado.foco === b.dataset.foco ? null : b.dataset.foco;
    render();
  });
  $('#buscar').addEventListener('input', (e) => { estado.busqueda = e.target.value; render(); });
  $('#filtros').addEventListener('change', (e) => {
    const k = e.target.dataset.filtro;
    if (!k) return;
    estado.filtros[k] = e.target.value;
    render();
  });

  /* ================= Acciones de las fichas ================= */
  const porId = (id) => estado.personas.find((p) => p.id === id);

  $('#lista').addEventListener('click', (e) => {
    const b = e.target.closest('[data-accion]');
    if (!b || b.disabled) return;
    const p = porId(b.dataset.id);
    if (!p) return;
    if (b.dataset.accion === 'enviar') enviar(p, b);
    else if (b.dataset.accion === 'hecho') registrarContacto(p, p.proximo_tipo === 'Recordatorio día 30' ? 'Correo' : 'WhatsApp', b);
    else if (b.dataset.accion === 'resultado') abrirResultado(p);
  });
  $('#lista').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('article[data-accion]')) e.target.click();
  });

  // Llegó por un comentario público y no aceptó recibir información:
  // se le responde en el comentario, nunca por WhatsApp (hallazgo de Lía, 30/10).
  function esSoloComentario(p) {
    return p.origen === 'Comentario público' && !p.acepta_info && p.proximo_tipo !== 'Recordatorio día 30';
  }

  async function copiarRespuesta(p, boton) {
    const texto = p.borrador_lia || '';
    if (!texto) { toast('Todavía no hay borrador para responder el comentario.', true); return; }
    try {
      await navigator.clipboard.writeText(texto);
      toast('Respuesta copiada. Pégala en el comentario y luego marca "Contacto hecho".');
    } catch (e) {
      window.prompt('Copia la respuesta para el comentario:', texto);
    }
  }

  function enviar(p, boton) {
    if (p.estado === 'No contactar') { toast('Esta persona pidió no ser contactada.', true); return; }
    if (esSoloComentario(p)) { copiarRespuesta(p, boton); return; }
    const texto = p.borrador_lia || '';
    if (p.origen === 'Comentario público' && /precio|₡|colones|costo|cuesta/i.test(texto)) {
      if (!confirm('Esta persona llegó por un comentario público. Los precios solo se dan por mensaje privado. ¿Enviar de todas formas?')) return;
    }
    const dia30 = p.proximo_tipo === 'Recordatorio día 30';
    if (dia30) {
      if (!p.correo) { toast('Falta el correo de esta persona. Agrégalo en Editar datos.', true); return; }
      const url = `mailto:${encodeURIComponent(p.correo)}?subject=${encodeURIComponent('Clínica Kawoq · Dra. Cindy Laines')}&body=${encodeURIComponent(texto)}`;
      window.open(url, '_blank');
    } else {
      const url = `https://wa.me/506${p.telefono}${texto ? '?text=' + encodeURIComponent(texto) : ''}`;
      window.open(url, '_blank', 'noopener');
    }
    if (seDebeHoy(p)) registrarContacto(p, dia30 ? 'Correo' : 'WhatsApp', boton);
  }

  async function registrarContacto(p, canal, boton) {
    if (boton) boton.disabled = true;
    const { data, error } = await sb.rpc('registrar_contacto', { p_persona: p.id, p_canal: canal });
    if (error) { toast(mensajeError(error), true); if (boton) boton.disabled = false; return; }
    const sig = data && data.proximo_contacto
      ? `próximo contacto: ${fmtDia(data.proximo_contacto)}`
      : 'sin más contactos programados';
    toast(`Guardado · ${sig}`);
    await cargarDatos();
  }

  /* ================= Pantalla 2 · Nuevo lead / Editar ================= */
  const dlgLead = $('#dlg-lead');
  const seleccion = {};

  function marcarOpcion(grupo, valor) {
    seleccion[grupo] = valor;
    $$(`[data-grupo="${grupo}"] button`).forEach((b) => b.classList.toggle('sel', b.dataset.valor === valor));
    if (grupo === 'servicio') $('#f-servicio-otro').hidden = valor !== 'Otro';
  }
  $$('#form-lead .opciones').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-valor]');
    if (!b) return;
    const grupo = g.dataset.grupo;
    marcarOpcion(grupo, seleccion[grupo] === b.dataset.valor && grupo === 'origen' ? null : b.dataset.valor);
  }));

  function limpiarErrores() {
    $$('#form-lead .err').forEach((e) => { e.textContent = ''; });
    $$('#form-lead input').forEach((i) => i.classList.remove('invalido'));
    $('#lead-error').hidden = true;
  }
  // Si falta algo, lleva la vista al primer campo con error y avisa junto a Guardar
  function avisarFaltantes() {
    const errs = $$('#form-lead .err').filter((e) => e.textContent);
    const nombres = { nombre: 'nombre', telefono: 'teléfono', ultimo: 'fecha y hora', canal: 'canal de contacto', servicio: 'servicio', correo: 'correo' };
    const faltan = errs.map((e) => nombres[e.dataset.err] || e.dataset.err);
    $('#lead-error').textContent = `Falta completar: ${faltan.join(', ')}.`;
    $('#lead-error').hidden = false;
    if (errs[0]) errs[0].closest('fieldset').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function errorCampo(clave, texto, input) {
    const e = $(`#form-lead [data-err="${clave}"]`);
    if (e) e.textContent = texto;
    if (input) input.classList.add('invalido');
  }

  function abrirLead(p = null) {
    estado.editando = p;
    limpiarErrores();
    $('#lead-titulo').textContent = p ? 'Editar datos' : 'Nuevo lead';
    $('#bloque-estado-inicial').hidden = !!p;
    $('#f-nombre').value = p ? p.nombre : '';
    $('#f-telefono').value = p ? telVisible(p.telefono) : '';
    $('#f-ultimo').value = p ? timestampAInput(p.ultimo_mensaje) : ahoraLocalInput();
    $('#f-servicio-otro').value = p ? (p.servicio_otro || '') : '';
    $('#f-atendido').checked = p ? p.ya_atendido : false;
    $('#f-referencia').checked = p ? p.referencia_previa : false;
    $('#f-info').checked = p ? p.acepta_info : false;
    $('#f-newsletter').checked = p ? p.acepta_newsletter : false;
    $('#f-correo').value = p ? (p.correo || '') : '';
    $('#f-nota').value = p ? (p.nota || '') : '';
    marcarOpcion('canal', p ? p.canal : null);
    marcarOpcion('origen', p ? p.origen : 'Mensaje privado');
    marcarOpcion('servicio', p ? p.servicio : null);
    marcarOpcion('estadoInicial', 'Nuevo');
    dlgLead.showModal();
    $('#f-nombre').focus();
  }
  $('#btn-nuevo').addEventListener('click', () => abrirLead());
  $$('dialog [data-cerrar]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  $('#form-lead').addEventListener('submit', async (e) => {
    e.preventDefault();
    limpiarErrores();
    const p = estado.editando;
    const nombre = $('#f-nombre').value.trim();
    const tel = $('#f-telefono').value.replace(/\D/g, '');
    const ultimo = $('#f-ultimo').value;
    const correo = $('#f-correo').value.trim();
    let ok = true;
    if (!nombre) { errorCampo('nombre', 'Escribe el nombre.', $('#f-nombre')); ok = false; }
    if (tel.length !== 8) { errorCampo('telefono', 'El teléfono debe tener 8 dígitos.', $('#f-telefono')); ok = false; }
    if (!ultimo) { errorCampo('ultimo', 'Indica la fecha y hora del último mensaje.', $('#f-ultimo')); ok = false; }
    else if (new Date(inputATimestamp(ultimo)) > new Date(Date.now() + 5 * 60000)) { errorCampo('ultimo', 'La fecha no puede estar en el futuro.', $('#f-ultimo')); ok = false; }
    if (!seleccion.canal) { errorCampo('canal', 'Elige el canal.'); ok = false; }
    if (!seleccion.servicio) { errorCampo('servicio', 'Elige el servicio de interés.'); ok = false; }
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) { errorCampo('correo', 'Revisa el correo.', $('#f-correo')); ok = false; }
    if (!ok) { avisarFaltantes(); return; }

    // Teléfono repetido (incluye a quienes pidieron no ser contactados)
    if (tel.length === 8) {
      const { data: dup } = await sb.from('personas').select('id,nombre,estado').eq('telefono', tel).maybeSingle();
      if (dup && (!p || dup.id !== p.id)) {
        const extra = dup.estado === 'No contactar' ? ' (pidió no ser contactada)' : '';
        errorCampo('telefono', `Este teléfono ya está registrado: ${dup.nombre}${extra}.`, $('#f-telefono'));
        return;
      }
    }

    const ahora = new Date().toISOString();
    const datos = {
      nombre, telefono: tel, canal: seleccion.canal, origen: seleccion.origen || null,
      servicio: seleccion.servicio, servicio_otro: seleccion.servicio === 'Otro' ? $('#f-servicio-otro').value.trim() || null : null,
      ultimo_mensaje: inputATimestamp(ultimo),
      ya_atendido: $('#f-atendido').checked, referencia_previa: $('#f-referencia').checked,
      acepta_info: $('#f-info').checked, acepta_newsletter: $('#f-newsletter').checked,
      correo: correo || null, nota: $('#f-nota').value.trim() || null
    };
    if (!p || (datos.acepta_info && !p.acepta_info)) datos.acepta_info_fecha = datos.acepta_info ? ahora : null;
    if (!p || (datos.acepta_newsletter && !p.acepta_newsletter)) datos.acepta_newsletter_fecha = datos.acepta_newsletter ? ahora : null;

    const btn = $('#btn-guardar-lead');
    btn.disabled = true;
    let res;
    if (p) {
      if (datos.ya_atendido && !p.ya_atendido) { datos.estado = 'Recurrente'; datos.proximo_contacto = null; datos.proximo_tipo = null; }
      if (datos.ultimo_mensaje === p.ultimo_mensaje || timestampAInput(p.ultimo_mensaje) === ultimo) delete datos.ultimo_mensaje;
      res = await sb.from('personas').update(datos).eq('id', p.id).select().single();
    } else {
      datos.estado = datos.ya_atendido ? 'Recurrente' : seleccion.estadoInicial || 'Nuevo';
      if (datos.estado === 'Prioritario') datos.requiere_doctora = true;
      res = await sb.from('personas').insert(datos).select().single();
    }
    btn.disabled = false;
    if (res.error) { $('#lead-error').textContent = mensajeError(res.error); $('#lead-error').hidden = false; return; }
    dlgLead.close();
    const r = res.data;
    if (r.estado === 'Recurrente') toast('Guardado · es paciente recurrente: no entra al seguimiento de venta');
    else if (r.proximo_contacto) toast(`Guardado · ${r.proximo_tipo}: ${fmtDia(r.proximo_contacto)}`);
    else toast('Guardado');
    await cargarDatos();
    if (estado.abierta && p) abrirResultado(porId(p.id));
  });

  /* ================= Pantalla 3 · Resultado ================= */
  const dlgRes = $('#dlg-resultado');
  const res = { estado: null, motivo: null };

  async function abrirResultado(p) {
    if (!p) return;
    estado.abierta = p;
    res.estado = ESTADOS_RESULTADO.includes(p.estado) || p.estado === 'No contactar' ? p.estado
      : p.estado === 'Recordatorio día 30' ? 'Cerrado con motivo' : null;
    res.motivo = p.motivo_no_agendar;
    $('#res-error').hidden = true;
    const bloqueado = ['Recurrente'].includes(p.estado);
    const guia = GUIAS[p.servicio];
    const botonesEstado = ESTADOS_RESULTADO.map((e) =>
      `<button type="button" data-estado="${e}" class="${res.estado === e ? 'sel' : ''}">${e}</button>`).join('') +
      `<button type="button" data-estado="No contactar" class="no-contactar ${res.estado === 'No contactar' ? 'sel' : ''}">No contactar</button>`;
    $('#resultado-cuerpo').innerHTML = `
      ${ficha(p, { compacta: true })}
      ${bloqueado ? '<p class="aviso-error">Es paciente recurrente: recibe el MP-02 y no entra al seguimiento de venta.</p>' : ''}
      <div class="aviso-retomar" id="caja-retomar" hidden>
        <p>${p.importado ? 'Contacto anterior importado: no entra solo a Hoy toca.' : 'Esta persona ya salió del seguimiento.'} Si decides volver a escribirle, retómala.</p>
        <button type="button" class="btn btn-contorno btn-bloque" id="btn-retomar-cuerpo">Retomar seguimiento</button>
      </div>
      <div class="bloque">
        <p class="etiqueta" style="margin-top:0">Estado · elige uno</p>
        <div class="opciones" id="res-estados">${botonesEstado}</div>
        <p class="nota-gris" id="nota-no-contactar" ${res.estado === 'No contactar' ? '' : 'hidden'}>No se borra; el sistema no volverá a incluirla.</p>
        <div id="res-agendo" hidden>
          <label for="res-cita">Fecha y hora de la cita *</label>
          <input id="res-cita" type="datetime-local" value="${timestampAInput(p.fecha_cita)}">
        </div>
        <div id="res-cerrado" hidden>
          <p class="etiqueta">Motivo para no agendar *</p>
          <div class="opciones" id="res-motivos">${MOTIVOS.map((m) => `<button type="button" data-motivo="${m}" class="${res.motivo === m ? 'sel' : ''}">${m}</button>`).join('')}</div>
          <label class="interruptor ${guia ? '' : 'apagado'}"><span><b>Acepta la guía gratuita de su dolor</b><small>${guia ? esc(guia) : 'Sin guía para este dolor'}</small></span><input type="checkbox" id="res-guia" ${guia ? '' : 'disabled'} ${p.acepta_guia ? 'checked' : ''}></label>
          <label class="interruptor"><span><b>Acepta newsletter</b><small>Información útil de la clínica por correo</small></span><input type="checkbox" id="res-newsletter" ${p.acepta_newsletter ? 'checked' : ''}></label>
          <label class="interruptor" id="fila-dia30"><span><b>Acepta recordatorio en 30 días</b><small>Solo para "Dinero por ahora"</small></span><input type="checkbox" id="res-dia30" ${p.acepta_dia30 ? 'checked' : ''}></label>
        </div>
      </div>
      <div class="bloque" style="margin-top:14px">
        <p class="etiqueta" style="margin-top:0">Historial de contactos</p>
        <ul class="historial" id="res-historial"><li>Cargando…</li></ul>
      </div>
      <label for="res-nota">Nota</label>
      <textarea id="res-nota" rows="3" placeholder="Detalles o acuerdos con la persona…">${esc(p.nota || '')}</textarea>`;
    $$('#res-estados button').forEach((b) => { b.disabled = bloqueado; });
    $('#btn-guardar-resultado').disabled = bloqueado;
    const retomable = !['No contactar', 'Recurrente', 'Agendó'].includes(p.estado)
      && ((p.importado && !p.retomar) || estaCerrado(p));
    $('#btn-retomar').hidden = true;
    $('#caja-retomar').hidden = !retomable;
    actualizarSecciones();
    dlgRes.showModal();
    cargarHistorial(p.id);
  }

  function actualizarSecciones() {
    $('#res-agendo').hidden = res.estado !== 'Agendó';
    $('#res-cerrado').hidden = res.estado !== 'Cerrado con motivo';
    $('#nota-no-contactar').hidden = res.estado !== 'No contactar';
    const fila = $('#fila-dia30');
    if (fila) {
      const aplica = res.motivo === 'Dinero por ahora';
      fila.classList.toggle('apagado', !aplica);
      $('#res-dia30').disabled = !aplica;
      if (!aplica) $('#res-dia30').checked = false;
    }
  }

  async function cargarHistorial(id) {
    const { data, error } = await sb.from('contactos').select('*').eq('persona_id', id).order('enviado_en', { ascending: false });
    const ul = $('#res-historial');
    if (!ul) return;
    if (error) { ul.innerHTML = `<li>${esc(mensajeError(error))}</li>`; return; }
    ul.innerHTML = data.length ? data.map((c) => `<li><b>${esc(c.tipo)}</b> · ${fmtFechaHora(c.enviado_en)}
      <small>${c.canal_envio ? 'Por ' + esc(c.canal_envio) : ''}${c.enviado_por ? ' · Enviado por ' + esc(c.enviado_por.split('@')[0]) : ''}${c.atrasado ? ' · salió atrasado (debía salir el ' + fmtDia(c.debia_salir) + ')' : ''}</small></li>`).join('')
      : '<li>Todavía no hay contactos registrados.</li>';
  }

  $('#resultado-cuerpo').addEventListener('click', (e) => {
    const be = e.target.closest('[data-estado]');
    if (be && !be.disabled) {
      res.estado = be.dataset.estado;
      $$('#res-estados button').forEach((b) => b.classList.toggle('sel', b === be));
      actualizarSecciones();
      return;
    }
    const bm = e.target.closest('[data-motivo]');
    if (bm) {
      res.motivo = bm.dataset.motivo;
      $$('#res-motivos button').forEach((b) => b.classList.toggle('sel', b === bm));
      actualizarSecciones();
    }
  });

  $('#btn-guardar-resultado').addEventListener('click', async () => {
    const p = estado.abierta;
    const err = $('#res-error');
    err.hidden = true;
    if (!res.estado) { err.textContent = 'Elige un estado.'; err.hidden = false; return; }
    if (res.estado === 'Agendó' && !$('#res-cita').value) { err.textContent = 'Indica la fecha y hora de la cita.'; err.hidden = false; return; }
    if (res.estado === 'Cerrado con motivo' && !res.motivo) { err.textContent = 'Elige el motivo para no agendar.'; err.hidden = false; return; }
    if (res.estado === 'No contactar' && p.estado !== 'No contactar'
      && !confirm('¿Marcar como "No contactar"? No se borra, pero el sistema no volverá a incluirla.')) return;
    const btn = $('#btn-guardar-resultado');
    btn.disabled = true;
    const { error } = await sb.rpc('guardar_resultado', {
      p_persona: p.id,
      p_estado: res.estado,
      p_motivo: res.estado === 'Cerrado con motivo' ? res.motivo : null,
      p_fecha_cita: res.estado === 'Agendó' ? inputATimestamp($('#res-cita').value) : null,
      p_guia: !!($('#res-guia') && $('#res-guia').checked),
      p_newsletter: !!($('#res-newsletter') && $('#res-newsletter').checked),
      p_dia30: !!($('#res-dia30') && $('#res-dia30').checked),
      p_nota: $('#res-nota').value
    });
    btn.disabled = false;
    if (error) { err.textContent = mensajeError(error); err.hidden = false; return; }
    dlgRes.close();
    toast('Resultado guardado');
    await cargarDatos();
  });

  $('#btn-editar').addEventListener('click', () => { dlgRes.close(); abrirLead(estado.abierta); });
  $('#resultado-cuerpo').addEventListener('click', (e) => {
    if (e.target.closest('#btn-retomar-cuerpo')) $('#btn-retomar').click();
  });
  $('#btn-retomar').addEventListener('click', async () => {
    const p = estado.abierta;
    if (!confirm(`¿Retomar el seguimiento de ${p.nombre}? Aparecerá hoy en "Hoy toca".`)) return;
    const { error } = await sb.rpc('retomar', { p_persona: p.id });
    if (error) { $('#res-error').textContent = mensajeError(error); $('#res-error').hidden = false; return; }
    dlgRes.close();
    toast('Retomado · aparece en Hoy toca');
    await cargarDatos();
  });
  dlgRes.addEventListener('close', () => { estado.abierta = null; });

  iniciar();
})();
