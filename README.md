# VeciClick Bot

Chat automatizado de pedidos por WhatsApp para tiendas de barrio, con panel para el tendero.

- `/panel`: panel del tendero (pedidos en vivo, confirmar, en camino, entregado)
- `/simulador`: chat de prueba con la misma lógica (respaldo para la demo)
- `/estado`: revisa si el bot está bien conectado
- `/webhook`: dirección que se pega en Meta (WhatsApp → Configuración)

## Variables de entorno (en Render → Environment)

| Nombre | Qué es |
|---|---|
| `WHATSAPP_TOKEN` | Token de acceso de Meta (API Setup → Generate access token) |
| `PHONE_NUMBER_ID` | Identificador del número de teléfono (API Setup) |
| `VERIFY_TOKEN` | Una palabra secreta inventada, por ejemplo `veciclick2026` |
| `NOMBRE_TIENDA` | Nombre que verá el cliente, por ejemplo `Tienda Doña Rosa` |
| `NUMERO_NEQUI` | Número que se muestra para pagar por Nequi |
| `GRAPH_VERSION` | Opcional. Versión de la API que muestra Meta, por ejemplo `v23.0` |

Los productos y precios se cambian en `productos.js` (máximo 10).

Los pedidos se guardan en memoria: si el servidor se reinicia, se borran (suficiente para una demostración).
