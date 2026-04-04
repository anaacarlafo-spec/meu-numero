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

// ─────────────────────────────────────────────────────────────
// RING — Web Audio API
//
// REGRA DO BROWSER: AudioContext so pode tocar apos uma
// interacao do usuario (click/touch). Por isso:
//
// - Ring.init()  -> chame SINCRONAMENTE dentro do handler de click
//                  (cria e resume o AudioContext nesse momento)
// - Ring.start() -> chame depois (pode ser async, contexto ja esta ativo)
// - Ring.stop()  -> para o loop
// ─────────────────────────────────────────────────────────────
const Ring = (() => {
  let ctx       = null;
  let loopTimer = null;
  let active    = false;

  // Cria e desbloqueia o AudioContext SINCRONAMENTE no click
  function init() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    // resume() deve ser chamado dentro de um user-gesture handler
    if (ctx.state === 'suspended') ctx.resume();
  }

  // Dois tons de sino suaves com envelope
  function beep() {
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;

    function tone(freq, startOffset, peakVol, duration) {
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

    tone(1047, 0,    0.20, 0.55); // Do5
    tone(1319, 0.18, 0.15, 0.55); // Mi5
  }

  function start() {
    if (active) return;
    active = true;
    beep();
    loopTimer = setInterval(beep, 3200);
  }

  function stop() {
    active = false;
    clearInterval(loopTimer);
    loopTimer = null;
  }

  return { init, start, stop };
})();

// ─────────────────────────────────────────────────────────────
// RING para a CRIADORA — via <audio> tag com data URI
// O <audio> pode tocar via .play() desde que a pagina tenha
// tido qualquer interacao antes (ex: login, clique nos botoes).
// ─────────────────────────────────────────────────────────────
const CriadoraRing = (() => {
  let el = null;

  // Gera o audio element com um beep suave em base64 (WAV 1s, 440Hz)
  // para nao depender de arquivo externo
  function getEl() {
    if (el) return el;

    // WAV minimo de 440Hz gerado em JS puro
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
    view.setUint16(20, 1, true);            // PCM
    view.setUint16(22, 1, true);            // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples * 2, true);

    for (let i = 0; i < numSamples; i++) {
      // envelope: fade in 10%, sustain, fade out 30%
      const t         = i / sampleRate;
      const fadeIn    = Math.min(1, t / (duration * 0.10));
      const fadeOut   = Math.max(0, 1 - (t - duration * 0.7) / (duration * 0.3));
      const envelope  = fadeIn * fadeOut;
      const sample    = Math.sin(2 * Math.PI * freq * t) * envelope * 0.25;
      view.setInt16(44 + i * 2, Math.max(-32767, Math.min(32767, sample * 32767)), true);
    }

    const blob = new Blob([buffer], { type: 'audio/wav' });
    const url  = URL.createObjectURL(blob);
    el = new Audio(url);
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

// Helpers
async function getMedia() {
  const attempts = [
    { video: { width: 1280, height: 720, frameRate: 30, facingMode: 'user' }, audio: { echoCancellation: true, noiseSuppression: true } },
    { video: true, audio: true }
  ];
  for (const c of attempts) {
    try { return await navigator.mediaDevices.getUserMedia(c); } catch {}
  }
  throw new Error('Sem acesso a camera/microfone');
}

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

  // IMPORTANTE: callBtn.addEventListener deve ser SINCRONO no inicio
  // para que Ring.init() crie o AudioContext dentro do user-gesture
  callBtn.addEventListener('click', async () => {
    callBtn.disabled = true;

    // Cria AudioContext AGORA (ainda no user-gesture, antes de qualquer await)
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
        Ring.stop();
        remoteVideo.srcObject = e.streams[0];
        callStatusMsg.textContent = 'Chamada em andamento';
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        Ring.stop();
        callStatusMsg.textContent = 'Chamada em andamento';
      }
      if (pc.connectionState === 'failed') {
        Ring.stop();
        callStatusMsg.textContent = 'Falha na conexao. Tente novamente.';
        setTimeout(endCall, 3000);
      }
    };

    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    await waitForIce(pc);

    const { data: row, error } = await sb.from('sinalizacao')
      .insert({ role: 'client', status: 'calling', offer: pc.localDescription.sdp })
      .select('id').single();

    if (error || !row) {
      Ring.stop();
      alert('Erro ao iniciar chamada. Tente novamente.');
      endCall();
      return;
    }
    callId = row.id;

    realtimeCh = sb.channel('client-sig-' + callId)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'sinalizacao', filter: `id=eq.${callId}`
      }, async p => {
        const r = p.new;
        if (r.status === 'active' && r.answer && pc.signalingState === 'have-local-offer') {
          try {
            await pc.setRemoteDescription({ type: 'answer', sdp: r.answer });
            Ring.stop();
            callStatusMsg.textContent = 'Conectando video...';
          } catch (e) { console.error('setRemoteDescription:', e); }
        }
        if (r.status === 'rejected') {
          Ring.stop();
          callStatusMsg.textContent = 'Chamada nao atendida.';
          setTimeout(endCall, 2000);
        }
        if (r.status === 'ended') { Ring.stop(); endCall(); }
      })
      .subscribe();
  });

  endCallBtn.addEventListener('click', async () => {
    Ring.stop();
    if (callId) await sb.from('sinalizacao').update({ status: 'ended' }).eq('id', callId);
    endCall();
  });

  function endCall() {
    Ring.stop();
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

  // Pre-aquece o audio ao primeiro clique em qualquer botao da pagina
  // Isso garante que CriadoraRing.start() funcione mesmo vindo do Realtime
  let audioWarmedUp = false;
  document.addEventListener('click', () => {
    if (audioWarmedUp) return;
    audioWarmedUp = true;
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

    const { data: row } = await sb.from('sinalizacao')
      .select('offer').eq('id', callId).single();

    if (!row || !row.offer) {
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
      if (pc.connectionState === 'connected') callStatusMsg.textContent = 'Chamada em andamento';
      if (pc.connectionState === 'failed') {
        callStatusMsg.textContent = 'Falha na conexao.';
        setTimeout(endCall, 3000);
      }
    };

    await pc.setRemoteDescription({ type: 'offer', sdp: row.offer });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIce(pc);

    await sb.from('sinalizacao').update({
      answer: pc.localDescription.sdp,
      status: 'active'
    }).eq('id', callId);

    callStatusMsg.textContent = 'Chamada em andamento';

    realtimeCh = sb.channel('criadora-sig-' + callId)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'sinalizacao', filter: `id=eq.${callId}`
      }, p => {
        if (p.new.status === 'ended') endCall();
      })
      .subscribe();
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
    if (realtimeCh) { sb.removeChannel(realtimeCh); realtimeCh = null; }
    if (pc)          { pc.close(); pc = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    localVideo.srcObject  = null;
    remoteVideo.srcObject = null;
    callScreen.classList.add('hidden');
    callId = null;
  }
}
