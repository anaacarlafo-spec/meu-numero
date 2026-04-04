/**
 * app.js — Meu Número V1
 *
 * Supabase é usado para:
 *   1. Autenticação real da criadora (Supabase Auth)
 *   2. Perfil da criadora: nome, foto, status (tabela `perfil`)
 *   3. Sinalização WebRTC multidevice (tabela `sinalizacao` + Realtime)
 *
 * WebRTC faz a chamada de vídeo peer-to-peer diretamente entre os navegadores.
 */

'use strict';

// ── Lê config do Supabase injetada no HTML via meta tags (valores substituídos pelo Vercel) ──
function getMeta(name) {
  const el = document.querySelector(`meta[name="${name}"]`);
  return el ? el.getAttribute('content') : '';
}

const SUPABASE_URL  = getMeta('supabase-url');
const SUPABASE_KEY  = getMeta('supabase-key');

if (!SUPABASE_URL || SUPABASE_URL === '__SUPABASE_URL__') {
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100dvh;background:#0a0a0a;">
      <div style="text-align:center;color:#C9A84C;font-family:Inter,sans-serif;padding:2rem;">
        <h2 style="font-family:'Cormorant Garamond',serif;font-size:1.8rem;margin-bottom:1rem;">Configuração pendente</h2>
        <p style="color:rgba(201,168,76,0.65);max-width:40ch;margin:0 auto;">
          As variáveis de ambiente do Supabase ainda não foram preenchidas no Vercel.<br><br>
          Acesse <strong>Vercel → meu-numero → Settings → Environment Variables</strong> e adicione <code>SUPABASE_URL</code> e <code>SUPABASE_ANON_KEY</code>.
        </p>
      </div>
    </div>`;
  throw new Error('Supabase não configurado.');
}

const { createClient } = supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

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

  // Carrega perfil da criadora
  async function loadPerfil() {
    const { data } = await sb.from('perfil').select('nome, foto_url, status').eq('id', 1).single();
    if (!data) return;
    creatorName.textContent = data.nome || 'Criadora';
    if (data.foto_url) creatorPhoto.src = data.foto_url;
    applyStatus(data.status);
  }

  function applyStatus(status) {
    const online = status === 'online';
    statusDot.className   = 'status-dot ' + (online ? 'online' : 'offline');
    statusLabel.className = 'status-label ' + (online ? 'online-text' : 'offline-text');
    statusLabel.textContent = online ? 'Online agora' : 'Offline agora';
    callBtn.disabled = !online;
    callHint.textContent = online ? 'Clique para iniciar a videochamada.' : 'A criadora está offline no momento.';
  }

  loadPerfil();

  // Escuta mudanças de status em tempo real
  sb.channel('perfil-status')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'perfil', filter: 'id=eq.1' },
      (payload) => applyStatus(payload.new.status)
    ).subscribe();

  // ── Iniciar chamada ──
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

    // Cria registro de sinalização no Supabase
    const { data: row } = await sb.from('sinalizacao').insert({ role: 'client', status: 'calling' }).select().single();
    callId = row.id;

    pc = buildPC();
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sb.from('sinalizacao').update({ offer: JSON.stringify(offer) }).eq('id', callId);

    // Escuta resposta da criadora
    sigChannel = sb.channel('sig-client-' + callId)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sinalizacao', filter: `id=eq.${callId}` },
        async (payload) => {
          const row = payload.new;
          if (row.answer && pc.signalingState !== 'stable') {
            await pc.setRemoteDescription(JSON.parse(row.answer));
            callStatusMsg.textContent = 'Chamada em andamento';
          }
          if (row.ice_criadora) {
            const candidates = JSON.parse(row.ice_criadora);
            for (const c of candidates) { try { await pc.addIceCandidate(c); } catch {} }
          }
          if (row.status === 'rejected') {
            callStatusMsg.textContent = 'Chamada não atendida.';
            setTimeout(endCall, 2000);
          }
          if (row.status === 'ended') endCall();
        }
      ).subscribe();
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

  // ── Verifica sessão ──
  async function init() {
    const { data: { session } } = await sb.auth.getSession();
    if (session) showDashboard();
  }
  init();

  sb.auth.onAuthStateChange((_e, session) => {
    if (session) showDashboard(); else showLogin();
  });

  // ── Login ──
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

  // ── Logout ──
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

  // ── Perfil ──
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

  // ── Foto ──
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

  // ── Nome ──
  saveNameBtn.addEventListener('click', async () => {
    const nome = nameInput.value.trim();
    if (!nome) return;
    await sb.from('perfil').update({ nome }).eq('id', 1);
    nameFeedback.textContent = 'Nome salvo!';
    nameFeedback.classList.remove('hidden');
    setTimeout(() => nameFeedback.classList.add('hidden'), 2000);
  });

  // ── Escuta chamadas entrantes ──
  function listenIncomingCalls() {
    sb.channel('incoming-calls')
      .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'sinalizacao',
          filter: 'status=eq.calling'
        },
        (payload) => {
          incomingCallId = payload.new.id;
          incomingSection.classList.remove('hidden');
        }
      ).subscribe();
  }

  // ── Atender chamada ──
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

    // Busca offer do cliente
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
      for (const c of JSON.parse(row.ice_client)) { try { await pc.addIceCandidate(c); } catch {} }
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sb.from('sinalizacao').update({ answer: JSON.stringify(answer), status: 'active' }).eq('id', callId);

    // Escuta encerramento pelo cliente
    sigChannel = sb.channel('sig-criadora-' + callId)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'sinalizacao', filter: `id=eq.${callId}` },
        (payload) => { if (payload.new.status === 'ended') endCall(); }
      ).subscribe();
  });

  // ── Recusar chamada ──
  rejectCallBtn.addEventListener('click', async () => {
    incomingSection.classList.add('hidden');
    if (incomingCallId) {
      await sb.from('sinalizacao').update({ status: 'rejected' }).eq('id', incomingCallId);
      incomingCallId = null;
    }
  });

  // ── Encerrar chamada ──
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
