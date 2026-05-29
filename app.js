// MiDelivery AI - Node.js puro v3.1
var http = require('http');
var https = require('https');
var fs = require('fs');
var url = require('url');

var ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
var WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
var PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
var WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
var LOGISTICS_NUMBER = process.env.LOGISTICS_NUMBER;
var OWNER_NUMBER = process.env.OWNER_NUMBER;
var PROFIT_MARGIN = parseFloat(process.env.PROFIT_MARGIN || '0.15');
var PORT = process.env.PORT || 3000;
var WABA_ID = '101658011052309';

var conversations = {};

function loadProviders() {
  try {
    return JSON.parse(fs.readFileSync('./providers.json', 'utf8'));
  } catch(e) {
    return [];
  }
}

function httpsPost(hostname, path, headers, body) {
  return new Promise(function(resolve, reject) {
    var options = { hostname: hostname, path: path, method: 'POST', headers: headers };
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendWhatsApp(to, message) {
  var body = JSON.stringify({
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: { body: message }
  });
  var headers = {
    'Authorization': 'Bearer ' + WHATSAPP_TOKEN,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  };
  return httpsPost('graph.facebook.com', '/v18.0/' + PHONE_NUMBER_ID + '/messages', headers, body)
    .then(function(r) { console.log('Enviado a ' + to); return r; })
    .catch(function(e) { console.error('Error envio: ' + e.message); });
}

function callClaude(messages, systemPrompt) {
  var body = JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    system: systemPrompt,
    messages: messages
  });
  var headers = {
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  };
  return httpsPost('api.anthropic.com', '/v1/messages', headers, body)
    .then(function(r) {
      if (r && r.content && r.content[0]) return r.content[0].text;
      console.error('Claude error:', JSON.stringify(r));
      return 'Disculpa, problema tecnico.';
    });
}

function buildCatalogText(providers) {
  var text = '';
  providers.forEach(function(prov) {
    text += 'PROVEEDOR: ' + prov.nombre + ' (ID: ' + prov.id + ')\n';
    text += 'Ubicacion: ' + prov.ubicacion + '\n';
    text += 'Telefono: ' + prov.telefono + '\n';
    prov.productos.forEach(function(cat) {
      text += '\n[' + cat.categoria + ']\n';
      cat.items.forEach(function(item) {
        text += '- ' + item.nombre + ': $' + item.precio.toFixed(2);
        if (item.descripcion) text += ' | ' + item.descripcion;
        text += '\n';
      });
    });
    text += '\n';
  });
  return text;
}

function findProviderById(providers, id) {
  return providers.find(function(p) { return p.id === id; }) || null;
}

function processMessage(userPhone, userMessage) {
  var providers = loadProviders();
  if (!conversations[userPhone]) conversations[userPhone] = { history: [] };
  var conv = conversations[userPhone];
  conv.history.push({ role: 'user', content: userMessage });

  var catalogText = buildCatalogText(providers);

  var systemPrompt = [
    'Eres "Mia", asistente de delivery de MiDelivery. Tono: amable, directo y conciso. Sin textos largos innecesarios.',
    '',
    'CATALOGO:\n' + catalogText,
    '',
    'REGLAS DE PRECIOS:',
    '- Usa los precios del catalogo TAL CUAL. Sin margen adicional.',
    '- Envases: $0.25 por cada item en pedidos a domicilio (siempre).',
    '- Delivery DENTRO de Plaza Volare: pedido < $6 cobra $0.50; pedido >= $6 cobra $1.00.',
    '- Delivery FUERA de Plaza Volare: indica al cliente que debes consultar el costo con el restaurante.',
    '',
    'PAGOS ACEPTADOS:',
    '- Efectivo al momento de la entrega',
    '- Transferencia bancaria: YOLOCORP S.A.S. | RUC: 0993367608001 | Cta Cte Produbanco: 2006168082',
    '- Tarjeta de credito: se envia link de pago',
    '',
    'FLUJO DEL PEDIDO:',
    '1. Toma el pedido',
    '2. Pregunta si es en Volare o a domicilio',
    '3. Si es domicilio, pide la direccion',
    '4. Pide el nombre para el pedido',
    '5. Confirma el resumen con precios + envases + delivery',
    '6. Pregunta metodo de pago',
    '7. Confirma el pedido con el JSON',
    '',
    'DESCRIPCIONES DE PLATOS:',
    '- Breves y apetitosas. Menciona 2-3 ingredientes clave. Sin parrafos largos.',
    '- Para platos poco conocidos o especialidades, describe brevemente que contiene.',
    '',
    'CONSULTAS AL PROVEEDOR:',
    '- Si el cliente pide modificacion de un plato (sin maní, sin cebolla, etc.) indica: "Déjame confirmar con el restaurante, un momento." y responde al cliente que estas verificando.',
    '- Si piden algo fuera del menu, indica que lo consultas.',
    '- El numero del restaurante es 593990095075.',
    '',
    'PARA CONFIRMAR UN PEDIDO responde UNICAMENTE este JSON:',
    '{"accion":"pedido_confirmado","proveedor_id":"margarita","nombre_cliente":"Nombre","items":[{"nombre":"plato","cantidad":1,"precio":3.50}],"envases":0.25,"subtotal":3.50,"delivery":1.00,"total":4.75,"direccion":"direccion","metodo_pago":"efectivo"}',
    '',
    'Para consultas fuera del menu responde UNICAMENTE:',
    '{"accion":"consultar","producto":"nombre"}',
  ].join('\n');

  return callClaude(conv.history, systemPrompt)
    .then(function(msg) {
      conv.history.push({ role: 'assistant', content: msg });

      try {
        var s = msg.indexOf('{');
        var e = msg.lastIndexOf('}');
        if (s !== -1 && e !== -1) {
          var action = JSON.parse(msg.substring(s, e + 1));

          if (action.accion === 'pedido_confirmado') {
            var proveedor = findProviderById(providers, action.proveedor_id);
            var nombreProveedor = proveedor ? proveedor.nombre : action.proveedor_id;
            var telefonoProveedor = proveedor ? proveedor.telefono : null;
            var nombreCliente = action.nombre_cliente || 'Sin nombre';

            var itemsTexto = action.items.map(function(i) {
              return '- ' + i.cantidad + 'x ' + i.nombre + ': $' + parseFloat(i.precio).toFixed(2);
            }).join('\n');

            var envases = parseFloat(action.envases || 0).toFixed(2);
            var subtotal = parseFloat(action.subtotal).toFixed(2);
            var delivery = parseFloat(action.delivery).toFixed(2);
            var total = parseFloat(action.total).toFixed(2);

            // Mensaje PROVEEDOR
            var msgProveedor = '🛒 *PEDIDO MiDelivery*\n';
            msgProveedor += '👤 *' + nombreCliente + '*\n\n';
            msgProveedor += itemsTexto + '\n\n';
            msgProveedor += '📍 ' + (action.direccion || 'Retiro en local') + '\n';
            msgProveedor += '💳 Pago: ' + action.metodo_pago + '\n';
            msgProveedor += '📞 Cliente: +' + userPhone;

            // Mensaje DUEÑO
            var msgDueno = '✅ *PEDIDO CONFIRMADO*\n';
            msgDueno += '👤 ' + nombreCliente + ' | 📞 +' + userPhone + '\n';
            msgDueno += '🏪 ' + nombreProveedor + '\n\n';
            msgDueno += itemsTexto + '\n';
            msgDueno += '📦 Envases: $' + envases + '\n';
            msgDueno += '🛵 Delivery: $' + delivery + '\n';
            msgDueno += '💰 *Total: $' + total + '*\n';
            msgDueno += '💳 Pago: ' + action.metodo_pago + '\n';
            msgDueno += '📍 ' + (action.direccion || 'Retiro en local');

            // Mensaje LOGISTICA (para Margarita = mismo proveedor)
            var msgLogistica = '🛵 *DELIVERY*\n';
            msgLogistica += '👤 ' + nombreCliente + '\n';
            msgLogistica += '🏪 Recoger: ' + nombreProveedor;
            if (proveedor && proveedor.ubicacion) msgLogistica += ' — ' + proveedor.ubicacion;
            msgLogistica += '\n' + itemsTexto + '\n';
            msgLogistica += '📍 Entregar: ' + (action.direccion || 'Retiro en local') + '\n';
            msgLogistica += '💵 Cobrar: $' + total;

            // Enviar notificaciones
            if (telefonoProveedor) sendWhatsApp(telefonoProveedor, msgProveedor);
            if (OWNER_NUMBER) sendWhatsApp(OWNER_NUMBER, msgDueno);
            if (LOGISTICS_NUMBER && LOGISTICS_NUMBER !== telefonoProveedor) {
              sendWhatsApp(LOGISTICS_NUMBER, msgLogistica);
            } else if (LOGISTICS_NUMBER && LOGISTICS_NUMBER === telefonoProveedor) {
              // Proveedor y logistica son el mismo numero — ya recibio msgProveedor, no duplicar
              console.log('Logistica = Proveedor, mensaje unico enviado a ' + telefonoProveedor);
            }

            // Enviar datos de transferencia si aplica
            if (action.metodo_pago && action.metodo_pago.toLowerCase().includes('transferencia')) {
              var msgTransferencia = '🏦 *Datos para transferencia:*\n';
              msgTransferencia += 'YOLOCORP S.A.S.\n';
              msgTransferencia += 'RUC: 0993367608001\n';
              msgTransferencia += 'Cta Cte Produbanco: 2006168082\n';
              msgTransferencia += 'Monto: $' + total + '\n';
              msgTransferencia += '_Envía el comprobante a este chat_ 📎';
              setTimeout(function() { sendWhatsApp(userPhone, msgTransferencia); }, 2000);
            }

            conversations[userPhone] = { history: [] };

            var respCliente = '✅ *¡Pedido listo, ' + nombreCliente + '!*\n\n';
            respCliente += itemsTexto + '\n';
            respCliente += '📦 Envases: $' + envases + '\n';
            respCliente += '🛵 Delivery: $' + delivery + '\n';
            respCliente += '💰 *Total: $' + total + '*\n\n';
            if (action.direccion) respCliente += '📍 ' + action.direccion + '\n';
            respCliente += '⏱ Listo en aprox. 15-20 min.';

            return respCliente;
          }

          if (action.accion === 'consultar') {
            return 'Consultando *' + action.producto + '* con el restaurante. En un momento te confirmo. 🔍';
          }
        }
      } catch(err) {}

      return msg;
    })
    .catch(function(e) {
      console.error('Error IA: ' + e.message);
      return 'Disculpa, problema técnico. Intenta de nuevo. 🙏';
    });
}

function subscribeWABA() {
  var emptyBody = '{}';
  var headers = {
    'Authorization': 'Bearer ' + WHATSAPP_TOKEN,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(emptyBody)
  };
  httpsPost('graph.facebook.com', '/v18.0/' + WABA_ID + '/subscribed_apps', headers, emptyBody)
    .then(function(r) { console.log('WABA suscrito:', JSON.stringify(r)); })
    .catch(function(e) { console.error('Error suscripcion WABA:', e.message); });
}

var server = http.createServer(function(req, res) {
  var parsed = url.parse(req.url, true);
  var pathname = parsed.pathname;

  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'MiDelivery v3.1 operativo' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/privacy') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>Politica de Privacidad - MiDelivery</title></head><body><h1>Politica de Privacidad - MiDelivery</h1><p>MiDelivery usa WhatsApp para recibir y responder pedidos de clientes.</p><p>Los datos procesados incluyen numero de telefono, mensajes, productos solicitados y direccion de entrega.</p><p>Estos datos se usan unicamente para gestionar pedidos y coordinar entregas.</p><p>Para solicitar acceso o eliminacion de datos escribe al mismo numero de WhatsApp o al correo aromerosecaira@hotmail.com.</p><p>Ultima actualizacion: mayo 2026.</p></body></html>');
    return;
  }

  if (req.method === 'GET' && pathname === '/webhook') {
    var mode = parsed.query['hub.mode'];
    var token = parsed.query['hub.verify_token'];
    var challenge = parsed.query['hub.challenge'];
    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
      console.log('Webhook verificado');
      res.writeHead(200);
      res.end(challenge);
    } else {
      res.writeHead(403);
      res.end('Forbidden');
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/webhook') {
    res.writeHead(200);
    res.end('OK');
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var data = JSON.parse(body);
        if (data.object === 'whatsapp_business_account') {
          (data.entry || []).forEach(function(entry) {
            (entry.changes || []).forEach(function(change) {
              var msgs = change.value && change.value.messages;
              if (msgs) {
                msgs.forEach(function(m) {
                  if (m.type === 'text') {
                    console.log('Mensaje de ' + m.from + ': ' + m.text.body);
                    processMessage(m.from, m.text.body)
                      .then(function(reply) { sendWhatsApp(m.from, reply); });
                  }
                });
              }
            });
          });
        }
      } catch(e) { console.error('Error webhook: ' + e.message); }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, function() {
  console.log('MiDelivery v3.1 corriendo en puerto ' + PORT);
  subscribeWABA();
});
