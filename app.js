'use strict';

const SUPABASE_URL = 'https://decuqgobcbuwgkaesbvo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRlY3VxZ29iY2J1d2drYWVzYnZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUzMTEzMTAsImV4cCI6MjA5MDg4NzMxMH0.DbMHj0K36zwOqdfo_y1q3R7HJKHkTzHn2j-BIJIkkiQ';

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

// ══════════════════════════════════════════
// HOME — página pública da criadora
// ══════════════════════════════════════════
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
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch {
      alert('Para ligar, autorize o acesso à câmera e ao microfone no seu navegador.');
      return;
    }
    localVideo.srcObject = localStream;
    callScreen.classList.remove('hidden');
    callStatusMsg.textContent = 'Aguardando a criadora atender...';

    const { data: row } = await sb.from('sinalizacao').insert({ role: 'client', status: 'calling' }).select().single();
    callId = row.id;

    pc = buildPC();
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sb.from('sinalizacao').update({ offer: JSON.stringify(offer) }).eq('id', callId);

    sigChannel = sb.channel('sig-client-' + callId)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'sinalizacao', filter: `id=eq.${callId}`
      }, async (payload) => {
        const r = payload.new;
        if (r.answer && pc.signalingState !== 'stable') {
          await pc.setRemoteDescription(JSON.parse(r.answer));
          callStatusMsg.textContent = 'Chamada em andamento';
        }
        if (r.ice_criadora) {
          for (const c of JSON.parse(r.ice_criadora)) {
            try { await pc.addIceCandidate(c); } catch {}
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
    const iceBuf = [];
    p.onicecandidate = (e) => {
      if (e.candidate) {
        iceBuf.push(e.candidate);
        sb.from('sinalizacao').update({ ice_client: JSON.stringify(iceBuf) }).eq('id', callId);
      }
    };
    p.ontrack = (e) => { remoteVideo.srcObject = e.streams[0]; };
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
  }
}

// ══════════════════════════════════════════
// PAINEL DA CRIADORA
// ══════════════════════════════════════════
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
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch {
      alert('Autorize câmera e microfone para atender.');
      await sb.from('sinalizacao').update({ status: 'rejected' }).eq('id', callId);
      return;
    }
    localVideo.srcObject = localStream;
    callScreen.classList.remove('hidden');
    callStatusMsg.textContent = 'Chamada em andamento';

    const { data: row } = await sb.from('sinalizacao').select('offer, ice_client').eq('id', callId).single();

    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const iceBuf = [];
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        iceBuf.push(e.candidate);
        sb.from('sinalizacao').update({ ice_criadora: JSON.stringify(iceBuf) }).eq('id', callId);
      }
    };
    pc.ontrack = (e) => { remoteVideo.srcObject = e.streams[0]; };

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    await pc.setRemoteDescription(JSON.parse(row.offer));

    if (row.ice_client) {
      for (const c of JSON.parse(row.ice_client)) {
        try { await pc.addIceCandidate(c); } catch {}
      }
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sb.from('sinalizacao').update({ answer: JSON.stringify(answer), status: 'active' }).eq('id', callId);

    sigChannel = sb.channel('sig-criadora-' + callId)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'sinalizacao', filter: `id=eq.${callId}`
      }, (payload) => {
        if (payload.new.status === 'ended') endCall();
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
