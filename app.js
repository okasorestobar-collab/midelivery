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
var OWNER_NUMBER = process.env.OWNER_NUMBER || '593999610313';
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
var pendingOwnerConsult = {}; // Respuestas pendientes del dueño hacia clientes
var CLIENTS_FILE = './clients.json';

function loadProviders() {
  try {
    return JSON.parse(fs.readFileSync('./providers.json', 'utf8'));
  } catch(e) {
    return [];
  }
}

function loadClients() {
  try {
    return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'));
  } catch(e) {
    return {};
  }
}

function saveClients(clients) {
  try {
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2), 'utf8');
  } catch(e) {
    console.error('[Clientes] No se pudo guardar clients.json: ' + e.message);
  }
}

function getClientRecord(phoneNumber) {
  var cleanPhone = normalizePhone(phoneNumber);
  var clients = loadClients();
  if (!clients[cleanPhone]) {
    clients[cleanPhone] = {
      phone: cleanPhone,
      name: '',
      first_seen: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      last_order: '',
      notes: []
    };
    saveClients(clients);
  }
  return clients[cleanPhone];
}

function updateClientRecord(phoneNumber, updates) {
  var cleanPhone = normalizePhone(phoneNumber);
  var clients = loadClients();
  var rec = clients[cleanPhone] || {
    phone: cleanPhone,
    name: '',
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
    last_order: '',
    notes: []
  };
  Object.keys(updates || {}).forEach(function(k) { rec[k] = updates[k]; });
  rec.last_seen = new Date().toISOString();
  clients[cleanPhone] = rec;
  saveClients(clients);
  return rec;
}

function extractPossibleName(text) {
  var t = String(text || '').trim();
  var m = t.match(/(?:me\s+llamo|mi\s+nombre\s+es|soy)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,}(?:\s+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,})?)/i);
  if (!m) return '';
  var name = m[1].trim();
  name = name.replace(/[.,;:!¡?¿].*$/, '').trim();
  if (/^(cliente|buenas|hola|yo|de|el|la|un|una)$/i.test(name)) return '';
  return name;
}

function updateClientNameFromMessage(phoneNumber, text) {
  var detected = extractPossibleName(text);
  if (!detected) return getClientRecord(phoneNumber);
  var rec = getClientRecord(phoneNumber);
  if (!rec.name) {
    return updateClientRecord(phoneNumber, { name: detected });
  }
  return rec;
}

