const { GoogleAuth } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const WALLET_API = 'https://walletobjects.googleapis.com/walletobjects/v1';

function issuerId() { return process.env.GOOGLE_ISSUER_ID; }
function classId()  { return `${issuerId()}.${process.env.GOOGLE_CLASS_ID || 'loyalty_vip'}`; }

function getAuth() {
  return new GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key:  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
  });
}

function vipExpiryDisplay(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('es-ES', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

function progressImageUrl(stamps) {
  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  const n = Math.max(0, Math.min(10, stamps || 0));
  return `${baseUrl}/pass-images/progress/stamps_${n}.png`;
}

function buildTextModules(stamps, vipExpiry) {
  return [
    { id: 'stamps',     header: 'Sellos',         body: `${stamps} / 10` },
    { id: 'vip_expiry', header: 'Validez Club',     body: vipExpiryDisplay(vipExpiry) },
    {
      id: 'how', header: 'Cómo conseguir sellos',
      body: 'Recibes 1 sello por cada servicio realizado en el salón. Los alisados además renuevan tu validez Club 6 meses.',
    },
    {
      id: 'hours', header: 'Horario',
      body: 'Lunes a Viernes: 11:00 – 19:00 · Sábados: 10:00 – 18:00',
    },
    {
      id: 'rules', header: 'Caducidad Club',
      body: 'La validez del Club se renueva con cada alisado. Caduca estrictamente en la fecha indicada.',
    },
  ];
}

function inviteUrlFor(enrollmentToken) {
  if (!enrollmentToken) return null;
  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  return `${baseUrl}/share/${enrollmentToken}`;
}

function buildLinksModule(inviteUrl) {
  const uris = [];
  if (inviteUrl)
    uris.push({ id: 'invite', uri: inviteUrl, description: '🎁 Invita y gana — comparte tu enlace' });
  if (process.env.BUSINESS_PHONE)
    uris.push({ id: 'phone',     uri: `tel:${process.env.BUSINESS_PHONE.replace(/\s/g, '')}`,     description: process.env.BUSINESS_PHONE });
  if (process.env.BUSINESS_EMAIL)
    uris.push({ id: 'email',     uri: `mailto:${process.env.BUSINESS_EMAIL}`,                       description: process.env.BUSINESS_EMAIL });
  if (process.env.BUSINESS_ADDRESS_URL)
    uris.push({ id: 'address',   uri: process.env.BUSINESS_ADDRESS_URL,                             description: process.env.BUSINESS_ADDRESS_LABEL || process.env.BUSINESS_ADDRESS_URL });
  if (process.env.BUSINESS_INSTAGRAM)
    uris.push({ id: 'instagram', uri: `https://www.instagram.com/${process.env.BUSINESS_INSTAGRAM.replace(/^@/, '')}/`, description: `@${process.env.BUSINESS_INSTAGRAM.replace(/^@/, '')}` });
  if (process.env.BUSINESS_WEBSITE)
    uris.push({ id: 'web',       uri: process.env.BUSINESS_WEBSITE,                                 description: process.env.BUSINESS_WEBSITE.replace(/^https?:\/\//, '') });
  return uris.length ? { uris } : undefined;
}

async function createGooglePass(cardId, clientName, stamps = 0, vipExpiry = null, enrollmentToken = null) {
  const objectId = `${issuerId()}.${uuidv4()}`;
  const auth   = getAuth();
  const client = await auth.getClient();

  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  const obj = {
    id:      objectId,
    classId: classId(),
    state:   'ACTIVE',
    cardTitle:  { defaultValue: { language: 'es', value: process.env.BUSINESS_NAME || 'Loyalty Card' } },
    header:     { defaultValue: { language: 'es', value: clientName } },
    subheader:  { defaultValue: { language: 'es', value: 'Tarjeta Club' } },
    logo: {
      sourceUri: { uri: `${baseUrl}/pass-images/icon@2x.png` },
      contentDescription: { defaultValue: { language: 'es', value: 'Logo' } },
    },
    heroImage: {
      sourceUri: { uri: progressImageUrl(stamps) },
      contentDescription: { defaultValue: { language: 'es', value: `Progreso de sellos: ${stamps} de 10` } },
    },
    barcode: {
      type:          'QR_CODE',
      value:         `card:${cardId}`,
      alternateText: `ID ${cardId}`,
    },
    textModulesData:  buildTextModules(stamps, vipExpiry),
    linksModuleData:  buildLinksModule(inviteUrlFor(enrollmentToken)),
    hexBackgroundColor: process.env.BRAND_COLOR || '#000000',
  };

  await client.request({ url: `${WALLET_API}/genericObject`, method: 'POST', data: obj });
  return objectId;
}

function getEnrollmentUrl(objectId) {
  const claims = {
    iss:     process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    aud:     'google',
    origins: [],
    typ:     'savetowallet',
    payload: { genericObjects: [{ id: objectId }] },
  };

  const token = jwt.sign(
    claims,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    { algorithm: 'RS256' }
  );

  return `https://pay.google.com/gp/v/save/${token}`;
}

async function expireGooglePass(objectId, clientName, stamps, vipExpiry) {
  const auth   = getAuth();
  const client = await auth.getClient();
  await client.request({
    url:    `${WALLET_API}/genericObject/${encodeURIComponent(objectId)}`,
    method: 'PATCH',
    data:   {
      state:              'ACTIVE',
      hexBackgroundColor: '#4a4a4a',
      header:             { defaultValue: { language: 'es', value: clientName } },
      subheader:          { defaultValue: { language: 'es', value: 'Tarjeta Club · Caducada' } },
      textModulesData: [
        { id: 'stamps',     header: 'Sellos conseguidos', body: `${stamps} / 10` },
        { id: 'expired',    header: 'Estado',             body: 'Esta tarjeta Club ha caducado.' },
        { id: 'vip_expiry', header: 'Venció el',          body: vipExpiryDisplay(vipExpiry) },
      ],
      heroImage: {
        sourceUri:          { uri: progressImageUrl(stamps) },
        contentDescription: { defaultValue: { language: 'es', value: 'Tarjeta caducada' } },
      },
    },
  });
}

async function reactivateGooglePass(objectId, clientName, stamps, vipExpiry, enrollmentToken = null) {
  const auth   = getAuth();
  const client = await auth.getClient();
  await client.request({
    url:    `${WALLET_API}/genericObject/${encodeURIComponent(objectId)}`,
    method: 'PATCH',
    data:   {
      state:              'ACTIVE',
      hexBackgroundColor: process.env.BRAND_COLOR || '#000000',
      header:             { defaultValue: { language: 'es', value: clientName } },
      subheader:          { defaultValue: { language: 'es', value: 'Tarjeta Club' } },
      textModulesData:    buildTextModules(stamps, vipExpiry),
      linksModuleData:    buildLinksModule(inviteUrlFor(enrollmentToken)),
      heroImage: {
        sourceUri:          { uri: progressImageUrl(stamps) },
        contentDescription: { defaultValue: { language: 'es', value: `Progreso de sellos: ${stamps} de 10` } },
      },
    },
  });
}

module.exports = { createGooglePass, getEnrollmentUrl, expireGooglePass, reactivateGooglePass };
