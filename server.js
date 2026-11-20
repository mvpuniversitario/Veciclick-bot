// ============================================================
//  VeciClick Bot — chat automatizado de pedidos por WhatsApp
//  + panel del tendero + simulador de respaldo
//  Sin dependencias: solo necesita Node.js 18 o superior.
// ============================================================

const http = require("http");
const fs = require("fs");
const path = require("path");
const CATALOGO = require("./productos");

// ---------- Configuración (se llena en Render → Environment) ----------
const CONFIG = {
  token: (process.env.WHATSAPP_TOKEN || "").trim(),
  phoneNumberId: (process.env.PHONE_NUMBER_ID || "").trim(),
  verifyToken: (process.env.VERIFY_TOKEN || "veciclick2026").trim(),
  graphVersion: (process.env.GRAPH_VERSION || "v23.0").trim(),
  graphBase: (process.env.GRAPH_BASE || "https://graph.facebook.com").trim(),
  tienda: (process.env.NOMBRE_TIENDA || "Tienda Doña Rosa").trim(),
  nequi: (process.env.NUMERO_NEQUI || "300 123 4567").trim(),
  port: process.env.PORT || 3000,
};

// ---------- Datos en memoria (se borran si el servidor se reinicia) ----------
const conversaciones = new Map(); // telefono -> { paso, carrito, productoPendiente, entrega, direccion, nombre }
const pedidos = [];               // lista de pedidos
const avisos = [];                // clientes que pidieron hablar con la tienda
const simBuzon = new Map();       // mensajes del simulador por usuario
const diagnostico = { ultimoWebhook: null, ultimoEnvioOk: null, ultimoError: null, mensajesRecibidos: 0, mensajesEnviados: 0 };
let consecutivo = 100;

const PRODUCTOS = {};
CATALOGO.forEach((s) => s.productos.forEach((p) => (PRODUCTOS[p.id] = p)));

const pesos = (n) => "$" + Math.round(n).toLocaleString("es-CO").replace(/,/g, ".");
const ahora = () => new Date().toISOString();

// ============================================================
//  ENVÍO DE MENSAJES
// ============================================================
async function enviar(para, mensaje) {
  // Simulador: no usa WhatsApp, guarda el mensaje para mostrarlo en la página
  if (para.startsWith("sim")) {
    if (!simBuzon.has(para)) simBuzon.set(para, []);
    simBuzon.get(para).push({ ...mensaje, hora: ahora() });
    return;
  }
  if (!CONFIG.token || !CONFIG.phoneNumberId) {
    diagnostico.ultimoError = { hora: ahora(), detalle: "Falta WHATSAPP_TOKEN o PHONE_NUMBER_ID en las variables de entorno" };
    console.error(diagnostico.ultimoError.detalle);
    return;
  }
  const url = `${CONFIG.graphBase}/${CONFIG.graphVersion}/${CONFIG.phoneNumberId}/messages`;
  const cuerpo = { messaging_product: "whatsapp", recipient_type: "individual", to: para, ...mensaje };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${CONFIG.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
    });
    const datos = await r.json().catch(() => ({}));
    if (!r.ok) {
      diagnostico.ultimoError = { hora: ahora(), para, detalle: datos.error || datos };
      console.error("Error de WhatsApp:", JSON.stringify(datos));
    } else {
      diagnostico.mensajesEnviados++;
      diagnostico.ultimoEnvioOk = ahora();
    }
  } catch (e) {
    diagnostico.ultimoError = { hora: ahora(), para, detalle: String(e) };
    console.error("Error de red:", e);
  }
}

const texto = (t) => ({ type: "text", text: { body: t, preview_url: false } });

const botones = (cuerpo, lista) => ({
  type: "interactive",
  interactive: {
    type: "button",
    body: { text: cuerpo },
    action: { buttons: lista.map(([id, titulo]) => ({ type: "reply", reply: { id, title: titulo.slice(0, 20) } })) },
  },
});

