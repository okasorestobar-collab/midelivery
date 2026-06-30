// LinkMarket AI - Node.js puro v4.0-multiprov
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
var PORT = process.env.PORT || 3000;
var WABA_ID = '1016580111052309';
var CHATWOOT_URL = process.env.CHATWOOT_URL || 'chatwoot-production-6854.up.railway.app';
var CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN || 'nSEom4sbee3sksbgdu16r6H3';
var CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '2';
var CHATWOOT_INBOX_ID = parseInt(process.env.CHATWOOT_INBOX_ID || '1', 10);

var conversations = {};
var pendingClientForProvider = {};
var humanPauseUntil = {};
var humanLastActivity = {};
var pendingOwnerConsult = {};
var pendingBrokerConsult = {};
var activeDeliveries = {};
var pendingCardPayment = {};

var CLIENTS_FILE = './clients.json';
var COUNTER_FILE = './orders_counter.json';

// ─── ORDEN COUNTER ──────────────────────────────────────────────────────────
function getNextOrderNumber() {
  try {
    var data = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
    data.counter = (data.counter || 0) + 1;
    fs.writeFileSync(COUNTER_FILE, JSON.stringify(data), 'utf8');
    return data.counter;
  } catch(e) {
    var init = { counter: 1 };
    try { fs.writeFileSync(COUNTER_FILE, JSON.stringify(init), 'utf8'); } catch(e2) {}
    return 1;
  }
}

function formatOrderTag(num) {
  return '#' + String(num).padStart(4, '0');
}

// ─── PROVIDERS ──────────────────────────────────────────────────────────────
function loadProviders() {
  try { return JSON.parse(fs.readFileSync('./providers.json', 'utf8')); }
  catch(e) { return []; }
}

// ─── CLIENTS ────────────────────────────────────────────────────────────────
function loadClients() {
  try { return JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8')); }
  catch(e) { return {}; }
}

function saveClients(clients) {
  try { fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clients, null, 2), 'utf8'); }
  catch(e) { console.error('[Clientes] No se pudo guardar clients.json: ' + e.message); }
}

function getClientRecord(phoneNumber) {
  var cleanPhone = normalizePhone(phoneNumber);
  var clients = loadClients();
  if (!clients[cleanPhone]) {
    clients[cleanPhone] = { phone: cleanPhone, name: '', first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), last_order: '', notes: [] };
    saveClients(clients);
  }
  return clients[cleanPhone];
}

function updateClientRecord(phoneNumber, updates) {
  var cleanPhone = normalizePhone(phoneNumber);
  var clients = loadClients();
  var rec = clients[cleanPhone] || { phone: cleanPhone, name: '', first_seen: new Date().toISOString(), last_seen: new Date().toISOString(), last_order: '', notes: [] };
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
  var name = m[1].trim().replace(/[.,;:!¡?¿].*$/, '').trim();
  if (/^(cliente|buenas|hola|yo|de|el|la|un|una)$/i.test(name)) return '';
  return name;
}

function looksLikeStandaloneName(text) {
  var t = String(text || '').trim();
  if (!t || t.length < 2 || t.length > 35) return '';
  if (/[0-9@#$%&*/_=+{}\[\]<>|?¿!¡]/.test(t)) return '';
  var lower = t.toLowerCase();
  var blocked = ['hola','buenas','buenos dias','buenas tardes','buenas noches','gracias','ok','okay','dale','listo','si','sí','no','encebollado','ceviche','bollo','alitas','hamburguesa','burger','burguer','moro','chuleta','mandado','menu','menú','pedido','delivery','domicilio','plaza','volare','envio','envío','enviar','enviame','envíame','retiro','retirar','local','direccion','dirección','villa','manzana','mz','calle','urbanizacion','urbanización','club','villa club','pago','transferencia','tarjeta','efectivo','si claro','claro','perfecto','joya','okey','un bollo','una bollo','un encebollado','una guatita','un caldo','caldo de salchicha','caldo','para llevar','a domicilio','retiro en local','empanada','empanadas','marquito'];
  for (var i = 0; i < blocked.length; i++) {
    if (lower === blocked[i] || lower.indexOf(blocked[i] + ' ') === 0) return '';
  }
  if (/(quiero|dame|env[ií]a|manda|lleva|pedido|plato|comida|caldo|bollo|alitas|guatita|encebollado|moro|chuleta|salsa|salsas|transfer|pago|tarjeta|efectivo|villa|mz|manzana|direcci[oó]n|domicilio|local|volare|club|empanada)/i.test(t)) return '';
  var words = t.split(/\s+/).filter(Boolean);
  if (words.length > 3) return '';
  for (var j = 0; j < words.length; j++) {
    if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,}$/.test(words[j])) return '';
  }
  return words.map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }).join(' ');
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
  if (!detected && rec.asked_name_pending) detected = looksLikeStandaloneName(text);
  if (!detected) return rec;
  var updates = { name: detected, asked_name_pending: false };
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

