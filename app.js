'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Supabase — anon key é pública por design (segurança via RLS no banco)
// ─────────────────────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://decuqgobcbuwgkaesbvo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlY3VxZ29iY2J1d2drYWVzYnZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzMTEzMTAsImV4cCI6MjA5MDg4NzMxMH0.DbMHj0K36zwOqdfo_y1q3R7HJKHkTzHn2j-BIJIkkiQ';

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { params: { eventsPerSecond: 40 } }
});

// ─────────────────────────────────────────────────────────────────────────────
// ICE Servers
// Estratégia em camadas:
//   1. STUN do Google/Cloudflare — funciona em ~85% das redes (rápido, sem custo)
//   2. TURN via UDP (fréeice.net) — cobre NAT simétrico e firewalls corporativos
//   3. TURN via TCP 443 (fréeice.net) — último recurso: atravessa até proxies HTTPS
//
// freeturn.net e numb.viagenie.ca foram descontinuados.
// freestun.net/freeice.net são ativos e gratuitos em 2025-2026.
// ─────────────────────────────────────────────────────────────────────────────
const ICE_SERVERS = [
  // — STUN (resolução de IP público, sem relay) —
  { urls: 'stun:stun.l.google.com:19302'  },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },

  // — TURN UDP — atravessa a maioria dos NATs fora do Brasil —
  {
    urls:       'turn:freestun.net:3478',
    username:   'free',
    credential: 'free'
  },
  // TURN UDP alternativo (porta diferente, maior chance de passar em firewalls)
  {
    urls:       'turn:freestun.net:5350',
    username:   'free',
    credential: 'free'
  },

  // — TURN TCP 443 — último recurso: atravessa proxies HTTPS e redes corporativas —
  {
    urls:       'turns:freestun.net:5349',
    username:   'free',
    credential: 'free'
  }
];

// Config WebRTC
const PC_CONFIG = {
  iceServers:         ICE_SERVERS,
  iceCandidatePoolSize: 4,
  bundlePolicy:       'max-bundle',
  rtcpMuxPolicy:      'require'
};

// ─────────────────────────────────────────────────────────────────────────────
// RING — Web Audio API (cliente)
// ─────────────────────────────────────────────────────────────────────────────
const Ring = (() => {
  let ctx = null;
  let intervalId = null;

  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  }

  function tone(freq, startOffset, peakVol, duration) {
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
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

  function playOnce() {
    tone(1047, 0,    0.20, 0.55);
    tone(1319, 0.18, 0.15, 0.55);
  }

  function start() {
    if (intervalId) return;
    playOnce();
    intervalId = setInterval(playOnce, 2000);
  }

  function stop() {
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
  }

  return { init, start, stop };
})();

// ─────────────────────────────────────────────────────────────────────────────
// RING para a CRIADORA
// ─────────────────────────────────────────────────────────────────────────────
const CriadoraRing = (() => {
  let audioEl = null;
  let blobUrl  = null;
  let unlocked = false;

  function buildBlobUrl() {
    if (blobUrl) return blobUrl;
    const sampleRate = 44100, duration = 0.8, freq = 880;
    const numSamples = Math.floor(sampleRate * duration);
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    function ws(offset, str) { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }
    ws(0,'RIFF'); view.setUint32(4, 36 + numSamples*2, true);
    ws(8,'WAVE'); ws(12,'fmt ');
    view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
    view.setUint32(24,sampleRate,true); view.setUint32(28,sampleRate*2,true);
    view.setUint16(32,2,true); view.setUint16(34,16,true);
    ws(36,'data'); view.setUint32(40,numSamples*2,true);
    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const env = Math.min(1, t/(duration*0.10)) * Math.max(0, 1-(t-duration*0.7)/(duration*0.3));
      const sample = Math.sin(2*Math.PI*freq*t) * env * 0.25;
      view.setInt16(44 + i*2, Math.max(-32767, Math.min(32767, sample*32767)), true);
    }
    const blob = new Blob([buffer], { type: 'audio/wav' });
    blobUrl = URL.createObjectURL(blob);
    return blobUrl;
  }

  function unlock() {
    if (unlocked) return;
    const url = buildBlobUrl();
    audioEl = new Audio(url);
    audioEl.loop   = true;
    audioEl.volume = 0;
    const p = audioEl.play();
    if (p && p.then) {
      p.then(() => { audioEl.pause(); audioEl.currentTime = 0; audioEl.volume = 0.5; unlocked = true; }).catch(() => {});
    } else {
      audioEl.pause(); audioEl.currentTime = 0; audioEl.volume = 0.5; unlocked = true;
    }
  }

  function start() {
    if (!audioEl) { audioEl = new Audio(buildBlobUrl()); audioEl.loop = true; audioEl.volume = 0.5; }
    audioEl.currentTime = 0;
    audioEl.volume = 0.5;
    audioEl.play().catch(() => {});
  }

  function stop() {
    if (!audioEl) return;
    audioEl.pause();
    audioEl.currentTime = 0;
  }

  return { unlock, start, stop };
})();