const listaProductos = () => ({
  type: "interactive",
  interactive: {
    type: "list",
    header: { type: "text", text: `🛒 ${CONFIG.tienda}`.slice(0, 60) },
    body: { text: "Toca *Ver productos* y elige lo que necesitas. Te vamos sumando el total automáticamente." },
    footer: { text: "VeciClick · pedidos sin esperas" },
    action: {
      button: "Ver productos",
      sections: CATALOGO.map((s) => ({
        title: s.seccion.slice(0, 24),
        rows: s.productos.map((p) => ({
          id: p.id,
          title: p.nombre.slice(0, 24),
          description: `${pesos(p.precio)} · ${p.detalle}`.slice(0, 72),
        })),
      })),
    },
  },
});

// ============================================================
//  LÓGICA DEL CHAT (la "conversación" de VeciClick)
// ============================================================
function estadoDe(tel, nombre) {
  if (!conversaciones.has(tel)) conversaciones.set(tel, { paso: "inicio", carrito: [], nombre: nombre || "" });
  const c = conversaciones.get(tel);
  if (nombre) c.nombre = nombre;
  return c;
}

const totalCarrito = (carrito) => carrito.reduce((s, i) => s + i.precio * i.cantidad, 0);
const textoCarrito = (carrito) =>
  carrito.map((i) => `• ${i.cantidad} x ${i.nombre} — ${pesos(i.precio * i.cantidad)}`).join("\n");

async function bienvenida(tel, c) {
  const saludo = c.nombre ? `¡Hola, ${c.nombre.split(" ")[0]}! 👋` : "¡Hola! 👋";
  await enviar(tel, botones(
    `${saludo} Soy el asistente automático de *${CONFIG.tienda}*.\n\nHaz tu pedido aquí mismo, sin salir del chat: eliges tus productos, te damos el total al instante y escoges cómo pagar.`,
    [["PEDIR", "🛒 Hacer pedido"], ["TENDERO", "💬 Hablar con tienda"]]
  ));
}

async function mostrarCarrito(tel, c, encabezado) {
  await enviar(tel, botones(
    `${encabezado}\n\n*Tu pedido:*\n${textoCarrito(c.carrito)}\n\n*Total: ${pesos(totalCarrito(c.carrito))}*`,
    [["AGREGAR", "➕ Agregar más"], ["FINALIZAR", "✅ Finalizar pedido"], ["VACIAR", "🗑️ Vaciar carrito"]]
  ));
}

async function pedirPago(tel, c) {
  c.paso = "pago";
  await enviar(tel, botones(
    `¿Cómo quieres pagar tu pedido de *${pesos(totalCarrito(c.carrito))}*?`,
    [["PAGO_EFECTIVO", "💵 Efectivo"], ["PAGO_NEQUI", "📱 Nequi"], ["PAGO_TRANSF", "🏦 Transferencia"]]
  ));
}

async function crearPedido(tel, c, metodo) {
  const pedido = {
    id: ++consecutivo,
    telefono: tel,
    cliente: c.nombre || "Cliente",
    items: c.carrito.map((i) => ({ ...i })),
    total: totalCarrito(c.carrito),
    entrega: c.entrega,
    direccion: c.direccion || "",
    pago: metodo,
    comprobante: false,
    estado: "nuevo",
    creado: ahora(),
  };
  pedidos.unshift(pedido);
  c.carrito = [];
  c.paso = "esperando";
  c.ultimoPedido = pedido.id;

  let extraPago = "";
  if (metodo === "Nequi") extraPago = `\n\n📱 Envía el pago al Nequi *${CONFIG.nequi}* y manda la foto del comprobante por este chat.`;
  if (metodo === "Transferencia") extraPago = `\n\n🏦 Transfiere a la cuenta de la tienda (Nequi/Bancolombia *${CONFIG.nequi}*) y manda la foto del comprobante por este chat.`;
  if (metodo === "Efectivo") extraPago = pedido.entrega === "Domicilio" ? "\n\n💵 Pagas en efectivo al recibir." : "\n\n💵 Pagas en efectivo al recoger.";

  await enviar(tel, texto(
    `🧾 *Pedido #${pedido.id} recibido*\n\n${textoCarrito(pedido.items)}\n\n*Total: ${pesos(pedido.total)}*\n` +
    `Entrega: ${pedido.entrega}${pedido.direccion ? " — " + pedido.direccion : ""}\nPago: ${metodo}` +
    extraPago +
    `\n\nYa le llegó a la tienda ✅ Te avisamos por aquí apenas lo confirme.`
  ));
}

