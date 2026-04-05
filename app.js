'use strict';

const SUPABASE_URL = 'https://decuqgobcbuwgkaesbvo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlY3VxZ29iY2J1d2drYWVzYnZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzMTEzMTAsImV4cCI6MjA5MDg4NzMxMH0.DbMHj0K36zwOqdfo_y1q3R7HJKHkTzHn2j-BIJIkkiQ';

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// STUN + TURN (Open Relay — gratuito, cobre conexoes internacionais)
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
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
    urls:       'turn:openrelay.metered.ca:443?transport=tcp',
    username:   'openrelayproject',
    credential: 'openrelayproject'
  }
];

// ─────────────────────────────────────────────────────────────
// RING — Web Audio API (cliente)
// ─────────────────────────────────────────────────────────────
const Ring = (() => {
  let ctx = null;

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  }

  function tone(freq, startOffset, peakVol, duration) {
    if (!ctx || ctx.state !== 'running') return;
    const now  = ctx.currentTime;
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now + startOffset);
    gain.gain.linearRampToValueAtTime(peakVol, now + startOffset + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + startOffset + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + startOffset);
    osc.stop(now + startOffset + duration);
  }

  function start() {
    tone(1047, 0,    0.20, 0.55);
    tone(1319, 0.18, 0.15, 0.55);
  }

  function stop() {}

  return { init, start, stop };
})();

