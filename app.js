'use strict';

const SUPABASE_URL = 'https://decuqgobcbuwgkaesbvo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlY3VxZ29iY2J1d2drYWVzYnZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzMTEzMTAsImV4cCI6MjA5MDg4NzMxMH0.DbMHj0K36zwOqdfo_y1q3R7HJKHkTzHn2j-BIJIkkiQ';

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' }
];

// Constraints de video HD 720p
const VIDEO_CONSTRAINTS = {
  video: {
    width:     { ideal: 1280 },
    height:    { ideal: 720 },
    frameRate: { ideal: 30 },
    facingMode: 'user'
  },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    sampleRate: 48000
  }
};

// Aumenta bitrate do video apos conexao estabelecida
async function boostBitrate(pc) {
  try {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = 2_500_000; // 2.5 Mbps
    params.encodings[0].maxFramerate = 30;
    await sender.setParameters(params);
  } catch {}
}

async function applyIceCandidates(pc, candidatesJson) {
  if (!candidatesJson || !pc) return;
  try {
    const candidates = JSON.parse(candidatesJson);
    for (const c of candidates) {
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
      }
    }
  } catch {}
}

function waitForIce(p, ms = 3000) {
  return new Promise(resolve => {
    if (p.iceGatheringState === 'complete') { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    p.addEventListener('icegatheringstatechange', () => {
      if (p.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); }
    });
  });
}