async function procesar(tel, entrada, nombre) {
  // entrada = { tipo: "texto" | "id" | "imagen", valor }
  const c = estadoDe(tel, nombre);
  const valor = (entrada.valor || "").trim();
  const minus = valor.toLowerCase();

  // --- Comprobante de pago (foto) ---
  if (entrada.tipo === "imagen") {
    const p = pedidos.find((x) => x.telefono === tel && !x.comprobante && (x.pago === "Nequi" || x.pago === "Transferencia"));
    if (p) {
      p.comprobante = true;
      await enviar(tel, texto(`📎 ¡Recibimos tu comprobante del pedido #${p.id}! La tienda lo va a revisar.`));
    } else {
      await enviar(tel, texto("📎 Recibimos tu imagen. Si es un comprobante, la tienda lo revisará."));
    }
    return;
  }

  // --- Palabras para volver a empezar ---
  if (entrada.tipo === "texto" && ["hola", "menu", "menú", "inicio", "buenas", "buenos dias", "buenos días", "buenas tardes", "buenas noches", "hi", "cancelar"].some((w) => minus === w || minus.startsWith(w + " "))) {
    if (minus.startsWith("cancelar")) { c.carrito = []; }
    c.paso = "inicio";
    return bienvenida(tel, c);
  }

  // --- Botones y opciones de lista ---
  if (entrada.tipo === "id") {
    if (valor === "PEDIR" || valor === "AGREGAR") {
      c.paso = "eligiendo";
      return enviar(tel, listaProductos());
    }
    if (valor === "TENDERO") {
      avisos.unshift({ telefono: tel, cliente: c.nombre || "Cliente", hora: ahora() });
      return enviar(tel, texto(`💬 Listo, le avisamos a *${CONFIG.tienda}*. Te escribirán por este chat en un momento.\n\nSi quieres pedir mientras tanto, escribe *hola*.`));
    }
    if (PRODUCTOS[valor]) {
      c.productoPendiente = valor;
      c.paso = "cantidad";
      const p = PRODUCTOS[valor];
      return enviar(tel, botones(
        `*${p.nombre}* — ${pesos(p.precio)} c/u\n\n¿Cuántas unidades quieres? Toca un botón o escribe el número.`,
        [["Q_1", "1"], ["Q_2", "2"], ["Q_3", "3"]]
      ));
    }
    if (valor.startsWith("Q_") && c.productoPendiente) {
      return agregar(tel, c, parseInt(valor.slice(2), 10));
    }
    if (valor === "VACIAR") {
      c.carrito = [];
      c.paso = "inicio";
      await enviar(tel, texto("🗑️ Vaciamos tu carrito."));
      return bienvenida(tel, c);
    }
    if (valor === "FINALIZAR") {
      if (!c.carrito.length) { c.paso = "eligiendo"; return enviar(tel, listaProductos()); }
      c.paso = "entrega";
      return enviar(tel, botones("¿Cómo quieres recibir tu pedido?", [["DOMICILIO", "🛵 Domicilio"], ["RECOGER", "🏪 Recoger en tienda"]]));
    }
    if (valor === "DOMICILIO") {
      c.entrega = "Domicilio";
      c.paso = "direccion";
      return enviar(tel, texto("🛵 Escribe tu dirección (calle, número y alguna referencia):"));
    }
    if (valor === "RECOGER") {
      c.entrega = "Recoger en tienda";
      c.direccion = "";
      return pedirPago(tel, c);
    }
    if (valor.startsWith("PAGO_")) {
      if (!c.carrito.length) return bienvenida(tel, c);
      const metodo = { PAGO_EFECTIVO: "Efectivo", PAGO_NEQUI: "Nequi", PAGO_TRANSF: "Transferencia" }[valor];
      return crearPedido(tel, c, metodo);
    }
  }

  // --- Texto libre según el paso en que va el cliente ---
  if (entrada.tipo === "texto") {
    if (c.paso === "cantidad" && /^\d{1,2}$/.test(valor) && parseInt(valor, 10) > 0) {
      return agregar(tel, c, parseInt(valor, 10));
    }
    if (c.paso === "direccion" && valor.length >= 4) {
      c.direccion = valor.slice(0, 120);
      return pedirPago(tel, c);
    }
    if (c.paso === "cantidad") return enviar(tel, texto("Escribe solo el número de unidades, por ejemplo *4*."));
    if (c.paso === "direccion") return enviar(tel, texto("Escribe tu dirección completa, por ejemplo *Calle 10 # 5-20, frente al parque*."));
  }

  // --- Cualquier otra cosa ---
  if (c.paso === "inicio" || c.paso === "esperando") return bienvenida(tel, c);
  await enviar(tel, botones("No te entendí 🤔 ¿Qué quieres hacer?", [["PEDIR", "🛒 Ver productos"], ["FINALIZAR", "✅ Finalizar pedido"], ["TENDERO", "💬 Hablar con tienda"]]));
}

