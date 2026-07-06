const crypto = require('crypto');

(async () => {
  const sessionId = crypto.randomUUID();
  const url = 'https://app.uz.gov.ua/api/v3/trips?station_from_id=2200200&station_to_id=2218300&with_transfers=0&date=2026-07-20';
  console.log('Using session id:', sessionId);
  const r = await fetch(url, {
    headers: {
      'x-user-agent': 'UZ/2 Web/1 User/guest',
      'x-session-id': sessionId
    }
  });
  console.log('Status:', r.status);
  console.log('Body:', await r.text());
})();
