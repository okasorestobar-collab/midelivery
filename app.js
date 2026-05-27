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
var PROFIT_MARGIN = parseFloat(process.env.PROFIT_MARGIN || '0.15');
var PORT = process.env.PORT || 3000;

var conversations = {};

function loadProviders() {
  try {
    return JSON.parse(fs.readFileSync('/home/romersae/midelivery/providers.json', 'utf8'));
  } catch(e) {
    return [];
  }
}

function httpsPost(hostname, path, headers, body) {
  return new Promise(function(resolve, reject) {
    var options = {
      hostname: hostname,
      path: path,
      method: 'POST',
      headers: headers
    };
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
    model: 'claude-sonnet-4-20250514',
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
    .then(function(r) { return r.content[0].text; });
}

function processMessage(userPhone, userMessage) {
  var providers = loadProviders();
  if (!conversations[userPhone]) conversations[userPhone] = { history: [] };
  var conv = conversations[userPhone];
  conv.history.push({ role: 'user', content: userMessage });

  var systemPrompt = 'Eres "Mia", asistente de MiDelivery Ecuador. Amable y eficiente.\n\n';
  systemPrompt += 'CATALOGO:\n' + JSON.stringify(providers, null, 2) + '\n\n';
  systemPrompt += 'MARGEN: ' + (PROFIT_MARGIN * 100).toFixed(0) + '%\n';
  systemPrompt += 'DELIVERY: $1.00\n\n';
  systemPrompt += 'REGLAS:\n';
  systemPrompt += '- Saluda cordialmente\n';
  systemPrompt += '- Precio cliente = precio_proveedor x (1 + margen)\n';
  systemPrompt += '- Si NO tienes el producto responde SOLO: {"accion":"consultar","producto":"nombre"}\n';
  systemPrompt += '- Para confirmar pedido responde SOLO: {"accion":"pedido_confirmado","items":[{"nombre":"x","cantidad":1,"precio_unitario":2.50}],"subtotal":2.50,"delivery":1.00,"total":3.50,"direccion":"dir"}\n';
  systemPrompt += '- Pide siempre la direccion antes de confirmar';

  return callClaude(conv.history, systemPrompt)
    .then(function(msg) {
      conv.history.push({ role: 'assistant', content: msg });
      try {
        var s = msg.indexOf('{');
        var e = msg.lastIndexOf('}');
        if (s !== -1 && e !== -1) {
          var action = JSON.parse(msg.substring(s, e + 1));
          if (action.accion === 'pedido_confirmado') {
            var items = action.items.map(function(i) {
              return '- ' + i.cantidad + 'x ' + i.nombre + ': $' + parseFloat(i.precio_unitario).toFixed(2);
            }).join('\n');
            var summary = 'NUEVO PEDIDO\nCliente: ' + userPhone + '\n' + items + '\nTotal: $' + parseFloat(action.total).toFixed(2);
            if (action.direccion) summary += '\nDir: ' + action.direccion;
            if (LOGISTICS_NUMBER) sendWhatsApp(LOGISTICS_NUMBER, summary);
            conversations[userPhone] = { history: [] };
            return 'Pedido confirmado!\n\n' + items + '\nTotal: $' + parseFloat(action.total).toFixed(2) + '\n\nNuestro motorizado va pronto. Gracias!';
          }
          if (action.accion === 'consultar') {
            return 'Consultando precio de ' + action.producto + '. Te respondo en 3 min.';
          }
        }
      } catch(err) {}
      return msg;
    })
    .catch(function(e) {
      console.error('Error IA: ' + e.message);
      return 'Disculpa, problema tecnico. Intenta de nuevo.';
    });
}

var server = http.createServer(function(req, res) {
  var parsed = url.parse(req.url, true);
  var pathname = parsed.pathname;

  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'MiDelivery funcionando v3' }));
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
});