async function agregar(tel, c, cantidad) {
  const p = PRODUCTOS[c.productoPendiente];
  if (!p) return bienvenida(tel, c);
  const existente = c.carrito.find((i) => i.id === p.id);
  if (existente) existente.cantidad += cantidad;
  else c.carrito.push({ id: p.id, nombre: p.nombre, precio: p.precio, cantidad });
  c.productoPendiente = null;
  c.paso = "carrito";
  await mostrarCarrito(tel, c, `✅ Agregaste ${cantidad} x ${p.nombre}.`);
}

// ============================================================
//  AVISOS AL CLIENTE CUANDO EL TENDERO CAMBIA EL ESTADO
// ============================================================
const ESTADOS = {
  confirmado: (p) => `✅ *${CONFIG.tienda}* confirmó tu pedido #${p.id}. ¡Ya lo estamos alistando!`,
  en_camino: (p) => p.entrega === "Domicilio"
    ? `🛵 Tu pedido #${p.id} va en camino a ${p.direccion}.`
    : `🏪 Tu pedido #${p.id} está listo. Puedes pasar a recogerlo.`,
  entregado: (p) => `🎉 Pedido #${p.id} entregado. ¡Gracias por comprarle a *${CONFIG.tienda}*! Escribe *hola* cuando quieras volver a pedir.`,
  cancelado: (p) => `❌ Lo sentimos, la tienda no pudo atender tu pedido #${p.id}. Escribe *hola* para intentarlo de nuevo.`,
};

// ============================================================
//  SERVIDOR WEB
// ============================================================
function leerCuerpo(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (ch) => { d += ch; if (d.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
  });
}

function responder(res, codigo, cuerpo, tipo = "application/json") {
  res.writeHead(codigo, { "Content-Type": tipo + "; charset=utf-8", "Cache-Control": "no-store" });
  res.end(typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo));
}

function archivo(res, nombre) {
  fs.readFile(path.join(__dirname, "public", nombre), (err, data) => {
    if (err) return responder(res, 404, "No encontrado", "text/plain");
    responder(res, 200, data.toString(), "text/html");
  });
}