// ─────────────────────────────────────────────────────────────
// RING para a CRIADORA — via <audio> WAV gerado em JS
// ─────────────────────────────────────────────────────────────
const CriadoraRing = (() => {
  let el = null;

  function getEl() {
    if (el) return el;
    const sampleRate = 44100;
    const duration   = 0.8;
    const freq       = 880;
    const numSamples = Math.floor(sampleRate * duration);
    const buffer     = new ArrayBuffer(44 + numSamples * 2);
    const view       = new DataView(buffer);

    function writeStr(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }
    writeStr(0,  'RIFF');
    view.setUint32(4,  36 + numSamples * 2, true);
    writeStr(8,  'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples * 2, true);

    for (let i = 0; i < numSamples; i++) {
      const t        = i / sampleRate;
      const fadeIn   = Math.min(1, t / (duration * 0.10));
      const fadeOut  = Math.max(0, 1 - (t - duration * 0.7) / (duration * 0.3));
      const envelope = fadeIn * fadeOut;
      const sample   = Math.sin(2 * Math.PI * freq * t) * envelope * 0.25;
      view.setInt16(44 + i * 2, Math.max(-32767, Math.min(32767, sample * 32767)), true);
    }

    const blob = new Blob([buffer], { type: 'audio/wav' });
    el = new Audio(URL.createObjectURL(blob));
    el.loop   = true;
    el.volume = 0.35;
    return el;
  }

  function start() {
    try { getEl().play().catch(() => {}); } catch {}
  }

  function stop() {
    if (!el) return;
    el.pause();
    el.currentTime = 0;
  }

  return { start, stop };
})();

// ─────────────────────────────────────────────────────────────
// Captura de midia: Full HD 16:9
// ─────────────────────────────────────────────────────────────
async function getMedia() {
  return navigator.mediaDevices.getUserMedia({
    video: {
      width:       { ideal: 1920 },
      height:      { ideal: 1080 },
      aspectRatio: { ideal: 16 / 9 },
      frameRate:   { ideal: 30 },
      facingMode:  'user'
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Trickle ICE helpers
// ─────────────────────────────────────────────────────────────

// Buffer local para candidatos gerados antes do callId existir (lado cliente)
let pendingCandidates = [];

async function flushPendingCandidates(callId, role) {
  for (const c of pendingCandidates) {
    await sb.from('ice_candidates').insert({ call_id: callId, role, candidate: JSON.stringify(c) });
  }
  pendingCandidates = [];
}

async function sendIceCandidate(callId, role, candidate) {
  if (!candidate) return;
  await sb.from('ice_candidates').insert({
    call_id:   callId,
    role:      role,
    candidate: JSON.stringify(candidate)
  });
}

function listenIceCandidates(callId, peerRole, pc, channelRef) {
  const ch = sb.channel('ice-' + callId + '-' + peerRole)
    .on('postgres_changes', {
      event:  'INSERT',
      schema: 'public',
      table:  'ice_candidates',
      filter: `call_id=eq.${callId}`
    }, async payload => {
      const row = payload.new;
      if (row.role !== peerRole) return;
      try {
        const cand = JSON.parse(row.candidate);
        if (pc && pc.remoteDescription && cand && cand.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
        }
      } catch (e) { console.warn('addIceCandidate:', e); }
    })
    .subscribe();
  channelRef.push(ch);
}

// ══════════════════════════════════════════════════════════════
// HOME — pagina publica (cliente)
// ══════════════════════════════════════════════════════════════
if (document.body.classList.contains('page-home')) {

  const creatorPhoto  = document.getElementById('creatorPhoto');
  const creatorName   = document.getElementById('creatorName');
  const statusDot     = document.getElementById('statusDot');
  const statusLabel   = document.getElementById('statusLabel');
  const callBtn       = document.getElementById('callBtn');
  const callHint      = document.getElementById('callHint');
  const callScreen    = document.getElementById('callScreen');
  const localVideo    = document.getElementById('localVideo');
  const remoteVideo   = document.getElementById('remoteVideo');
  const endCallBtn    = document.getElementById('endCallBtn');
  const callStatusMsg = document.getElementById('callStatusMsg');

  let localStream = null;
  let pc          = null;
  let callId      = null;
  let channels    = [];

  async function loadPerfil() {
    const { data } = await sb.from('perfil').select('nome,foto_url,status').eq('id',1).single();
    if (!data) return;
    creatorName.textContent = data.nome || 'Criadora';
    if (data.foto_url) creatorPhoto.src = data.foto_url;
    applyStatus(data.status);
  }

  function applyStatus(s) {
    const on = s === 'online';
    statusDot.className     = 'status-dot '   + (on ? 'online'      : 'offline');
    statusLabel.className   = 'status-label ' + (on ? 'online-text' : 'offline-text');
    statusLabel.textContent = on ? 'Online agora' : 'Offline agora';
    callBtn.disabled        = !on;
    callHint.textContent    = on
      ? 'Clique para iniciar a videochamada.'
      : 'A criadora esta offline no momento.';
  }

  loadPerfil();

  sb.channel('perfil-public')
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'perfil', filter:'id=eq.1' },
      p => applyStatus(p.new.status))
    .subscribe();

  callBtn.addEventListener('click', async () => {
    callBtn.disabled = true;
    Ring.init();

    try {
      localStream = await getMedia();
    } catch {
      alert('Autorize o acesso a camera e ao microfone no seu navegador.');
      callBtn.disabled = false;
      return;
    }

    localVideo.srcObject = localStream;
    callScreen.classList.remove('hidden');
    callStatusMsg.textContent = 'Aguardando a criadora atender...';
    Ring.start();

    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.ontrack = e => {
      if (e.streams && e.streams[0]) {
        remoteVideo.srcObject = e.streams[0];
        callStatusMsg.textContent = 'Chamada em andamento';
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected')
        callStatusMsg.textContent = 'Chamada em andamento';
      if (pc.connectionState === 'failed') {
        callStatusMsg.textContent = 'Falha na conexao. Tente novamente.';
        setTimeout(endCall, 3000);
      }
    };

    // ✅ REGISTRAR onicecandidate ANTES de createOffer/setLocalDescription
    // Candidatos gerados antes do callId existir vao para o buffer
    pendingCandidates = [];
    pc.onicecandidate = e => {
      if (!e.candidate) return;
      if (callId) {
        sendIceCandidate(callId, 'client', e.candidate);
      } else {
        pendingCandidates.push(e.candidate);
      }
    };

    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);

    const { data: row, error } = await sb.from('sinalizacao')
      .insert({ role: 'client', status: 'calling', offer: pc.localDescription.sdp })
      .select('id').single();

    if (error || !row) {
      alert('Erro ao iniciar chamada. Tente novamente.');
      endCall();
      return;
    }
    callId = row.id;

    // Enviar candidatos que foram gerados antes do callId existir
    await flushPendingCandidates(callId, 'client');

    // Escutar candidatos ICE da criadora
    listenIceCandidates(callId, 'criadora', pc, channels);

    // Escutar answer e status
    const sigCh = sb.channel('client-sig-' + callId)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'sinalizacao', filter: `id=eq.${callId}`
      }, async p => {
        const r = p.new;
        if (r.status === 'active' && r.answer && pc.signalingState === 'have-local-offer') {
          try {
            await pc.setRemoteDescription({ type: 'answer', sdp: r.answer });
            callStatusMsg.textContent = 'Conectando video...';
          } catch (e) { console.error('setRemoteDescription (cliente):', e); }
        }
        if (r.status === 'rejected') {
          callStatusMsg.textContent = 'Chamada nao atendida.';
          setTimeout(endCall, 2000);
        }
        if (r.status === 'ended') endCall();
      })
      .subscribe();
    channels.push(sigCh);
  });

  endCallBtn.addEventListener('click', async () => {
    if (callId) await sb.from('sinalizacao').update({ status: 'ended' }).eq('id', callId);
    endCall();
  });

  function endCall() {
    channels.forEach(ch => sb.removeChannel(ch));
    channels = [];
    pendingCandidates = [];
    if (pc)          { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    localVideo.srcObject  = null;
    remoteVideo.srcObject = null;
    callScreen.classList.add('hidden');
    callStatusMsg.textContent = 'Aguardando a criadora atender...';
    callId = null;
    callBtn.disabled = false;
  }
}

// ══════════════════════════════════════════════════════════════
// PAINEL DA CRIADORA
// ══════════════════════════════════════════════════════════════
if (document.body.classList.contains('page-criadora')) {

  const loginScreen     = document.getElementById('loginScreen');
  const dashboardScreen = document.getElementById('dashboardScreen');
  const loginForm       = document.getElementById('loginForm');
  const loginError      = document.getElementById('loginError');
  const loginBtn        = document.getElementById('loginBtn');
  const logoutBtn       = document.getElementById('logoutBtn');
  const btnOnline       = document.getElementById('btnOnline');
  const btnOffline      = document.getElementById('btnOffline');
  const statusFeedback  = document.getElementById('statusFeedback');
  const photoInput      = document.getElementById('photoInput');
  const dashPhoto       = document.getElementById('dashPhoto');
  const nameInput       = document.getElementById('nameInput');
  const saveNameBtn     = document.getElementById('saveNameBtn');
  const nameFeedback    = document.getElementById('nameFeedback');
  const incomingSection = document.getElementById('incomingSection');
  const acceptCallBtn   = document.getElementById('acceptCallBtn');
  const rejectCallBtn   = document.getElementById('rejectCallBtn');
  const callScreen      = document.getElementById('callScreen');
  const localVideo      = document.getElementById('localVideo');
  const remoteVideo     = document.getElementById('remoteVideo');
  const endCallBtn      = document.getElementById('endCallBtn');
  const callStatusMsg   = document.getElementById('callStatusMsg');

  let localStream    = null;
  let pc             = null;
  let callId         = null;
  let incomingCallId = null;
  let listenCh       = null;
  let channels       = [];

  document.addEventListener('click', () => {
    const tmp = new Audio();
    tmp.play().catch(() => {});
  }, { once: true });

  async function init() {
    const { data: { session } } = await sb.auth.getSession();
    if (session) showDashboard();
  }
  init();

  sb.auth.onAuthStateChange((_e, session) => {
    if (session) showDashboard(); else showLogin();
  });

  loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    loginBtn.disabled    = true;
    loginBtn.textContent = 'Entrando...';
    loginError.classList.add('hidden');
    const email = document.getElementById('loginEmail').value.trim();
    const pass  = document.getElementById('loginPassword').value;
    const { error } = await sb.auth.signInWithPassword({ email, password: pass });
    if (error) {
      loginError.textContent = 'E-mail ou senha incorretos.';
      loginError.classList.remove('hidden');
      loginBtn.disabled    = false;
      loginBtn.textContent = 'Entrar';
    }
  });

  logoutBtn.addEventListener('click', async () => {
    await setStatus('offline');
    await sb.auth.signOut();
  });

  function showLogin() {
    dashboardScreen.classList.add('hidden');
    loginScreen.classList.remove('hidden');
    if (listenCh) { sb.removeChannel(listenCh); listenCh = null; }
  }

  async function showDashboard() {
    loginScreen.classList.add('hidden');
    dashboardScreen.classList.remove('hidden');
    await loadPerfil();
    startListening();
  }

  async function loadPerfil() {
    const { data } = await sb.from('perfil').select('nome,foto_url,status').eq('id',1).single();
    if (!data) return;
    nameInput.value = data.nome || '';
    if (data.foto_url) dashPhoto.src = data.foto_url;
    applyStatusUI(data.status || 'offline');
  }

  function applyStatusUI(s) {
    const on = s === 'online';
    btnOnline.classList.toggle('active',  on);
    btnOffline.classList.toggle('active', !on);
    statusFeedback.textContent = on
      ? 'Voce esta online. Pode receber chamadas.'
      : 'Voce esta offline. Clientes nao podem ligar.';
  }

  async function setStatus(s) {
    await sb.from('perfil').update({ status: s }).eq('id', 1);
    applyStatusUI(s);
  }

  btnOnline.addEventListener('click',  () => setStatus('online'));
  btnOffline.addEventListener('click', () => setStatus('offline'));

  photoInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const ext  = file.name.split('.').pop();
    const path = `criadora/foto.${ext}`;
    const { error: upErr } = await sb.storage.from('fotos').upload(path, file, { upsert: true });
    if (upErr) { alert('Erro ao enviar foto.'); return; }
    const { data: urlData } = sb.storage.from('fotos').getPublicUrl(path);
    const url = urlData.publicUrl;
    await sb.from('perfil').update({ foto_url: url }).eq('id', 1);
    dashPhoto.src = url + '?t=' + Date.now();
  });

  saveNameBtn.addEventListener('click', async () => {
    const nome = nameInput.value.trim();
    if (!nome) return;
    await sb.from('perfil').update({ nome }).eq('id', 1);
    nameFeedback.textContent = 'Nome salvo!';
    nameFeedback.classList.remove('hidden');
    setTimeout(() => nameFeedback.classList.add('hidden'), 2000);
  });

  function startListening() {
    if (listenCh) sb.removeChannel(listenCh);
    listenCh = sb.channel('criadora-incoming')
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'sinalizacao'
      }, payload => {
        const row = payload.new;
        if (row.status === 'calling' && row.offer) {
          incomingCallId = row.id;
          incomingSection.classList.remove('hidden');
          CriadoraRing.start();
        }
      })
      .subscribe();
  }

  acceptCallBtn.addEventListener('click', async () => {
    CriadoraRing.stop();
    incomingSection.classList.add('hidden');
    callId = incomingCallId;
    incomingCallId = null;

    try {
      localStream = await getMedia();
    } catch {
      alert('Autorize camera e microfone para atender.');
      await sb.from('sinalizacao').update({ status: 'rejected' }).eq('id', callId);
      callId = null;
      return;
    }

    localVideo.srcObject = localStream;
    callScreen.classList.remove('hidden');
    callStatusMsg.textContent = 'Conectando...';

    const { data: sigRow } = await sb.from('sinalizacao')
      .select('offer').eq('id', callId).single();

    if (!sigRow || !sigRow.offer) {
      alert('Erro: oferta do cliente nao encontrada.');
      await sb.from('sinalizacao').update({ status: 'rejected' }).eq('id', callId);
      endCall();
      return;
    }

    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.ontrack = e => {
      if (e.streams && e.streams[0]) {
        remoteVideo.srcObject = e.streams[0];
        callStatusMsg.textContent = 'Chamada em andamento';
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected')
        callStatusMsg.textContent = 'Chamada em andamento';
      if (pc.connectionState === 'failed') {
        callStatusMsg.textContent = 'Falha na conexao.';
        setTimeout(endCall, 3000);
      }
    };

    // ✅ REGISTRAR onicecandidate ANTES de setRemoteDescription/createAnswer
    pc.onicecandidate = e => {
      if (e.candidate) sendIceCandidate(callId, 'criadora', e.candidate);
    };

    // Escutar candidatos ICE do cliente (novos que chegarem)
    listenIceCandidates(callId, 'client', pc, channels);

    // Setar oferta do cliente
    await pc.setRemoteDescription({ type: 'offer', sdp: sigRow.offer });

    // Aplicar candidatos do cliente que ja chegaram antes de atender
    const { data: existing } = await sb.from('ice_candidates')
      .select('candidate').eq('call_id', callId).eq('role', 'client');
    if (existing) {
      for (const c of existing) {
        try {
          const cand = JSON.parse(c.candidate);
          if (cand && cand.candidate)
            await pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch {}
      }
    }

    // Criar e setar answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Gravar answer no banco
    await sb.from('sinalizacao').update({
      answer: pc.localDescription.sdp,
      status: 'active'
    }).eq('id', callId);

    callStatusMsg.textContent = 'Chamada em andamento';

    const sigCh = sb.channel('criadora-sig-' + callId)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'sinalizacao', filter: `id=eq.${callId}`
      }, p => {
        if (p.new.status === 'ended') endCall();
      })
      .subscribe();
    channels.push(sigCh);
  });

  rejectCallBtn.addEventListener('click', async () => {
    CriadoraRing.stop();
    incomingSection.classList.add('hidden');
    if (incomingCallId) {
      await sb.from('sinalizacao').update({ status: 'rejected' }).eq('id', incomingCallId);
      incomingCallId = null;
    }
  });

  endCallBtn.addEventListener('click', async () => {
    if (callId) await sb.from('sinalizacao').update({ status: 'ended' }).eq('id', callId);
    endCall();
  });

  function endCall() {
    CriadoraRing.stop();
    channels.forEach(ch => sb.removeChannel(ch));
    channels = [];
    if (pc)          { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    localVideo.srcObject  = null;
    remoteVideo.srcObject = null;
    callScreen.classList.add('hidden');
    callId = null;
  }
}
