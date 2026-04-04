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

// Aguarda ms milissegundos
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Pega midia do usuario com fallback progressivo
async function getMedia() {
  const attempts = [
    { video: { width: 1280, height: 720, frameRate: 30, facingMode: 'user' }, audio: { echoCancellation: true, noiseSuppression: true } },
    { video: true, audio: true }
  ];
  for (const c of attempts) {
    try { return await navigator.mediaDevices.getUserMedia(c); } catch {}
  }
  throw new Error('Nao foi possivel acessar camera/microfone');
}

// Aguarda ICE gathering terminar (max ms)
function waitForIce(pc, ms = 4000) {
  return new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const t = setTimeout(resolve, ms);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
    };
  });
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
  let realtimeCh  = null;

  // --- Carrega perfil da criadora ---
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

  // Escuta mudanca de status da criadora em tempo real
  sb.channel('perfil-public')
    .on('postgres_changes', { event:'UPDATE', schema:'public', table:'perfil', filter:'id=eq.1' },
      p => applyStatus(p.new.status))
    .subscribe();

  // --- Botao Ligar ---
  callBtn.addEventListener('click', async () => {
    callBtn.disabled = true;

    // 1. Pega midia local
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

    // 2. Cria PeerConnection
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.ontrack = e => {
      if (e.streams && e.streams[0]) {
        remoteVideo.srcObject = e.streams[0];
        callStatusMsg.textContent = 'Chamada em andamento';
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        callStatusMsg.textContent = 'Falha na conexao. Tente novamente.';
        setTimeout(endCall, 3000);
      }
    };

    // 3. Cria offer COMPLETA (aguarda ICE antes de salvar)
    const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
    await pc.setLocalDescription(offer);
    await waitForIce(pc); // espera todos ICE candidates serem coletados

    // 4. Insere na tabela com offer JA completa (SDP ja tem candidates embutidos)
    const { data: row, error } = await sb.from('sinalizacao')
      .insert({
        role:   'client',
        status: 'calling',
        offer:  pc.localDescription.sdp   // SDP completo com ICE candidates
      })
      .select('id').single();

    if (error || !row) {
      alert('Erro ao iniciar chamada. Tente novamente.');
      endCall();
      return;
    }
    callId = row.id;

    // 5. Escuta UPDATE nessa linha esperando a resposta da criadora
    realtimeCh = sb.channel('client-sig-' + callId)
      .on('postgres_changes', {
        event:'UPDATE', schema:'public', table:'sinalizacao', filter:`id=eq.${callId}`
      }, async p => {
        const r = p.new;

        if (r.status === 'active' && r.answer && pc.signalingState === 'have-local-offer') {
          // Criadora aceitou — aplica answer
          try {
            await pc.setRemoteDescription({ type:'answer', sdp: r.answer });
            callStatusMsg.textContent = 'Conectando video...';
          } catch(e) { console.error('setRemoteDescription:', e); }
        }

        if (r.status === 'rejected') {
          callStatusMsg.textContent = 'Chamada nao atendida.';
          setTimeout(endCall, 2000);
        }
        if (r.status === 'ended') endCall();
      })
      .subscribe();
  });

  endCallBtn.addEventListener('click', async () => {
    if (callId) await sb.from('sinalizacao').update({ status:'ended' }).eq('id', callId);
    endCall();
  });

  function endCall() {
    if (realtimeCh) { sb.removeChannel(realtimeCh); realtimeCh = null; }
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
  let realtimeCh     = null;
  let incomingCallId = null;
  let listenCh       = null;

  // --- Auth ---
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

  // Upload de foto
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

  // Salvar nome
  saveNameBtn.addEventListener('click', async () => {
    const nome = nameInput.value.trim();
    if (!nome) return;
    await sb.from('perfil').update({ nome }).eq('id', 1);
    nameFeedback.textContent = 'Nome salvo!';
    nameFeedback.classList.remove('hidden');
    setTimeout(() => nameFeedback.classList.add('hidden'), 2000);
  });

  // --- Escuta chamadas entrantes ---
  // O Supabase Realtime NAO suporta filtro em INSERT.
  // Solucao: escuta todos os INSERTs e filtra por status='calling' no JS.
  function startListening() {
    if (listenCh) { sb.removeChannel(listenCh); }

    listenCh = sb.channel('criadora-incoming')
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'sinalizacao'
      }, payload => {
        const row = payload.new;
        if (row.status === 'calling' && row.offer) {
          // Ja tem offer — pode exibir para a criadora atender
          incomingCallId = row.id;
          incomingSection.classList.remove('hidden');
        }
      })
      .subscribe();
  }

  // --- Aceitar chamada ---
  acceptCallBtn.addEventListener('click', async () => {
    incomingSection.classList.add('hidden');
    callId = incomingCallId;
    incomingCallId = null;

    // 1. Pega midia da criadora
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

    // 2. Busca a offer do cliente (ja deve estar salva no INSERT)
    const { data: row } = await sb.from('sinalizacao')
      .select('offer')
      .eq('id', callId)
      .single();

    if (!row || !row.offer) {
      alert('Erro: oferta do cliente nao encontrada.');
      await sb.from('sinalizacao').update({ status: 'rejected' }).eq('id', callId);
      endCall();
      return;
    }

    // 3. Cria PeerConnection da criadora
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.ontrack = e => {
      if (e.streams && e.streams[0]) {
        remoteVideo.srcObject = e.streams[0];
        callStatusMsg.textContent = 'Chamada em andamento';
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') callStatusMsg.textContent = 'Chamada em andamento';
      if (pc.connectionState === 'failed') {
        callStatusMsg.textContent = 'Falha na conexao.';
        setTimeout(endCall, 3000);
      }
    };

    // 4. Aplica offer do cliente (SDP completo com ICE embutidos)
    await pc.setRemoteDescription({ type: 'offer', sdp: row.offer });

    // 5. Cria answer COMPLETA (aguarda ICE)
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIce(pc); // espera todos ICE candidates serem coletados

    // 6. Salva answer no banco e marca como active
    await sb.from('sinalizacao').update({
      answer: pc.localDescription.sdp,  // SDP completo com ICE candidates da criadora
      status: 'active'
    }).eq('id', callId);

    callStatusMsg.textContent = 'Chamada em andamento';

    // 7. Escuta se o cliente encerrou
    realtimeCh = sb.channel('criadora-sig-' + callId)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'sinalizacao', filter: `id=eq.${callId}`
      }, p => {
        if (p.new.status === 'ended') endCall();
      })
      .subscribe();
  });

  // --- Rejeitar chamada ---
  rejectCallBtn.addEventListener('click', async () => {
    incomingSection.classList.add('hidden');
    if (incomingCallId) {
      await sb.from('sinalizacao').update({ status: 'rejected' }).eq('id', incomingCallId);
      incomingCallId = null;
    }
  });

  // --- Encerrar chamada ---
  endCallBtn.addEventListener('click', async () => {
    if (callId) await sb.from('sinalizacao').update({ status: 'ended' }).eq('id', callId);
    endCall();
  });

  function endCall() {
    if (realtimeCh) { sb.removeChannel(realtimeCh); realtimeCh = null; }
    if (pc)          { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    localVideo.srcObject  = null;
    remoteVideo.srcObject = null;
    callScreen.classList.add('hidden');
    callId = null;
  }
}
