require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');
const { Resend } = require('resend');

const { db, q }                                = require('./db');
const { createGooglePass, updateGooglePass, getEnrollmentUrl, expireGooglePass, reactivateGooglePass } = require('./wallet-google');

const { createApplePass,  updateApplePass  }   = require('./wallet-apple');
const { pushPassUpdate }                       = require('./apns');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// La raíz no tiene tarjeta asociada — evita que express.static sirva
// public/index.html (pensado solo para /enroll/:token) sin token.
app.get('/', (_req, res) => res.redirect('/join'));

app.use(express.static('public'));
app.use(session({
  secret:            process.env.SESSION_SECRET || 'change-me-in-production',
  resave:            false,
  saveUninitialized: false,
  cookie:            { maxAge: 8 * 60 * 60 * 1000 }, // 8h
}));

const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin';
const STAMPS_TO_WIN = 10;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (req.session?.admin) return next();
  res.status(401).json({ error: 'No autorizado' });
}

function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d.toISOString().split('T')[0];
}

function isValidPhone(raw) {
  const clean = (raw || '').replace(/[\s\-().]/g, '');
  return /^(\+34|0034)?[6789]\d{8}$/.test(clean);
}
function isValidEmail(raw) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw || '');
}
function validateContact(name, phone, email) {
  if (!name?.trim())          return 'Nombre requerido';
  if (!phone?.trim())         return 'Teléfono requerido';
  if (!isValidPhone(phone))   return 'Teléfono no válido';
  if (!email?.trim())         return 'Email requerido';
  if (!isValidEmail(email))   return 'Email no válido';
  return null;
}

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const RESEND_FROM = process.env.RESEND_FROM || `${process.env.BUSINESS_NAME || 'Loyalty'} <noreply@example.com>`;