// ─────────────────────────────────────────────────────────────────────────────
// getUserMedia
// ─────────────────────────────────────────────────────────────────────────────
async function getMedia() {
  return navigator.mediaDevices.getUserMedia({
    video: { width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30}, facingMode:'user' },
    audio: { echoCancellation:true, noiseSuppression:true }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ICE helpers — batch insert para reduzir round-trips
// ─────────────────────────────────────────────────────────────────────────────
let pendingCandidates = [];
let flushScheduled    = false;
let currentCallId     = null;
let currentRole       = null;

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(async () => {
    flushScheduled = false;
    if (!pendingCandidates.length || !currentCallId) return;
    const batch = pendingCandidates.splice(0);
    const rows = batch.map(c => ({ call_id: currentCallId, role: currentRole, candidate: JSON.stringify(c) }));
    await sb.from('ice_candidates').insert(rows);
  }, 80);
}

function queueCandidate(candidate) {
  if (!candidate) return;
  pendingCandidates.push(candidate);
  if (currentCallId) scheduleFlush();
}

async function flushPending() {
  if (!pendingCandidates.length || !currentCallId) return;
  const batch = pendingCandidates.splice(0);
  const rows = batch.map(c => ({ call_id: currentCallId, role: currentRole, candidate: JSON.stringify(c) }));
  await sb.from('ice_candidates').insert(rows);
}

async function applyRemoteCandidates(pc, rows) {
  await Promise.all(
    (rows || []).map(async r => {
      try {
        const c = JSON.parse(r.candidate);
        if (c && c.candidate) await pc.addIceCandidate(new RTCIceCandidate(c));
      } catch (e) { console.warn('addIceCandidate:', e); }
    })
  );
}

function listenIceCandidates(callId, peerRole, pc, channels) {
  const ch = sb.channel('ice-' + callId + '-' + peerRole)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'ice_candidates',
      filter: `call_id=eq.${callId}`
    }, async payload => {
      const row = payload.new;
      if (row.role !== peerRole) return;
      try {
        const c = JSON.parse(row.candidate);
        if (pc && pc.remoteDescription && c && c.candidate)
          await pc.addIceCandidate(new RTCIceCandidate(c));
      } catch (e) { console.warn('addIceCandidate live:', e); }
    })
    .subscribe();
  channels.push(ch);
}

