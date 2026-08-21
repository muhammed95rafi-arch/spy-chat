const entryScreen = document.getElementById('entry-screen');
const chatScreen = document.getElementById('chat-screen');
const codenameInput = document.getElementById('codename');
const roomcodeInput = document.getElementById('roomcode');
const enterBtn = document.getElementById('enter-btn');

const roomLabel = document.getElementById('room-label');
const agentLabel = document.getElementById('agent-label');
const rosterList = document.getElementById('roster-list');
const messagesEl = document.getElementById('messages');
const msgInput = document.getElementById('msg-input');
const sendBtn = document.getElementById('send-btn');
const voiceToggle = document.getElementById('voice-toggle');
const voiceStatus = document.getElementById('voice-status');
const remoteAudiosEl = document.getElementById('remote-audios');

let socket = null;
let myName = '';
let myRoom = '';

// ---- Typing sound (generated in-browser, no audio file needed) ----
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function playTypeSound() {
  try {
    const ctx = getAudioCtx();
    const now = ctx.currentTime;

    // --- Layer 1: short filtered noise burst (mechanical "clack" texture) ---
    const bufferSize = Math.floor(ctx.sampleRate * 0.03);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize); // decaying noise
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 2200 + Math.random() * 900;
    noiseFilter.Q.value = 1.4;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.22, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);

    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noise.start(now);

    // --- Layer 2: low click transient (gives it weight, like a real key strike) ---
    const click = ctx.createOscillator();
    click.type = 'square';
    click.frequency.setValueAtTime(140 + Math.random() * 40, now);
    const clickGain = ctx.createGain();
    clickGain.gain.setValueAtTime(0.12, now);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.02);
    click.connect(clickGain);
    clickGain.connect(ctx.destination);
    click.start(now);
    click.stop(now + 0.02);
  } catch (e) { /* audio not available, ignore silently */ }
}
function playSendSound() {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  } catch (e) {}
}

// ---- WebRTC state ----
let localStream = null;
let inVoice = false;
const peerConnections = {}; // id -> RTCPeerConnection
const ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

enterBtn.addEventListener('click', enter);
[codenameInput, roomcodeInput].forEach(el => {
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter(); });
});

function enter() {
  const name = codenameInput.value.trim();
  const room = roomcodeInput.value.trim();
  if (!name || !room) {
    alert('Codename and Safehouse ID are both required, Agent.');
    return;
  }
  myName = name;
  myRoom = room;

  socket = io();

  socket.on('connect', () => {
    socket.emit('join', { room: myRoom, name: myName });
  });

  socket.on('system', (text) => addSystemMessage(text));

  socket.on('members', (members) => {
    rosterList.innerHTML = '';
    members.forEach(m => {
      const li = document.createElement('li');
      li.textContent = m;
      rosterList.appendChild(li);
    });
  });

  socket.on('chat-message', ({ name, text, time }) => {
    addChatMessage(name, text, time);
  });

  socket.on('peer-left', ({ id }) => {
    closePeer(id);
  });

  socket.on('signal', async ({ from, data }) => {
    await handleSignal(from, data);
  });

  // Someone else just went live on voice. If we are also live, call them.
  socket.on('voice-ready', ({ id }) => {
    if (inVoice) callPeer(id);
  });

  entryScreen.classList.add('hidden');
  chatScreen.classList.remove('hidden');
  roomLabel.textContent = `// SAFEHOUSE: ${myRoom.toUpperCase()}`;
  agentLabel.textContent = `AGENT: ${myName.toUpperCase()}`;
  msgInput.focus();
  getAudioCtx(); // unlock audio on this user gesture (needed for typing sounds on mobile)
}

sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { sendMessage(); return; }
  // Skip sound for modifier/navigation keys so it only fires on real typing
  if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Space') {
    playTypeSound();
  }
});

function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !socket) return;
  socket.emit('chat-message', text);
  msgInput.value = '';
  playSendSound();
}

function addChatMessage(name, text, time) {
  const div = document.createElement('div');
  const mine = name === myName;
  div.className = 'msg' + (mine ? ' me' : '');
  div.innerHTML = `<span class="who">${escapeHtml(name)}:</span>${escapeHtml(text)}<span class="time">${time}</span>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ================= VOICE CHAT (WebRTC mesh) =================

voiceToggle.addEventListener('click', async () => {
  if (!inVoice) {
    await startVoice();
  } else {
    stopVoice();
  }
});

async function startVoice() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert('Microphone access denied or unavailable.');
    return;
  }
  inVoice = true;
  voiceToggle.textContent = '🔴 END TRANSMISSION';
  voiceToggle.classList.add('live');
  voiceStatus.textContent = 'LIVE';
  voiceStatus.classList.add('live');

  socket.emit('chat-message', `🎙 ${myName} went live on voice.`);
  // Tell the room we're live; anyone else currently live will call us,
  // and future joiners who go live will trigger this same handshake.
  socket.emit('voice-ready');
}

function stopVoice() {
  inVoice = false;
  voiceToggle.textContent = '🎙 GO LIVE (AUDIO)';
  voiceToggle.classList.remove('live');
  voiceStatus.textContent = 'OFFLINE';
  voiceStatus.classList.remove('live');

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  Object.keys(peerConnections).forEach(closePeer);
  remoteAudiosEl.innerHTML = '';
}

async function callPeer(id) {
  if (!localStream) return;
  const pc = createPeerConnection(id);
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: id, data: { type: 'offer', sdp: offer } });
}

function createPeerConnection(id) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peerConnections[id] = pc;

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signal', { to: id, data: { type: 'candidate', candidate: e.candidate } });
    }
  };

  pc.ontrack = (e) => {
    let audioEl = document.getElementById('audio-' + id);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = 'audio-' + id;
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.muted = false;
      audioEl.volume = 1.0;
      remoteAudiosEl.appendChild(audioEl);
    }
    audioEl.srcObject = e.streams[0];
    // Some mobile browsers block autoplay even after a user gesture;
    // force play explicitly and retry once on failure.
    const tryPlay = () => audioEl.play().catch(() => {
      setTimeout(() => audioEl.play().catch(() => {}), 500);
    });
    tryPlay();
  };

  return pc;
}

async function handleSignal(from, data) {
  if (data.type === 'offer') {
    if (!inVoice || !localStream) return; // ignore calls if we're not live
    const pc = peerConnections[from] || createPeerConnection(from);
    if (localStream) {
      localStream.getTracks().forEach(track => {
        if (!pc.getSenders().find(s => s.track === track)) pc.addTrack(track, localStream);
      });
    }
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', { to: from, data: { type: 'answer', sdp: answer } });
  } else if (data.type === 'answer') {
    const pc = peerConnections[from];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.type === 'candidate') {
    const pc = peerConnections[from];
    if (pc) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) {}
    }
  }
}

function closePeer(id) {
  const pc = peerConnections[id];
  if (pc) {
    pc.close();
    delete peerConnections[id];
  }
  const audioEl = document.getElementById('audio-' + id);
  if (audioEl) audioEl.remove();
}
