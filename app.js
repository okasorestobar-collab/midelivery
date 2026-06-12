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
var pendingBrokerConsult = {}; // Respuestas pendientes del corredor inmobiliario hacia interesados
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

function looksLikeStandaloneName(text) {
  var t = String(text || '').trim();
  if (!t) return '';
  if (t.length < 2 || t.length > 35) return '';
  if (/[0-9@#$%&*/_=+{}\[\]<>|]/.test(t)) return '';
  if (/[?¿!¡]/.test(t)) return '';

  var lower = t.toLowerCase();
  var blocked = [
    'hola','buenas','buenos dias','buenas tardes','buenas noches','gracias','ok','okay','dale','listo','si','sí','no',
    'encebollado','ceviche','bollo','alitas','hamburguesa','burger','burguer','moro','chuleta','mandado','menu','menú','pedido','delivery','domicilio','plaza','volare','envio','envío','enviar','enviame','envíame','retiro','retirar','local','direccion','dirección','villa','manzana','mz','calle','urbanizacion','urbanización','club','villa club','pago','transferencia','tarjeta','efectivo','si claro','claro','perfecto','joya','okey',
    'un bollo','una bollo','un encebollado','una guatita','un caldo','caldo de salchicha','caldo','para llevar','a domicilio','retiro en local'
  ];
  for (var i = 0; i < blocked.length; i++) {
    if (lower === blocked[i] || lower.indexOf(blocked[i] + ' ') === 0) return '';
  }

  // No aceptar como nombre frases que parecen pedido, dirección, pago o instrucción operativa.
  if (/(quiero|dame|env[ií]a|manda|lleva|pedido|plato|comida|caldo|bollo|alitas|guatita|encebollado|moro|chuleta|salsa|salsas|transfer|pago|tarjeta|efectivo|villa|mz|manzana|direcci[oó]n|domicilio|local|volare|club)/i.test(t)) return '';

  var words = t.split(/\s+/).filter(Boolean);
  if (words.length > 3) return '';
  for (var j = 0; j < words.length; j++) {
    if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,}$/.test(words[j])) return '';
  }

  return words.map(function(w) {
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

function sanitizeClientNameCandidate(name) {
  var n = String(name || '').trim();
  if (!n) return '';
  var explicit = extractPossibleName('me llamo ' + n);
  if (explicit) return explicit;
  return looksLikeStandaloneName(n);
}

function isRealManualContactName(name) {
  var n = String(name || '').trim();
  if (!n) return false;
  if (isBadContactName(n)) return false;
  if (/^\+?\d{7,}$/.test(n)) return false;
  return !!sanitizeClientNameCandidate(n);
}

function updateClientNameFromMessage(phoneNumber, text) {
  var rec = getClientRecord(phoneNumber);
  var detected = extractPossibleName(text);

  if (!detected && rec.asked_name_pending) {
    detected = looksLikeStandaloneName(text);
  }

  if (!detected) return rec;

  var updates = {
    name: detected,
    asked_name_pending: false
  };

  if (rec.name && rec.name.toLowerCase() !== detected.toLowerCase()) {
    updates.previous_name = rec.name;
    updates.name_changed_at = new Date().toISOString();
  }

  return updateClientRecord(phoneNumber, updates);
}

function shouldAskClientName(phoneNumber, conv) {
  var rec = getClientRecord(phoneNumber);
  if (rec.name) return false;
  if (rec.asked_name_pending) return false;
  return (conv.messageCount || 0) <= 2;
}

function isProbablyEnglish(text) {
  var t = String(text || '').toLowerCase();
  if (/\b(apartment|house|rent|rental|bedroom|bedrooms|bath|bathroom|move|moving|budget|voucher|parking|pets|lease|available|photos|pictures|showing|visit)\b/i.test(t)) return true;
  if (/\b(hello|hi|good morning|good afternoon|i need|i am looking|looking for|do you have)\b/i.test(t)) return true;
  return false;
}

function appendNameQuestionIfNeeded(phoneNumber, conv, reply) {
  if (!shouldAskClientName(phoneNumber, conv)) return reply;
  var text = String(reply || '');

  // Nunca añadir pregunta de nombre a respuestas JSON internas.
  if (/\{\s*"accion"\s*:/i.test(text)) return reply;

  // No mezclar la pregunta del nombre con preguntas operativas del pedido o de alquileres.
  // Ejemplo del error anterior: Mia preguntaba retiro/envío y también nombre; el cliente respondió "Envío" y el sistema lo tomó como nombre.
  var operationalQuestion = /(retiro|retiras|local|domicilio|env[ií]o|delivery|direcci[oó]n|a d[oó]nde|d[oó]nde te lo|forma de pago|m[eé]todo de pago|efectivo|transferencia|tarjeta|total|resumen|salsa|salsas|apartamento|casa|renta|alquiler|habitaci[oó]n|habitaciones|baños|baths|bedrooms|apartment|house|rent|rental|budget|presupuesto|voucher|parking|mascotas|pets|visita|showing|fotos|photos)/i.test(text);
  if (operationalQuestion) return reply;

  if (/nombre|te atiendo|a nombre de|me dices tu nombre|me regalas tu nombre|what'?s your name|your name/i.test(text)) {
    updateClientRecord(phoneNumber, { asked_name_pending: true });
    return reply;
  }
  updateClientRecord(phoneNumber, { asked_name_pending: true });
  var lastUserText = '';
  try {
    if (conv && conv.history && conv.history.length) {
      for (var i = conv.history.length - 1; i >= 0; i--) {
        if (conv.history[i].role === 'user') { lastUserText = conv.history[i].content || ''; break; }
      }
    }
  } catch(e) {}
  if (isProbablyEnglish(lastUserText || text)) return text + '\n\nBy the way, what\'s your name? 😊';
  return text + '\n\nPor cierto, ¿me dices tu nombre porfa? 😊';
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
  // Chatwoot no permite ubicar la hora exactamente en la esquina inferior como WhatsApp.
  // Se deja al final del mensaje, discreta y sin etiquetas HTML que Chatwoot muestra como texto.
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


function isRealEstateProvider(provider) {
  return provider && String(provider.tipo_negocio || '').toLowerCase() === 'real_estate_demo';
}

function isProviderNumber(phone, providers) {
  var clean = normalizePhone(phone);
  return (providers || []).some(function(p) {
    if (p.es_proveedor_externo === false) return false;
    return normalizePhone(p.telefono) === clean;
  });
}

function findProviderByPhone(phone, providers) {
  var clean = normalizePhone(phone);
  return (providers || []).find(function(p) {
    if (p.es_proveedor_externo === false) return false;
    return normalizePhone(p.telefono) === clean;
  }) || null;
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

function getWhatsAppMediaInfo(m) {
  if (!m || !m.type || m.type === 'text' || m.type === 'audio') return null;

  var media = m[m.type] || {};

  if (!media.id) return null;

  return {
    type: m.type,
    id: media.id,
    mime_type: media.mime_type || '',
    caption: media.caption || '',
    filename: media.filename || '',
    sha256: media.sha256 || ''
  };
}

function getMediaTypeLabel(type) {
  var t = String(type || '').toLowerCase();
  if (t === 'image') return 'imagen';
  if (t === 'document') return 'documento/archivo';
  if (t === 'video') return 'video';
  if (t === 'sticker') return 'sticker';
  if (t === 'contacts') return 'contacto';
  if (t === 'location') return 'ubicación';
  return t || 'archivo';
}

function findMargaritaProvider(providers) {
  providers = providers || [];
  for (var i = 0; i < providers.length; i++) {
    var p = providers[i];
    if (String(p.id || '').toLowerCase() === 'margarita') return p;
  }
  for (var j = 0; j < providers.length; j++) {
    var p2 = providers[j];
    if (String(p2.nombre || '').toLowerCase().indexOf('margarita') !== -1) return p2;
  }
  return null;
}

function buildMediaSummaryForProvider(clientPhone, mediaInfo) {
  var label = getMediaTypeLabel(mediaInfo.type);
  var lines = [];
  lines.push('📎 *Archivo recibido de cliente LinkMarket*');
  lines.push('Cliente: +' + normalizePhone(clientPhone));
  lines.push('Tipo: ' + label);
  if (mediaInfo.filename) lines.push('Archivo: ' + mediaInfo.filename);
  if (mediaInfo.mime_type) lines.push('Formato: ' + mediaInfo.mime_type);
  if (mediaInfo.caption) lines.push('Mensaje/caption: ' + mediaInfo.caption);
  lines.push('Por favor revisar y confirmar si sirve para verificar el pedido/pago.');
  return lines.join('\n');
}

function sendWhatsAppMedia(to, mediaInfo, caption) {
  var type = mediaInfo.type;
  var bodyObj = {
    messaging_product: 'whatsapp',
    to: to,
    type: type
  };

  bodyObj[type] = { id: mediaInfo.id };

  if ((type === 'image' || type === 'video' || type === 'document') && caption) {
    bodyObj[type].caption = caption;
  }

  if (type === 'document' && mediaInfo.filename) {
    bodyObj[type].filename = mediaInfo.filename;
  }

  var body = JSON.stringify(bodyObj);
  var headers = {
    'Authorization': 'Bearer ' + WHATSAPP_TOKEN,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  };

  return httpsPost('graph.facebook.com', '/v19.0/' + PHONE_NUMBER_ID + '/messages', headers, body)
    .then(function(r) {
      console.log('Media ' + type + ' enviado a ' + to);
      return r;
    })
    .catch(function(e) {
      console.error('Error enviando media: ' + e.message);
      return null;
    });
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
  var rec = getClientRecord(cleanPhone);
  var currentName = String(contact.name || '').trim();
  var storedName = sanitizeClientNameCandidate(rec.name || '');

  // Regla de seguridad: si el contacto fue corregido manualmente en Chatwoot con un nombre válido,
  // NO volver a pisarlo con un nombre que Mia haya tomado por error. También sincroniza ese nombre manual a clients.json.
  if (isRealManualContactName(currentName) && currentName !== storedName) {
    updateClientRecord(cleanPhone, {
      name: currentName,
      asked_name_pending: false,
      name_source: 'chatwoot_manual',
      name_synced_from_chatwoot_at: new Date().toISOString()
    });
    return Promise.resolve(contact);
  }

  var desiredName = storedName || ('+' + cleanPhone);

  if (currentName === desiredName) {
    return Promise.resolve(contact);
  }

  // Solo actualiza Chatwoot si el nombre actual es basura/punto/número, o si tenemos un nombre claramente válido.
  if (!isBadContactName(currentName) && !/^\+?\d{7,}$/.test(currentName) && !storedName) {
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
  var rec = getClientRecord(cleanPhone);
  var contactName = rec.name || ('+' + cleanPhone);
  var body = JSON.stringify({
    inbox_id: CHATWOOT_INBOX_ID,
    name: contactName,
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
      content: formatChatwootNote('CENTRAL', message),
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
  var clientRec = updateClientNameFromMessage(cleanPhone, text);

  return ensureChatwootConversation(cleanPhone)
    .then(function(conversation) {
      var latestClient = getClientRecord(cleanPhone);
      var displayName = latestClient.name || ('+' + cleanPhone);

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

function handleClientMediaMessage(m, providers) {
  var cleanPhone = normalizePhone(m.from);
  var mediaInfo = getWhatsAppMediaInfo(m);
  var latestClient = updateClientRecord(cleanPhone, {});
  var displayName = latestClient.name || ('+' + cleanPhone);

  if (!mediaInfo) {
    var unsupportedMsg = 'Por ahora no puedo procesar audios desde aquí 🙏. Escríbeme el pedido o la consulta por texto y te ayudo enseguida.';
    return ensureChatwootConversation(cleanPhone)
      .then(function(conversation) {
        return createChatwootMessageSafe(conversation.id, 'El cliente envió un audio o archivo no procesable automáticamente.', 'client_note', displayName)
          .then(function() {
            return sendWhatsApp(cleanPhone, unsupportedMsg).then(function() {
              return createChatwootMessageSafe(conversation.id, unsupportedMsg, 'mia_note');
            });
          });
      })
      .catch(function(e) {
        console.error('[Media] Error manejando audio/no soportado: ' + e.message);
        return sendWhatsApp(cleanPhone, unsupportedMsg);
      });
  }

  var label = getMediaTypeLabel(mediaInfo.type);
  var clientNote = 'Envió ' + label + ' para revisión.';
  if (mediaInfo.filename) clientNote += '\nArchivo: ' + mediaInfo.filename;
  if (mediaInfo.caption) clientNote += '\nTexto adjunto: ' + mediaInfo.caption;

  var margarita = findMargaritaProvider(providers || []);
  var targetPhone = margarita && margarita.telefono ? margarita.telefono : OWNER_NUMBER;
  var summary = buildMediaSummaryForProvider(cleanPhone, mediaInfo);
  var clientReply = 'Recibí tu ' + label + ' 👍. Se lo envío a Margarita para verificación y te confirmo enseguida.';

  return ensureChatwootConversation(cleanPhone)
    .then(function(conversation) {
      return createChatwootMessageSafe(conversation.id, clientNote, 'client_note', displayName)
        .then(function() {
          return sendWhatsApp(targetPhone, summary);
        })
        .then(function() {
          if (mediaInfo.type === 'contacts' || mediaInfo.type === 'location') {
            return null;
          }
          return sendWhatsAppMedia(targetPhone, mediaInfo, 'Archivo del cliente +' + cleanPhone + ' para verificación.');
        })
        .then(function() {
          return sendWhatsApp(cleanPhone, clientReply);
        })
        .then(function() {
          return createChatwootMessageSafe(conversation.id, clientReply, 'mia_note');
        });
    })
    .catch(function(e) {
      console.error('[Media] Error manejando archivo de cliente ' + cleanPhone + ': ' + e.message);
      return sendWhatsApp(cleanPhone, clientReply);
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
  (providers || []).forEach(function(prov) {
    text += 'PROVEEDOR: ' + prov.nombre + ' (ID: ' + prov.id + ')\n';
    if (prov.tipo_negocio) text += 'Tipo de negocio: ' + prov.tipo_negocio + '\n';
    if (prov.descripcion) text += 'Descripcion: ' + prov.descripcion + '\n';
    text += 'Ubicacion: ' + (prov.ubicacion || '') + '\n';
    text += 'Telefono: ' + (prov.telefono || '') + '\n';

    if (Array.isArray(prov.productos) && prov.productos.length) {
      prov.productos.forEach(function(cat) {
        text += '\n[' + cat.categoria + ']\n';
        (cat.items || []).forEach(function(item) {
          text += '- ' + item.nombre + ': $' + parseFloat(item.precio || 0).toFixed(2);
          if (item.descripcion) text += ' | ' + item.descripcion;
          text += '\n';
        });
      });
    }

    if (Array.isArray(prov.propiedades) && prov.propiedades.length) {
      text += '\n[PROPIEDADES DISPONIBLES / RENTAL LISTINGS]\n';
      prov.propiedades.forEach(function(p) {
        text += '- ID ' + p.id + ' | ' + p.tipo + ' | ' + p.ciudad + ' | ' + p.direccion +
          ' | ' + p.habitaciones + ' hab/bed | ' + p.banos + ' baño/bath | $' + p.precio_mensual + '/mes' +
          ' | Depósito: ' + p.deposito + ' | Disponible: ' + p.disponible +
          ' | Parking: ' + p.parking + ' | Mascotas/Pets: ' + p.mascotas +
          ' | Voucher: ' + p.voucher + ' | Requisitos: ' + p.requisitos;
        if (p.descripcion) text += ' | ' + p.descripcion;
        text += '\n';
      });
    }

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



function findRealEstateProvider(providers) {
  providers = providers || loadProviders();
  for (var i = 0; i < providers.length; i++) {
    if (isRealEstateProvider(providers[i])) return providers[i];
  }
  return null;
}

function sendBrokerConsultRequest(clientPhone, provider, topic, originalMessage) {
  provider = provider || findRealEstateProvider(loadProviders());
  if (!provider || !provider.telefono) {
    sendOwnerConsultRequest(clientPhone, topic, originalMessage);
    return;
  }

  var cleanClient = normalizePhone(clientPhone);
  var brokerPhone = normalizePhone(provider.notificar_a || provider.telefono);
  var rec = getClientRecord(cleanClient);
  var question = originalMessage || topic || 'consulta inmobiliaria sin detalle';

  pendingBrokerConsult[brokerPhone] = {
    clientPhone: cleanClient,
    providerId: provider.id,
    providerName: provider.nombre,
    originalMessage: question,
    createdAt: Date.now()
  };

  updateClientRecord(cleanClient, {
    real_estate_pending: true,
    broker_last_question: question,
    broker_last_question_at: new Date().toISOString()
  });

  var msg = '🏠 *Consulta demo inmobiliaria - LinkMarket*\n';
  msg += 'Cliente interesado: +' + cleanClient + (rec.name ? ' (' + rec.name + ')' : '') + '\n';
  msg += 'Consulta / solicitud: ' + question + '\n\n';
  msg += 'Si pide fotos, por ahora envíalas directamente al interesado por WhatsApp.\n';
  msg += 'Si pide visita, confirma día y hora disponible.\n\n';
  msg += 'Respóndeme por aquí y Mia transmitirá tu respuesta al interesado.';

  sendWhatsApp(brokerPhone, msg);
  notifyChatwoot(cleanClient, 'Consulta enviada al CORREDOR:\n' + question + '\n\nCorredor: +' + brokerPhone, 'system_note');
  console.log('[Rentas NJ] Consulta enviada al corredor +' + brokerPhone + ' para cliente +' + cleanClient);
}

function processBrokerConsultReply(brokerPhone, brokerMessage) {
  var cleanBroker = normalizePhone(brokerPhone);
  var pending = pendingBrokerConsult[cleanBroker];
  if (!pending || !pending.clientPhone) return Promise.resolve(false);

  delete pendingBrokerConsult[cleanBroker];

  var clientPhone = pending.clientPhone;
  var rec = getClientRecord(clientPhone);

  updateClientRecord(clientPhone, {
    real_estate_pending: false,
    broker_last_question: pending.originalMessage || '',
    broker_last_answer: brokerMessage,
    broker_last_answer_at: new Date().toISOString()
  });

  notifyChatwoot(clientPhone, 'Respuesta del CORREDOR:\n' + brokerMessage + '\n\nSobre: ' + (pending.originalMessage || 'consulta inmobiliaria'), 'system_note');

  var systemPrompt = [
    'Eres Mia de LinkMarket en modo demo inmobiliaria para alquileres en New Jersey.',
    'Debes convertir la respuesta del corredor en un mensaje claro para el interesado.',
    'No digas que eres el corredor. Habla como Mia.',
    'Si el interesado venía hablando en inglés, responde en inglés. Si venía hablando en español, responde en español.',
    'No prometas aprobación ni disponibilidad definitiva salvo que el corredor lo haya confirmado.',
    'Cliente: ' + (rec.name || ('+' + clientPhone)),
    'Consulta original del interesado: ' + (pending.originalMessage || ''),
    'Respuesta del corredor: ' + brokerMessage
  ].join('\n');

  return callClaude([{ role: 'user', content: brokerMessage }], systemPrompt)
    .then(function(reply) {
      if (conversations[clientPhone] && conversations[clientPhone].history) {
        conversations[clientPhone].history.push({ role: 'assistant', content: 'Corredor confirmó: ' + brokerMessage });
      }
      return sendWhatsApp(clientPhone, reply).then(function() {
        return notifyChatwoot(clientPhone, reply, 'mia_note');
      });
    })
    .then(function() {
      console.log('[Rentas NJ] Respuesta del corredor transmitida al cliente +' + clientPhone);
      return true;
    })
    .catch(function(e) {
      console.error('[Rentas NJ] Error transmitiendo respuesta del corredor: ' + e.message);
      return false;
    });
}


function hasRecentCentralShippingAnswer(phoneNumber) {
  var rec = getClientRecord(phoneNumber);
  if (!rec.central_last_answer || !rec.central_last_answer_at) return false;
  var t = new Date(rec.central_last_answer_at).getTime();
  if (!t || Date.now() - t > 30 * 60000) return false;
  var q = String(rec.central_last_question || '').toLowerCase();
  return /(env[ií]o|delivery|domicilio|villa|direcci[oó]n|fuera|volare|club|ciudadela|urbanizaci[oó]n)/i.test(q);
}

function sendOwnerConsultRequest(clientPhone, product, originalMessage) {
  var cleanClient = normalizePhone(clientPhone);
  var rec = getClientRecord(cleanClient);
  var question = originalMessage || product || 'consulta sin detalle';

  // Evita repetir la misma consulta a Central por cada mensaje del cliente.
  if (rec.central_pending === true && rec.central_last_question && String(rec.central_last_question).toLowerCase() === String(question).toLowerCase()) {
    console.log('[Central] Consulta duplicada omitida para cliente +' + cleanClient + ': ' + question);
    return;
  }

  pendingOwnerConsult[OWNER_NUMBER] = {
    clientPhone: cleanClient,
    product: product || '',
    originalMessage: question,
    createdAt: Date.now()
  };

  updateClientRecord(cleanClient, {
    central_pending: true,
    central_last_question: question,
    central_last_question_at: new Date().toISOString()
  });

  var msg = '🔎 *Consulta para Central*\n';
  msg += 'Cliente: +' + cleanClient + (rec.name ? ' (' + rec.name + ')' : '') + '\n';
  msg += 'Pidió/consultó: ' + question + '\n\n';
  msg += 'Respóndeme por aquí y Mia se lo transmitirá al cliente con su tono.';

  if (OWNER_NUMBER) sendWhatsApp(OWNER_NUMBER, msg);

  notifyChatwoot(cleanClient, 'Consulta enviada a Central:\n' + question, 'system_note');
  console.log('[Central] Consulta enviada al dueño para cliente +' + cleanClient);
}

function processOwnerConsultReply(ownerPhone, ownerMessage) {
  var pending = pendingOwnerConsult[OWNER_NUMBER] || pendingOwnerConsult[normalizePhone(ownerPhone)];
  if (!pending || !pending.clientPhone) return Promise.resolve(false);

  delete pendingOwnerConsult[OWNER_NUMBER];
  delete pendingOwnerConsult[normalizePhone(ownerPhone)];

  var clientPhone = pending.clientPhone;
  var rec = getClientRecord(clientPhone);

  updateClientRecord(clientPhone, {
    central_pending: false,
    central_last_question: pending.originalMessage || '',
    central_last_answer: ownerMessage,
    central_last_answer_at: new Date().toISOString()
  });

  notifyChatwoot(clientPhone, 'Respuesta de Central:\n' + ownerMessage + '\n\nSobre: ' + (pending.originalMessage || 'consulta'), 'system_note');

  var systemPrompt = [
    'Eres Mia de LinkMarket.',
    'Debes convertir la respuesta de Central en un mensaje amable, claro y comercial para el cliente.',
    'No digas que eres Central. Habla como Mia.',
    'No reinicies la conversacion ni vuelvas a presentarte. Continúa el pedido en curso.',
    'Mantén el tono cálido, útil, con emojis moderados.',
    'Cliente: ' + (rec.name || ('+' + clientPhone)),
    'Consulta original del cliente: ' + (pending.originalMessage || ''),
    'Respuesta de Central: ' + ownerMessage
  ].join('\n');

  return callClaude([{ role: 'user', content: ownerMessage }], systemPrompt)
    .then(function(reply) {
      if (conversations[clientPhone] && conversations[clientPhone].history) {
        conversations[clientPhone].history.push({ role: 'assistant', content: 'Central confirmó: ' + ownerMessage });
      }
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
  var centralLastAnswer = clientRecord.central_last_answer || '';
  var centralLastQuestion = clientRecord.central_last_question || '';

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
    '- LinkMarket gestiona pedidos de varios proveedores o líneas propias. Tienes disponible a Margarita Restaurant y TecnoGO si aparecen en el catálogo.',
    '- En tu bienvenida o primer saludo preséntate exactamente como: Hola, soy Mia de LinkMarket. Luego pregunta qué necesita el cliente (comida, mandados, etc).',
    '- No te limites a ofrecer solo comida en la bienvenida. Pregunta qué necesita y luego ofrece lo disponible.',
    '',
    'CONTEXTO ACTUAL:',
    '- Fecha y hora actual: ' + fechaHoraEcuador + '.',
    '- Numero del cliente: +' + userPhone + '.',
    '- Nombre registrado del cliente: ' + (clientRecord.name || 'SIN NOMBRE REGISTRADO') + '.',
    '- Ultimo pedido registrado: ' + (clientRecord.last_order || 'sin pedido anterior registrado') + '.',
    '- Ultima consulta hecha a Central: ' + (centralLastQuestion || 'ninguna') + '.',
    '- Ultima respuesta de Central: ' + (centralLastAnswer || 'ninguna') + '.',
    '- Mensaje numero ' + conv.messageCount + ' de esta conversacion activa.',
    '',
    'MEMORIA Y APEGO CON CLIENTE:',
    '- Si el cliente no tiene nombre registrado, puedes pedir su nombre con naturalidad SOLO cuando no estés preguntando algo operativo del pedido. No mezcles la pregunta del nombre con preguntas de envío, dirección, pago, salsas o retiro. Usa frases naturales de Guayaquil/Ecuador como: Por cierto, ¿me dices tu nombre porfa? o ¿me regalas tu nombre?',
    '- Si ya tiene nombre registrado, úsalo ocasionalmente y con naturalidad, no en cada mensaje.',
    '- Si hay ultimo pedido registrado y aplica, puedes mencionarlo con gracia: ¿Hoy repetimos como la otra vez?',
    '- No asumas que una palabra suelta es nombre si puede ser una respuesta de pedido: envío, retiro, domicilio, local, transferencia, efectivo, tarjeta, dirección, villa, manzana, etc. Si hay duda, no lo registres como nombre.',
    '- Si el cliente dice explícitamente que se llama distinto y ya hay nombre registrado, responde con picardia suave: Pensaba que te llamabas ' + (clientRecord.name || '...') + ', eso me dijiste la ultima vez 😄. Igual te actualizo.',
    '',
    'CONSULTAS GENERALES:',
    '- Si preguntan la hora o fecha, responde usando la fecha y hora actual del contexto. No digas que vas a consultar al proveedor por eso.',
    '- Si preguntan algo no relacionado con comprar bienes o servicios, responde de forma breve, amable y con algo de picardia; luego trae la conversacion sutilmente de vuelta a lo que puede pedir por LinkMarket.',
    '- No inventes datos actuales en vivo como marcadores de futbol, noticias o clima. Si no tienes el dato en vivo, dilo con gracia y vuelve a enfocar en el pedido.',
    '',
    'CONSULTAS A PROVEEDOR O CENTRAL:',
    '- Solo responde con {"accion":"consultar"} cuando sea una consulta real de compra, disponibilidad, precio, pedido especial, producto o servicio legal que necesita confirmacion y NO tengas ya una respuesta reciente de Central para ese mismo tema.',
    '- No uses consultar para hora, fecha, bromas, futbol, preguntas generales o temas que no requieren proveedor.',
    '',
    'CATALOGO DISPONIBLE:\n' + catalogText,
    '',
    'MODO DEMO INMOBILIARIA / RENTAS NJ:',
    '- También puedes atender interesados en alquileres de casas y apartamentos en New Jersey usando el proveedor ID rentas_nj_demo.',
    '- Activa este modo solo si el cliente habla de apartment, house, rent, rental, lease, apartamento, casa, renta, alquiler, habitaciones, baños, Newark, East Orange, Irvington, Elizabeth, Paterson, voucher, visita, showing, fotos o photos.',
    '- Si el cliente escribe en inglés sobre bienes raíces, respóndele en inglés. Si escribe en español, respóndele en español.',
    '- En bienes raíces pregunta de forma natural: casa o apartamento, ciudad/zona, habitaciones, baños, presupuesto mensual, fecha de mudanza, parking, mascotas y si usa voucher si aplica.',
    '- Ofrece solo propiedades del catálogo rentas_nj_demo que encajen con lo que busca. Si no encaja ninguna, dilo y pide ajustar ciudad, presupuesto o habitaciones.',
    '- Para fotos: NO inventes fotos y NO digas que las vas a enviar tú. Dile al interesado que pedirás al corredor que le envíe las fotos directamente por WhatsApp y responde UNICAMENTE el JSON consultar con proveedor_id rentas_nj_demo.',
    '- Para visitas/showings: pregunta primero el día y horario preferido del interesado. Luego responde UNICAMENTE el JSON consultar con proveedor_id rentas_nj_demo para confirmar disponibilidad con el corredor.',
    '- Si el interesado pregunta algo que no está en la ficha, consulta al corredor con el JSON de consultar.',
    '- No uses reglas de delivery, envases, salsas, pagos de restaurante ni tiempo de preparación cuando estés en modo inmobiliario.',
    '- Cumple Fair Housing: no comentes sobre raza, nacionalidad, religión, familias, niños, seguridad subjetiva de zonas ni perfiles de personas. Solo datos objetivos de la propiedad.',
    '',

    'JUGOS DISPONIBLES: solo limon, mora y maracuya. No ofrezcas otras frutas.',
    '',
    'REGLAS OBLIGATORIAS PARA ALITAS:',
    '- Las salsas disponibles son BBQ, Honey Mustard y Buffalo (picante).',
    '- Si el cliente pide 4 alitas, DEBES preguntar qué 1 salsa desea antes de resumir o cobrar.',
    '- Si el cliente pide 8 o 12 alitas, DEBES preguntar qué 2 salsas desea, o si prefiere todas con la misma salsa, antes de resumir o cobrar.',
    '- Si el cliente pide 20 alitas, puede incluir las 3 salsas; aun así confirma si desea las 3 o alguna preferencia.',
    '- Nunca cierres, resumas ni pidas forma de pago de un pedido de alitas sin haber confirmado salsa o salsas.',
    '- Cuando armes el resumen de alitas, incluye las salsas elegidas en el detalle del pedido.',
    '',
    'REGLAS DE PRECIOS:',
    '- Usa los precios del catalogo TAL CUAL. Sin margen adicional.',
    '- Envases: $0.25 por cada plato/item principal cuando el pedido es para llevar o a domicilio. No cobres envase si se consume en local.',
    '- Delivery dentro de Plaza/Urbanización Volare: subtotal igual o menor a $7.00 cobra $0.50; subtotal mayor a $7.00 cobra $1.00.',
    '- Delivery FUERA de Plaza Volare: primero pide la direccion completa de forma natural, sin preguntar literalmente si vive en Volare. Si la dirección no es dentro de Plaza/Urbanización Volare, debes consultar el costo a Central una sola vez. Si ya tienes una respuesta reciente de Central sobre ese envío, usa esa respuesta y continúa el pedido; no vuelvas a consultar por cada mensaje.',
    '- Cuando Central ya respondió el valor de delivery para una zona, si el cliente dice enviame, mándalo, ok, dirección, o sigue dando datos del pedido, NO vuelvas a consultar: usa la respuesta ya recibida de Central y continúa con pago/resumen.',
    '',
    'PAGOS ACEPTADOS:',
    '- Efectivo al momento de la entrega',
    '- Transferencia bancaria: YOLOCORP S.A.S. | RUC: 0993367608001 | Cta Cte Produbanco: 2006168082',
    '- Tarjeta de credito: se gestiona link de pago (tarda unos minutos en llegar)',
    'IMPORTANTE: Solo menciona datos bancarios si el cliente ELIGE transferencia. Nunca en otro caso.',
    'Si el cliente elige transferencia, después de dar los datos bancarios NO digas solo avísame ni confirma por este medio; pide específicamente que envíe una foto o imagen del comprobante de transferencia para confirmar el pedido.',
    'Si elige tarjeta: confirma el pedido normalmente e indica que en unos minutos recibirá el link de pago.',
    '',
    'FLUJO DEL PEDIDO:',
    '1. Saluda como Mia de LinkMarket y pregunta en qué puedes ayudar',
    '2. Toma el pedido',
    '3. Pregunta si retira en el local o si desea envío a domicilio',
    '4. Si es domicilio, pide la direccion completa de forma natural. No preguntes literalmente si vive en Volare; solo pide direccion para calcular el envio',
    '5. Pide el nombre para el pedido solo cuando no estés esperando dirección, pago, salsas o decisión de retiro/envío',
    '6. Muestra resumen: items + envases + delivery = total',
    '7. Pregunta metodo de pago (efectivo / transferencia / tarjeta)',
    '8. Solo si elige transferencia, da los datos bancarios y pide imagen/foto del comprobante de transferencia',
    '9. Confirma con el JSON',
    '',
    'DESCRIPCIONES: Breves y apetitosas. Max 2 lineas. Solo si el cliente pregunta.',
    '',
    'PARA CONFIRMAR UN PEDIDO responde UNICAMENTE este JSON (sin texto antes ni despues):',
    '{"accion":"pedido_confirmado","proveedor_id":"margarita","nombre_cliente":"Nombre","items":[{"nombre":"plato","cantidad":1,"precio":3.50,"salsas":"solo si aplica"}],"envases":0.25,"subtotal":3.50,"delivery":1.00,"total":4.75,"direccion":"direccion o Retiro en local","metodo_pago":"efectivo"}',
    '',
    'Para consultas fuera del menu o costos de envío fuera de Volare que requieran Central responde UNICAMENTE:',
    '{"accion":"consultar","producto":"nombre"}',
    'Para consultas inmobiliarias que requieran al corredor, fotos, voucher, disponibilidad o visita responde UNICAMENTE:',
    '{"accion":"consultar","proveedor_id":"rentas_nj_demo","producto":"consulta exacta del interesado"}',
  ].join('\n');

  return callClaude(conv.history, systemPrompt)
    .then(function(msg) {
      msg = appendNameQuestionIfNeeded(userPhone, conv, msg);
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

            var nombreClienteValido = sanitizeClientNameCandidate(nombreCliente);
            updateClientRecord(userPhone, {
              name: nombreClienteValido || (sanitizeClientNameCandidate(clientRecord.name || '') || ''),
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
            var consultaTxt = String(action.producto || userMessage || '');
            var consultaProvider = action.proveedor_id ? findProviderById(providers, action.proveedor_id) : null;

            if (consultaProvider && isRealEstateProvider(consultaProvider)) {
              sendBrokerConsultRequest(userPhone, consultaProvider, action.producto || userMessage, userMessage);
              if (isProbablyEnglish(userMessage + ' ' + consultaTxt)) {
                return 'Let me confirm that with the agent so I don\'t give you wrong information. I\'ll let you know here shortly.';
              }
              return 'Dame un momento y confirmo eso con el corredor para darte información segura 🔎. Te aviso por aquí mismo.';
            }

            if (hasRecentCentralShippingAnswer(userPhone) && /(env[ií]o|delivery|domicilio|direcci[oó]n|villa|volare|fuera|club|manzana|mz|envi)/i.test(consultaTxt + ' ' + userMessage)) {
              return 'Central ya me confirmó ese dato: ' + (getClientRecord(userPhone).central_last_answer || '') + ' 😊. Sigo con tu pedido.';
            }
            sendOwnerConsultRequest(userPhone, action.producto || userMessage, userMessage);
            return 'Dame un momento y confirmo ese dato con Central para darte el valor correcto 🔎. Te aviso enseguida por aquí.';
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
    res.end(JSON.stringify({ status: 'LinkMarket v3.5-v19-rentas-nj operativo' }));
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
                  var providers = loadProviders();

                  if (m.type === 'text') {
                    console.log('Mensaje de ' + m.from + ': ' + m.text.body);
                    if (OWNER_NUMBER && normalizePhone(m.from) === normalizePhone(OWNER_NUMBER) && (pendingOwnerConsult[OWNER_NUMBER] || pendingOwnerConsult[normalizePhone(m.from)])) {
                      processOwnerConsultReply(m.from, m.text.body);
                      return;
                    }
                    if (pendingBrokerConsult[normalizePhone(m.from)]) {
                      processBrokerConsultReply(m.from, m.text.body);
                      return;
                    }
                    if (isProviderNumber(m.from, providers)) {
                      processProviderMessage(m.from, m.text.body, providers)
                        .then(function(reply) { sendWhatsApp(m.from, reply); });
                    } else {
                      handleClientWhatsAppMessage(m.from, m.text.body);
                    }
                    return;
                  }

                  if (m.type === 'audio') {
                    console.log('Audio recibido de ' + m.from + '. No se reenvia ni procesa automaticamente.');
                    if (!isProviderNumber(m.from, providers)) {
                      handleClientMediaMessage(m, providers);
                    }
                    return;
                  }

                  console.log('Archivo/media recibido de ' + m.from + ' | tipo: ' + m.type);
                  if (!isProviderNumber(m.from, providers)) {
                    handleClientMediaMessage(m, providers);
                  } else if (OWNER_NUMBER) {
                    sendWhatsApp(OWNER_NUMBER, '📎 El proveedor +' + m.from + ' envió un archivo/media tipo ' + m.type + '. Revisar en WhatsApp si corresponde.');
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
        var phoneRaw = contact.phone_number || contact.identifier ||
          (conversation.custom_attributes && conversation.custom_attributes.whatsapp_number) ||
          (conversation.additional_attributes && conversation.additional_attributes.whatsapp_number) ||
          (conversation.meta && conversation.meta.sender && conversation.meta.sender.phone_number) ||
          (conversation.meta && conversation.meta.sender && conversation.meta.sender.identifier) || '';
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

          var manualMatch = rawText.match(/^(WA|CENTRAL)(?:\s*[:：]\s*|\s+)([\s\S]+)$/i);
          if (!manualMatch) {
            console.log('[Chatwoot] Nota privada ignorada porque no empieza con WA, WA:, Central o Central:');
            return;
          }

          var humanText = String(manualMatch[2] || '').trim();
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
  console.log('LinkMarket v3.5-v19-rentas-nj corriendo en puerto ' + PORT);
  subscribeWABA();
});