function entradaDesdeMensaje(m) {
  if (m.type === "text") return { tipo: "texto", valor: m.text?.body || "" };
  if (m.type === "interactive") {
    const r = m.interactive?.button_reply || m.interactive?.list_reply;
    return { tipo: "id", valor: r?.id || "" };
  }
  if (m.type === "button") return { tipo: "texto", valor: m.button?.text || "hola" }; // respuesta a plantilla
  if (m.type === "image" || m.type === "document") return { tipo: "imagen", valor: "" };
  return { tipo: "texto", valor: "hola" };
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const ruta = url.pathname.replace(/\/+$/, "") || "/";

  try {
    // ---- Verificación del webhook (Meta la hace una sola vez) ----
    if (req.method === "GET" && ruta === "/webhook") {
      const modo = url.searchParams.get("hub.mode");
      const tok = url.searchParams.get("hub.verify_token");
      const reto = url.searchParams.get("hub.challenge");
      if (modo === "subscribe" && tok === CONFIG.verifyToken) return responder(res, 200, reto || "", "text/plain");
      return responder(res, 403, "Token de verificación incorrecto", "text/plain");
    }

    // ---- Mensajes que llegan de WhatsApp ----
    if (req.method === "POST" && ruta === "/webhook") {
      const body = await leerCuerpo(req);
      responder(res, 200, { ok: true }); // responder rápido a Meta
      diagnostico.ultimoWebhook = ahora();
      diagnostico.ultimosWebhooks = [{ hora: ahora(), contenido: JSON.stringify(body).slice(0, 1200) }, ...(diagnostico.ultimosWebhooks || [])].slice(0, 5);
      console.log("Webhook recibido:", JSON.stringify(body).slice(0, 2000));
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const v = change.value || {};
          const contactos = v.contacts || [];
          for (const m of v.messages || []) {
            diagnostico.mensajesRecibidos++;
            const nombre = contactos.find((k) => k.wa_id === m.from)?.profile?.name || "";
            await procesar(m.from, entradaDesdeMensaje(m), nombre);
          }
        }
      }
      return;
    }

    // ---- Páginas ----
    if (req.method === "GET" && (ruta === "/" || ruta === "/panel")) return archivo(res, "panel.html");
    if (req.method === "GET" && ruta === "/simulador") return archivo(res, "simulador.html");

    // ---- API del panel ----
    if (req.method === "GET" && ruta === "/api/pedidos") {
      return responder(res, 200, { tienda: CONFIG.tienda, pedidos, avisos: avisos.slice(0, 10) });
    }
    const m = ruta.match(/^\/api\/pedidos\/(\d+)\/estado$/);
    if (req.method === "POST" && m) {
      const { estado } = await leerCuerpo(req);
      const p = pedidos.find((x) => x.id === Number(m[1]));
      if (!p || !ESTADOS[estado]) return responder(res, 400, { error: "Pedido o estado inválido" });
      p.estado = estado;
      p.actualizado = ahora();
      await enviar(p.telefono, texto(ESTADOS[estado](p)));
      return responder(res, 200, { ok: true, pedido: p });
    }
    if (req.method === "POST" && ruta === "/api/avisos/limpiar") {
      avisos.length = 0;
      return responder(res, 200, { ok: true });
    }

    // ---- API del simulador ----
    if (req.method === "POST" && ruta === "/api/sim/enviar") {
      const { usuario = "sim-1", nombre = "Cliente demo", tipo = "texto", valor = "" } = await leerCuerpo(req);
      const id = String(usuario).startsWith("sim") ? String(usuario) : "sim-1";
      await procesar(id, { tipo, valor }, nombre);
      const salida = simBuzon.get(id) || [];
      simBuzon.set(id, []);
      return responder(res, 200, { mensajes: salida });
    }
    if (req.method === "GET" && ruta === "/api/sim/nuevos") {
      const id = url.searchParams.get("usuario") || "sim-1";
      const salida = simBuzon.get(id) || [];
      simBuzon.set(id, []);
      return responder(res, 200, { mensajes: salida });
    }

    // ---- Diagnóstico (para revisar si todo está conectado) ----
    if (req.method === "GET" && ruta === "/estado") {
      return responder(res, 200, {
        funcionando: true,
        tienda: CONFIG.tienda,
        token_configurado: CONFIG.token ? `sí (termina en ...${CONFIG.token.slice(-4)})` : "NO",
        phone_number_id_configurado: CONFIG.phoneNumberId ? "sí" : "NO",
        verify_token: CONFIG.verifyToken,
        version_api: CONFIG.graphVersion,
        ...diagnostico,
        pedidos: pedidos.length,
      });
    }

    responder(res, 404, "No encontrado", "text/plain");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) responder(res, 500, { error: String(e) });
  }
});

servidor.listen(CONFIG.port, () => {
  console.log(`VeciClick Bot funcionando en el puerto ${CONFIG.port}`);
  console.log(`Panel: /panel · Simulador: /simulador · Estado: /estado`);
});
