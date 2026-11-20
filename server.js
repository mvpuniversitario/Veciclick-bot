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
  if (PAGINAS[nombre]) return responder(res, 200, PAGINAS[nombre], "text/html");
  responder(res, 404, "No encontrado", "text/plain");
}

// Páginas incluidas dentro de este archivo (por si no están en la carpeta public)
const PAGINAS = {
  "panel.html": "<!DOCTYPE html>\n<html lang=\"es\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>VeciClick · Panel del tendero</title>\n<link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n<link href=\"https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800&display=swap\" rel=\"stylesheet\">\n<style>\n  :root{\n    --azul:#1F3FB8; --azul-osc:#132A80; --naranja:#F7841E; --amarillo:#FFC83D;\n    --crema:#FFF6E6; --texto:#1B1F3B; --gris:#6B6F86; --borde:#EADFC9; --verde:#1E9E62; --rojo:#D64545;\n  }\n  *{box-sizing:border-box}\n  body{margin:0;font-family:Poppins,system-ui,sans-serif;background:var(--crema);color:var(--texto)}\n  header{background:var(--azul);color:#fff;padding:18px 28px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}\n  .logo{font-weight:800;font-size:26px;letter-spacing:-.5px}\n  .logo span{color:var(--amarillo)}\n  .tienda{background:rgba(255,255,255,.14);padding:6px 14px;border-radius:999px;font-size:14px}\n  .vivo{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:13px;opacity:.9}\n  .punto{width:10px;height:10px;border-radius:50%;background:#3EE08F;box-shadow:0 0 0 0 rgba(62,224,143,.7);animation:pulso 1.6s infinite}\n  @keyframes pulso{70%{box-shadow:0 0 0 10px rgba(62,224,143,0)}100%{box-shadow:0 0 0 0 rgba(62,224,143,0)}}\n  main{max-width:1200px;margin:0 auto;padding:24px}\n  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:22px}\n  .kpi{background:#fff;border-radius:18px;padding:18px 20px;border:1px solid var(--borde)}\n  .kpi small{color:var(--gris);font-size:13px}\n  .kpi b{display:block;font-size:30px;font-weight:700;margin-top:4px}\n  .kpi.n b{color:var(--naranja)} .kpi.a b{color:var(--azul)}\n  .avisos{background:var(--amarillo);border-radius:14px;padding:12px 16px;margin-bottom:18px;display:none;align-items:center;gap:12px;font-weight:500}\n  .avisos button{margin-left:auto}\n  h2{font-size:18px;margin:6px 0 14px}\n  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}\n  .card{background:#fff;border-radius:18px;border:1px solid var(--borde);padding:18px;display:flex;flex-direction:column;gap:10px;position:relative;overflow:hidden}\n  .card::before{content:\"\";position:absolute;left:0;top:0;bottom:0;width:6px;background:var(--c,var(--naranja))}\n  .card.nuevo{animation:entra .5s ease}\n  @keyframes entra{from{transform:translateY(-8px);opacity:0}to{transform:none;opacity:1}}\n  .top{display:flex;align-items:center;gap:10px}\n  .num{font-weight:700;font-size:18px}\n  .estado{margin-left:auto;font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;background:#FFE7CF;color:#A2540B}\n  .cliente{font-size:14px;color:var(--gris)}\n  ul{margin:0;padding:0;list-style:none;font-size:14px;border-top:1px dashed var(--borde);border-bottom:1px dashed var(--borde)}\n  li{display:flex;justify-content:space-between;padding:6px 0}\n  .total{display:flex;justify-content:space-between;font-weight:700;font-size:17px}\n  .meta{display:flex;flex-wrap:wrap;gap:6px;font-size:12px}\n  .chip{background:var(--crema);border:1px solid var(--borde);padding:3px 10px;border-radius:999px}\n  .chip.ok{background:#DDF5E9;border-color:#BCE8D2;color:#13714A}\n  .chip.pend{background:#FFF1D6;border-color:#FFD98A;color:#8A5A00}\n  .acciones{display:flex;gap:8px;flex-wrap:wrap}\n  button{font-family:inherit;font-size:13px;font-weight:600;border:0;border-radius:12px;padding:9px 14px;cursor:pointer}\n  .b1{background:var(--azul);color:#fff}.b2{background:var(--naranja);color:#fff}.b3{background:var(--verde);color:#fff}.b4{background:#F1E9DA;color:var(--texto)}\n  button:disabled{opacity:.35;cursor:default}\n  .vacio{background:#fff;border:2px dashed var(--borde);border-radius:18px;padding:40px;text-align:center;color:var(--gris)}\n  .vacio b{display:block;color:var(--texto);font-size:18px;margin-bottom:6px}\n  footer{text-align:center;color:var(--gris);font-size:12px;padding:20px}\n</style>\n</head>\n<body>\n<header>\n  <div class=\"logo\">Veci<span>Click</span></div>\n  <div class=\"tienda\" id=\"tienda\">Panel del tendero</div>\n  <div class=\"vivo\"><div class=\"punto\"></div> Recibiendo pedidos en vivo</div>\n</header>\n<main>\n  <section class=\"kpis\">\n    <div class=\"kpi n\"><small>Pedidos por atender</small><b id=\"kPend\">0</b></div>\n    <div class=\"kpi a\"><small>Pedidos de hoy</small><b id=\"kHoy\">0</b></div>\n    <div class=\"kpi\"><small>Vendido hoy (sin cancelados)</small><b id=\"kVenta\">$0</b></div>\n    <div class=\"kpi\"><small>Comprobantes por revisar</small><b id=\"kComp\">0</b></div>\n  </section>\n  <div class=\"avisos\" id=\"avisos\"></div>\n  <h2>Pedidos</h2>\n  <div class=\"grid\" id=\"lista\"></div>\n</main>\n<footer>VeciClick · el sistema suma, organiza y avisa por ti</footer>\n\n<script>\nconst pesos = n => \"$\" + Math.round(n).toLocaleString(\"es-CO\").replace(/,/g,\".\");\nconst esc = s => String(s ?? \"\").replace(/[&<>\"']/g, c => ({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\"}[c]));\nconst hora = iso => new Date(iso).toLocaleTimeString(\"es-CO\",{hour:\"2-digit\",minute:\"2-digit\"});\nconst ESTADO = {\n  nuevo:{t:\"Nuevo\",c:\"var(--naranja)\",bg:\"#FFE7CF\",fg:\"#A2540B\"},\n  confirmado:{t:\"Confirmado\",c:\"var(--azul)\",bg:\"#DCE4FF\",fg:\"#1F3FB8\"},\n  en_camino:{t:\"En camino / listo\",c:\"var(--amarillo)\",bg:\"#FFF1C2\",fg:\"#7A5B00\"},\n  entregado:{t:\"Entregado\",c:\"var(--verde)\",bg:\"#DDF5E9\",fg:\"#13714A\"},\n  cancelado:{t:\"Cancelado\",c:\"var(--rojo)\",bg:\"#FBE0E0\",fg:\"#A83232\"}\n};\nlet vistos = new Set(), primera = true;\n\nfunction sonar(){\n  try{const a=new (window.AudioContext||window.webkitAudioContext)();const o=a.createOscillator();const g=a.createGain();\n  o.connect(g);g.connect(a.destination);o.frequency.value=880;g.gain.value=.08;o.start();o.stop(a.currentTime+.18);}catch(e){}\n}\n\nasync function cambiar(id, estado){\n  await fetch(`/api/pedidos/${id}/estado`,{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({estado})});\n  cargar();\n}\nasync function limpiarAvisos(){ await fetch(\"/api/avisos/limpiar\",{method:\"POST\"}); cargar(); }\n\nfunction tarjeta(p){\n  const e = ESTADO[p.estado] || ESTADO.nuevo;\n  const fin = p.estado===\"entregado\"||p.estado===\"cancelado\";\n  const comp = (p.pago===\"Nequi\"||p.pago===\"Transferencia\")\n    ? `<span class=\"chip ${p.comprobante?\"ok\":\"pend\"}\">${p.comprobante?\"📎 Comprobante recibido\":\"⏳ Esperando comprobante\"}</span>` : \"\";\n  return `<div class=\"card ${vistos.has(p.id)?\"\":\"nuevo\"}\" style=\"--c:${e.c}\">\n    <div class=\"top\"><div class=\"num\">#${p.id}</div><div class=\"cliente\">${esc(p.cliente)} · ${hora(p.creado)}</div>\n      <div class=\"estado\" style=\"background:${e.bg};color:${e.fg}\">${e.t}</div></div>\n    <ul>${p.items.map(i=>`<li><span>${i.cantidad} × ${esc(i.nombre)}</span><span>${pesos(i.precio*i.cantidad)}</span></li>`).join(\"\")}</ul>\n    <div class=\"total\"><span>Total</span><span>${pesos(p.total)}</span></div>\n    <div class=\"meta\"><span class=\"chip\">${p.entrega===\"Domicilio\"?\"🛵\":\"🏪\"} ${esc(p.entrega)}${p.direccion?\": \"+esc(p.direccion):\"\"}</span>\n      <span class=\"chip\">💳 ${esc(p.pago)}</span>${comp}</div>\n    <div class=\"acciones\">\n      <button class=\"b1\" ${p.estado!==\"nuevo\"?\"disabled\":\"\"} onclick=\"cambiar(${p.id},'confirmado')\">✅ Confirmar</button>\n      <button class=\"b2\" ${p.estado!==\"confirmado\"?\"disabled\":\"\"} onclick=\"cambiar(${p.id},'en_camino')\">${p.entrega===\"Domicilio\"?\"🛵 En camino\":\"🏪 Listo\"}</button>\n      <button class=\"b3\" ${p.estado!==\"en_camino\"?\"disabled\":\"\"} onclick=\"cambiar(${p.id},'entregado')\">✔ Entregado</button>\n      <button class=\"b4\" ${fin?\"disabled\":\"\"} onclick=\"cambiar(${p.id},'cancelado')\">✕</button>\n    </div></div>`;\n}\n\nasync function cargar(){\n  try{\n    const r = await fetch(\"/api/pedidos\"); const d = await r.json();\n    document.getElementById(\"tienda\").textContent = \"Panel de \" + d.tienda;\n    const hoy = new Date().toDateString();\n    const deHoy = d.pedidos.filter(p=>new Date(p.creado).toDateString()===hoy);\n    document.getElementById(\"kPend\").textContent = d.pedidos.filter(p=>p.estado===\"nuevo\").length;\n    document.getElementById(\"kHoy\").textContent = deHoy.length;\n    document.getElementById(\"kVenta\").textContent = pesos(deHoy.filter(p=>p.estado!==\"cancelado\").reduce((s,p)=>s+p.total,0));\n    document.getElementById(\"kComp\").textContent = d.pedidos.filter(p=>p.comprobante && p.estado===\"nuevo\").length;\n    const nuevos = d.pedidos.filter(p=>!vistos.has(p.id));\n    if(!primera && nuevos.length) sonar();\n    document.getElementById(\"lista\").innerHTML = d.pedidos.length ? d.pedidos.map(tarjeta).join(\"\")\n      : `<div class=\"vacio\"><b>Todavía no hay pedidos</b>Cuando un cliente pida por WhatsApp, aparecerá aquí al instante con el total ya calculado.</div>`;\n    d.pedidos.forEach(p=>vistos.add(p.id)); primera=false;\n    const av = document.getElementById(\"avisos\");\n    if(d.avisos.length){ av.style.display=\"flex\";\n      av.innerHTML = `💬 ${d.avisos.map(a=>esc(a.cliente)).join(\", \")} ${d.avisos.length>1?\"quieren\":\"quiere\"} hablar con la tienda por WhatsApp <button class=\"b4\" onclick=\"limpiarAvisos()\">Listo</button>`;\n    } else av.style.display=\"none\";\n  }catch(e){}\n}\ncargar(); setInterval(cargar, 3000);\n</script>\n</body>\n</html>\n",
  "simulador.html": "<!DOCTYPE html>\n<html lang=\"es\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>VeciClick · Simulador del chat</title>\n<link href=\"https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap\" rel=\"stylesheet\">\n<style>\n  :root{--wa:#075E54;--wa2:#128C7E;--burbuja:#DCF8C6;--fondo:#ECE5DD;--azul:#1F3FB8;--naranja:#F7841E;--crema:#FFF6E6}\n  *{box-sizing:border-box}\n  body{margin:0;font-family:Poppins,system-ui,sans-serif;background:var(--crema);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}\n  .tel{width:390px;max-width:100%;height:760px;max-height:calc(100vh - 40px);background:var(--fondo);border-radius:34px;border:10px solid #1B1F3B;display:flex;flex-direction:column;overflow:hidden;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.18)}\n  .barra{background:var(--wa);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:12px}\n  .avatar{width:38px;height:38px;border-radius:50%;background:var(--naranja);display:flex;align-items:center;justify-content:center;font-weight:700}\n  .barra b{display:block;font-size:15px}.barra small{opacity:.8;font-size:12px}\n  .chat{flex:1;overflow-y:auto;padding:14px 10px;display:flex;flex-direction:column;gap:6px}\n  .msg{max-width:84%;padding:8px 10px 6px;border-radius:10px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;box-shadow:0 1px 1px rgba(0,0,0,.08)}\n  .yo{align-self:flex-end;background:var(--burbuja);border-top-right-radius:2px}\n  .bot{align-self:flex-start;background:#fff;border-top-left-radius:2px}\n  .hora{display:block;text-align:right;font-size:10px;color:#8a8a8a;margin-top:2px}\n  .encab{font-weight:700;margin-bottom:4px}.pie{font-size:12px;color:#8a8a8a;margin-top:4px}\n  .btns{align-self:flex-start;max-width:84%;width:84%;display:flex;flex-direction:column;gap:4px;margin-top:-2px}\n  .btns button,.abrir{background:#fff;border:0;border-radius:10px;padding:9px;font-family:inherit;font-size:14px;color:#027EB5;font-weight:500;cursor:pointer;box-shadow:0 1px 1px rgba(0,0,0,.08)}\n  .btns button:disabled{color:#aaa;cursor:default}\n  .entrada{display:flex;gap:6px;padding:8px;background:var(--fondo)}\n  .entrada input{flex:1;min-width:0;border:0;border-radius:22px;padding:11px 16px;font-family:inherit;font-size:14px;outline:none}\n  .entrada button{flex:0 0 44px;width:44px;height:44px;border-radius:50%;border:0;background:var(--wa2);color:#fff;font-size:18px;cursor:pointer}\n  .hoja{position:absolute;inset:0;background:rgba(0,0,0,.35);display:none;align-items:flex-end}\n  .hoja .caja{background:#fff;width:100%;border-radius:18px 18px 0 0;max-height:75%;overflow-y:auto;padding:10px 0 16px}\n  .hoja h4{margin:6px 18px 4px;font-size:13px;color:var(--wa2)}\n  .fila{padding:10px 18px;cursor:pointer;border-bottom:1px solid #f0f0f0}\n  .fila:hover{background:#f6f6f6}.fila b{display:block;font-size:14px;font-weight:500}.fila small{color:#777;font-size:12px}\n  .cerrar{display:block;margin:10px auto 0;border:0;background:none;color:#027EB5;font-family:inherit;font-size:14px;cursor:pointer}\n  @media(max-width:500px){.nota{display:none}body{padding:0}.tel{border-radius:0;border:0;height:100vh;max-height:none}}\n  .nota{position:fixed;top:12px;left:50%;transform:translateX(-50%);background:var(--azul);color:#fff;font-size:12px;padding:6px 14px;border-radius:999px}\n</style>\n</head>\n<body>\n<div class=\"nota\">Modo simulador · misma lógica que el bot de WhatsApp</div>\n<div class=\"tel\">\n  <div class=\"barra\"><div class=\"avatar\">VC</div><div><b id=\"nombreTienda\">Tienda</b><small>Cuenta de empresa · en línea</small></div></div>\n  <div class=\"chat\" id=\"chat\"></div>\n  <div class=\"entrada\">\n    <button title=\"Enviar comprobante\" onclick=\"comprobante()\" style=\"background:#fff;color:#555\">📎</button>\n    <input id=\"txt\" placeholder=\"Escribe un mensaje\" autocomplete=\"off\">\n    <button onclick=\"enviarTexto()\">➤</button>\n  </div>\n  <div class=\"hoja\" id=\"hoja\"><div class=\"caja\" id=\"caja\"></div></div>\n</div>\n<script>\nconst USUARIO = \"sim-1\", NOMBRE = \"Cliente demo\";\nconst chat = document.getElementById(\"chat\");\nconst esc = s => String(s ?? \"\").replace(/[&<>\"']/g, c => ({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\",'\"':\"&quot;\",\"'\":\"&#39;\"}[c]));\nconst fmt = s => esc(s).replace(/\\*([^*\\n]+)\\*/g,\"<b>$1</b>\");\nconst hh = () => new Date().toLocaleTimeString(\"es-CO\",{hour:\"2-digit\",minute:\"2-digit\"});\nconst bajar = () => chat.scrollTop = chat.scrollHeight;\n\nfetch(\"/api/pedidos\").then(r=>r.json()).then(d=>document.getElementById(\"nombreTienda\").textContent=d.tienda).catch(()=>{});\n\nfunction burbuja(html, quien){ const d=document.createElement(\"div\"); d.className=\"msg \"+quien; d.innerHTML=html+`<span class=\"hora\">${hh()}</span>`; chat.appendChild(d); bajar(); }\n\nfunction pintar(m){\n  if(m.type===\"text\") return burbuja(fmt(m.text.body),\"bot\");\n  const i = m.interactive;\n  let html = (i.header? `<div class=\"encab\">${fmt(i.header.text)}</div>`:\"\") + fmt(i.body.text) + (i.footer? `<div class=\"pie\">${fmt(i.footer.text)}</div>`:\"\");\n  burbuja(html,\"bot\");\n  const b = document.createElement(\"div\"); b.className=\"btns\";\n  if(i.type===\"button\"){\n    i.action.buttons.forEach(x=>{ const bt=document.createElement(\"button\"); bt.textContent=x.reply.title;\n      bt.onclick=()=>{ b.querySelectorAll(\"button\").forEach(z=>z.disabled=true); mandar(\"id\",x.reply.id,x.reply.title); }; b.appendChild(bt); });\n  } else if(i.type===\"list\"){\n    const bt=document.createElement(\"button\"); bt.textContent=\"☰ \"+i.action.button; bt.onclick=()=>abrirLista(i.action.sections); b.appendChild(bt);\n  }\n  chat.appendChild(b); bajar();\n}\n\nfunction abrirLista(secciones){\n  const caja=document.getElementById(\"caja\");\n  caja.innerHTML = secciones.map(s=>`<h4>${esc(s.title)}</h4>`+s.rows.map(r=>`<div class=\"fila\" data-id=\"${esc(r.id)}\" data-t=\"${esc(r.title)}\"><b>${esc(r.title)}</b><small>${esc(r.description||\"\")}</small></div>`).join(\"\")).join(\"\")\n    + `<button class=\"cerrar\" onclick=\"cerrarLista()\">Cerrar</button>`;\n  caja.querySelectorAll(\".fila\").forEach(f=>f.onclick=()=>{ cerrarLista(); mandar(\"id\",f.dataset.id,f.dataset.t); });\n  document.getElementById(\"hoja\").style.display=\"flex\";\n}\nfunction cerrarLista(){ document.getElementById(\"hoja\").style.display=\"none\"; }\n\nasync function mandar(tipo, valor, mostrar){\n  burbuja(fmt(mostrar ?? valor),\"yo\");\n  const r = await fetch(\"/api/sim/enviar\",{method:\"POST\",headers:{\"Content-Type\":\"application/json\"},body:JSON.stringify({usuario:USUARIO,nombre:NOMBRE,tipo,valor})});\n  const d = await r.json(); for(const m of d.mensajes){ await new Promise(s=>setTimeout(s,350)); pintar(m); }\n}\nfunction enviarTexto(){ const t=document.getElementById(\"txt\"); const v=t.value.trim(); if(!v) return; t.value=\"\"; mandar(\"texto\",v); }\nfunction comprobante(){ mandar(\"imagen\",\"\", \"📷 Foto del comprobante\"); }\ndocument.getElementById(\"txt\").addEventListener(\"keydown\",e=>{ if(e.key===\"Enter\") enviarTexto(); });\n\n// Mensajes que manda el tendero desde el panel (confirmado, en camino...)\nsetInterval(async()=>{ try{ const d=await (await fetch(\"/api/sim/nuevos?usuario=\"+USUARIO)).json(); d.mensajes.forEach(pintar);}catch(e){} }, 2000);\n</script>\n</body>\n</html>\n",
};

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
