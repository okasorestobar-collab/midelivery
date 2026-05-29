// LinkMarket AI - Node.js puro v3.5
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
var WABA_ID = '1016580111052309';
var CHATWOOT_URL = process.env.CHATWOOT_URL || 'chatwoot-production-6854.up.railway.app';
var CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN || 'nSEom4sbee3sksbgdu16r6H3';
var CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '2';
var CHATWOOT_INBOX_ID = parseInt(process.env.CHATWOOT_INBOX_ID || '1', 10);

var conversations = {};
var pendingClientForProvider = {};
var humanPauseUntil = {}; // Pausa de Mia por numero de cliente; NO afecta otros chats

function loadProviders() {
  try {
    return JSON.parse(fs.readFileSync('./providers.json', 'utf8'));
  } catch(e) {
    return [];
  }
}

function isProviderNumber(phone, providers) {
  return providers.some(function(p) { return p.telefono === phone; });
}

function findProviderByPhone(phone, providers) {
  return providers.find(function(p) { return p.telefono === phone; }) || null;
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

function httpsGet(hostname, path, headers) {
  return new Promise(function(resolve, reject) {
    var options = { hostname: hostname, path: path, method: 'GET', headers: headers };
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
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
  return httpsPost('graph.facebook.com', '/v19.0/' + PHONE_NUMBER_ID + '/messages', headers, body)
    .then(function(r) { console.log('Enviado a ' + to); return r; })
    .catch(function(e) { console.error('Error envio: ' + e.message); });
}

// Sincroniza Chatwoot: contacto + conversación + mensajes entrantes/salientes
function chatwootHeaders(body) {
  var headers = {
    'api_access_token': CHATWOOT_TOKEN,
    'Content-Type': 'application/json'
  };
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  return headers;
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d]/g, '');
}

function getPayload(result) {
  if (!result) return null;
  if (result.payload) return result.payload;
  return result;
}

function firstContactFromResult(result) {
  var payload = getPayload(result);

  if (Array.isArray(payload) && payload.length > 0) return payload[0];
  if (payload && Array.isArray(payload.contacts) && payload.contacts.length > 0) return payload.contacts[0];
  if (payload && payload.contact && payload.contact.id) return payload.contact;
  if (payload && payload.id) return payload;
  if (result && result.contact && result.contact.id) return result.contact;
  if (result && result.id) return result;

  return null;
}

function findContactInbox(contact, inboxId) {
  if (!contact) return null;

  var list = contact.contact_inboxes || [];

  for (var i = 0; i < list.length; i++) {
    var ci = list[i];
    if (ci.inbox && parseInt(ci.inbox.id, 10) === parseInt(inboxId, 10)) return ci;
    if (ci.inbox_id && parseInt(ci.inbox_id, 10) === parseInt(inboxId, 10)) return ci;
  }

  return null;
}

function getChatwootContactById(contactId) {
  return httpsGet(
    CHATWOOT_URL,
    '/api/v1/accounts/' + CHATWOOT_ACCOUNT_ID + '/contacts/' + contactId,
    chatwootHeaders()
  ).then(function(result) {
    var contact = firstContactFromResult(result);
    return contact || result;
  });
}

function searchChatwootContact(phoneNumber) {
  var cleanPhone = normalizePhone(phoneNumber);
  var headers = chatwootHeaders();
  var path = '/api/v1/accounts/' + CHATWOOT_ACCOUNT_ID +
    '/contacts/search?q=' + encodeURIComponent(cleanPhone);

  return httpsGet(CHATWOOT_URL, path, headers)
    .then(function(result) {
      var contact = firstContactFromResult(result);
      if (!contact || !contact.id) {
        console.log('[Chatwoot] Contacto no encontrado para ' + cleanPhone);
        return null;
      }

      return getChatwootContactById(contact.id).then(function(fullContact) {
        console.log('[Chatwoot] Contacto encontrado ID: ' + contact.id + ' para ' + cleanPhone);
        return fullContact && fullContact.id ? fullContact : contact;
      });
    });
}

function createChatwootContact(phoneNumber) {
  var cleanPhone = normalizePhone(phoneNumber);
  var body = JSON.stringify({
    inbox_id: CHATWOOT_INBOX_ID,
    name: 'Cliente +' + cleanPhone,
    phone_number: '+' + cleanPhone,
    identifier: cleanPhone,
    additional_attributes: {},
    custom_attributes: {}
  });

  return httpsPost(
    CHATWOOT_URL,
    '/api/v1/accounts/' + CHATWOOT_ACCOUNT_ID + '/contacts',
    chatwootHeaders(body),
    body
  ).then(function(result) {
    var contact = firstContactFromResult(result);

    if (!contact || !contact.id) {
      console.error('[Chatwoot] Error creando contacto. Respuesta: ' + JSON.stringify(result));
      throw new Error('Chatwoot no devolvio contact.id');
    }

    console.log('[Chatwoot] Contacto creado ID: ' + contact.id + ' para ' + cleanPhone);
    return getChatwootContactById(contact.id);
  });
}

function createChatwootContactInbox(contact, phoneNumber) {
  var cleanPhone = normalizePhone(phoneNumber);
  var body = JSON.stringify({
    inbox_id: CHATWOOT_INBOX_ID,
    source_id: cleanPhone
  });

  return httpsPost(
    CHATWOOT_URL,
    '/api/v1/accounts/' + CHATWOOT_ACCOUNT_ID + '/contacts/' + contact.id + '/contact_inboxes',
    chatwootHeaders(body),
    body
  ).then(function(result) {
    console.log('[Chatwoot] contact_inbox creado para contact_id: ' + contact.id + ' | source_id: ' + cleanPhone);
    return getChatwootContactById(contact.id);
  });
}

function getOrCreateChatwootContact(phoneNumber) {
  return searchChatwootContact(phoneNumber)
    .then(function(contact) {
      if (contact && contact.id) return contact;
      return createChatwootContact(phoneNumber);
    })
    .then(function(contact) {
      var ci = findContactInbox(contact, CHATWOOT_INBOX_ID);
      if (ci && ci.source_id) return contact;
      return createChatwootContactInbox(contact, phoneNumber);
    });
}

function getChatwootConversations(contactId) {
  return httpsGet(
    CHATWOOT_URL,
    '/api/v1/accounts/' + CHATWOOT_ACCOUNT_ID + '/contacts/' + contactId + '/conversations',
    chatwootHeaders()
  ).then(function(result) {
    var payload = getPayload(result);

    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.conversations)) return payload.conversations;

    return [];
  });
}

