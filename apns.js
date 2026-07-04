const http2 = require('http2');
const fs    = require('fs');
const path  = require('path');
const { q } = require('./db');

const APNS_HOST = 'api.push.apple.com';

function readCert(envB64, filePath) {
  if (process.env[envB64]) return Buffer.from(process.env[envB64], 'base64');
  const p = path.resolve(filePath);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

function sendPush(pushToken, passTypeId, tlsOpts) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${APNS_HOST}`, tlsOpts);
    client.on('error', (err) => { client.close(); reject(err); });

    const req = client.request({
      ':method':        'POST',
      ':path':          `/3/device/${pushToken}`,
      'apns-topic':     passTypeId,
      'apns-push-type': 'background',
      'content-type':   'application/json',
      'content-length': '2',
    });

    req.write('{}');
    req.end();

    let status;
    req.on('response', (h) => { status = h[':status']; });

    let body = '';
    req.on('data',  (c) => { body += c; });
    req.on('end',   ()  => {
      client.close();
      status === 200 ? resolve() : reject(new Error(`APNs ${status}: ${body}`));
    });
    req.on('error', (err) => { client.close(); reject(err); });
  });
}

async function pushPassUpdate(cardId) {
  const regs = q.getAppleRegs.all(cardId);
  if (!regs.length) return 0;

  const passTypeId = process.env.APPLE_PASS_TYPE_ID;
  if (!passTypeId) { console.error('[APNs] Falta APPLE_PASS_TYPE_ID'); return 0; }

  const cert = readCert('APPLE_CERT_B64', process.env.APPLE_CERT_PATH || './certs/certificate.pem');
  const key  = readCert('APPLE_KEY_B64',  process.env.APPLE_KEY_PATH  || './certs/key.pem');
  if (!cert || !key) { console.error('[APNs] Falta cert o key'); return 0; }

  const tlsOpts = { cert, key, passphrase: process.env.APPLE_KEY_PASSPHRASE || undefined };

  let sent = 0;
  for (const reg of regs) {
    try {
      await sendPush(reg.push_token, passTypeId, tlsOpts);
      sent++;
      console.log(`[APNs] ✓ Pushed card ${cardId} → device ${reg.device_id.slice(0, 8)}…`);
    } catch (e) {
      console.error(`[APNs] ✗ Card ${cardId}, device ${reg.device_id.slice(0, 8)}…: ${e.message}`);
    }
  }
  return sent;
}

module.exports = { pushPassUpdate };