function detectMessageLanguage(text) {
  var t = String(text || '').toLowerCase();
  var spanishScore = 0;
  var englishScore = 0;
  if (/\b(hola|buenas|buenos|soy|corredor|busco|buscando|quiero|necesito|apartamento|departamento|depa|casa|renta|alquiler|habitaci[oó]n|baño|presupuesto|mudanza|visita|fotos|personas|vivir|pueden|puede|aceptan|mascotas|parqueo|disponible|direcci[oó]n)\b/i.test(t)) spanishScore += 3;
  if (/[áéíóúñ¿¡]/i.test(t)) spanishScore += 2;
  if (/\b(el|la|los|las|un|una|para|por|con|sin|de|del|que|si|sí)\b/i.test(t)) spanishScore += 1;
  if (/\b(hello|hi|good morning|good afternoon|good evening|i need|i'm looking|looking for|do you have|apartment|house|rent|rental|bedroom|bath|bathroom|move|moving|budget|lease|available|photos|showing|visit|can we|can i)\b/i.test(t)) englishScore += 3;
  if (/\b(the|and|for|with|without|to|from|in|on|at|my|your)\b/i.test(t)) englishScore += 1;
  if (spanishScore >= englishScore && spanishScore > 0) return 'es';
  if (englishScore > spanishScore && englishScore > 0) return 'en';
  return 'es';
}

function isProbablyEnglish(text) { return detectMessageLanguage(text) === 'en'; }

function appendNameQuestionIfNeeded(phoneNumber, conv, reply) {
  if (!shouldAskClientName(phoneNumber, conv)) return reply;
  var text = String(reply || '');
  if (/\{\s*"accion"\s*:/i.test(text)) return reply;
  var operationalQuestion = /(retiro|retiras|local|domicilio|env[ií]o|delivery|direcci[oó]n|a d[oó]nde|d[oó]nde te lo|forma de pago|m[eé]todo de pago|efectivo|transferencia|tarjeta|total|resumen|salsa|salsas|empanada)/i.test(text);
  if (operationalQuestion) return reply;
  if (/nombre|te atiendo|a nombre de|me dices tu nombre|me regalas tu nombre/i.test(text)) {
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

// ─── FECHA/HORA ─────────────────────────────────────────────────────────────
function getEcuadorDateTimeText() {
  try {
    var now = new Date();
    var date = new Intl.DateTimeFormat('es-EC', { timeZone: 'America/Guayaquil', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(now);
    var time = new Intl.DateTimeFormat('es-EC', { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    return date + ', ' + time + ' (hora de Ecuador)';
  } catch(e) { return new Date().toISOString(); }
}

function getEcuadorShortDateTimeText() {
  try {
    var now = new Date();
    var date = new Intl.DateTimeFormat('es-EC', { timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: 'numeric' }).format(now);
    var time = new Intl.DateTimeFormat('es-EC', { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
    return date + ' ' + time;
  } catch(e) { return new Date().toISOString(); }
}

// ─── CHATWOOT HELPERS ────────────────────────────────────────────────────────
function formatChatwootNote(title, message) {
  return '**' + title + '**\n' + message + '\n\n_' + getEcuadorShortDateTimeText() + '_';
}

function isSystemGeneratedChatwootNote(rawText) {
  var text = String(rawText || '').trim();
  if (!text) return true;
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

function normalizePhone(phone) { return String(phone || '').replace(/[^\d]/g, ''); }

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

function updateChatwootContactNameIfNeeded(contact, phoneNumber) {
  if (!contact || !contact.id) return Promise.resolve(contact);
  var cleanPhone = normalizePhone(phoneNumber);
  var rec = getClientRecord(cleanPhone);
  var currentName = String(contact.name || '').trim();
  var storedName = sanitizeClientNameCandidate(rec.name || '');
  if (isRealManualContactName(currentName) && currentName !== storedName) {
    updateClientRecord(cleanPhone, { name: currentName, asked_name_pending: false, name_source: 'chatwoot_manual', name_synced_from_chatwoot_at: new Date().toISOString() });
    return Promise.resolve(contact);
  }
  var desiredName = storedName || ('+' + cleanPhone);
  if (currentName === desiredName) return Promise.resolve(contact);
  if (!isBadContactName(currentName) && !/^\+?\d{7,}$/.test(currentName) && !storedName) return Promise.resolve(contact);
  var body = JSON.stringify({ name: desiredName, phone_number: '+' + cleanPhone, identifier: cleanPhone });
  return httpsPut(CHATWOOT_URL, '/api/v1/accounts/' + CHATWOOT_ACCOUNT_ID + '/contacts/' + contact.id, chatwootHeaders(body), body)
    .then(function() {
      return getChatwootContactById(contact.id).then(function(updated) { return (updated && updated.id) ? updated : contact; });
    }).catch(function(e) { console.error('[Chatwoot] No se pudo actualizar nombre: ' + e.message); return contact; });
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

function chatwootHeaders(body) {
  var headers = { 'api_access_token': CHATWOOT_TOKEN, 'Content-Type': 'application/json' };
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  return headers;
}

// ─── HTTP HELPERS ────────────────────────────────────────────────────────────
function httpsPost(hostname, path, headers, body) {
  return new Promise(function(resolve, reject) {
    var options = { hostname: hostname, path: path, method: 'POST', headers: headers };
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
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
      res.on('end', function() { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
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
      res.on('end', function() { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── WHATSAPP ────────────────────────────────────────────────────────────────
function sendWhatsApp(to, message) {
  var body = JSON.stringify({ messaging_product: 'whatsapp', to: to, type: 'text', text: { body: message } });
  var headers = { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
  return httpsPost('graph.facebook.com', '/v19.0/' + PHONE_NUMBER_ID + '/messages', headers, body)
    .then(function(r) { console.log('Enviado a ' + to); return r; })
    .catch(function(e) { console.error('Error envio: ' + e.message); });
}

function getWhatsAppMediaInfo(m) {
  if (!m || !m.type || m.type === 'text' || m.type === 'audio') return null;
  var media = m[m.type] || {};
  if (!media.id) return null;
  return { type: m.type, id: media.id, mime_type: media.mime_type || '', caption: media.caption || '', filename: media.filename || '' };
}

function getMediaTypeLabel(type) {
  var t = String(type || '').toLowerCase();
  if (t === 'image') return 'imagen';
  if (t === 'document') return 'documento/archivo';
  if (t === 'video') return 'video';
  return t || 'archivo';
}

function sendWhatsAppMedia(to, mediaInfo, caption) {
  var type = mediaInfo.type;
  var bodyObj = { messaging_product: 'whatsapp', to: to, type: type };
  bodyObj[type] = { id: mediaInfo.id };
  if ((type === 'image' || type === 'video' || type === 'document') && caption) bodyObj[type].caption = caption;
  if (type === 'document' && mediaInfo.filename) bodyObj[type].filename = mediaInfo.filename;
  var body = JSON.stringify(bodyObj);
  var headers = { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
  return httpsPost('graph.facebook.com', '/v19.0/' + PHONE_NUMBER_ID + '/messages', headers, body)
    .then(function(r) { console.log('Media ' + type + ' enviado a ' + to); return r; })
    .catch(function(e) { console.error('Error enviando media: ' + e.message); return null; });
}

// ─── CHATWOOT OPERACIONES ────────────────────────────────────────────────────
function getChatwootContactById(contactId) {
  return httpsGet(CHATWOOT_URL, '/api/v1/accounts/' + CHATWOOT_ACCOUNT_ID + '/contacts/' + contactId, chatwootHeaders())
    .then(function(result) { var contact = firstContactFromResult(result); return contact || result; });
}

function searchChatwootContact(phoneNumber) {
  var cleanPhone = normalizePhone(phoneNumber);
  return httpsGet(CHATWOOT_URL, '/api/v1/accounts/' + CHATWOOT_ACCOUNT_ID + '/contacts/search?q=' + encodeURIComponent(cleanPhone), chatwootHeaders())
    .then(function(result) {
      var contact = firstContactFromResult(result);
      if (!contact || !contact.id) return null;
      return getChatwootContactById(contact.id).then(function(fullContact) { return (fullContact && fullContact.id) ? fullContact : contact; });
    });
}

function createChatwootContact(phoneNumber) {
  var cleanPhone = normalizePhone(phoneNumber);
  var rec = getClientRecord(cleanPhone);
  var body = JSON.stringify({ inbox_id: CHATWOOT_INBOX_ID, name: rec.name || ('+' + cleanPhone), phone_number: '+' + cleanPhone, identifier: cleanPhone, additional_attributes: {}, custom_attributes: {} });
  return httpsPost(CHATWOOT_URL, '/api/v1/accounts/' + CHATWOOT_ACCOUNT_ID + '/contacts', chatwootHeaders(body), body)
    .then(function(result) {
      var contact = firstContactFromResult(result);
      if (!contact || !contact.id) throw new Error('Chatwoot no devolvio contact.id');
      return getChatwootContactById(contact.id);
    });
}

function createChatwootContactInbox(contact, phoneNumber) {
  var cleanPhone = normalizePhone(phoneNumber);
  var body = JSON.stringify({ inbox_id: CHATWOOT_INBOX_ID, source_id: cleanPhone });
  return httpsPost(CHATWOOT_URL, '/api/v1/accounts/' + CHATWOOT_ACCOUNT_ID + '/contacts/' + contact.id + '/contact_inboxes', chatwootHeaders(body), body)
    .then(function() { return getChatwootContactById(contact.id); });
}

function getOrCreateChatwootContact(phoneNumber) {
  return searchChatwootContact(phoneNumber)
    .then(function(contact) { if (contact && contact.id) return contact; return createChatwootContact(phoneNumber); })
    .then(function(contact) {
      var ci = findContactInbox(contact, CHATWOOT_INBOX_ID);
      if (ci && ci.source_id) return contact;
      return createChatwootContactInbox(contact, phoneNumber);
    })
    .then(function(contact) { return updateChatwootContactNameIfNeeded(contact, phoneNumber); });
}

function getChatwootConversations(contactId) {
  return httpsGet(CHATWOOT_URL, '/api/v1/accounts/' + CHATWOOT_ACCOUNT_ID + '/contacts/' + contactId + '/conversations', chatwootHeaders())
    .then(function(result) {
      var payload = getPayload(result);
      if (Array.isArray(payload)) return payload;
      if (payload && Array.isArray(payload.conversations)) return payload.conversations;
      return [];
    });
}

function createChatwootConversation(contact, phoneNumber) {
  var ci = findContactInbox(contact, CHATWOOT_INBOX_ID);
  var cleanPhone = normalizePhone(phoneNumber);
  if (!ci || !ci.source_id) throw new Error('No se encontro source_id del contact_inbox');
  var body = JSON.stringify({ source_id: ci.source_id, inbox_id: CHATWOOT_INBOX_ID, contact_id: contact.id, status: 'open', additional_attributes: {}, custom_attributes: { whatsapp_number: cleanPhone } });
  return httpsPost(CHATWOOT_URL, '/api/v1/accounts/' + CHATWOOT_ACCOUNT_ID + '/conversations', chatwootHeaders(body), body)
    .then(function(result) {
      var conversation = getPayload(result);
      if (!conversation || !conversation.id) conversation = result;
      if (!conversation || !conversation.id) throw new Error('Chatwoot no devolvio conversation.id');
      return conversation;
    });
}

function ensureChatwootConversation(phoneNumber) {
  return getOrCreateChatwootContact(phoneNumber)
    .then(function(contact) {
      return getChatwootConversations(contact.id).then(function(convs) {
        var selected = null;
        for (var i = 0; i < convs.length; i++) {
          if (parseInt(convs[i].inbox_id, 10) === parseInt(CHATWOOT_INBOX_ID, 10) && convs[i].status !== 'resolved') { selected = convs[i]; break; }
        }
        if (!selected) {
          for (var j = 0; j < convs.length; j++) {
            if (parseInt(convs[j].inbox_id, 10) === parseInt(CHATWOOT_INBOX_ID, 10)) { selected = convs[j]; break; }
          }
        }
        if (selected && selected.id) { selected.__contact = contact; return selected; }
        return createChatwootConversation(contact, phoneNumber).then(function(c) { c.__contact = contact; return c; });
      });
    });
}

function createChatwootMessage(conversationId, message, messageType, displayName) {
  var type = messageType || 'mia_note';
  var cleanDisplay = String(displayName || 'cliente').trim();
  var bodyObj;
  if (type === 'client_public') {
    bodyObj = { content: message, message_type: 'incoming', private: false, content_type: 'text', content_attributes: {} };
  } else if (type === 'client_note') {
    bodyObj = { content: formatChatwootNote(cleanDisplay, message), message_type: 'outgoing', private: true, content_type: 'text', content_attributes: {} };
  } else if (type === 'mia_note') {
    bodyObj = { content: formatChatwootNote('Mia', message), message_type: 'outgoing', private: true, content_type: 'text', content_attributes: {} };
  } else if (type === 'human_note') {
    bodyObj = { content: formatChatwootNote('CENTRAL', message), message_type: 'outgoing', private: true, content_type: 'text', content_attributes: {} };
  } else if (type === 'system_note') {
    bodyObj = { content: formatChatwootNote('sistema', message), message_type: 'outgoing', private: true, content_type: 'text', content_attributes: {} };
  } else {
    bodyObj = { content: message, message_type: type, private: false, content_type: 'text', content_attributes: {} };
  }
  var body = JSON.stringify(bodyObj);
  return httpsPost(CHATWOOT_URL, '/api/v1/accounts/' + CHATWOOT_ACCOUNT_ID + '/conversations/' + conversationId + '/messages', chatwootHeaders(body), body)
    .then(function(result) {
      if (!result || !result.id) throw new Error('Chatwoot no devolvio message.id');
      return result;
    });
}

function createChatwootMessageSafe(conversationId, message, messageType, displayName) {
  return createChatwootMessage(conversationId, message, messageType, displayName)
    .catch(function(e) { console.error('[Chatwoot] ERROR creando ' + messageType + ': ' + e.message); return null; });
}

function isMiaPaused(phoneNumber) {
  var cleanPhone = normalizePhone(phoneNumber);
  return humanPauseUntil[cleanPhone] && humanPauseUntil[cleanPhone] > Date.now();
}

function pauseMia(phoneNumber, minutes) {
  var cleanPhone = normalizePhone(phoneNumber);
  humanPauseUntil[cleanPhone] = Date.now() + (minutes || 3) * 60000;
  humanLastActivity[cleanPhone] = Date.now();
  console.log('[Mia] Pausada para ' + cleanPhone + ' por ' + (minutes || 3) + ' minutos');
}

function resumeMia(phoneNumber) {
  var cleanPhone = normalizePhone(phoneNumber);
  delete humanPauseUntil[cleanPhone];
  delete humanLastActivity[cleanPhone];
  console.log('[Mia] Reactivada para ' + cleanPhone);
}

function touchActivity(phoneNumber) {
  var cleanPhone = normalizePhone(phoneNumber);
  humanLastActivity[cleanPhone] = Date.now();
  // Si estaba pausada, extender la pausa 3 min más desde ahora (renovar timer)
  if (humanPauseUntil[cleanPhone] && humanPauseUntil[cleanPhone] > Date.now()) {
    humanPauseUntil[cleanPhone] = Date.now() + 3 * 60000;
  }
}

function notifyChatwoot(toPhone, message, messageType) {
  var cleanPhone = normalizePhone(toPhone);
  if (!CHATWOOT_TOKEN) return Promise.resolve(null);
  return ensureChatwootConversation(cleanPhone)
    .then(function(conversation) { return createChatwootMessage(conversation.id, message, messageType); })
    .catch(function(e) { console.error('[Chatwoot] ERROR sync ' + messageType + ' para ' + cleanPhone + ': ' + e.message); return null; });
}

// ─── PROVEEDOR HELPERS ───────────────────────────────────────────────────────
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

function findProviderById(providers, id) {
  return (providers || []).find(function(p) { return p.id === id; }) || null;
}

function isBrokerNumber(phone, providers) {
  var clean = normalizePhone(phone);
  return (providers || []).some(function(p) {
    if (!isRealEstateProvider(p)) return false;
    return normalizePhone(p.notificar_a || p.telefono) === clean || normalizePhone(p.telefono) === clean;
  });
}

// ─── CLAUDE ──────────────────────────────────────────────────────────────────
function callClaude(messages, systemPrompt) {
  var body = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, system: systemPrompt, messages: messages });
  var headers = { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
  return httpsPost('api.anthropic.com', '/v1/messages', headers, body)
    .then(function(r) {
      if (r && r.content && r.content[0]) return r.content[0].text;
      console.error('Claude error:', JSON.stringify(r));
      return 'Disculpa, problema tecnico.';
    });
}

// ─── CATÁLOGO ────────────────────────────────────────────────────────────────
function buildCatalogText(providers) {
  var text = '';
  (providers || []).forEach(function(prov) {
    if (isRealEstateProvider(prov)) return; // omitir demo inmobiliaria del catálogo de delivery
    text += 'PROVEEDOR: ' + prov.nombre + ' (ID: ' + prov.id + ')\n';
    if (prov.descripcion) text += 'Descripcion: ' + prov.descripcion + '\n';
    text += 'Horario: ' + (prov.horario || 'consultar') + '\n';
    text += 'Ubicacion: ' + (prov.ubicacion || '') + '\n';
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
    text += '\n';
  });
  return text;
}

// ─── MENSAJES DE PROVEEDOR ───────────────────────────────────────────────────
function analyzeProviderMessage(providerName, providerMessage) {
  var systemPrompt = [
    'Eres un analizador de mensajes de proveedores para LinkMarket.',
    'Analiza el mensaje del proveedor "' + providerName + '" y responde UNICAMENTE con JSON:',
    '{"tipo":"cerrado","mensaje_cliente":"texto amigable para el cliente"}',
    'O si es link de pago: {"tipo":"link_pago","link":"url"}',
    'O si otro: {"tipo":"otro","reenviar_dueno":true}',
    'Palabras de cierre: cerrado, no atendemos, fuera de horario, no disponible, abierto desde, horario, regresamos, volvemos.'
  ].join('\n');
  return callClaude([{ role: 'user', content: 'Mensaje: ' + providerMessage }], systemPrompt)
    .then(function(response) {
      try {
        var s = response.indexOf('{'), e = response.lastIndexOf('}');
        if (s !== -1 && e !== -1) return JSON.parse(response.substring(s, e + 1));
      } catch(err) {}
      return { tipo: 'otro', reenviar_dueno: true };
    });
}

function processProviderMessage(providerPhone, message, providers) {
  var proveedor = findProviderByPhone(providerPhone, providers);
  var nombreProveedor = proveedor ? proveedor.nombre : providerPhone;
  console.log('Mensaje de proveedor ' + nombreProveedor + ': ' + message);
  if (OWNER_NUMBER) sendWhatsApp(OWNER_NUMBER, '📩 *Mensaje de ' + nombreProveedor + ':*\n' + message);
  analyzeProviderMessage(nombreProveedor, message).then(function(analysis) {
    var clienteActivo = pendingClientForProvider[providerPhone];
    if (analysis.tipo === 'cerrado' && clienteActivo) {
      sendWhatsApp(clienteActivo, analysis.mensaje_cliente);
      notifyChatwoot(clienteActivo, analysis.mensaje_cliente, 'mia_note');
    } else if (analysis.tipo === 'link_pago' && clienteActivo) {
      var msgLink = '💳 *Link de pago:*\n' + analysis.link + '\n\nUna vez completado el pago tu pedido será confirmado. ✅';
      sendWhatsApp(clienteActivo, msgLink);
      notifyChatwoot(clienteActivo, msgLink, 'mia_note');
    }
  });
  return Promise.resolve('✅ Mensaje recibido. El equipo de LinkMarket está al tanto.');
}

// ─── MOTORIZADO ──────────────────────────────────────────────────────────────
function processMotoristaMessage(motoPhone, message) {
  var keys = Object.keys(activeDeliveries);
  if (!keys.length) {
    sendWhatsApp(motoPhone, '✅ Recibido. No hay entregas activas registradas en este momento.');
    return Promise.resolve();
  }
  var listaTags = keys.map(function(k) { return formatOrderTag(parseInt(k, 10)); }).join(', ');
  var systemP = [
    'Eres un detector de confirmaciones de entrega para un servicio de delivery.',
    'El motorizado envió: "' + message + '".',
    'Determina si está confirmando que entregó un pedido (palabras como: entregué, entregado, listo, ya entregué, lo dejé, llegué, pedido entregado, hice la entrega, etc.).',
    'Si menciona un número de pedido, extráelo.',
    'Pedidos activos: ' + listaTags,
    'Responde SOLO con JSON: {"es_entrega":true,"numero_pedido":"#0001"} o {"es_entrega":false}'
  ].join('\n');
  return callClaude([{ role: 'user', content: message }], systemP)
    .then(function(resp) {
      try {
        var s = resp.indexOf('{'), e = resp.lastIndexOf('}');
        if (s === -1 || e === -1) return;
        var r = JSON.parse(resp.substring(s, e + 1));
        if (!r.es_entrega) {
          sendWhatsApp(motoPhone, '¿Confirmás que entregaste el pedido? Respondé con "entregué el #XXXX" 📦');
          return;
        }
        var orderNum = null;
        if (r.numero_pedido) {
          var n = String(r.numero_pedido).replace(/\D/g, '');
          if (n && activeDeliveries[parseInt(n, 10)]) orderNum = parseInt(n, 10);
        }
        if (!orderNum && keys.length === 1) orderNum = parseInt(keys[0], 10);
        if (!orderNum) {
          sendWhatsApp(motoPhone, 'Decime el número de pedido entregado (ej: #0001) para registrarlo. 📦');
          return;
        }
        var delivery = activeDeliveries[orderNum];
        delete activeDeliveries[orderNum];
        var orderTag = formatOrderTag(orderNum);
        var msgCliente = '🎉 *¡Tu pedido ' + orderTag + ' fue entregado!*\n\n¡Gracias por elegir LinkMarket! Esperamos verte pronto. 😊';
        sendWhatsApp(delivery.clientPhone, msgCliente);
        notifyChatwoot(delivery.clientPhone, msgCliente, 'mia_note');
        sendWhatsApp(motoPhone, '✅ Pedido ' + orderTag + ' registrado como entregado. ¡Gracias!');
        if (OWNER_NUMBER) sendWhatsApp(OWNER_NUMBER, '✅ Pedido ' + orderTag + ' entregado. Cliente: +' + delivery.clientPhone);
        console.log('[Motorizado] Pedido ' + orderTag + ' cerrado para cliente +' + delivery.clientPhone);
      } catch(e2) { console.error('[Motorizado] Error procesando confirmacion: ' + e2.message); }
    });
}

// ─── CENTRAL OWNER CONSULT ───────────────────────────────────────────────────
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
  if (rec.central_pending === true && rec.central_last_question && String(rec.central_last_question).toLowerCase() === String(question).toLowerCase()) return;
  pendingOwnerConsult[OWNER_NUMBER] = { clientPhone: cleanClient, product: product || '', originalMessage: question, createdAt: Date.now() };
  updateClientRecord(cleanClient, { central_pending: true, central_last_question: question, central_last_question_at: new Date().toISOString() });
  var msg = '🔎 *Consulta para Central*\nCliente: +' + cleanClient + (rec.name ? ' (' + rec.name + ')' : '') + '\nPidió/consultó: ' + question + '\n\nResponde aquí y Mia se lo transmite al cliente.';
  if (OWNER_NUMBER) sendWhatsApp(OWNER_NUMBER, msg);
  notifyChatwoot(cleanClient, 'Consulta enviada a Central:\n' + question, 'system_note');
}

function processOwnerConsultReply(ownerPhone, ownerMessage) {
  var pending = pendingOwnerConsult[OWNER_NUMBER] || pendingOwnerConsult[normalizePhone(ownerPhone)];
  if (!pending || !pending.clientPhone) return Promise.resolve(false);
  delete pendingOwnerConsult[OWNER_NUMBER];
  delete pendingOwnerConsult[normalizePhone(ownerPhone)];
  var clientPhone = pending.clientPhone;
  var rec = getClientRecord(clientPhone);
  updateClientRecord(clientPhone, { central_pending: false, central_last_question: pending.originalMessage || '', central_last_answer: ownerMessage, central_last_answer_at: new Date().toISOString() });
  notifyChatwoot(clientPhone, 'Respuesta de Central:\n' + ownerMessage + '\n\nSobre: ' + (pending.originalMessage || 'consulta'), 'system_note');
  var systemPrompt = [
    'Eres Mia de LinkMarket.',
    'Convierte la respuesta de Central en un mensaje amable y claro para el cliente.',
    'No te presentés de nuevo. Continúa el pedido en curso. Tono cálido con emojis moderados.',
    'Cliente: ' + (rec.name || ('+' + clientPhone)),
    'Consulta original: ' + (pending.originalMessage || ''),
    'Respuesta de Central: ' + ownerMessage
  ].join('\n');
  return callClaude([{ role: 'user', content: ownerMessage }], systemPrompt)
    .then(function(reply) {
      if (conversations[clientPhone] && conversations[clientPhone].history) {
        conversations[clientPhone].history.push({ role: 'assistant', content: 'Central confirmó: ' + ownerMessage });
      }
      return sendWhatsApp(clientPhone, reply).then(function() { return notifyChatwoot(clientPhone, reply, 'mia_note'); });
    })
    .then(function() { console.log('[Central] Respuesta transmitida a +' + clientPhone); return true; })
    .catch(function(e) { console.error('[Central] Error: ' + e.message); return false; });
}

// ─── BROKER (BIENES RAICES DEMO) ─────────────────────────────────────────────
function findRealEstateProvider(providers) {
  return (providers || []).find(function(p) { return isRealEstateProvider(p); }) || null;
}

function sendBrokerConsultRequest(clientPhone, provider, topic, originalMessage) {
  provider = provider || findRealEstateProvider(loadProviders());
  if (!provider || !provider.telefono) { sendOwnerConsultRequest(clientPhone, topic, originalMessage); return; }
  var cleanClient = normalizePhone(clientPhone);
  var brokerPhone = normalizePhone(provider.notificar_a || provider.telefono);
  var rec = getClientRecord(cleanClient);
  var exactQuestion = originalMessage || topic || 'consulta inmobiliaria';
  var clientLang = rec.real_estate_language || detectMessageLanguage(exactQuestion);
  pendingBrokerConsult[brokerPhone] = { clientPhone: cleanClient, providerId: provider.id, originalMessage: exactQuestion, clientLanguage: clientLang, createdAt: Date.now() };
  updateClientRecord(cleanClient, { real_estate_pending: true, real_estate_language: clientLang, broker_last_question: exactQuestion });
  var msg = '🏠 *Consulta demo inmobiliaria - LinkMarket*\nCliente: +' + cleanClient + '\nPregunta: ' + exactQuestion + '\n\nResponde aquí y Mia se lo transmite.';
  sendWhatsApp(brokerPhone, msg);
}

function processBrokerConsultReply(brokerPhone, brokerMessage) {
  var cleanBroker = normalizePhone(brokerPhone);
  var pending = pendingBrokerConsult[cleanBroker];
  if (!pending || !pending.clientPhone) return Promise.resolve(false);
  delete pendingBrokerConsult[cleanBroker];
  var clientPhone = pending.clientPhone;
  updateClientRecord(clientPhone, { real_estate_pending: false, broker_last_answer: brokerMessage });
  notifyChatwoot(clientPhone, 'Respuesta del corredor:\n' + brokerMessage, 'system_note');
  var directReply = 'Me confirma el corredor: ' + brokerMessage;
  if (conversations[clientPhone] && conversations[clientPhone].history) {
    conversations[clientPhone].history.push({ role: 'assistant', content: directReply });
  }
  return sendWhatsApp(clientPhone, directReply).then(function() { return notifyChatwoot(clientPhone, directReply, 'mia_note'); }).then(function() { return true; }).catch(function() { return false; });
}

function processBrokerStandaloneMessage(brokerPhone, message) {
  return Promise.resolve('Recibido. Cuando Mia necesite confirmar algo de una propiedad, te consultará por aquí.');
}

// ─── MENSAJE DE CLIENTE CON MEDIA ────────────────────────────────────────────
function handleClientMediaMessage(m, providers) {
  var cleanPhone = normalizePhone(m.from);
  var mediaInfo = getWhatsAppMediaInfo(m);
  var latestClient = updateClientRecord(cleanPhone, {});
  var displayName = latestClient.name || ('+' + cleanPhone);
  if (!mediaInfo) {
    var unsupportedMsg = 'Por ahora no puedo procesar audios automáticamente 🙏. Escríbeme el pedido o consulta por texto y te ayudo enseguida.';
    return ensureChatwootConversation(cleanPhone)
      .then(function(conversation) {
        return createChatwootMessageSafe(conversation.id, 'El cliente envió audio no procesable.', 'client_note', displayName)
          .then(function() { return sendWhatsApp(cleanPhone, unsupportedMsg).then(function() { return createChatwootMessageSafe(conversation.id, unsupportedMsg, 'mia_note'); }); });
      })
      .catch(function() { return sendWhatsApp(cleanPhone, unsupportedMsg); });
  }
  var label = getMediaTypeLabel(mediaInfo.type);
  var clientNote = 'Envió ' + label + ' para revisión.' + (mediaInfo.caption ? '\nTexto adjunto: ' + mediaInfo.caption : '');
  var targetPhone = OWNER_NUMBER;
  var summary = '📎 *Archivo de cliente LinkMarket*\nCliente: +' + cleanPhone + '\nTipo: ' + label + (mediaInfo.caption ? '\nMensaje: ' + mediaInfo.caption : '') + '\nPor favor revisar.';
  var clientReply = 'Recibí tu ' + label + ' 👍. Lo envío para revisión y te confirmo enseguida.';
  return ensureChatwootConversation(cleanPhone)
    .then(function(conversation) {
      return createChatwootMessageSafe(conversation.id, clientNote, 'client_note', displayName)
        .then(function() { return sendWhatsApp(targetPhone, summary); })
        .then(function() {
          if (mediaInfo.type !== 'contacts' && mediaInfo.type !== 'location') return sendWhatsAppMedia(targetPhone, mediaInfo, 'Archivo del cliente +' + cleanPhone);
        })
        .then(function() { return sendWhatsApp(cleanPhone, clientReply); })
        .then(function() { return createChatwootMessageSafe(conversation.id, clientReply, 'mia_note'); });
    })
    .catch(function(e) { console.error('[Media] Error: ' + e.message); return sendWhatsApp(cleanPhone, clientReply); });
}

// ─── PROCESO PRINCIPAL ───────────────────────────────────────────────────────
function processMessage(userPhone, userMessage) {
  var providers = loadProviders();
  if (!conversations[userPhone]) conversations[userPhone] = { history: [], lastOrderTime: null, messageCount: 0 };
  var conv = conversations[userPhone];
  conv.messageCount = (conv.messageCount || 0) + 1;
  var clientRecord = getClientRecord(userPhone);
  var fechaHoraEcuador = getEcuadorDateTimeText();
  var centralLastAnswer = clientRecord.central_last_answer || '';
  var centralLastQuestion = clientRecord.central_last_question || '';
  if (conv.lastOrderTime && (Date.now() - conv.lastOrderTime) > 7200000) { conv.history = []; conv.lastOrderTime = null; }
  conv.history.push({ role: 'user', content: userMessage });
  var catalogText = buildCatalogText(providers);

  var systemPrompt = [
    'Eres "Mia", asistente de LinkMarket. LinkMarket es un servicio de mandados y delivery que gestiona pedidos de múltiples proveedores locales en un solo pedido.',
    'Tono: amable, directo y conciso. Mensajes cortos pero cálidos. Usa emojis moderados.',
    '',
    'IDENTIDAD:',
    '- Eres Mia de LinkMarket. No eres ningún proveedor específico.',
    '- Un cliente PUEDE pedir items de varios proveedores en el mismo pedido (ej: comida de Margarita + empanadas de Marquito). Coordinás todo vos.',
    '- Al saludar preséntate como: "Hola, soy Mia de LinkMarket 👋 ¿En qué te ayudo hoy? Puedo hacer mandados, pedidos de comida, snacks y más." No te limites a comida.',
    '',
    'CONTEXTO ACTUAL:',
    '- Fecha y hora: ' + fechaHoraEcuador,
    '- Número del cliente: +' + userPhone,
    '- Nombre registrado: ' + (clientRecord.name || 'SIN NOMBRE REGISTRADO'),
    '- Último pedido: ' + (clientRecord.last_order || 'sin pedido anterior'),
    '- Última consulta a Central: ' + (centralLastQuestion || 'ninguna'),
    '- Última respuesta de Central: ' + (centralLastAnswer || 'ninguna'),
    '- Mensaje número ' + conv.messageCount + ' de esta conversación.',
    '',
    'MEMORIA CON EL CLIENTE:',
    '- Si no tiene nombre, pídelo con naturalidad SOLO cuando no estés preguntando algo operativo del pedido. No mezcles con preguntas de envío, dirección, pago o salsas.',
    '- Si ya tiene nombre úsalo ocasionalmente con naturalidad, no en cada mensaje.',
    '- Si hay pedido anterior puedes mencionarlo: "¿Repetimos como la otra vez?"',
    '',
    'CATÁLOGO DISPONIBLE (proveedores activos):\n' + catalogText,
    '',
    'JUGOS (solo si el proveedor los ofrece): limón, mora, maracuyá.',
    '',
    'REGLAS DE ALITAS (Margarita):',
    '- Salsas disponibles: BBQ, Honey Mustard, Buffalo (picante).',
    '- 4 alitas: preguntar 1 salsa. 8 o 12 alitas: preguntar 2 salsas o si quiere la misma. 20 alitas: puede incluir las 3.',
    '- Nunca cerrar el pedido de alitas sin confirmar salsas.',
    '',
    'REGLAS DE PRECIOS:',
    '- Usa precios del catálogo tal cual. Sin margen adicional.',
    '- Envases: $0.25 por cada plato/ítem principal para pedidos a domicilio o para llevar.',
    '- Delivery dentro de Plaza/Urbanización Volare: subtotal ≤ $7.00 cobra $0.50; subtotal > $7.00 cobra $1.00.',
    '- Delivery fuera de Plaza Volare: pide la dirección completa y consulta el costo a Central una sola vez. Si ya tienes respuesta reciente de Central sobre ese envío, úsala sin volver a consultar.',
    '',
    'PAGOS ACEPTADOS:',
    '- Efectivo al momento de la entrega.',
    '- Transferencia: YOLOCORP S.A.S. | RUC: 0993367608001 | Cta Cte Produbanco: 2006168082. SOLO dar estos datos si el cliente elige transferencia. Luego pedir foto del comprobante.',
    '- Tarjeta de crédito o débito: hay un recargo del 6% sobre el total. El link de pago llega en minutos. El total en el JSON debe incluir ese 6% cuando el método sea tarjeta.',
    '',
    'FLUJO DEL PEDIDO:',
    '1. Saludar como Mia de LinkMarket y preguntar qué necesita.',
    '2. Tomar todos los ítems (de uno o varios proveedores) antes de cerrar.',
    '3. Preguntar si retira o si desea envío a domicilio.',
    '4. Si es domicilio: pedir dirección completa.',
    '5. Confirmar nombre del cliente.',
    '6. Mostrar resumen con todos los ítems agrupados por proveedor + envases + delivery = total.',
    '7. Preguntar método de pago.',
    '8. Si elige transferencia: dar datos bancarios y pedir foto del comprobante.',
    '9. Si elige tarjeta: avisar el recargo del 6% y confirmar.',
    '10. Confirmar con el JSON multi-proveedor.',
    '',
    'PARA CONFIRMAR UN PEDIDO responde UNICAMENTE este JSON (sin texto antes ni después):',
    '{"accion":"pedido_confirmado","nombre_cliente":"Nombre","direccion":"direccion o Retiro en local","metodo_pago":"efectivo","delivery":1.00,"total":15.50,"items_por_proveedor":[{"proveedor_id":"margarita","items":[{"nombre":"Encebollado + Chifle","cantidad":1,"precio":3.50,"salsas":""}],"subtotal":3.50},{"proveedor_id":"marquito","items":[{"nombre":"Empanada de queso","cantidad":4,"precio":0.75,"salsas":""}],"subtotal":3.00}]}',
    'El total = suma de todos los subtotales + delivery (+ 6% si es tarjeta). Incluye solo los proveedores que tienen items en el pedido.',
    '',
    'Para consultas fuera del menú o costos de envío fuera de Volare responde UNICAMENTE:',
    '{"accion":"consultar","producto":"descripcion exacta de la consulta"}'
  ].join('\n');

  return callClaude(conv.history, systemPrompt)
    .then(function(msg) {
      msg = appendNameQuestionIfNeeded(userPhone, conv, msg);
      conv.history.push({ role: 'assistant', content: msg });

      try {
        var s = msg.indexOf('{'), e = msg.lastIndexOf('}');
        if (s !== -1 && e !== -1) {
          var action = JSON.parse(msg.substring(s, e + 1));

          // ── PEDIDO CONFIRMADO ────────────────────────────────────────────
          if (action.accion === 'pedido_confirmado') {
            var orderNum = getNextOrderNumber();
            var orderTag = formatOrderTag(orderNum);
            var nombreCliente = action.nombre_cliente || 'Sin nombre';
            var direccion = action.direccion || 'Retiro en local';
            var metodoPago = action.metodo_pago || 'efectivo';
            var delivery = parseFloat(action.delivery || 0).toFixed(2);
            var total = parseFloat(action.total || 0).toFixed(2);
            var itemsPorProv = Array.isArray(action.items_por_proveedor) ? action.items_por_proveedor : [];

            // Texto de todos los ítems para cliente y dueño
            var allItemsText = '';
            itemsPorProv.forEach(function(pp) {
              var prov = findProviderById(providers, pp.proveedor_id);
              var provNombre = prov ? prov.nombre : pp.proveedor_id;
              allItemsText += '🏪 *' + provNombre + ':*\n';
              (pp.items || []).forEach(function(i) {
                allItemsText += '  - ' + i.cantidad + 'x ' + i.nombre;
                if (i.salsas) allItemsText += ' (' + i.salsas + ')';
                allItemsText += ': $' + parseFloat(i.precio * i.cantidad).toFixed(2) + '\n';
              });
            });

            // Mensaje individual a cada proveedor (solo sus ítems, sin datos del cliente)
            itemsPorProv.forEach(function(pp) {
              var prov = findProviderById(providers, pp.proveedor_id);
              if (!prov || prov.es_proveedor_externo === false) return;
              var tel = prov ? prov.telefono : null;
              if (!tel) return;
              var itemsTexto = (pp.items || []).map(function(i) {
                var line = '  - ' + i.cantidad + 'x ' + i.nombre;
                if (i.salsas) line += ' (' + i.salsas + ')';
                return line;
              }).join('\n');
              var msgProv = '🛒 *PEDIDO ' + orderTag + ' — LinkMarket*\n\n';
              msgProv += itemsTexto + '\n\n';
              msgProv += '📍 Destino: ' + direccion + '\n';
              msgProv += '💳 Pago: ' + metodoPago.toUpperCase() + '\n';
              msgProv += '✅ Por favor preparar y avisar cuando esté listo.';
              pendingClientForProvider[tel] = userPhone;
              setTimeout(function() { if (pendingClientForProvider[tel] === userPhone) delete pendingClientForProvider[tel]; }, 1800000);
              sendWhatsApp(tel, msgProv);
            });

            // Mensaje al motorizado con todos los puntos de recogida + entrega
            if (LOGISTICS_NUMBER) {
              var msgMoto = '🛵 *PEDIDO ' + orderTag + ' — INSTRUCCIONES*\n\n';
              msgMoto += '*RECOGER:*\n';
              itemsPorProv.forEach(function(pp) {
                var prov = findProviderById(providers, pp.proveedor_id);
                var provNombre = prov ? prov.nombre : pp.proveedor_id;
                var provUbic = prov ? (prov.ubicacion || '') : '';
                msgMoto += '📦 ' + provNombre;
                if (provUbic) msgMoto += ' — ' + provUbic;
                msgMoto += '\n';
                (pp.items || []).forEach(function(i) {
                  msgMoto += '   - ' + i.cantidad + 'x ' + i.nombre + '\n';
                });
              });
              msgMoto += '\n*ENTREGAR A:*\n';
              msgMoto += '👤 ' + nombreCliente + '\n';
              msgMoto += '📍 ' + direccion + '\n';
              msgMoto += '💵 Cobrar: $' + total + '\n';
              msgMoto += '💳 Pago: ' + metodoPago.toUpperCase();
              sendWhatsApp(LOGISTICS_NUMBER, msgMoto);
            }

            // Notificación al dueño
            if (OWNER_NUMBER) {
              var msgDueno = '✅ *PEDIDO ' + orderTag + ' CONFIRMADO*\n';
              msgDueno += '👤 ' + nombreCliente + ' | 📞 +' + userPhone + '\n\n';
              msgDueno += allItemsText;
              msgDueno += '🛵 Delivery: $' + delivery + '\n';
              msgDueno += '💰 *Total: $' + total + '*\n';
              msgDueno += '💳 Pago: ' + metodoPago + '\n';
              msgDueno += '📍 ' + direccion;
              sendWhatsApp(OWNER_NUMBER, msgDueno);
            }

            // Registrar entrega activa
            activeDeliveries[orderNum] = { clientPhone: userPhone, orderTag: orderTag, ts: Date.now() };

            // Flujo de pago
            if (metodoPago.toLowerCase().indexOf('transferencia') !== -1) {
              setTimeout(function() {
                var msgT = '🏦 *Datos para transferencia:*\n';
                msgT += 'YOLOCORP S.A.S.\nRUC: 0993367608001\nCta Cte Produbanco: 2006168082\n';
                msgT += 'Monto: *$' + total + '*\n\nEnvía el comprobante aquí para confirmar tu pedido. 📎';
                sendWhatsApp(userPhone, msgT);
                notifyChatwoot(userPhone, msgT, 'mia_note');
              }, 2000);
            } else if (metodoPago.toLowerCase().indexOf('tarjeta') !== -1) {
              pendingCardPayment[orderTag] = { clientPhone: userPhone };
              if (OWNER_NUMBER) {
                var msgLinkReq = '💳 *LINK DE PAGO REQUERIDO*\n';
                msgLinkReq += 'Pedido: ' + orderTag + '\n';
                msgLinkReq += 'Cliente: +' + userPhone + '\n';
                msgLinkReq += 'Monto: $' + total + '\n\n';
                msgLinkReq += 'Por favor generá el link y envialo aquí con el formato:\nLINK-' + orderTag + ' https://...';
                sendWhatsApp(OWNER_NUMBER, msgLinkReq);
              }
            }

            // Guardar en historial del cliente
            var nombreClienteValido = sanitizeClientNameCandidate(nombreCliente) || clientRecord.name || '';
            updateClientRecord(userPhone, {
              name: nombreClienteValido,
              last_order: orderTag + ' | ' + allItemsText.replace(/\n/g, ' ').replace(/\*/g, '') + '| Total: $' + total,
              last_order_at: new Date().toISOString()
            });
            conv.lastOrderTime = Date.now();
            conv.history = [];

            // Confirmación al cliente
            var respCliente = '✅ *¡Pedido ' + orderTag + ' confirmado, ' + nombreCliente + '!*\n\n';
            respCliente += allItemsText;
            respCliente += '🛵 Delivery: $' + delivery + '\n';
            respCliente += '💰 *Total: $' + total + '*\n';
            respCliente += '📍 ' + direccion + '\n';
            if (metodoPago.toLowerCase().indexOf('tarjeta') !== -1) respCliente += '💳 En unos minutos recibirás el link de pago. 🔗\n';
            respCliente += '\n⏱ ¡En camino pronto! 🙌';
            return respCliente;
          }

          // ── CONSULTAR A CENTRAL ──────────────────────────────────────────
          if (action.accion === 'consultar') {
            var consultaTxt = String(action.producto || userMessage || '');
            if (hasRecentCentralShippingAnswer(userPhone) && /(env[ií]o|delivery|domicilio|direcci[oó]n|villa|volare|fuera|club)/i.test(consultaTxt + ' ' + userMessage)) {
              return 'Central ya me confirmó ese dato: ' + (getClientRecord(userPhone).central_last_answer || '') + ' 😊. Sigo con tu pedido.';
            }
            sendOwnerConsultRequest(userPhone, action.producto || userMessage, userMessage);
            return 'Dame un momento y confirmo ese dato con Central para darte el valor correcto 🔎. Te aviso enseguida por aquí.';
          }
        }
      } catch(err) {}

      return msg;
    })
    .catch(function(e) { console.error('Error IA: ' + e.message); return 'Disculpa, problema técnico. Intenta de nuevo. 🙏'; });
}

// ─── FLUJO DE CLIENTE ────────────────────────────────────────────────────────
function handleClientWhatsAppMessage(fromPhone, text) {
  var cleanPhone = normalizePhone(fromPhone);
  updateClientNameFromMessage(cleanPhone, text);
  return ensureChatwootConversation(cleanPhone)
    .then(function(conversation) {
      var latestClient = getClientRecord(cleanPhone);
      var displayName = latestClient.name || ('+' + cleanPhone);
      return createChatwootMessageSafe(conversation.id, text, 'client_note', displayName)
        .then(function() {
          if (isMiaPaused(cleanPhone)) {
            console.log('[Mia] Pausada para ' + cleanPhone);
            return createChatwootMessageSafe(conversation.id, 'Mia pausada para este cliente. Mensaje recibido sin respuesta automática.', 'system_note');
          }
          return processMessage(cleanPhone, text)
            .then(function(reply) {
              return sendWhatsApp(cleanPhone, reply).then(function() { return createChatwootMessageSafe(conversation.id, reply, 'mia_note'); });
            });
        });
    })
    .catch(function(e) {
      console.error('[Chatwoot] ERROR flujo cliente ' + cleanPhone + ': ' + e.message);
      if (isMiaPaused(cleanPhone)) return null;
      return processMessage(cleanPhone, text).then(function(reply) { return sendWhatsApp(cleanPhone, reply); });
    });
}

// ─── SERVIDOR HTTP ───────────────────────────────────────────────────────────
function subscribeWABA() {
  var emptyBody = '{}';
  var headers = { 'Authorization': 'Bearer ' + WHATSAPP_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(emptyBody) };
  httpsPost('graph.facebook.com', '/v19.0/' + WABA_ID + '/subscribed_apps', headers, emptyBody)
    .then(function(r) { console.log('WABA suscrito:', JSON.stringify(r)); })
    .catch(function(e) { console.error('Error suscripcion WABA:', e.message); });
}

var server = http.createServer(function(req, res) {
  var parsed = url.parse(req.url, true);
  var pathname = parsed.pathname;

  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'LinkMarket v4.0-multiprov operativo' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/privacy') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>Politica de Privacidad - LinkMarket</title></head><body><h1>Politica de Privacidad - LinkMarket</h1><p>LinkMarket usa WhatsApp para recibir y responder pedidos de clientes.</p><p>Los datos procesados incluyen numero de telefono, mensajes, productos solicitados y direccion de entrega.</p><p>Estos datos se usan unicamente para gestionar pedidos y coordinar entregas.</p><p>Para solicitar acceso o eliminacion de datos escribe al mismo numero de WhatsApp o al correo aromerosecaira@hotmail.com.</p><p>Ultima actualizacion: junio 2026.</p></body></html>');
    return;
  }

  if (req.method === 'GET' && pathname === '/webhook') {
    var mode = parsed.query['hub.mode'];
    var token = parsed.query['hub.verify_token'];
    var challenge = parsed.query['hub.challenge'];
    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) { res.writeHead(200); res.end(challenge); }
    else { res.writeHead(403); res.end('Forbidden'); }
    return;
  }

  if (req.method === 'POST' && pathname === '/webhook') {
    res.writeHead(200); res.end('OK');
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var data = JSON.parse(body);
        if (data.object === 'whatsapp_business_account') {
          (data.entry || []).forEach(function(entry) {
            (entry.changes || []).forEach(function(change) {
              var msgs = change.value && change.value.messages;
              if (!msgs) return;
              msgs.forEach(function(m) {
                var providers = loadProviders();

                if (m.type === 'text') {
                  console.log('Mensaje de ' + m.from + ': ' + m.text.body);
                  var fromClean = normalizePhone(m.from);

                  // 1. Dueño/supervisor
                  if (OWNER_NUMBER && fromClean === normalizePhone(OWNER_NUMBER)) {
                    // Detectar link de pago: LINK-#0001 https://...
                    var linkMatch = m.text.body.match(/LINK-?(#?\d+)\s+(https?:\/\/\S+)/i);
                    if (linkMatch) {
                      var orderTag = '#' + String(linkMatch[1]).replace(/\D/g, '').padStart(4, '0');
                      var linkUrl = linkMatch[2];
                      var pending = pendingCardPayment[orderTag];
                      if (pending && pending.clientPhone) {
                        var msgLink = '💳 *Link de pago para tu pedido ' + orderTag + ':*\n' + linkUrl + '\n\nUna vez completado tu pedido quedará confirmado. ✅';
                        sendWhatsApp(pending.clientPhone, msgLink);
                        notifyChatwoot(pending.clientPhone, msgLink, 'mia_note');
                        delete pendingCardPayment[orderTag];
                        console.log('[Pago] Link ' + orderTag + ' enviado a +' + pending.clientPhone);
                      }
                      return;
                    }
                    // Respuesta a consulta pendiente de Central
                    if (pendingOwnerConsult[OWNER_NUMBER] || pendingOwnerConsult[fromClean]) {
                      processOwnerConsultReply(m.from, m.text.body);
                      return;
                    }
                  }

                  // 2. Motorizado
                  if (LOGISTICS_NUMBER && fromClean === normalizePhone(LOGISTICS_NUMBER)) {
                    processMotoristaMessage(m.from, m.text.body);
                    return;
                  }

                  // 3. Broker/corredor inmobiliario
                  if (pendingBrokerConsult[fromClean]) { processBrokerConsultReply(m.from, m.text.body); return; }
                  if (isBrokerNumber(m.from, providers)) {
                    processBrokerStandaloneMessage(m.from, m.text.body).then(function(reply) { sendWhatsApp(m.from, reply); });
                    return;
                  }

                  // 4. Proveedor externo
                  if (isProviderNumber(m.from, providers)) {
                    processProviderMessage(m.from, m.text.body, providers).then(function(reply) { sendWhatsApp(m.from, reply); });
                    return;
                  }

                  // 5. Cliente
                  handleClientWhatsAppMessage(m.from, m.text.body);
                  return;
                }

                if (m.type === 'audio') {
                  if (!isProviderNumber(m.from, providers)) handleClientMediaMessage(m, providers);
                  return;
                }

                // Media (imagen, documento, etc.)
                if (!isProviderNumber(m.from, providers)) {
                  handleClientMediaMessage(m, providers);
                } else if (OWNER_NUMBER) {
                  sendWhatsApp(OWNER_NUMBER, '📎 El proveedor +' + m.from + ' envió un archivo tipo ' + m.type + '. Revisar en WhatsApp.');
                }
              });
            });
          });
        }
      } catch(e) { console.error('Error webhook: ' + e.message); }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/chatwoot-webhook') {
    res.writeHead(200); res.end('OK');
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
          (conversation.meta && conversation.meta.sender && conversation.meta.sender.phone_number) ||
          (conversation.meta && conversation.meta.sender && conversation.meta.sender.identifier) || '';
        var fromPhone = normalizePhone(phoneRaw);
        if (!fromPhone) return;

        if (isPrivate && /^(MIA\s*ON|BOT\s*ON|DEVOLVER\s+A\s+MIA)$/i.test(rawText)) {
          resumeMia(fromPhone);
          notifyChatwoot(fromPhone, 'Mia fue reactivada para este cliente.', 'system_note');
          return;
        }
        if (isPrivate && /^(MIA\s*OFF|BOT\s*OFF|PAUSAR\s+MIA)$/i.test(rawText)) {
          pauseMia(fromPhone, 3);
          notifyChatwoot(fromPhone, 'Mia fue pausada para este cliente. Se reactivará automáticamente si no hay mensajes en 3 minutos.', 'system_note');
          return;
        }
        if (isPrivate) {
          if (isSystemGeneratedChatwootNote(rawText)) return;
          var manualMatch = rawText.match(/^(WA|CENTRAL)(?:\s*[:：]\s*|\s+)([\s\S]+)$/i);
          if (!manualMatch) return;
          var humanText = String(manualMatch[2] || '').trim();
          if (!humanText) return;
          sendWhatsApp(fromPhone, humanText).then(function() {
            pauseMia(fromPhone, 3); // pausa 3 min desde el último mensaje del humano
            notifyChatwoot(fromPhone, humanText, 'human_note');
          });
          return;
        }
        if (!isPrivate && msgType === 'outgoing') {
          if (isSystemGeneratedChatwootNote(rawText)) return;
          sendWhatsApp(fromPhone, rawText).then(function() { pauseMia(fromPhone, 3); });
          return;
        }
      } catch(e) { console.error('Error chatwoot-webhook: ' + e.message); }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, function() {
  console.log('LinkMarket v4.0-multiprov corriendo en puerto ' + PORT);
  subscribeWABA();
});