function createChatwootConversation(contact, phoneNumber) {
  var ci = findContactInbox(contact, CHATWOOT_INBOX_ID);
  var cleanPhone = normalizePhone(phoneNumber);

  if (!ci || !ci.source_id) {
    console.error('[Chatwoot] Contacto sin source_id para inbox ' + CHATWOOT_INBOX_ID + ': ' + JSON.stringify(contact));
    throw new Error('No se encontro source_id del contact_inbox');
  }

  var body = JSON.stringify({
    source_id: ci.source_id,
    inbox_id: CHATWOOT_INBOX_ID,
    contact_id: contact.id,
    status: 'open',
    additional_attributes: {},
    custom_attributes: {
      whatsapp_number: cleanPhone
    }
  });

  return httpsPost(
    CHATWOOT_URL,
    '/api/v1/accounts/' + CHATWOOT_ACCOUNT_ID + '/conversations',
    chatwootHeaders(body),
    body
  ).then(function(result) {
    var conversation = getPayload(result);

    if (!conversation || !conversation.id) conversation = result;

    if (!conversation || !conversation.id) {
      console.error('[Chatwoot] Error creando conversacion. Respuesta: ' + JSON.stringify(result));
      throw new Error('Chatwoot no devolvio conversation.id');
    }

    console.log('[Chatwoot] Conversacion creada ID: ' + conversation.id + ' | contact_id: ' + contact.id + ' | inbox_id: ' + CHATWOOT_INBOX_ID);
    return conversation;
  });
}

function ensureChatwootConversation(phoneNumber) {
  return getOrCreateChatwootContact(phoneNumber)
    .then(function(contact) {
      return getChatwootConversations(contact.id)
        .then(function(conversations) {
          var selected = null;

          for (var i = 0; i < conversations.length; i++) {
            var c = conversations[i];
            if (parseInt(c.inbox_id, 10) === parseInt(CHATWOOT_INBOX_ID, 10) && c.status !== 'resolved') {
              selected = c;
              break;
            }
          }

          if (!selected) {
            for (var j = 0; j < conversations.length; j++) {
              if (parseInt(conversations[j].inbox_id, 10) === parseInt(CHATWOOT_INBOX_ID, 10)) {
                selected = conversations[j];
                break;
              }
            }
          }

          if (selected && selected.id) {
            console.log('[Chatwoot] Conversacion existente ID: ' + selected.id + ' | contact_id: ' + contact.id);
            return selected;
          }

          return createChatwootConversation(contact, phoneNumber);
        });
    });
}

