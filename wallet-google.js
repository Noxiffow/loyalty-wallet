const { GoogleAuth } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const WALLET_API = 'https://walletobjects.googleapis.com/walletobjects/v1';

function issuerId() { return process.env.GOOGLE_ISSUER_ID; }
function classId()  { return `${issuerId()}.${process.env.GOOGLE_CLASS_ID || 'tatiana_vip'}`; }

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
    { id: 'vip_expiry', header: 'Validez VIP',     body: vipExpiryDisplay(vipExpiry) },
    {
      id: 'how', header: 'Cómo conseguir sellos',
      body: 'Recibes 1 sello por cada servicio realizado en el salón. Los alisados además renuevan tu validez VIP 6 meses.',
    },
    {
      id: 'hours', header: 'Horario',
      body: 'Lunes a Viernes: 11:00 – 19:00 · Sábados: 10:00 – 18:00',
    },
    {
      id: 'rules', header: 'Caducidad VIP',
      body: 'La validez VIP se renueva con cada alisado. Caduca estrictamente en la fecha indicada.',
    },
  ];
}

const LINKS_MODULE = {
  uris: [
    {
      id: 'phone',
      uri: 'tel:+34671033310',
      description: '+34 671 03 33 10',
    },
    {
      id: 'email',
      uri: 'mailto:hola@tatianasilva.es',
      description: 'hola@tatianasilva.es',
    },
    {
      id: 'address',
      uri: 'https://maps.google.com/?q=Calle+General+Pardiñas+36+Madrid',
      description: 'C/ General Pardiñas 36, local izq. · Madrid',
    },
    {
      id: 'instagram',
      uri: 'https://www.instagram.com/ts.peluqueria/',
      description: '@ts.peluqueria',
    },
    {
      id: 'web',
      uri: 'https://tatianasilva.es',
      description: 'tatianasilva.es',
    },
  ],
};

async function createGooglePass(cardId, clientName, stamps = 0, vipExpiry = null) {
  const objectId = `${issuerId()}.${uuidv4()}`;
  const auth   = getAuth();
  const client = await auth.getClient();

  const baseUrl = (process.env.BASE_URL || '').replace(/\/$/, '');
  const obj = {
    id:      objectId,
    classId: classId(),
    state:   'ACTIVE',
    cardTitle:  { defaultValue: { language: 'es', value: process.env.BUSINESS_NAME || 'Tatiana Silva Hair & Beauty' } },
    header:     { defaultValue: { language: 'es', value: clientName } },
    subheader:  { defaultValue: { language: 'es', value: 'Tarjeta VIP' } },
    logo: {
      sourceUri: { uri: `${baseUrl}/pass-images/icon@2x.png` },
      contentDescription: { defaultValue: { language: 'es', value: 'Logo TS' } },
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
    linksModuleData:  LINKS_MODULE,
    hexBackgroundColor: process.env.BRAND_COLOR || '#000000',
  };

  await client.request({ url: `${WALLET_API}/genericObject`, method: 'POST', data: obj });
  return objectId;
}

async function updateGooglePass(objectId, stamps, vipExpiry) {
  const auth   = getAuth();
  const client = await auth.getClient();

  await client.request({
    url:    `${WALLET_API}/genericObject/${encodeURIComponent(objectId)}`,
    method: 'PATCH',
    data:   {
      textModulesData: buildTextModules(stamps, vipExpiry),
      linksModuleData: LINKS_MODULE,
      heroImage: {
        sourceUri: { uri: progressImageUrl(stamps) },
        contentDescription: { defaultValue: { language: 'es', value: `Progreso de sellos: ${stamps} de 10` } },
      },
    },
  });
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
      subheader:          { defaultValue: { language: 'es', value: 'Tarjeta VIP · Caducada' } },
      textModulesData: [
        { id: 'stamps',     header: 'Sellos conseguidos', body: `${stamps} / 10` },
        { id: 'expired',    header: 'Estado',             body: 'Esta tarjeta VIP ha caducado.' },
        { id: 'vip_expiry', header: 'Venció el',          body: vipExpiryDisplay(vipExpiry) },
      ],
      heroImage: {
        sourceUri:          { uri: progressImageUrl(stamps) },
        contentDescription: { defaultValue: { language: 'es', value: 'Tarjeta caducada' } },
      },
    },
  });
}

async function reactivateGooglePass(objectId, clientName, stamps, vipExpiry) {
  const auth   = getAuth();
  const client = await auth.getClient();
  await client.request({
    url:    `${WALLET_API}/genericObject/${encodeURIComponent(objectId)}`,
    method: 'PATCH',
    data:   {
      state:              'ACTIVE',
      hexBackgroundColor: process.env.BRAND_COLOR || '#000000',
      header:             { defaultValue: { language: 'es', value: clientName } },
      subheader:          { defaultValue: { language: 'es', value: 'Tarjeta VIP' } },
      textModulesData:    buildTextModules(stamps, vipExpiry),
      linksModuleData:    LINKS_MODULE,
      heroImage: {
        sourceUri:          { uri: progressImageUrl(stamps) },
        contentDescription: { defaultValue: { language: 'es', value: `Progreso de sellos: ${stamps} de 10` } },
      },
    },
  });
}

module.exports = { createGooglePass, updateGooglePass, getEnrollmentUrl, expireGooglePass, reactivateGooglePass };
