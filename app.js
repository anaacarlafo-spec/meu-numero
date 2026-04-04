/**
 * app.js — Meu Número V1
 * Gerencia: status da criadora (via localStorage compartilhado simulado),
 * WebRTC signaling via BroadcastChannel (mesmo dispositivo / demo),
 * e controles da área da criadora.
 *
 * Nota: Para produção multidevice, substituir BroadcastChannel por
 * Supabase Realtime (websocket) como canal de sinalização WebRTC.
 */

'use strict';

// ── Credenciais demo da criadora (hardcoded para V1 sem backend) ──
const DEMO_EMAIL    = 'criadora@meunumero.com';
const DEMO_PASSWORD = 'meunumero2025';

// ── Chave de estado compartilhado (sessionStorage — demo no mesmo browser) ──
const KEY_STATUS = 'mn_status';   // 'online' | 'offline'
const KEY_NAME   = 'mn_name';
const KEY_PHOTO  = 'mn_photo';

function getState(key, def) {
  try { return sessionStorage.getItem(key) || def; } catch { return def; }
}
function setState(key, val) {
  try { sessionStorage.setItem(key, val); } catch {}
}

// ════════════════════════════════════════════
// HOME PAGE
// ════════════════════════════════════════════
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
  const callStatusMsg = document.getElementById('callStatus');

  let localStream = null;
  let pc = null;

  // Canal de sinalização (mesmo browser, demo)
  const channel = new BroadcastChannel('mn_signaling');

  function refreshHome() {
    const status = getState(KEY_STATUS, 'offline');
    const name   = getState(KEY_NAME,   'Ana Carla');
    const photo  = getState(KEY_PHOTO,  '');

    creatorName.textContent = name;
    if (photo) creatorPhoto.src = photo;

    const isOnline = status === 'online';
    statusDot.className   = 'status-dot ' + status;
    statusLabel.className = 'status-label ' + (isOnline ? 'online-text' : 'offline-text');
    statusLabel.textContent = isOnline ? 'Online agora' : 'Offline agora';
    callBtn.disabled = !isOnline;
    callHint.textContent = isOnline
      ? 'Clique para iniciar a videochamada.'
      : 'A criadora está offline no momento.';
  }

  refreshHome();

  // Atualiza quando criadora muda status (mesmo browser)
  window.addEventListener('storage', refreshHome);
  channel.addEventListener('message', (e) => {
    if (e.data.type === 'STATUS_CHANGED') refreshHome();
    if (e.data.type === 'CALL_ACCEPTED')  onCallAccepted(e.data.answer);
    if (e.data.type === 'CALL_ENDED')     endCall();
  });

  callBtn.addEventListener('click', async () => {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      openCallScreen('Aguardando a criadora atender...');
      await startPeerConnection(true);
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        alert('Para ligar, você precisa autorizar o acesso à câmera e ao microfone.');
      } else {
        alert('Não foi possível acessar câmera/microfone. Verifique seus dispositivos.');
      }
    }
  });

  endCallBtn.addEventListener('click', () => {
    channel.postMessage({ type: 'CALL_ENDED' });
    endCall();
  });

  async function startPeerConnection(isInitiator) {
    pc = createPC();
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      channel.postMessage({ type: 'CALL_REQUEST', offer });
    }
  }

  function onCallAccepted(answer) {
    if (!pc) return;
    pc.setRemoteDescription(new RTCSessionDescription(answer));
    callStatusMsg.textContent = 'Chamada em andamento';
  }

  function createPC() {
    const p = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    p.onicecandidate = (e) => {
      if (e.candidate) channel.postMessage({ type: 'ICE', candidate: e.candidate, from: 'client' });
    };
    p.ontrack = (e) => {
      remoteVideo.srcObject = e.streams[0];
    };
    return p;
  }

  function openCallScreen(msg) {
    callScreen.classList.remove('hidden');
    callStatusMsg.textContent = msg || 'Conectando...';
  }

  function endCall() {
    if (pc) { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    localVideo.srcObject  = null;
    remoteVideo.srcObject = null;
    callScreen.classList.add('hidden');
    callStatusMsg.textContent = 'Conectando...';
  }
}