function createChatwootMessage(conversationId, message, messageType) {
  var type = messageType || 'mia_note';
  var bodyObj;

  if (type === 'client_note') {
    bodyObj = {
      content: '[CLIENTE WHATSAPP]\n' + message,
      message_type: 'outgoing',
      private: true,
      content_type: 'text',
      content_attributes: {}
    };
  } else if (type === 'mia_note') {
    bodyObj = {
      content: '[MIA ENVIADO POR WHATSAPP]\n' + message,
      message_type: 'outgoing',
      private: true,
      content_type: 'text',
      content_attributes: {}
    };
  } else if (type === 'human_note') {
    bodyObj = {
      content: '[HUMANO ENVIADO POR WHATSAPP]\n' + message,
      message_type: 'outgoing',
      private: true,
      content_type: 'text',
      content_attributes: {}
    };
  } else if (type === 'system_note') {
    bodyObj = {
      content: '[SISTEMA]\n' + message,
      message_type: 'outgoing',
      private: true,
      content_type: 'text',
      content_attributes: {}
    };
  } else {
    bodyObj = {
      content: message,
      message_type: type,
      private: false,
      content_type: 'text',
      content_attributes: {}
    };
  }

  var body = JSON.stringify(bodyObj);

  return httpsPost(
    CHATWOOT_URL,
    '/api/v1/accounts/' + CHATWOOT_ACCOUNT_ID + '/conversations/' + conversationId + '/messages',
    chatwootHeaders(body),
    body
  ).then(function(result) {
    if (!result || !result.id) {
      console.error('[Chatwoot] Error creando registro. Respuesta: ' + JSON.stringify(result));
      throw new Error('Chatwoot no devolvio message.id');
    }

    console.log('[Chatwoot] Registro ' + type + ' ID: ' + result.id + ' | conversation_id: ' + conversationId);
    return result;
  });
}

function createChatwootMessageSafe(conversationId, message, messageType) {
  return createChatwootMessage(conversationId, message, messageType)
    .catch(function(e) {
      console.error('[Chatwoot] ERROR creando ' + messageType + ': ' + e.message);
      return null;
    });
}

function isMiaPaused(phoneNumber) {
  var cleanPhone = normalizePhone(phoneNumber);
  return humanPauseUntil[cleanPhone] && humanPauseUntil[cleanPhone] > Date.now();
}

function pauseMia(phoneNumber, minutes) {
  var cleanPhone = normalizePhone(phoneNumber);
  humanPauseUntil[cleanPhone] = Date.now() + (minutes || 60) * 60000;
  console.log('[Mia] Pausada SOLO para ' + cleanPhone + ' por ' + (minutes || 60) + ' minutos');
}

function resumeMia(phoneNumber) {
  var cleanPhone = normalizePhone(phoneNumber);
  delete humanPauseUntil[cleanPhone];
  console.log('[Mia] Reactivada para ' + cleanPhone);
}

function notifyChatwoot(toPhone, message, messageType) {
  var cleanPhone = normalizePhone(toPhone);
  var type = messageType || 'mia_note';

  if (!CHATWOOT_TOKEN) {
    console.error('[Chatwoot] Falta CHATWOOT_TOKEN');
    return Promise.resolve(null);
  }

  return ensureChatwootConversation(cleanPhone)
    .then(function(conversation) {
      return createChatwootMessage(conversation.id, message, type);
    })
    .catch(function(e) {
      console.error('[Chatwoot] ERROR sincronizando ' + type + ' para ' + cleanPhone + ': ' + e.message);
      return null;
    });
}

