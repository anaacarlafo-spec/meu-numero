// Vercel Function — gera credenciais TURN temporarias do Twilio NTS
// Credenciais expiram em 1h, geradas por request (seguro)
// Variaveis de ambiente necessarias no Vercel:
//   TWILIO_ACCOUNT_SID  — ex: ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//   TWILIO_AUTH_TOKEN   — ex: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token) {
    res.status(200).json({ iceServers: fallbackServers() });
    return;
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Tokens.json`;
    const basic = Buffer.from(`${sid}:${token}`).toString('base64');

    // ttl=3600 (padrão); Twilio retorna servidores TURN globais
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'Ttl=3600'
    });

    if (!response.ok) throw new Error(`Twilio ${response.status}`);

    const data = await response.json();
    const twilioServers = data.ice_servers || [];

    // Adiciona STUN do Google e Cloudflare como reforço extra
    // (garante conectividade mesmo quando TURN falha em redes restritivas)
    const extraStun = [
      { urls: 'stun:stun.l.google.com:19302'  },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ];

    // Junta Twilio + STUN extra, sem duplicar
    const all = [...twilioServers, ...extraStun];

    res.status(200).json({ iceServers: all });
  } catch (err) {
    console.error('Twilio TURN error:', err.message);
    res.status(200).json({ iceServers: fallbackServers() });
  }
}

function fallbackServers() {
  return [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls:       'turn:openrelay.metered.ca:80',
      username:   'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls:       'turn:openrelay.metered.ca:443',
      username:   'openrelayproject',
      credential: 'openrelayproject'
    },
    {
      urls:       'turns:openrelay.metered.ca:443',
      username:   'openrelayproject',
      credential: 'openrelayproject'
    }
  ];
}