function getEcuadorDateTimeText() {
  try {
    var now = new Date();
    var date = new Intl.DateTimeFormat('es-EC', {
      timeZone: 'America/Guayaquil',
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    }).format(now);
    var time = new Intl.DateTimeFormat('es-EC', {
      timeZone: 'America/Guayaquil',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(now);
    return date + ', ' + time + ' (hora de Ecuador)';
  } catch(e) {
    return new Date().toISOString();
  }
}


function getEcuadorShortDateTimeText() {
  try {
    var now = new Date();
    var date = new Intl.DateTimeFormat('es-EC', {
      timeZone: 'America/Guayaquil',
      day: '2-digit', month: '2-digit', year: 'numeric'
    }).format(now);
    var time = new Intl.DateTimeFormat('es-EC', {
      timeZone: 'America/Guayaquil',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(now);
    return date + ' ' + time;
  } catch(e) {
    return new Date().toISOString();
  }
}

function formatChatwootNote(title, message) {
  // Chatwoot no permite ubicar la hora exactamente en la esquina inferior como WhatsApp,
  // pero aquí queda al final del texto, pequeña y discreta.
  return '**' + title + '**\n' + message + '\n\n_' + getEcuadorShortDateTimeText() + '_';
}

function isSystemGeneratedChatwootNote(rawText) {
  var text = String(rawText || '').trim();
  if (!text) return true;

  // Ignora notas creadas por el propio app para evitar bucles.
  // Chatwoot a veces entrega el contenido con markdown y a veces sin markdown.
  if (/^\*\*Mia\*\*/i.test(text)) return true;
  if (/^Mia\s*\n/i.test(text)) return true;
  if (/^\*\*Central\*\*/i.test(text)) return true;
  if (/^Central\s*\n/i.test(text)) return true;
  if (/^\*\*sistema\*\*/i.test(text)) return true;
  if (/^sistema\s*\n/i.test(text)) return true;
  if (/^\*\*\+?\d+\*\*/i.test(text)) return true;
  if (/^\+?\d{7,}\s*\n/i.test(text)) return true;
  if (/^\[MIA ENVIADO POR WHATSAPP\]/i.test(text)) return true;
  if (/^\[CLIENTE WHATSAPP\]/i.test(text)) return true;
  if (/^\[HUMANO ENVIADO POR WHATSAPP\]/i.test(text)) return true;
  if (/^\[SISTEMA\]/i.test(text)) return true;

  return false;
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

function httpsPut(hostname, path, headers, body) {
  return new Promise(function(resolve, reject) {
    var options = { hostname: hostname, path: path, method: 'PUT', headers: headers };
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
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


function isBadContactName(name) {
  var n = String(name || '').trim();
  if (!n) return true;
  if (n === '.' || n === '-' || n === '_') return true;
  if (/^cliente\s*$/i.test(n)) return true;
  if (/^cliente\s*\+?\d+$/i.test(n)) return true;
  return false;
}

function getContactDisplayName(contact, fallbackPhone) {
  var cleanPhone = normalizePhone(fallbackPhone);
  if (contact && contact.name && !isBadContactName(contact.name)) return contact.name;
  if (contact && contact.phone_number) return contact.phone_number;
  if (cleanPhone) return '+' + cleanPhone;
  return 'cliente';
}

function getConversationDisplayName(conversation, fallbackPhone) {
  var contact = conversation && conversation.__contact ? conversation.__contact : null;
  if (!contact && conversation && conversation.meta && conversation.meta.sender) contact = conversation.meta.sender;
  if (!contact && conversation && conversation.contact) contact = conversation.contact;
  return getContactDisplayName(contact, fallbackPhone);
}

function updateChatwootContactNameIfNeeded(contact, phoneNumber) {
  if (!contact || !contact.id) return Promise.resolve(contact);

  var cleanPhone = normalizePhone(phoneNumber);
  var desiredName = '+' + cleanPhone;

  if (!isBadContactName(contact.name)) {
    return Promise.resolve(contact);
  }

  var body = JSON.stringify({
    name: desiredName,
    phone_number: '+' + cleanPhone,
    identifier: cleanPhone
  });

  return httpsPut(
    CHATWOOT_URL,
    '/api/v1/accounts/' + CHATWOOT_ACCOUNT_ID + '/contacts/' + contact.id,
    chatwootHeaders(body),
    body
  ).then(function(result) {
    console.log('[Chatwoot] Nombre de contacto actualizado a: ' + desiredName);
    return getChatwootContactById(contact.id).then(function(updated) {
      return updated && updated.id ? updated : contact;
    });
  }).catch(function(e) {
    console.error('[Chatwoot] No se pudo actualizar nombre de contacto: ' + e.message);
    return contact;
  });
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
    name: '+' + cleanPhone,
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
    })
    .then(function(contact) {
      return updateChatwootContactNameIfNeeded(contact, phoneNumber);
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
            selected.__contact = contact;
            console.log('[Chatwoot] Conversacion existente ID: ' + selected.id + ' | contact_id: ' + contact.id);
            return selected;
          }

          return createChatwootConversation(contact, phoneNumber).then(function(conversation) {
            conversation.__contact = contact;
            return conversation;
          });
        });
    });
}

function createChatwootMessage(conversationId, message, messageType, displayName) {
  var type = messageType || 'mia_note';
  var bodyObj;
  var cleanDisplay = String(displayName || '').trim();
  if (!cleanDisplay) cleanDisplay = 'cliente';

  if (type === 'client_public') {
    bodyObj = {
      content: message,
      message_type: 'incoming',
      private: false,
      content_type: 'text',
      content_attributes: {}
    };
  } else if (type === 'client_note') {
    bodyObj = {
      content: formatChatwootNote(cleanDisplay, message),
      message_type: 'outgoing',
      private: true,
      content_type: 'text',
      content_attributes: {}
    };
  } else if (type === 'mia_note') {
    bodyObj = {
      content: formatChatwootNote('Mia', message),
      message_type: 'outgoing',
      private: true,
      content_type: 'text',
      content_attributes: {}
    };
  } else if (type === 'human_note') {
    bodyObj = {
      content: formatChatwootNote('Central', message),
      message_type: 'outgoing',
      private: true,
      content_type: 'text',
      content_attributes: {}
    };
  } else if (type === 'system_note') {
    bodyObj = {
      content: formatChatwootNote('sistema', message),
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

function createChatwootMessageSafe(conversationId, message, messageType, displayName) {
  return createChatwootMessage(conversationId, message, messageType, displayName)
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
  updateClientNameFromMessage(cleanPhone, text);

  return ensureChatwootConversation(cleanPhone)
    .then(function(conversation) {
      var displayName = '+' + cleanPhone;

      return createChatwootMessageSafe(conversation.id, text, 'client_note', displayName)
        .then(function() {
          if (isMiaPaused(cleanPhone)) {
            console.log('[Mia] No responde a ' + cleanPhone + ' porque este chat esta en control humano');
            return createChatwootMessageSafe(conversation.id, 'Mia esta pausada solo para este cliente. Mensaje recibido sin respuesta automatica.', 'system_note');
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


function sendOwnerConsultRequest(clientPhone, product, originalMessage) {
  var cleanClient = normalizePhone(clientPhone);
  var rec = getClientRecord(cleanClient);
  pendingOwnerConsult[OWNER_NUMBER] = {
    clientPhone: cleanClient,
    product: product || '',
    originalMessage: originalMessage || '',
    createdAt: Date.now()
  };

  var msg = '🔎 *Consulta para Central*\n';
  msg += 'Cliente: +' + cleanClient + (rec.name ? ' (' + rec.name + ')' : '') + '\n';
  msg += 'Pidió/consultó: ' + (originalMessage || product || 'consulta sin detalle') + '\n\n';
  msg += 'Respóndeme por aquí y Mia se lo transmitirá al cliente con su tono.';

  if (OWNER_NUMBER) sendWhatsApp(OWNER_NUMBER, msg);
  console.log('[Central] Consulta enviada al dueño para cliente +' + cleanClient);
}

function processOwnerConsultReply(ownerPhone, ownerMessage) {
  var pending = pendingOwnerConsult[OWNER_NUMBER] || pendingOwnerConsult[normalizePhone(ownerPhone)];
  if (!pending || !pending.clientPhone) return Promise.resolve(false);

  delete pendingOwnerConsult[OWNER_NUMBER];
  delete pendingOwnerConsult[normalizePhone(ownerPhone)];

  var clientPhone = pending.clientPhone;
  var rec = getClientRecord(clientPhone);
  var systemPrompt = [
    'Eres Mia de LinkMarket.',
    'Debes convertir la respuesta de Central en un mensaje amable, claro y comercial para el cliente.',
    'No digas que eres Central. Habla como Mia.',
    'Mantén el tono cálido, útil, con emojis moderados.',
    'Cliente: ' + (rec.name || ('+' + clientPhone)),
    'Consulta original del cliente: ' + (pending.originalMessage || ''),
    'Respuesta de Central: ' + ownerMessage
  ].join('\n');

  return callClaude([{ role: 'user', content: ownerMessage }], systemPrompt)
    .then(function(reply) {
      return sendWhatsApp(clientPhone, reply).then(function() {
        return notifyChatwoot(clientPhone, reply, 'mia_note');
      });
    })
    .then(function() {
      console.log('[Central] Respuesta del dueño transmitida al cliente +' + clientPhone);
      return true;
    })
    .catch(function(e) {
      console.error('[Central] Error transmitiendo respuesta del dueño: ' + e.message);
      return false;
    });
}

function processMessage(userPhone, userMessage) {
  var providers = loadProviders();

  if (!conversations[userPhone]) conversations[userPhone] = { history: [], lastOrderTime: null, messageCount: 0 };
  var conv = conversations[userPhone];
  conv.messageCount = (conv.messageCount || 0) + 1;
  var clientRecord = getClientRecord(userPhone);
  var fechaHoraEcuador = getEcuadorDateTimeText();

  if (conv.lastOrderTime && (Date.now() - conv.lastOrderTime) > 7200000) {
    conv.history = [];
    conv.lastOrderTime = null;
  }

  conv.history.push({ role: 'user', content: userMessage });

  var catalogText = buildCatalogText(providers);

  var systemPrompt = [
    'Eres "Mia", asistente de LinkMarket. LinkMarket es un servicio de delivery de confianza que gestiona pedidos y entregas de múltiples proveedores locales.',
    'Tono: amable, directo y conciso. Mensajes cortos, pero cálidos. Usa emojis moderados y variados cuando ayuden a sonar cercano, sin saturar.',
    '',
    'IDENTIDAD:',
    '- Eres Mia de LinkMarket, NO eres Margarita Restaurant ni ningún proveedor específico.',
    '- LinkMarket gestiona pedidos de varios proveedores. Por ahora tienes disponible a Margarita Restaurant.',
    '- En tu bienvenida o primer saludo preséntate exactamente como: Hola, soy Mia de LinkMarket. Luego pregunta qué necesita el cliente (comida, mandados, etc).',
    '- No te limites a ofrecer solo comida en la bienvenida. Pregunta qué necesita y luego ofrece lo disponible.',
    '',
    'CONTEXTO ACTUAL:',
    '- Fecha y hora actual: ' + fechaHoraEcuador + '.',
    '- Numero del cliente: +' + userPhone + '.',
    '- Nombre registrado del cliente: ' + (clientRecord.name || 'SIN NOMBRE REGISTRADO') + '.',
    '- Ultimo pedido registrado: ' + (clientRecord.last_order || 'sin pedido anterior registrado') + '.',
    '- Mensaje numero ' + conv.messageCount + ' de esta conversacion activa.',
    '',
    'MEMORIA Y APEGO CON CLIENTE:',
    '- Si el cliente no tiene nombre registrado, en el primer o segundo mensaje pide su nombre de forma natural, sin frenar la venta. Ejemplo: Por cierto, ¿a qué nombre te atiendo?',
    '- Si ya tiene nombre registrado, úsalo ocasionalmente y con naturalidad, no en cada mensaje.',
    '- Si hay ultimo pedido registrado y aplica, puedes mencionarlo con gracia: ¿Hoy repetimos como la otra vez?',
    '- Si el cliente dice llamarse distinto y ya hay nombre registrado, responde con picardia suave: Pensaba que te llamabas ' + (clientRecord.name || '...') + ', eso me dijiste la ultima vez 😄. Igual te actualizo.',
    '',
    'CONSULTAS GENERALES:',
    '- Si preguntan la hora o fecha, responde usando la fecha y hora actual del contexto. No digas que vas a consultar al proveedor por eso.',
    '- Si preguntan algo no relacionado con comprar bienes o servicios, responde de forma breve, amable y con algo de picardia; luego trae la conversacion sutilmente de vuelta a lo que puede pedir por LinkMarket.',
    '- No inventes datos actuales en vivo como marcadores de futbol, noticias o clima. Si no tienes el dato en vivo, dilo con gracia y vuelve a enfocar en el pedido.',
    '',
    'CONSULTAS A PROVEEDOR O CENTRAL:',
    '- Solo responde con {"accion":"consultar"} cuando sea una consulta real de compra, disponibilidad, precio, pedido especial, producto o servicio legal que necesita confirmacion.',
    '- No uses consultar para hora, fecha, bromas, futbol, preguntas generales o temas que no requieren proveedor.',
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

            updateClientRecord(userPhone, {
              name: nombreCliente && nombreCliente !== 'Sin nombre' ? nombreCliente : (clientRecord.name || ''),
              last_order: itemsTexto.replace(/\n/g, ' | ') + ' | Total: $' + total,
              last_order_at: new Date().toISOString()
            });

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
            sendOwnerConsultRequest(userPhone, action.producto || userMessage, userMessage);
            return 'Déjame confirmar eso con Central para no inventarte nada 🔎. Dame un momento y te aviso por aquí mismo.';
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
                    if (OWNER_NUMBER && normalizePhone(m.from) === normalizePhone(OWNER_NUMBER) && (pendingOwnerConsult[OWNER_NUMBER] || pendingOwnerConsult[normalizePhone(m.from)])) {
                      processOwnerConsultReply(m.from, m.text.body);
                      return;
                    }
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
        // MIA ON          -> devuelve este chat a Mia.
        // MIA OFF         -> pausa Mia en este chat sin enviar mensaje.
        // Cualquier otra nota privada escrita por un humano se envia al WhatsApp del cliente como Central.
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

        if (isPrivate) {
          // Seguridad anti-bucle: las notas privadas normales NO se envían al cliente.
          // Solo se envía si el humano escribe explícitamente WA: o Central:
          // Esto evita que las notas que crea el propio sistema se reenvíen infinitamente.
          if (isSystemGeneratedChatwootNote(rawText)) return;

          if (!/^(WA|CENTRAL)\s*:/i.test(rawText)) {
            console.log('[Chatwoot] Nota privada ignorada porque no empieza con WA: o Central:');
            return;
          }

          var humanText = rawText.replace(/^(WA|CENTRAL)\s*:/i, '').trim();
          if (!humanText) return;

          sendWhatsApp(fromPhone, humanText).then(function() {
            pauseMia(fromPhone, 60);
            notifyChatwoot(fromPhone, humanText, 'human_note');
          });
          return;
        }

        // Si Chatwoot permite una respuesta publica normal, tambien la enviamos a WhatsApp y pausamos Mia SOLO para ese cliente.
        // Ignoramos los registros generados por el propio sistema para evitar bucles.
        if (!isPrivate && msgType === 'outgoing') {
          if (isSystemGeneratedChatwootNote(rawText)) return;

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
  console.log('LinkMarket v3.5-v11 corriendo en puerto ' + PORT);
  subscribeWABA();
});