function handleClientWhatsAppMessage(fromPhone, text) {
  var cleanPhone = normalizePhone(fromPhone);

  return ensureChatwootConversation(cleanPhone)
    .then(function(conversation) {
      return createChatwootMessageSafe(conversation.id, text, 'client_note')
        .then(function() {
          if (isMiaPaused(cleanPhone)) {
            console.log('[Mia] No responde a ' + cleanPhone + ' porque este chat esta en control humano');
            return createChatwootMessageSafe(conversation.id, 'Mia esta pausada para este cliente. Mensaje recibido sin respuesta automatica.', 'system_note');
          }

          return processMessage(cleanPhone, text)
            .then(function(reply) {
              return sendWhatsApp(cleanPhone, reply)
                .then(function() {
                  return createChatwootMessageSafe(conversation.id, reply, 'mia_note');
                });
            });
        });
    })
    .catch(function(e) {
      console.error('[Chatwoot] ERROR en flujo de cliente ' + cleanPhone + ': ' + e.message);
      if (isMiaPaused(cleanPhone)) return null;
      return processMessage(cleanPhone, text)
        .then(function(reply) {
          return sendWhatsApp(cleanPhone, reply);
        });
    });
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

function analyzeProviderMessage(providerName, providerMessage) {
  var systemPrompt = [
    'Eres un analizador de mensajes de proveedores para LinkMarket, un servicio de delivery.',
    'Analiza el siguiente mensaje del proveedor "' + providerName + '" y responde UNICAMENTE con un JSON:',
    '',
    '{"tipo":"cerrado","mensaje_cliente":"texto amigable para el cliente explicando la situacion con el horario o razon si se menciona"}',
    'O si es un link de pago:',
    '{"tipo":"link_pago","link":"url del link"}',
    'O si es otro tipo de mensaje:',
    '{"tipo":"otro","reenviar_dueno":true}',
    '',
    'Palabras que indican cierre: cerrado, no atendemos, fuera de horario, no disponible, abierto desde, horario, momentos, regresamos, volvemos.',
    'Para el mensaje_cliente usa un tono amigable, incluye el horario o razon si viene en el mensaje original.',
    'Ejemplo de mensaje_cliente: "Por el momento Margarita Restaurant no está atendiendo. Retoman a las 12:00. Puedo ayudarte con algo más 😊"'
  ].join('\n');

  return callClaude([{ role: 'user', content: 'Mensaje del proveedor: ' + providerMessage }], systemPrompt)
    .then(function(response) {
      try {
        var s = response.indexOf('{');
        var e = response.lastIndexOf('}');
        if (s !== -1 && e !== -1) {
          return JSON.parse(response.substring(s, e + 1));
        }
      } catch(err) {}
      return { tipo: 'otro', reenviar_dueno: true };
    });
}

function processProviderMessage(providerPhone, message, providers) {
  var proveedor = findProviderByPhone(providerPhone, providers);
  var nombreProveedor = proveedor ? proveedor.nombre : providerPhone;

  console.log('Mensaje de proveedor ' + nombreProveedor + ': ' + message);

  if (OWNER_NUMBER) {
    var msgDueno = '📩 *Mensaje de ' + nombreProveedor + ':*\n' + message;
    sendWhatsApp(OWNER_NUMBER, msgDueno);
  }

  analyzeProviderMessage(nombreProveedor, message)
    .then(function(analysis) {
      var clienteActivo = pendingClientForProvider[providerPhone];
      if (analysis.tipo === 'cerrado' && clienteActivo) {
        sendWhatsApp(clienteActivo, analysis.mensaje_cliente);
        notifyChatwoot(clienteActivo, analysis.mensaje_cliente, 'mia_note');
      } else if (analysis.tipo === 'link_pago' && clienteActivo) {
        var msgLink = '💳 *Link de pago:*\n' + analysis.link + '\n\nUna vez completado el pago tu pedido será confirmado. ✅';
        sendWhatsApp(clienteActivo, msgLink);
        notifyChatwoot(clienteActivo, msgLink, 'mia_note');
      } else if (analysis.tipo === 'cerrado' && !clienteActivo) {
        console.log('Proveedor cerrado pero no hay cliente activo');
      }
    });

  var respuesta = '✅ Mensaje recibido. El equipo de LinkMarket está al tanto.';
  return Promise.resolve(respuesta);
}

function processMessage(userPhone, userMessage) {
  var providers = loadProviders();

  if (!conversations[userPhone]) conversations[userPhone] = { history: [], lastOrderTime: null };
  var conv = conversations[userPhone];

  if (conv.lastOrderTime && (Date.now() - conv.lastOrderTime) > 7200000) {
    conv.history = [];
    conv.lastOrderTime = null;
  }

  conv.history.push({ role: 'user', content: userMessage });

  var catalogText = buildCatalogText(providers);

  var systemPrompt = [
    'Eres "Mia", asistente de LinkMarket. LinkMarket es un servicio de delivery de confianza que gestiona pedidos y entregas de múltiples proveedores locales.',
    'Tono: amable, directo y conciso. Mensajes cortos.',
    '',
    'IDENTIDAD:',
    '- Eres Mia de LinkMarket, NO eres Margarita Restaurant ni ningún proveedor específico.',
    '- LinkMarket gestiona pedidos de varios proveedores. Por ahora tienes disponible a Margarita Restaurant.',
    '- En tu bienvenida o primer saludo preséntate exactamente como: Hola, soy Mia de LinkMarket. Luego pregunta qué necesita el cliente (comida, mandados, etc).',
    '- No te limites a ofrecer solo comida en la bienvenida. Pregunta qué necesita y luego ofrece lo disponible.',
    '',
    'CATALOGO DISPONIBLE:\n' + catalogText,
    '',
    'JUGOS DISPONIBLES: solo limon, mora y maracuya. No ofrezcas otras frutas.',
    '',
    'REGLAS DE PRECIOS:',
    '- Usa los precios del catalogo TAL CUAL. Sin margen adicional.',
    '- Envases: $0.25 por cada item en pedidos a domicilio (siempre, sin excepcion).',
    '- Delivery DENTRO de Plaza Volare: pedido < $6 cobra $0.50; pedido >= $6 cobra $1.00.',
    '- Delivery FUERA de Plaza Volare: informa que debes consultar el costo con el proveedor.',
    '',
    'PAGOS ACEPTADOS:',
    '- Efectivo al momento de la entrega',
    '- Transferencia bancaria: YOLOCORP S.A.S. | RUC: 0993367608001 | Cta Cte Produbanco: 2006168082',
    '- Tarjeta de credito: se gestiona link de pago (tarda unos minutos en llegar)',
    'IMPORTANTE: Solo menciona datos bancarios si el cliente ELIGE transferencia. Nunca en otro caso.',
    'Si elige tarjeta: confirma el pedido normalmente e indica que en unos minutos recibirá el link de pago.',
    '',
    'FLUJO DEL PEDIDO:',
    '1. Saluda como Mia de LinkMarket y pregunta en qué puedes ayudar',
    '2. Toma el pedido',
    '3. Pregunta si es en Volare o a domicilio',
    '4. Si es domicilio, pide la direccion',
    '5. Pide el nombre para el pedido',
    '6. Muestra resumen: items + envases + delivery = total',
    '7. Pregunta metodo de pago (efectivo / transferencia / tarjeta)',
    '8. Solo si elige transferencia, da los datos bancarios',
    '9. Confirma con el JSON',
    '',
    'DESCRIPCIONES: Breves y apetitosas. Max 2 lineas. Solo si el cliente pregunta.',
    '',
    'PARA CONFIRMAR UN PEDIDO responde UNICAMENTE este JSON (sin texto antes ni despues):',
    '{"accion":"pedido_confirmado","proveedor_id":"margarita","nombre_cliente":"Nombre","items":[{"nombre":"plato","cantidad":1,"precio":3.50}],"envases":0.25,"subtotal":3.50,"delivery":1.00,"total":4.75,"direccion":"direccion o Retiro en local","metodo_pago":"efectivo"}',
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
            var metodoPago = action.metodo_pago || 'efectivo';

            var itemsTexto = action.items.map(function(i) {
              return '- ' + i.cantidad + 'x ' + i.nombre + ': $' + parseFloat(i.precio).toFixed(2);
            }).join('\n');

            var envases = parseFloat(action.envases || 0).toFixed(2);
            var subtotal = parseFloat(action.subtotal).toFixed(2);
            var delivery = parseFloat(action.delivery).toFixed(2);
            var total = parseFloat(action.total).toFixed(2);
            var direccion = action.direccion || 'Retiro en local';

            if (telefonoProveedor) {
              pendingClientForProvider[telefonoProveedor] = userPhone;
              setTimeout(function() {
                if (pendingClientForProvider[telefonoProveedor] === userPhone) {
                  delete pendingClientForProvider[telefonoProveedor];
                }
              }, 1800000);
            }

            var msgProveedor = '🛒 *PEDIDO LinkMarket*\n';
            msgProveedor += '👤 *' + nombreCliente + '*\n\n';
            msgProveedor += itemsTexto + '\n\n';
            msgProveedor += '📍 ' + direccion + '\n';
            msgProveedor += '💳 *Pago: ' + metodoPago.toUpperCase() + '*\n';
            if (metodoPago.toLowerCase().includes('transferencia')) {
              msgProveedor += '⚠️ Verificar transferencia antes de entregar\n';
            }
            if (metodoPago.toLowerCase().includes('tarjeta')) {
              msgProveedor += '🔗 Por favor envía el link de pago a este chat\n';
            }
            msgProveedor += '💵 Total a cobrar: $' + total + '\n';
            msgProveedor += '📞 Cliente: +' + userPhone;

            var msgDueno = '✅ *PEDIDO CONFIRMADO*\n';
            msgDueno += '👤 ' + nombreCliente + ' | 📞 +' + userPhone + '\n';
            msgDueno += '🏪 ' + nombreProveedor + '\n\n';
            msgDueno += itemsTexto + '\n';
            msgDueno += '📦 Envases: $' + envases + '\n';
            msgDueno += '🛵 Delivery: $' + delivery + '\n';
            msgDueno += '💰 *Total: $' + total + '*\n';
            msgDueno += '💳 Pago: ' + metodoPago + '\n';
            msgDueno += '📍 ' + direccion;

            var msgLogistica = '🛵 *DELIVERY*\n';
            msgLogistica += '👤 ' + nombreCliente + '\n';
            msgLogistica += '🏪 Recoger: ' + nombreProveedor;
            if (proveedor && proveedor.ubicacion) msgLogistica += ' — ' + proveedor.ubicacion;
            msgLogistica += '\n' + itemsTexto + '\n';
            msgLogistica += '📍 Entregar: ' + direccion + '\n';
            msgLogistica += '💵 Cobrar: $' + total;

            if (telefonoProveedor) sendWhatsApp(telefonoProveedor, msgProveedor);
            if (OWNER_NUMBER) sendWhatsApp(OWNER_NUMBER, msgDueno);
            if (LOGISTICS_NUMBER && LOGISTICS_NUMBER !== telefonoProveedor) {
              sendWhatsApp(LOGISTICS_NUMBER, msgLogistica);
            }

            if (metodoPago.toLowerCase().includes('transferencia')) {
              var msgTransferencia = '🏦 *Datos para transferencia:*\n';
              msgTransferencia += 'YOLOCORP S.A.S.\n';
              msgTransferencia += 'RUC: 0993367608001\n';
              msgTransferencia += 'Cta Cte Produbanco: 2006168082\n';
              msgTransferencia += 'Monto: *$' + total + '*\n\n';
              msgTransferencia += 'Envía el comprobante aquí para confirmar tu pedido. 📎';
              setTimeout(function() {
                sendWhatsApp(userPhone, msgTransferencia);
                notifyChatwoot(userPhone, msgTransferencia, 'mia_note');
              }, 2000);
            }

            conv.lastOrderTime = Date.now();
            conv.history = [];

            var respCliente = '✅ *¡Pedido confirmado, ' + nombreCliente + '!*\n\n';
            respCliente += itemsTexto + '\n';
            respCliente += '📦 Envases: $' + envases + '\n';
            respCliente += '🛵 Delivery: $' + delivery + '\n';
            respCliente += '💰 *Total: $' + total + '*\n\n';
            respCliente += '📍 ' + direccion + '\n';
            if (metodoPago.toLowerCase().includes('tarjeta')) {
              respCliente += '💳 En unos minutos recibirás el link de pago. 🔗\n';
            }
            respCliente += '⏱ Listo en aprox. 15-20 min. 🙌';

            return respCliente;
          }

          if (action.accion === 'consultar') {
            return 'Consultando *' + action.producto + '* con el proveedor. En un momento te confirmo. 🔍';
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
  httpsPost('graph.facebook.com', '/v19.0/' + WABA_ID + '/subscribed_apps', headers, emptyBody)
    .then(function(r) { console.log('WABA suscrito:', JSON.stringify(r)); })
    .catch(function(e) { console.error('Error suscripcion WABA:', e.message); });
}

var server = http.createServer(function(req, res) {
  var parsed = url.parse(req.url, true);
  var pathname = parsed.pathname;

  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'LinkMarket v3.5 operativo' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/privacy') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>Politica de Privacidad - LinkMarket</title></head><body><h1>Politica de Privacidad - LinkMarket</h1><p>LinkMarket usa WhatsApp para recibir y responder pedidos de clientes.</p><p>Los datos procesados incluyen numero de telefono, mensajes, productos solicitados y direccion de entrega.</p><p>Estos datos se usan unicamente para gestionar pedidos y coordinar entregas.</p><p>Para solicitar acceso o eliminacion de datos escribe al mismo numero de WhatsApp o al correo aromerosecaira@hotmail.com.</p><p>Ultima actualizacion: mayo 2026.</p></body></html>');
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
                    var providers = loadProviders();
                    if (isProviderNumber(m.from, providers)) {
                      processProviderMessage(m.from, m.text.body, providers)
                        .then(function(reply) { sendWhatsApp(m.from, reply); });
                    } else {
                      handleClientWhatsAppMessage(m.from, m.text.body);
                    }
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

  if (req.method === 'POST' && pathname === '/chatwoot-webhook') {
    res.writeHead(200);
    res.end('OK');
    var chatwootBody = '';
    req.on('data', function(chunk) { chatwootBody += chunk; });
    req.on('end', function() {
      try {
        var cw = JSON.parse(chatwootBody);
        if (cw.event !== 'message_created' || !cw.content) return;

        var rawText = String(cw.content || '').trim();
        var isPrivate = cw.private === true || (cw.message && cw.message.private === true);
        var msgType = cw.message_type || (cw.message && cw.message.message_type);
        var conversation = cw.conversation || {};
        var contact = conversation.contact || cw.contact || (conversation.meta && conversation.meta.sender) || {};
        var phoneRaw = contact.phone_number || contact.identifier || '';
        var fromPhone = normalizePhone(phoneRaw);

        if (!fromPhone) {
          console.log('[Chatwoot] Webhook sin telefono util. Payload omitido.');
          return;
        }

        // COMANDOS EN NOTA PRIVADA:
        // WA: texto        -> envia texto al WhatsApp y pausa Mia SOLO en este chat.
        // MIA ON          -> devuelve este chat a Mia.
        // MIA OFF         -> pausa Mia en este chat sin enviar mensaje.
        if (isPrivate && /^WA\s*:/i.test(rawText)) {
          var humanText = rawText.replace(/^WA\s*:/i, '').trim();
          if (!humanText) return;
          sendWhatsApp(fromPhone, humanText).then(function() {
            pauseMia(fromPhone, 60);
            notifyChatwoot(fromPhone, humanText, 'human_note');
          });
          return;
        }

        if (isPrivate && /^(MIA\s*ON|BOT\s*ON|DEVOLVER\s+A\s+MIA)$/i.test(rawText)) {
          resumeMia(fromPhone);
          notifyChatwoot(fromPhone, 'Mia fue reactivada para este cliente. A partir del próximo mensaje del cliente, responderá automáticamente.', 'system_note');
          return;
        }

        if (isPrivate && /^(MIA\s*OFF|BOT\s*OFF|PAUSAR\s+MIA)$/i.test(rawText)) {
          pauseMia(fromPhone, 60);
          notifyChatwoot(fromPhone, 'Mia fue pausada para este cliente por 60 minutos.', 'system_note');
          return;
        }

        // Si Chatwoot permite una respuesta publica normal, tambien la enviamos a WhatsApp y pausamos Mia SOLO para ese cliente.
        // Ignoramos los registros generados por el propio sistema para evitar bucles.
        if (!isPrivate && msgType === 'outgoing') {
          if (rawText.indexOf('[MIA ENVIADO POR WHATSAPP]') === 0) return;
          if (rawText.indexOf('[CLIENTE WHATSAPP]') === 0) return;
          if (rawText.indexOf('[HUMANO ENVIADO POR WHATSAPP]') === 0) return;
          if (rawText.indexOf('[SISTEMA]') === 0) return;

          sendWhatsApp(fromPhone, rawText).then(function() {
            pauseMia(fromPhone, 60);
          });
          return;
        }
      } catch(e) { console.error('Error chatwoot-webhook: ' + e.message); }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, function() {
  console.log('LinkMarket v3.5 corriendo en puerto ' + PORT);
  subscribeWABA();
});
