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

  // Se as credenciais Twilio nao estiverem configuradas,
  // retorna servidores STUN + open-relay como fallback
  if (!sid || !token) {
    res.status(200).json({ iceServers: fallbackServers() });
    return;
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Tokens.json`;
    const basic = Buffer.from(`${sid}:${token}`).toString('base64');
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${basic}` }
    });

    if (!response.ok) throw new Error(`Twilio ${response.status}`);

    const data = await response.json();
    // Twilio retorna ice_servers prontos para uso
    res.status(200).json({ iceServers: data.ice_servers });
  } catch (err) {
    console.error('Twilio TURN error:', err.message);
    // Fallback: retorna servidores abertos se Twilio falhar
    res.status(200).json({ iceServers: fallbackServers() });
  }
}

function fallbackServers() {
  return [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // open-relay.metered.ca — gratuito, global, confiavel
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