// ══════════════════════════════════════════════════════════════════════════════
// HOME — página pública (cliente)
// ══════════════════════════════════════════════════════════════════════════════
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

  let localStream = null, pc = null, callId = null, channels = [];

  async function loadPerfil() {
    const { data, error } = await sb.from('perfil').select('nome,foto_url,status').eq('id',1).single();
    if (error) { creatorName.textContent = 'Offline'; return; }
    if (!data) return;
    creatorName.textContent = data.nome || 'Criadora';
    if (data.foto_url) creatorPhoto.src = data.foto_url;
    applyStatus(data.status);
  }

  function applyStatus(s) {
    const on = s === 'online';
    statusDot.className   = 'status-dot '   + (on ? 'online' : 'offline');
    statusLabel.className = 'status-label ' + (on ? 'online-text' : 'offline-text');
    statusLabel.textContent = on ? 'Online agora' : 'Offline agora';
    callBtn.disabled = !on;
    callHint.textContent = on
      ? 'Clique para iniciar a videochamada.'
      : 'A criadora está offline no momento.';
  }

  loadPerfil();

  sb.channel('perfil-public')
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'perfil', filter:'id=eq.1' },
      p => applyStatus(p.new.status))
    .subscribe();

  callBtn.addEventListener('click', async () => {
    callBtn.disabled = true;
    Ring.init();

    let mediaPromise = getMedia();

    pc = new RTCPeerConnection(PC_CONFIG);
    currentRole = 'client';
    currentCallId = null;
    pendingCandidates = [];

    pc.onicecandidate = e => { if (e.candidate) queueCandidate(e.candidate); };

    pc.ontrack = e => {
      if (e.streams && e.streams[0]) {
        remoteVideo.srcObject = e.streams[0];
        callStatusMsg.textContent = 'Chamada em andamento';
        Ring.stop();
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') { callStatusMsg.textContent = 'Chamada em andamento'; Ring.stop(); }
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        callStatusMsg.textContent = 'Conexão perdida. Encerrando...';
        setTimeout(endCall, 2000);
      }
    };

    try { localStream = await mediaPromise; }
    catch {
      alert('Autorize o acesso à câmera e ao microfone no seu navegador.');
      pc.close(); pc = null;
      callBtn.disabled = false;
      return;
    }

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    localVideo.srcObject = localStream;
    callScreen.classList.remove('hidden');
    callStatusMsg.textContent = 'Aguardando a criadora atender...';
    Ring.start();

    const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
    await pc.setLocalDescription(offer);

    const { data: row, error } = await sb.from('sinalizacao')
      .insert({ role:'client', status:'calling', offer: pc.localDescription.sdp })
      .select('id').single();

    if (error || !row) {
      alert('Erro ao iniciar chamada. Tente novamente.');
      endCall(); return;
    }

    callId = row.id;
    currentCallId = callId;

    await flushPending();
    listenIceCandidates(callId, 'criadora', pc, channels);

    const sigCh = sb.channel('client-sig-' + callId)
      .on('postgres_changes', {
        event:'UPDATE', schema:'public', table:'sinalizacao', filter:`id=eq.${callId}`
      }, async p => {
        const r = p.new;
        if (r.status === 'active' && r.answer && pc.signalingState === 'have-local-offer') {
          try {
            await pc.setRemoteDescription({ type:'answer', sdp:r.answer });
            callStatusMsg.textContent = 'Conectando vídeo...';
          } catch (e) { console.error('setRemoteDescription (cliente):', e); }
        }
        if (r.status === 'rejected') { Ring.stop(); callStatusMsg.textContent = 'Chamada não atendida.'; setTimeout(endCall, 2000); }
        if (r.status === 'ended') endCall();
      })
      .subscribe();
    channels.push(sigCh);
  });

  endCallBtn.addEventListener('click', async () => {
    if (callId) await sb.from('sinalizacao').update({ status:'ended' }).eq('id', callId);
    endCall();
  });

  function endCall() {
    Ring.stop();
    channels.forEach(ch => sb.removeChannel(ch));
    channels = [];
    pendingCandidates = [];
    currentCallId = null;
    if (pc) { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    callScreen.classList.add('hidden');
    callStatusMsg.textContent = 'Aguardando a criadora atender...';
    callId = null;
    callBtn.disabled = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PAINEL DA CRIADORA
// ══════════════════════════════════════════════════════════════════════════════
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

  let localStream = null, pc = null, callId = null;
  let incomingCallId = null, incomingOffer = null;
  let listenCh = null, channels = [];

  async function init() {
    const { data: { session } } = await sb.auth.getSession();
    if (session) showDashboard();
  }
  init();

  sb.auth.onAuthStateChange((_e, session) => {
    if (session) showDashboard();
    else showLogin();
  });

  loginForm.addEventListener('submit', async e => {
    e.preventDefault();
    loginBtn.disabled = true;
    loginBtn.textContent = 'Entrando...';
    loginError.classList.add('hidden');
    const email = document.getElementById('loginEmail').value.trim();
    const pass  = document.getElementById('loginPassword').value;
    const { error } = await sb.auth.signInWithPassword({ email, password: pass });
    if (error) {
      loginError.textContent = 'E-mail ou senha incorretos.';
      loginError.classList.remove('hidden');
      loginBtn.disabled = false;
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
    btnOnline.classList.toggle('active', on);
    btnOffline.classList.toggle('active', !on);
    statusFeedback.textContent = on
      ? 'Você está online. Pode receber chamadas.'
      : 'Você está offline. Clientes não podem ligar.';
  }

  async function setStatus(s) {
    if (s === 'online') CriadoraRing.unlock();
    await sb.from('perfil').update({ status: s }).eq('id', 1);
    applyStatusUI(s);
  }

  btnOnline.addEventListener('click',  () => setStatus('online'));
  btnOffline.addEventListener('click', () => setStatus('offline'));

  photoInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop();
    const path = `criadora/foto.${ext}`;
    const { error: upErr } = await sb.storage.from('fotos').upload(path, file, { upsert:true });
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

  function cancelIncoming() {
    CriadoraRing.stop();
    incomingSection.classList.add('hidden');
    incomingCallId = null;
    incomingOffer  = null;
  }

  function startListening() {
    if (listenCh) sb.removeChannel(listenCh);
    listenCh = sb.channel('criadora-incoming')
      .on('postgres_changes', { event:'INSERT', schema:'public', table:'sinalizacao' }, payload => {
        const row = payload.new;
        if (row.status === 'calling' && row.offer) {
          incomingCallId = row.id;
          incomingOffer  = row.offer;
          incomingSection.classList.remove('hidden');
          CriadoraRing.start();
        }
      })
      .on('postgres_changes', { event:'UPDATE', schema:'public', table:'sinalizacao' }, payload => {
        const row = payload.new;
        if (row.id === incomingCallId && (row.status === 'ended' || row.status === 'rejected'))
          cancelIncoming();
      })
      .subscribe();
  }

  acceptCallBtn.addEventListener('click', async () => {
    CriadoraRing.stop();
    incomingSection.classList.add('hidden');
    callId = incomingCallId;
    const offerSdp = incomingOffer;
    incomingCallId = null;
    incomingOffer  = null;

    currentRole = 'criadora';
    currentCallId = callId;
    pendingCandidates = [];

    let mediaPromise = getMedia();

    pc = new RTCPeerConnection(PC_CONFIG);

    pc.onicecandidate = e => { if (e.candidate) queueCandidate(e.candidate); };

    pc.ontrack = e => {
      if (e.streams && e.streams[0]) {
        remoteVideo.srcObject = e.streams[0];
        callStatusMsg.textContent = 'Chamada em andamento';
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') callStatusMsg.textContent = 'Chamada em andamento';
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        callStatusMsg.textContent = 'Conexão perdida.';
        setTimeout(endCall, 2000);
      }
    };

    await pc.setRemoteDescription({ type:'offer', sdp: offerSdp });

    const [_, existingIce, localStream_] = await Promise.all([
      Promise.resolve(),
      sb.from('ice_candidates').select('candidate').eq('call_id', callId).eq('role', 'client'),
      mediaPromise
    ]);

    if (!localStream_) {
      alert('Autorize câmera e microfone para atender.');
      await sb.from('sinalizacao').update({ status:'rejected' }).eq('id', callId);
      pc.close(); pc = null; callId = null; return;
    }

    localStream = localStream_;
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    localVideo.srcObject = localStream;
    callScreen.classList.remove('hidden');
    callStatusMsg.textContent = 'Conectando...';

    if (existingIce.data) await applyRemoteCandidates(pc, existingIce.data);

    listenIceCandidates(callId, 'client', pc, channels);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    await Promise.all([
      sb.from('sinalizacao').update({ answer: pc.localDescription.sdp, status:'active' }).eq('id', callId),
      flushPending()
    ]);

    const sigCh = sb.channel('criadora-sig-' + callId)
      .on('postgres_changes', {
        event:'UPDATE', schema:'public', table:'sinalizacao', filter:`id=eq.${callId}`
      }, p => { if (p.new.status === 'ended') endCall(); })
      .subscribe();
    channels.push(sigCh);
  });

  rejectCallBtn.addEventListener('click', async () => {
    CriadoraRing.stop();
    incomingSection.classList.add('hidden');
    if (incomingCallId) {
      await sb.from('sinalizacao').update({ status:'rejected' }).eq('id', incomingCallId);
      incomingCallId = null;
      incomingOffer  = null;
    }
  });

  endCallBtn.addEventListener('click', async () => {
    if (callId) await sb.from('sinalizacao').update({ status:'ended' }).eq('id', callId);
    endCall();
  });

  function endCall() {
    CriadoraRing.stop();
    channels.forEach(ch => sb.removeChannel(ch));
    channels = [];
    pendingCandidates = [];
    currentCallId = null;
    if (pc) { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    localVideo.srcObject = null;
    remoteVideo.srcObject = null;
    callScreen.classList.add('hidden');
    callId = null;
  }
}
