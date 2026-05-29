// MiDelivery AI - Node.js puro v3
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
  var path = '/v18.0/' + PHONE_NUMBER_ID + '/messages';
  return httpsPost('graph.facebook.com', path, headers, body)
    .then(function(r) { console.log('Enviado a ' + to); return r; })
    .catch(function(e) { console.error('Error envio: ' + e.message); });
}

function callClaude(messages, systemPrompt) {
  var body = JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 1000,
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
    prov.productos.forEach(function(cat) {
      text += '\n[' + cat.categoria + ']\n';
      cat.items.forEach(function(item) {
        text += '- ' + item.nombre + ': $' + item.precio.toFixed(2);
        if (item.descripcion) text += ' (' + item.descripcion + ')';
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

  var systemPrompt = 'Eres "Mia", asistente de delivery de MiDelivery Ecuador. Eres amable, eficiente y conoces muy bien la comida ecuatoriana.\n\n';
  systemPrompt += 'CATALOGO DE PROVEEDORES:\n' + catalogText + '\n';
  systemPrompt += 'MARGEN DE GANANCIA: ' + (PROFIT_MARGIN * 100).toFixed(0) + '%\n';
  systemPrompt += 'COSTO DE DELIVERY: $1.00\n\n';
  systemPrompt += 'REGLAS IMPORTANTES:\n';
  systemPrompt += '- Saluda cordialmente al inicio de cada conversacion nueva\n';
  systemPrompt += '- El precio que cobras al cliente = precio_del_menu x (1 + margen). Ejemplo: $3.50 x 1.15 = $4.03\n';
  systemPrompt += '- Siempre redondea los precios a 2 decimales\n';
  systemPrompt += '- Presenta el menu por categorias cuando el cliente pregunte que hay\n';
  systemPrompt += '- Pide SIEMPRE la direccion de entrega antes de confirmar el pedido\n';
  systemPrompt += '- Para confirmar un pedido responde UNICAMENTE con este JSON (sin texto adicional):\n';
  systemPrompt += '{"accion":"pedido_confirmado","proveedor_id":"margarita","items":[{"nombre":"nombre del plato","cantidad":1,"precio_proveedor":3.50,"precio_cliente":4.03}],"subtotal":4.03,"delivery":1.00,"total":5.03,"direccion":"direccion del cliente"}\n';
  systemPrompt += '- Si el cliente pregunta por algo que NO esta en el catalogo responde UNICAMENTE: {"accion":"consultar","producto":"nombre del producto"}\n';
  systemPrompt += '- Nunca inventes precios. Solo usa los del catalogo.\n';

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

            var itemsTexto = action.items.map(function(i) {
              return '- ' + i.cantidad + 'x ' + i.nombre + ': $' + parseFloat(i.precio_cliente).toFixed(2);
            }).join('\n');

            var itemsParaProveedor = action.items.map(function(i) {
              return '- ' + i.cantidad + 'x ' + i.nombre + ': $' + parseFloat(i.precio_proveedor).toFixed(2);
            }).join('\n');

            var costoProveedor = action.subtotal / (1 + PROFIT_MARGIN);
            var ganancia = (action.subtotal - costoProveedor).toFixed(2);

            // Mensaje para el PROVEEDOR
            var msgProveedor = '🛒 *NUEVO PEDIDO - MiDelivery*\n\n';
            msgProveedor += itemsParaProveedor + '\n\n';
            msgProveedor += '📍 *Entrega en:* ' + action.direccion + '\n';
            msgProveedor += '📞 *Cliente:* +' + userPhone + '\n';
            msgProveedor += '💰 *Total a cobrar:* $' + costoProveedor.toFixed(2);

            // Mensaje para el DUEÑO
            var msgDueno = '✅ *PEDIDO CONFIRMADO*\n\n';
            msgDueno += '🏪 *Proveedor:* ' + nombreProveedor + '\n';
            msgDueno += '📋 *Items:*\n' + itemsTexto + '\n\n';
            msgDueno += '📍 *Entrega:* ' + action.direccion + '\n';
            msgDueno += '📞 *Cliente:* +' + userPhone + '\n';
            msgDueno += '💵 *Subtotal:* $' + parseFloat(action.subtotal).toFixed(2) + '\n';
            msgDueno += '🛵 *Delivery:* $' + parseFloat(action.delivery).toFixed(2) + '\n';
            msgDueno += '💰 *Total cliente:* $' + parseFloat(action.total).toFixed(2) + '\n';
            msgDueno += '📈 *Tu ganancia:* $' + ganancia;

            // Mensaje para LOGISTICA
            var msgLogistica = '🛵 *NUEVO DELIVERY*\n\n';
            msgLogistica += '🏪 Recoger en: ' + nombreProveedor;
            if (proveedor && proveedor.ubicacion) msgLogistica += ' (' + proveedor.ubicacion + ')';
            msgLogistica += '\n📋 Pedido:\n' + itemsTexto + '\n\n';
            msgLogistica += '📍 Entregar en: ' + action.direccion + '\n';
            msgLogistica += '📞 Cliente: +' + userPhone + '\n';
            msgLogistica += '💵 Cobrar al cliente: $' + parseFloat(action.total).toFixed(2);

            // Enviar notificaciones
            if (telefonoProveedor) sendWhatsApp(telefonoProveedor, msgProveedor);
            if (OWNER_NUMBER) sendWhatsApp(OWNER_NUMBER, msgDueno);
            if (LOGISTICS_NUMBER) sendWhatsApp(LOGISTICS_NUMBER, msgLogistica);

            conversations[userPhone] = { history: [] };

            return '✅ *¡Pedido confirmado!*\n\n' + itemsTexto + '\n\n' +
                   '💵 Subtotal: $' + parseFloat(action.subtotal).toFixed(2) + '\n' +
                   '🛵 Delivery: $' + parseFloat(action.delivery).toFixed(2) + '\n' +
                   '💰 *Total: $' + parseFloat(action.total).toFixed(2) + '*\n\n' +
                   '📍 Entrega en: ' + action.direccion + '\n\n' +
                   '⏱ Nuestro motorizado está en camino. ¡Gracias por tu pedido!';
          }

          if (action.accion === 'consultar') {
            return 'Consultando el precio de *' + action.producto + '*. Te respondo en unos minutos. 🔍';
          }
        }
      } catch(err) {}

      return msg;
    })
    .catch(function(e) {
      console.error('Error IA: ' + e.message);
      return 'Disculpa, tuve un problema técnico. Por favor intenta de nuevo. 🙏';
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
    res.end(JSON.stringify({ status: 'MiDelivery funcionando v3' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/privacy') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>Politica de Privacidad - MiDeliveryAI</title></head><body><h1>Politica de Privacidad - MiDeliveryAI</h1><p>MiDeliveryAI usa WhatsApp para recibir y responder pedidos de clientes.</p><p>Los datos procesados pueden incluir numero de telefono, mensajes enviados por WhatsApp, productos solicitados y direccion de entrega cuando el cliente la proporciona.</p><p>Estos datos se usan solo para gestionar pedidos, responder consultas, coordinar entregas y mejorar el servicio.</p><p>Los datos pueden compartirse solo con el operador logistico o proveedor necesario para completar el pedido.</p><p>Para solicitar acceso, correccion o eliminacion de datos, escribe al mismo numero de WhatsApp de MiDeliveryAI o al correo aromerosecaira@hotmail.com.</p><p>Ultima actualizacion: mayo 2026.</p></body></html>');
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
  console.log('MiDelivery v3 corriendo en puerto ' + PORT);
  subscribeWABA();
});