// ════════════════════════════════════════════
// PAINEL DA CRIADORA
// ════════════════════════════════════════════
if (document.body.classList.contains('page-criadora')) {
  const loginScreen      = document.getElementById('loginScreen');
  const dashboardScreen  = document.getElementById('dashboardScreen');
  const loginForm        = document.getElementById('loginForm');
  const loginError       = document.getElementById('loginError');
  const logoutBtn        = document.getElementById('logoutBtn');
  const btnOnline        = document.getElementById('btnOnline');
  const btnOffline       = document.getElementById('btnOffline');
  const statusFeedback   = document.getElementById('statusFeedback');
  const photoInput       = document.getElementById('photoInput');
  const dashPhoto        = document.getElementById('dashPhoto');
  const nameInput        = document.getElementById('nameInput');
  const saveNameBtn      = document.getElementById('saveNameBtn');
  const nameFeedback     = document.getElementById('nameFeedback');
  const incomingSection  = document.getElementById('incomingSection');
  const acceptCallBtn    = document.getElementById('acceptCallBtn');
  const rejectCallBtn    = document.getElementById('rejectCallBtn');
  const callScreen       = document.getElementById('callScreen');
  const localVideo       = document.getElementById('localVideo');
  const remoteVideo      = document.getElementById('remoteVideo');
  const endCallBtn       = document.getElementById('endCallBtn');
  const callStatusMsg    = document.getElementById('callStatus');

  // Sessão simples em memória
  let loggedIn    = false;
  let localStream = null;
  let pc          = null;
  let pendingOffer = null;

  const channel = new BroadcastChannel('mn_signaling');

  // ── Autenticação demo ──
  function checkSession() {
    const session = getState('mn_session', '');
    if (session === 'active') showDashboard();
  }
  checkSession();

  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value.trim();
    const pass  = document.getElementById('loginPassword').value;

    if (email === DEMO_EMAIL && pass === DEMO_PASSWORD) {
      setState('mn_session', 'active');
      showDashboard();
    } else {
      loginError.textContent = 'E-mail ou senha incorretos.';
      loginError.classList.remove('hidden');
    }
  });

  logoutBtn.addEventListener('click', () => {
    setState('mn_session', '');
    setStatusValue('offline');
    location.reload();
  });

  function showDashboard() {
    loggedIn = true;
    loginScreen.classList.add('hidden');
    dashboardScreen.classList.remove('hidden');
    loadDashboardState();
  }

  function loadDashboardState() {
    const status = getState(KEY_STATUS, 'offline');
    const name   = getState(KEY_NAME, 'Ana Carla');
    const photo  = getState(KEY_PHOTO, '');

    nameInput.value = name;
    if (photo) dashPhoto.src = photo;
    applyStatus(status);
  }

  // ── Status ──
  function applyStatus(status) {
    const isOnline = status === 'online';
    btnOnline.classList.toggle('active',  isOnline);
    btnOffline.classList.toggle('active', !isOnline);
    btnOnline.setAttribute('aria-pressed',  String(isOnline));
    btnOffline.setAttribute('aria-pressed', String(!isOnline));
    statusFeedback.textContent = isOnline
      ? 'Você está online. Pode receber chamadas.'
      : 'Você está offline. Clientes não podem ligar.';
  }

  function setStatusValue(status) {
    setState(KEY_STATUS, status);
    applyStatus(status);
    channel.postMessage({ type: 'STATUS_CHANGED', status });
  }

  btnOnline.addEventListener('click',  () => setStatusValue('online'));
  btnOffline.addEventListener('click', () => setStatusValue('offline'));

  // ── Foto ──
  photoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      setState(KEY_PHOTO, dataUrl);
      dashPhoto.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });

  // ── Nome ──
  saveNameBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) return;
    setState(KEY_NAME, name);
    nameFeedback.textContent = 'Nome salvo!';
    nameFeedback.classList.remove('hidden');
    setTimeout(() => nameFeedback.classList.add('hidden'), 2000);
  });

  // ── Chamadas recebidas ──
  channel.addEventListener('message', async (e) => {
    if (e.data.type === 'CALL_REQUEST' && loggedIn) {
      pendingOffer = e.data.offer;
      incomingSection.classList.remove('hidden');
    }
    if (e.data.type === 'ICE' && e.data.from === 'client' && pc) {
      try { await pc.addIceCandidate(new RTCIceCandidate(e.data.candidate)); } catch {}
    }
    if (e.data.type === 'CALL_ENDED') endCall();
  });

  acceptCallBtn.addEventListener('click', async () => {
    incomingSection.classList.add('hidden');
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      callScreen.classList.remove('hidden');
      await answerCall();
    } catch {
      alert('Não foi possível acessar câmera/microfone.');
    }
  });

  rejectCallBtn.addEventListener('click', () => {
    incomingSection.classList.add('hidden');
    channel.postMessage({ type: 'CALL_REJECTED' });
    pendingOffer = null;
  });

  async function answerCall() {
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.onicecandidate = (e) => {
      if (e.candidate) channel.postMessage({ type: 'ICE', candidate: e.candidate, from: 'criadora' });
    };
    pc.ontrack = (e) => {
      remoteVideo.srcObject = e.streams[0];
    };
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    channel.postMessage({ type: 'CALL_ACCEPTED', answer });
    pendingOffer = null;
  }

  endCallBtn.addEventListener('click', () => {
    channel.postMessage({ type: 'CALL_ENDED' });
    endCall();
  });

  function endCall() {
    if (pc) { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    localVideo.srcObject  = null;
    remoteVideo.srcObject = null;
    callScreen.classList.add('hidden');
  }
}
