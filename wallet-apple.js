const { PKPass } = require('passkit-generator');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs   = require('fs');

const PASS_TYPE_ID  = () => process.env.APPLE_PASS_TYPE_ID;
const TEAM_ID       = () => process.env.APPLE_TEAM_ID;
const WEB_SERVICE   = () => process.env.BASE_URL; // e.g. https://your-app.railway.app

function hexToRgb(hex) {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!r) return '26,26,46';
  return `${parseInt(r[1],16)},${parseInt(r[2],16)},${parseInt(r[3],16)}`;
}

function vipExpiryDisplay(dateStr) {
  if (!dateStr) return 'Sin activar';
  return new Date(dateStr).toLocaleDateString('es-ES', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
}

async function buildPass(cardId, serial, clientName, stamps, vipExpiry, expired = false) {
  const readCert = (envB64, filePath) => {
    if (process.env[envB64]) return Buffer.from(process.env[envB64], 'base64');
    return fs.readFileSync(path.resolve(filePath));
  };

  const passJson = {
    formatVersion:      1,
    passTypeIdentifier: PASS_TYPE_ID(),
    teamIdentifier:     TEAM_ID(),
    serialNumber:       serial,
    organizationName:   process.env.BUSINESS_NAME || 'Loyalty Card',
    description:        'Tarjeta VIP de fidelidad',
    backgroundColor:    `rgb(${hexToRgb(process.env.BRAND_COLOR || '#000000')})`,
    foregroundColor:    expired ? 'rgb(110,110,110)' : 'rgb(255,255,255)',
    labelColor:         expired ? 'rgb(80,80,80)' : 'rgb(180,180,200)',
    webServiceURL:      WEB_SERVICE(),
    authenticationToken: serial,
    barcodes: [{
      format:          'PKBarcodeFormatQR',
      message:         `card:${cardId}`,
      messageEncoding: 'iso-8859-1',
      altText:         `ID ${cardId}`,
    }],
    storeCard: {
      secondaryFields: [
        { key: 'name',   label: 'TITULAR',     value: clientName.toUpperCase() },
        { key: 'stamps', label: 'SELLOS',       value: expired ? '—' : `${stamps}/10` },
      ],
      auxiliaryFields: [
        { key: 'vip',    label: 'VALIDEZ VIP', value: expired ? 'CADUCADA' : vipExpiryDisplay(vipExpiry) },
      ],
      backFields: [
        { key: 'benefits',    label: 'Beneficios VIP',       value: 'Precio especial en alisados · Descuento en servicios (excluye productos y suplementos).' },
        { key: 'rules',       label: 'Caducidad',            value: 'La validez VIP se renueva solo con alisados. Caduca estrictamente en la fecha indicada.' },
        { key: 'stamps_info', label: 'Programa de sellos',   value: 'Por cada visita recibes 1 sello.' },
        { key: 'contact',     label: 'Contacto',             value: process.env.BUSINESS_PHONE || '' },
      ],
    },
  };

  const model = { 'pass.json': Buffer.from(JSON.stringify(passJson)) };

  // Add images
  const imagesDir = path.resolve('./public/pass-images');
  if (fs.existsSync(imagesDir)) {
    for (const file of ['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png']) {
      const fp = path.join(imagesDir, file);
      if (fs.existsSync(fp)) model[file] = fs.readFileSync(fp);
    }
    const n = Math.max(0, Math.min(10, stamps || 0));
    const progressPath = path.join(imagesDir, 'progress', `stamps_${n}.png`);
    if (fs.existsSync(progressPath)) {
      const buf = fs.readFileSync(progressPath);
      model['strip.png']    = buf;
      model['strip@2x.png'] = buf;
      model['strip@3x.png'] = buf;
    }
  }

  const pass = new PKPass(model, {
    wwdr:                readCert('APPLE_WWDR_B64', process.env.APPLE_WWDR_PATH || './certs/wwdr.pem'),
    signerCert:          readCert('APPLE_CERT_B64', process.env.APPLE_CERT_PATH || './certs/certificate.pem'),
    signerKey:           readCert('APPLE_KEY_B64',  process.env.APPLE_KEY_PATH  || './certs/key.pem'),
    signerKeyPassphrase: process.env.APPLE_KEY_PASSPHRASE || undefined,
  });

  return pass.getAsBuffer();
}

async function createApplePass(cardId, clientName, stamps = 0, vipExpiry = null, expired = false) {
  const serial = uuidv4();
  const buffer = await buildPass(cardId, serial, clientName, stamps, vipExpiry, expired);
  return { serial, buffer };
}

async function updateApplePass(cardId, serial, clientName, stamps, vipExpiry, expired = false) {
  return buildPass(cardId, serial, clientName, stamps, vipExpiry, expired);
}

module.exports = { createApplePass, updateApplePass };