// ══════════════════════════════════════════════════════════════
// HOME — página pública da criadora
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
  let pc = null;
  let callId = null;
  let sigChannel = null;
  let pendingCriadoraIce = null;

  async function loadPerfil() {
    const { data } = await sb.from('perfil').select('nome, foto_url, status').eq('id', 1).single();
    if (!data) return;
    creatorName.textContent = data.nome || 'Criadora';
    if (data.foto_url) creatorPhoto.src = data.foto_url;
    applyStatus(data.status);
  }

  function applyStatus(status) {
    const online = status === 'online';
    statusDot.className    = 'status-dot ' + (online ? 'online' : 'offline');
    statusLabel.className  = 'status-label ' + (online ? 'online-text' : 'offline-text');
    statusLabel.textContent = online ? 'Online agora' : 'Offline agora';
    callBtn.disabled = !online;
    callHint.textContent = online
      ? 'Clique para iniciar a videochamada.'
      : 'A criadora está offline no momento.';
  }

  loadPerfil();

  sb.channel('perfil-status')
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'perfil', filter: 'id=eq.1'
    }, (payload) => applyStatus(payload.new.status))
    .subscribe();

  callBtn.addEventListener('click', async () => {
    callBtn.disabled = true;
    try {
      localStream = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);
    } catch {
      // Fallback para qualquer camera disponivel
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch {
        alert('Para ligar, autorize o acesso à câmera e ao microfone no seu navegador.');
        callBtn.disabled = false;
        return;
      }
    }

    localVideo.srcObject = localStream;
    callScreen.classList.remove('hidden');
    callStatusMsg.textContent = 'Aguardando a criadora atender...';

    pc = buildPC();
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    const { data: row } = await sb.from('sinalizacao')
      .insert({ role: 'client', status: 'calling' })
      .select().single();
    callId = row.id;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIce(pc);

    await sb.from('sinalizacao').update({
      offer:      JSON.stringify(pc.localDescription),
      ice_client: JSON.stringify(pc.localDescription.sdp)
    }).eq('id', callId);

    sigChannel = sb.channel('sig-client-' + callId)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'sinalizacao', filter: `id=eq.${callId}`
      }, async (payload) => {
        const r = payload.new;

        if (r.answer && pc && pc.signalingState === 'have-local-offer') {
          try {
            await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(r.answer)));
            callStatusMsg.textContent = 'Chamada em andamento';
            if (pendingCriadoraIce) {
              await applyIceCandidates(pc, pendingCriadoraIce);
              pendingCriadoraIce = null;
            }
          } catch (e) { console.error('setRemoteDescription error', e); }
        }

        if (r.ice_criadora) {
          if (pc && pc.remoteDescription) {
            await applyIceCandidates(pc, r.ice_criadora);
          } else {
            pendingCriadoraIce = r.ice_criadora;
          }
        }

        if (r.status === 'rejected') {
          callStatusMsg.textContent = 'Chamada não atendida.';
          setTimeout(endCall, 2000);
        }
        if (r.status === 'ended') endCall();
      }).subscribe();
  });

  endCallBtn.addEventListener('click', async () => {
    if (callId) await sb.from('sinalizacao').update({ status: 'ended' }).eq('id', callId);
    endCall();
  });

  function buildPC() {
    const p = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    p.ontrack = (e) => {
      if (e.streams && e.streams[0]) remoteVideo.srcObject = e.streams[0];
    };
    p.onconnectionstatechange = () => {
      if (p.connectionState === 'connected') {
        callStatusMsg.textContent = 'Chamada em andamento';
        boostBitrate(p);
      }
      if (p.connectionState === 'failed') {
        callStatusMsg.textContent = 'Falha na conexão. Tente novamente.';
        setTimeout(endCall, 3000);
      }
    };
    return p;
  }

  function endCall() {
    if (sigChannel) { sb.removeChannel(sigChannel); sigChannel = null; }
    if (pc) { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    localVideo.srcObject  = null;
    remoteVideo.srcObject = null;
    callScreen.classList.add('hidden');
    callStatusMsg.textContent = 'Conectando...';
    callId = null;
    pendingCriadoraIce = null;
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

  let localStream = null;
  let pc = null;
  let callId = null;
  let sigChannel = null;
  let incomingCallId = null;

  async function init() {
    const { data: { session } } = await sb.auth.getSession();
    if (session) showDashboard();
  }
  init();

  sb.auth.onAuthStateChange((_e, session) => {
    if (session) showDashboard(); else showLogin();
  });

  loginForm.addEventListener('submit', async (e) => {
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
  }

  async function showDashboard() {
    loginScreen.classList.add('hidden');
    dashboardScreen.classList.remove('hidden');
    await loadPerfil();
    listenIncomingCalls();
  }

  async function loadPerfil() {
    const { data } = await sb.from('perfil').select('nome, foto_url, status').eq('id', 1).single();
    if (!data) return;
    nameInput.value = data.nome || '';
    if (data.foto_url) dashPhoto.src = data.foto_url;
    applyStatusUI(data.status || 'offline');
  }

  function applyStatusUI(status) {
    const online = status === 'online';
    btnOnline.classList.toggle('active',  online);
    btnOffline.classList.toggle('active', !online);
    btnOnline.setAttribute('aria-pressed',  String(online));
    btnOffline.setAttribute('aria-pressed', String(!online));
    statusFeedback.textContent = online
      ? 'Você está online. Pode receber chamadas.'
      : 'Você está offline. Clientes não podem ligar.';
  }

  async function setStatus(status) {
    await sb.from('perfil').update({ status }).eq('id', 1);
    applyStatusUI(status);
  }

  btnOnline.addEventListener('click',  () => setStatus('online'));
  btnOffline.addEventListener('click', () => setStatus('offline'));

  photoInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const ext  = file.name.split('.').pop();
    const path = `criadora/foto.${ext}`;
    const { error: upErr } = await sb.storage.from('fotos').upload(path, file, { upsert: true });
    if (upErr) { alert('Erro ao enviar foto. Tente novamente.'); return; }
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

  function listenIncomingCalls() {
    sb.channel('incoming-calls')
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'sinalizacao', filter: 'status=eq.calling'
      }, (payload) => {
        incomingCallId = payload.new.id;
        incomingSection.classList.remove('hidden');
      }).subscribe();
  }

  acceptCallBtn.addEventListener('click', async () => {
    incomingSection.classList.add('hidden');
    callId = incomingCallId;

    try {
      localStream = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);
    } catch {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch {
        alert('Autorize câmera e microfone para atender.');
        await sb.from('sinalizacao').update({ status: 'rejected' }).eq('id', callId);
        return;
      }
    }

    localVideo.srcObject = localStream;
    callScreen.classList.remove('hidden');
    callStatusMsg.textContent = 'Conectando...';

    let row = null;
    for (let i = 0; i < 10; i++) {
      const { data } = await sb.from('sinalizacao').select('offer, ice_client').eq('id', callId).single();
      if (data && data.offer) { row = data; break; }
      await new Promise(r => setTimeout(r, 500));
    }

    if (!row || !row.offer) {
      alert('Erro ao conectar. Tente novamente.');
      endCall();
      return;
    }

    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.ontrack = (e) => {
      if (e.streams && e.streams[0]) remoteVideo.srcObject = e.streams[0];
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        callStatusMsg.textContent = 'Chamada em andamento';
        boostBitrate(pc);
      }
      if (pc.connectionState === 'failed') {
        callStatusMsg.textContent = 'Falha na conexão.';
        setTimeout(endCall, 3000);
      }
    };

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(row.offer)));

    if (row.ice_client) {
      await applyIceCandidates(pc, JSON.stringify(JSON.parse(row.ice_client)));
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIce(pc);

    await sb.from('sinalizacao').update({
      answer:       JSON.stringify(pc.localDescription),
      ice_criadora: JSON.stringify(pc.localDescription.sdp),
      status:       'active'
    }).eq('id', callId);

    callStatusMsg.textContent = 'Chamada em andamento';

    sigChannel = sb.channel('sig-criadora-' + callId)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'sinalizacao', filter: `id=eq.${callId}`
      }, async (payload) => {
        const r = payload.new;
        if (r.ice_client && pc && pc.remoteDescription) {
          await applyIceCandidates(pc, r.ice_client);
        }
        if (r.status === 'ended') endCall();
      }).subscribe();
  });

  rejectCallBtn.addEventListener('click', async () => {
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
    if (sigChannel) { sb.removeChannel(sigChannel); sigChannel = null; }
    if (pc) { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    localVideo.srcObject  = null;
    remoteVideo.srcObject = null;
    callScreen.classList.add('hidden');
    callId = null;
  }
}
