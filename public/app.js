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
}

sendBtn.addEventListener('click', sendMessage);
msgInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !socket) return;
  socket.emit('chat-message', text);
  msgInput.value = '';
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
      remoteAudiosEl.appendChild(audioEl);
    }
    audioEl.srcObject = e.streams[0];
  };

  return pc;
}

async function handleSignal(from, data) {
  if (data.type === 'offer') {
    if (!localStream && inVoice) return;
    if (!inVoice) return; // ignore calls if we're not live
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
