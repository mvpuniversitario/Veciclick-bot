// ============================================================
//  PRODUCTOS DE LA TIENDA (puedes cambiar nombres y precios)
//  - Máximo 10 productos en total (límite de WhatsApp para listas)
//  - "nombre": máximo 24 letras
//  - "detalle": máximo 72 letras
//  - "precio": en pesos, sin puntos
// ============================================================

module.exports = [
  {
    seccion: "Despensa",
    productos: [
      { id: "P_ARROZ",  nombre: "Arroz Diana 1 kg",      detalle: "Bolsa de 1 kg",            precio: 4800 },
      { id: "P_ACEITE", nombre: "Aceite 1 litro",        detalle: "Aceite vegetal",           precio: 9500 },
      { id: "P_HUEVOS", nombre: "Huevos x 12",           detalle: "Huevos AA, cubeta x 12",   precio: 7800 },
      { id: "P_AZUCAR", nombre: "Azúcar 1 kg",           detalle: "Azúcar blanca",            precio: 4500 },
      { id: "P_CAFE",   nombre: "Café 250 g",            detalle: "Café molido",              precio: 8900 },
    ],
  },
  {
    seccion: "Lácteos y bebidas",
    productos: [
      { id: "P_LECHE",  nombre: "Leche 1 litro",         detalle: "Bolsa de leche entera",    precio: 4200 },
      { id: "P_PAN",    nombre: "Pan tajado",            detalle: "Paquete familiar",         precio: 6500 },
      { id: "P_QUESO",  nombre: "Queso costeño 500 g",   detalle: "Queso fresco",             precio: 11000 },
      { id: "P_GASEO",  nombre: "Gaseosa 1,5 L",         detalle: "Gaseosa sabor a elección", precio: 5500 },
      { id: "P_AGUA",   nombre: "Agua 600 ml",           detalle: "Botella de agua",          precio: 1800 },
    ],
  },
];
