/**
 * Ejecutar UNA VEZ para crear la Google Wallet GenericClass (plantilla de tarjeta).
 * Uso: node setup-google-class.js
 */
require('dotenv').config();
const { GoogleAuth } = require('google-auth-library');

const ISSUER_ID  = process.env.GOOGLE_ISSUER_ID;
const CLASS_ID   = `${ISSUER_ID}.${process.env.GOOGLE_CLASS_ID || 'tatiana_vip'}`;
const WALLET_API = 'https://walletobjects.googleapis.com/walletobjects/v1';

async function setup() {
  const auth = new GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key:  process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/wallet_object.issuer'],
  });

  const client = await auth.getClient();

  const genericClass = {
    id: CLASS_ID,
    classTemplateInfo: {
      cardTemplateOverride: {
        cardRowTemplateInfos: [
          {
            twoItems: {
              startItem: { firstValue: { fields: [{ fieldPath: 'object.textModulesData["stamps"]' }] } },
              endItem:   { firstValue: { fields: [{ fieldPath: 'object.textModulesData["vip_expiry"]' }] } },
            },
          },
        ],
      },
    },
  };

  try {
    const get = await client.request({ url: `${WALLET_API}/genericClass/${CLASS_ID}` });
    if (get.status === 200) {
      console.log('La clase ya existe. Actualizando…');
      await client.request({ url: `${WALLET_API}/genericClass/${CLASS_ID}`, method: 'PUT', data: genericClass });
      console.log('✓ Clase actualizada.');
      return;
    }
  } catch (_) { /* no existe, se crea */ }

  const res = await client.request({ url: `${WALLET_API}/genericClass`, method: 'POST', data: genericClass });
  console.log('✓ Clase creada:', res.data.id);
}

setup().catch(err => { console.error('Error:', err.message); process.exit(1); });