async function sendVipReminder(card) {
  if (!resend) return;
  const expiryFormatted = new Date(card.vip_expiry).toLocaleDateString('es-ES', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  await resend.emails.send({
    from:    RESEND_FROM,
    to:      card.client_email,
    subject: `Tu tarjeta VIP caduca el ${expiryFormatted}`,
    html: `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f0ea;font-family:'Helvetica Neue',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0ea;padding:40px 16px">
    <tr><td align="center">
      <table width="100%" style="max-width:480px;background:#0d0c0a;border-radius:4px;overflow:hidden">
        <tr>
          <td style="padding:36px 32px 24px;text-align:center;border-bottom:1px solid rgba(201,169,110,0.2)">
            <div style="font-size:22px;font-weight:300;color:#ede5d8;letter-spacing:1px">${process.env.BUSINESS_NAME || 'Loyalty'}</div>
            <div style="font-size:10px;color:#7a6e60;text-transform:uppercase;letter-spacing:2px;margin-top:4px">Programa VIP</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 8px">
            <p style="margin:0 0 16px;font-size:16px;color:#ede5d8;font-weight:300">
              Hola, <strong style="font-weight:500">${card.client_name}</strong> 👋
            </p>
            <p style="margin:0 0 16px;font-size:14px;color:#b8a896;line-height:1.7">
              Tu tarjeta VIP caduca el <strong style="color:#c9a96e">${expiryFormatted}</strong>.
              Recuerda que puedes renovarla haciendo un <strong style="color:#ede5d8">alisado</strong>
              antes de esa fecha — la nueva caducidad se extiende 6 meses desde el día del servicio.
            </p>
            <p style="margin:0 0 24px;font-size:14px;color:#b8a896;line-height:1.7">
              Llama o escríbenos para pedir cita. ¡Te esperamos!
            </p>
            <div style="background:rgba(201,169,110,0.08);border:1px solid rgba(201,169,110,0.2);padding:16px 20px;margin-bottom:24px">
              <div style="font-size:10px;color:#7a6e60;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px">Tu estado actual</div>
              <div style="font-size:14px;color:#ede5d8">${card.stamps} de 10 sellos · VIP hasta ${expiryFormatted}</div>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px 32px;border-top:1px solid rgba(201,169,110,0.1)">
            <p style="margin:0;font-size:11px;color:#4a4038;line-height:1.6;text-align:center">
              Estás recibiendo este mensaje porque eres cliente VIP de ${process.env.BUSINESS_NAME || 'nuestro negocio'}.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  });
}

async function checkVipExpiry() {
  if (!resend) return;
  try {
    const cards = q.getCardsNeedingReminder.all();
    for (const card of cards) {
      try {
        await sendVipReminder(card);
        q.markReminderSent.run(card.id);
        console.log(`[Reminder] Sent to ${card.client_email} (card ${card.id}, expires ${card.vip_expiry})`);
      } catch (e) {
        console.error(`[Reminder] Failed for card ${card.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Reminder] checkVipExpiry error:', e.message);
  }
}

async function checkExpiredCards() {
  try {
    const cards = q.getExpiredCards.all();
    for (const card of cards) {
      try {
        if (card.google_object_id) await expireGooglePass(card.google_object_id, card.client_name, card.stamps, card.vip_expiry, card.enrollment_token);
        if (card.apple_serial) {
          await updateApplePass(card.id, card.apple_serial, card.client_name, card.stamps, card.vip_expiry, true, card.enrollment_token);
        }
        q.markPassExpired.run(card.id);
        await pushPassUpdate(card.id);
        console.log(`[Expired] Marked card ${card.id} (${card.client_name}) as expired`);
      } catch (e) {
        console.error(`[Expired] Failed for card ${card.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('[Expired] checkExpiredCards error:', e.message);
  }
}

async function pushGoogleUpdate(card) {
  if (!card.google_object_id) return;
  try {
    await updateGooglePass(card.google_object_id, card.stamps, card.vip_expiry, card.enrollment_token);
  } catch (e) {
    console.error('Google Wallet update failed:', e.message);
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASS) {
    req.session.admin = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Contraseña incorrecta' });
  }
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ─── Admin UI ─────────────────────────────────────────────────────────────────

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── API: Clients ─────────────────────────────────────────────────────────────

app.get('/api/clients', requireAdmin, (req, res) => {
  const q_str = `%${req.query.q || ''}%`;
  const clients = q.searchClients.all(q_str, q_str);
  res.json(clients);
});

app.post('/api/clients', requireAdmin, async (req, res) => {
  const { name, phone, email } = req.body;
  const validationError = validateContact(name, phone, email);
  if (validationError) return res.status(400).json({ error: validationError });

  try {
    const [client] = q.createClient.all(name.trim(), phone.trim(), email.trim());
    const token    = uuidv4();
    const [card]   = q.createCard.all(client.id, token);

    // Create Google Wallet pass (best-effort — needs credentials)
    if (process.env.GOOGLE_ISSUER_ID && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
      try {
        const objectId = await createGooglePass(card.id, client.name, 0, null, card.enrollment_token);
        q.setGoogleObjectId.run(objectId, card.id);
        card.google_object_id = objectId;
      } catch (e) {
        console.error('Google pass creation failed:', e.message);
      }
    }

    res.json({ client, card, enrollmentUrl: `${process.env.BASE_URL}/enroll/${token}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error creando cliente' });
  }
});

app.get('/api/clients/:id', requireAdmin, (req, res) => {
  const client = q.getClient.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

  const history = client.card_id ? q.getStampHistory.all(client.card_id) : [];
  const enrollmentUrl = client.enrollment_token
    ? `${process.env.BASE_URL}/enroll/${client.enrollment_token}`
    : null;

  res.json({ ...client, history, enrollmentUrl });
});

// ─── API: Cards ───────────────────────────────────────────────────────────────

app.get('/api/cards/:cardId', requireAdmin, (req, res) => {
  const card = q.getCardById.get(req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Tarjeta no encontrada' });
  const history = q.getStampHistory.all(card.id);
  res.json({ ...card, history });
});

app.post('/api/cards/:cardId/stamp', requireAdmin, async (req, res) => {
  const card = q.getCardById.get(req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Tarjeta no encontrada' });
  const serviceType  = req.body.service_type === 'alisado' ? 'alisado' : 'otro';
  const notes        = req.body.notes?.trim() || null;
  const stampsBefore = card.stamps;
  const stampsAfter  = stampsBefore >= STAMPS_TO_WIN ? 1 : stampsBefore + 1;
  const prizePending = stampsAfter >= STAMPS_TO_WIN ? 1 : 0;

  let newVipExpiry   = card.vip_expiry;
  let lastAlisado    = card.last_alisado;

  if (serviceType === 'alisado') {
    lastAlisado  = new Date().toISOString().split('T')[0];
    newVipExpiry = addMonths(lastAlisado, 6);
  }

  q.updateStamps.run(stampsAfter, lastAlisado, newVipExpiry, prizePending, card.id);
  q.addStampEvent.run(card.id, serviceType, notes, stampsBefore, stampsAfter);
  if (serviceType === 'alisado') q.resetReminder.run(card.id);

  // Si es alisado y hay una invitación pendiente de crédito, dar sello a quien invitó
  if (serviceType === 'alisado') {
    const pendingRef = q.getPendingReferralByCard.get(card.id);
    if (pendingRef) {
      const refCard = q.getCardById.get(pendingRef.referrer_card_id);
      if (refCard && !refCard.prize_pending) {
        const refBefore = refCard.stamps;
        const refAfter  = refBefore >= STAMPS_TO_WIN ? 1 : refBefore + 1;
        const refPrize  = refAfter >= STAMPS_TO_WIN ? 1 : 0;
        q.updateStamps.run(refAfter, null, null, refPrize, refCard.id);
        q.addStampEvent.run(refCard.id, 'alisado', `Sello por invitar a ${card.client_name}`, refBefore, refAfter);
        await pushGoogleUpdate(q.getCardById.get(refCard.id));
      }
      q.creditReferral.run(pendingRef.id);
    }
  }

  const updated = q.getCardById.get(card.id);
  await pushGoogleUpdate(updated);
  await pushPassUpdate(card.id);

  res.json({ card: updated, prize: prizePending === 1 });
});

app.post('/api/cards/:cardId/award-prize', requireAdmin, async (req, res) => {
  const card = q.getCardById.get(req.params.cardId);
  if (!card) return res.status(404).json({ error: 'Tarjeta no encontrada' });

  q.resetCard.run(card.id);
  const updated = q.getCardById.get(card.id);
  await pushGoogleUpdate(updated);

  res.json({ card: updated });
});

// Referral: stamp goes to referrer, new client+card created for friend
app.post('/api/cards/:cardId/referral', requireAdmin, async (req, res) => {
  const referrerCard = q.getCardById.get(req.params.cardId);
  if (!referrerCard) return res.status(404).json({ error: 'Tarjeta no encontrada' });

  const { name, phone, email, service_type, notes } = req.body;
  const validationError = validateContact(name, phone, email);
  if (validationError) return res.status(400).json({ error: validationError });

  // Add stamp to referrer
  const serviceType  = service_type === 'alisado' ? 'alisado' : 'otro';
  const stampsBefore = referrerCard.stamps;
  const stampsAfter  = stampsBefore >= STAMPS_TO_WIN ? 1 : stampsBefore + 1;
  const prizePending = stampsAfter >= STAMPS_TO_WIN ? 1 : 0;

  let newVipExpiry = referrerCard.vip_expiry;
  let lastAlisado  = referrerCard.last_alisado;
  if (serviceType === 'alisado') {
    lastAlisado  = new Date().toISOString().split('T')[0];
    newVipExpiry = addMonths(lastAlisado, 6);
  }

  q.updateStamps.run(stampsAfter, lastAlisado, newVipExpiry, prizePending, referrerCard.id);
  q.addStampEvent.run(referrerCard.id, serviceType, notes?.trim() || 'Referido', stampsBefore, stampsAfter);

  // Create new client + card for friend
  const [newClient] = q.createClient.all(name.trim(), phone.trim(), email.trim());
  const token       = uuidv4();
  const [newCard]   = q.createCard.all(newClient.id, token);
  q.addReferral.run(referrerCard.id, newClient.id, 1); // credited immediately (admin flow)

  // New friend: 0 stamps but VIP expiry starts today (6 months window to activate)
  const friendToday     = new Date().toISOString().split('T')[0];
  const friendVipExpiry = addMonths(friendToday, 6);
  q.updateStamps.run(0, null, friendVipExpiry, 0, newCard.id);

  if (process.env.GOOGLE_ISSUER_ID && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
    try {
      const objectId = await createGooglePass(newCard.id, newClient.name, 0, friendVipExpiry, newCard.enrollment_token);
      q.setGoogleObjectId.run(objectId, newCard.id);
    } catch (e) {
      console.error('Google pass creation for referral failed:', e.message);
    }
  }

  const updatedReferrer = q.getCardById.get(referrerCard.id);
  const updatedNewCard  = q.getCardById.get(newCard.id);
  await pushGoogleUpdate(updatedReferrer);

  res.json({
    referrerCard:  updatedReferrer,
    referrerPrize: prizePending === 1,
    newClient,
    newCard:       updatedNewCard,
    enrollmentUrl: `${process.env.BASE_URL}/enroll/${token}`,
  });
});

app.patch('/api/cards/:cardId/admin-edit', requireAdmin, async (req, res) => {
  const card = q.getCardById.get(req.params.cardId);
  if (!card) return res.status(404).json({ error: 'No encontrado' });

  const { name, phone, email, vip_expiry, stamps } = req.body;

  if (name !== undefined) {
    const trimName  = (name  || '').trim();
    const trimPhone = (phone || '').trim();
    const trimEmail = (email || '').trim();
    if (!trimName)                              return res.status(400).json({ error: 'Nombre requerido' });
    if (trimPhone && !isValidPhone(trimPhone))  return res.status(400).json({ error: 'Teléfono no válido' });
    if (trimEmail && !isValidEmail(trimEmail))  return res.status(400).json({ error: 'Email no válido' });
    db.prepare('UPDATE clients SET name=?, phone=?, email=? WHERE id=?')
      .run(trimName, trimPhone, trimEmail || null, card.client_id);
  }

  const newStamps = stamps !== undefined ? Math.max(0, Math.min(10, parseInt(stamps, 10) || 0)) : card.stamps;
  const newExpiry = vip_expiry !== undefined ? (vip_expiry || null) : card.vip_expiry;
  const isExpired = newExpiry ? new Date(newExpiry + 'T23:59:59') < new Date() : false;

  db.prepare("UPDATE cards SET stamps=?, vip_expiry=?, pass_expired=?, updated_at=datetime('now') WHERE id=?")
    .run(newStamps, newExpiry, isExpired ? 1 : 0, card.id);

  const updated = q.getCardById.get(card.id);

  if (updated.google_object_id) {
    try {
      if (isExpired) {
        await expireGooglePass(updated.google_object_id, updated.client_name, updated.stamps, updated.vip_expiry, updated.enrollment_token);
      } else {
        await reactivateGooglePass(updated.google_object_id, updated.client_name, updated.stamps, updated.vip_expiry, updated.enrollment_token);
      }
    } catch (e) {
      console.error('Google Wallet admin-edit update failed:', e.message);
    }
  }

  await pushPassUpdate(updated.id);
  res.json({ ok: true });
});

app.delete('/api/clients/:id', requireAdmin, (req, res) => {
  const client = q.getClient.get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrada' });

  const cardId = client.card_id;
  if (cardId) {
    q.deleteAppleRegsByCard.run(cardId);
    q.deleteStampEvents.run(cardId);
    q.deleteReferralsByCard.run(cardId, client.id);
    q.deleteCard.run(client.id);
  }
  q.deleteClient.run(client.id);
  res.json({ ok: true });
});

// ─── Self-service invite ──────────────────────────────────────────────────────

app.get('/invite/:token', (req, res) => {
  const referrer = q.getReferrerByToken.get(req.params.token);
  if (!referrer) return res.status(404).send('Enlace de invitación no válido');
  res.sendFile(path.join(__dirname, 'public', 'invite.html'));
});

app.get('/api/invite-info/:token', (req, res) => {
  const referrer = q.getReferrerByToken.get(req.params.token);
  if (!referrer) return res.status(404).json({ error: 'No encontrado' });
  res.json({ referrerName: referrer.referrer_name });
});

app.post('/api/invite/:token', async (req, res) => {
  const referrer = q.getReferrerByToken.get(req.params.token);
  if (!referrer) return res.status(404).json({ error: 'Enlace no válido' });

  const { name, phone, email } = req.body;
  const validationError = validateContact(name, phone, email);
  if (validationError) return res.status(400).json({ error: validationError });

  try {
    const [newClient]  = q.createClient.all(name.trim(), phone.trim(), email.trim());
    const token        = uuidv4();
    const [newCard]    = q.createCard.all(newClient.id, token);
    const today        = new Date().toISOString().split('T')[0];
    const initExpiry   = addMonths(today, 6);
    q.updateStamps.run(0, null, initExpiry, 0, newCard.id);
    q.addReferral.run(referrer.card_id, newClient.id, 0); // pending — credited when first alisado

    if (process.env.GOOGLE_ISSUER_ID && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
      try {
        const objectId = await createGooglePass(newCard.id, newClient.name, 0, initExpiry, newCard.enrollment_token);
        q.setGoogleObjectId.run(objectId, newCard.id);
      } catch (e) {
        console.error('Google pass creation (invite) failed:', e.message);
      }
    }

    q.markEnrolled.run(newCard.id);
    res.json({ token, name: newClient.name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error creando tarjeta' });
  }
});

// ─── Enrollment ───────────────────────────────────────────────────────────────

// Self-enrollment: QR fijo del salón
app.get('/join', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

app.post('/api/join', async (req, res) => {
  const { name, phone, email } = req.body;
  const validationError = validateContact(name, phone, email);
  if (validationError) return res.status(400).json({ error: validationError });

  try {
    const [client]   = q.createClient.all(name.trim(), phone.trim(), email.trim());
    const token      = uuidv4();
    const [card]     = q.createCard.all(client.id, token);
    const today      = new Date().toISOString().split('T')[0];
    const initExpiry = addMonths(today, 6);
    q.updateStamps.run(0, null, initExpiry, 0, card.id);

    if (process.env.GOOGLE_ISSUER_ID && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
      try {
        const objectId = await createGooglePass(card.id, client.name, 0, initExpiry, card.enrollment_token);
        q.setGoogleObjectId.run(objectId, card.id);
      } catch (e) {
        console.error('Google pass creation failed:', e.message);
      }
    }

    q.markEnrolled.run(card.id);
    res.json({ token, name: client.name });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error creando tarjeta' });
  }
});

// Public: enrollment page fetches client name by token
app.get('/api/cards-by-token/:token', (req, res) => {
  const card = q.getCardByToken.get(req.params.token);
  if (!card) return res.status(404).json({ error: 'Not found' });
  res.json({ client_name: card.client_name, stamps: card.stamps });
});

app.get('/enroll/:token', (req, res) => {
  const card = q.getCardByToken.get(req.params.token);
  if (!card) return res.status(404).send('Tarjeta no encontrada');
  // Mark as enrolled (first time)
  if (!card.enrolled_at) q.markEnrolled.run(card.id);
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/wallet/google/:token', async (req, res) => {
  const card = q.getCardByToken.get(req.params.token);
  if (!card) return res.status(404).send('Tarjeta no encontrada');
  try {
    let objectId = card.google_object_id;
    if (!objectId) {
      objectId = await createGooglePass(card.id, card.client_name, card.stamps, card.vip_expiry, card.enrollment_token);
      q.setGoogleObjectId.run(objectId, card.id);
    }
    const url = getEnrollmentUrl(objectId);
    res.redirect(url);
  } catch (e) {
    console.error('Google Wallet enrollment error:', e.message);
    res.status(500).send('Error generando enlace');
  }
});

app.get('/wallet/apple/:token', async (req, res) => {
  const card = q.getCardByToken.get(req.params.token);
  if (!card) return res.status(404).send('Tarjeta no encontrada');

  try {
    let serial = card.apple_serial;
    let buffer;

    const isExpired = card.pass_expired === 1;
    if (!serial) {
      const result = await createApplePass(card.id, card.client_name, card.stamps, card.vip_expiry, isExpired, card.enrollment_token);
      serial = result.serial;
      buffer = result.buffer;
      q.setAppleSerial.run(serial, card.id);
    } else {
      buffer = await updateApplePass(card.id, serial, card.client_name, card.stamps, card.vip_expiry, isExpired, card.enrollment_token);
    }

    res.set({
      'Content-Type':        'application/vnd.apple.pkpass',
      'Content-Disposition': 'attachment; filename="tatiana-vip.pkpass"',
      'Content-Length':      buffer.length,
    });
    res.send(buffer);
  } catch (e) {
    console.error('Apple Wallet error:', e);
    res.status(500).send('Error generando pase');
  }
});

// ─── Apple Wallet Update Protocol ────────────────────────────────────────────

// Device registers for updates
app.post('/v1/devices/:deviceId/registrations/:passTypeId/:serial', (req, res) => {
  const card = q.getCardBySerial.get(req.params.serial);
  if (!card) return res.status(404).end();

  const pushToken = req.body.pushToken;
  if (!pushToken) return res.status(400).end();

  q.upsertAppleReg.run(req.params.deviceId, pushToken, card.id);
  console.log(`[APNs] Device registered: card ${card.id}, device ${req.params.deviceId.slice(0,8)}…`);
  res.status(201).end();
});

// Device unregisters
app.delete('/v1/devices/:deviceId/registrations/:passTypeId/:serial', (req, res) => {
  const card = q.getCardBySerial.get(req.params.serial);
  if (!card) return res.status(404).end();
  q.deleteAppleReg.run(req.params.deviceId, card.id);
  res.status(200).end();
});

// List passes updated since lastUpdated
app.get('/v1/devices/:deviceId/registrations/:passTypeId', (req, res) => {
  const since = req.query.passesUpdatedSince || '1970-01-01';
  const passes = q.getCardsUpdatedSince.all(req.params.deviceId, since);
  if (!passes.length) return res.status(204).end();
  res.json({ serialNumbers: passes.map(p => p.apple_serial), lastUpdated: new Date().toISOString() });
});

// Serve updated pass to device
app.get('/v1/passes/:passTypeId/:serial', async (req, res) => {
  const card = q.getCardBySerial.get(req.params.serial);
  if (!card) return res.status(404).end();

  try {
    const buffer = await updateApplePass(card.id, card.apple_serial, card.client_name, card.stamps, card.vip_expiry, card.pass_expired === 1, card.enrollment_token);
    res.set({
      'Content-Type':     'application/vnd.apple.pkpass',
      'Last-Modified':    new Date(card.updated_at).toUTCString(),
      'Content-Length':   buffer.length,
    });
    res.send(buffer);
  } catch (e) {
    console.error('Apple pass serve error:', e);
    res.status(500).end();
  }
});

// Apple Wallet error logs
app.post('/v1/log', (req, res) => {
  console.warn('[Apple Wallet]', JSON.stringify(req.body));
  res.status(200).end();
});

// ─── Test helper (eliminar tras verificar expiración) ────────────────────────
app.post('/api/admin/test-expire', requireAdmin, async (req, res) => {
  const { card_id } = req.body;
  const { db } = require('./db');
  // Borra el object_id para forzar creación de objeto nuevo en Google Wallet
  db.prepare("UPDATE cards SET vip_expiry = date('now', '-1 day'), pass_expired = 0, google_object_id = NULL WHERE id = ?").run(card_id);
  res.json({ ok: true, message: 'Añade la tarjeta de nuevo al Wallet, luego llama a /api/admin/test-expire-run' });
});

app.post('/api/admin/test-expire-run', requireAdmin, async (req, res) => {
  await checkExpiredCards();
  res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Loyalty Wallet running on http://localhost:${PORT}`);
  // Reminders (~60 days before) and expiry marking — once at startup, then every 24h
  setTimeout(() => { checkVipExpiry(); checkExpiredCards(); }, 10_000);
  setInterval(() => { checkVipExpiry(); checkExpiredCards(); }, 24 * 60 * 60 * 1000);
});
