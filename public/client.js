
// Minimal WebRTC signaling client for owner/viewer with per-viewer PeerConnections.
// Works best for small rooms (P2P mesh). For larger rooms use an SFU (e.g., LiveKit).

const $ = (sel) => document.querySelector(sel);
const state = {
  role: 'owner',
  roomId: '',
  ws: null,
  id: null,
  ownerStream: null,
  // Owner: peer map per viewerId. Viewer: single pc.
  peers: new Map(),
};

// UI elements
const roomInput = $('#roomId');
const btnJoin = $('#btnJoin');
const btnShareScreen = $('#btnShareScreen');
const btnShareCamera = $('#btnShareCamera');
const btnStop = $('#btnStop');
const preview = $('#preview');
const remote = $('#remote');

// role switch
document.querySelectorAll('input[name="role"]').forEach(r => {
  r.addEventListener('change', () => {
    state.role = r.value;
    updateRoleUI();
  });
});

function updateRoleUI() {
  document.querySelector('.owner-only').classList.toggle('hidden', state.role !== 'owner');
  document.querySelector('.viewer-only').classList.toggle('hidden', state.role !== 'viewer');
}

updateRoleUI();

btnJoin.addEventListener('click', async () => {
  state.roomId = roomInput.value.trim();
  if (!state.roomId) {
    alert('ルームIDを入力してください');
    return;
  }
  await ensureWS();
  state.ws.send(JSON.stringify({ type: 'join-room', roomId: state.roomId, role: state.role }));
  if (state.role === 'owner') makeQR();
});

async function ensureWS() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}`);
  state.ws.onmessage = onSignal;
  await new Promise((res) => (state.ws.onopen = res));
}

function onSignal(ev) {
  const msg = JSON.parse(ev.data);
  // console.log('signal', msg);
  switch (msg.type) {
    case 'hello': state.id = msg.id; break;
    case 'owner-ready':
      if (state.role === 'viewer') {
        startViewer();
      }
      break;
    case 'viewer-offer':
      if (state.role === 'owner') {
        handleViewerOffer(msg.from, msg.sdp);
      }
      break;
    case 'owner-answer':
      if (state.role === 'viewer') {
        state.pc?.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      }
      break;
    case 'ice-candidate':
      if (state.role === 'owner') {
        const pc = state.peers.get(msg.from);
        if (pc && msg.candidate) pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(()=>{});
      } else if (state.role === 'viewer') {
        if (msg.candidate) state.pc?.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(()=>{});
      }
      break;
    case 'owner-left':
      if (state.role === 'viewer') {
        teardownViewer();
        alert('オーナーが退出しました');
      }
      break;
  }
}

// ===== Owner flow =====
btnShareScreen.addEventListener('click', async () => {
  try {
    const safariMode = document.getElementById('chkSafari').checked; // ← 新しいチェックボックス
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: safariMode ? false : true
    });
    onOwnerGotStream(stream);
  } catch (e) {
    alert('画面共有に失敗: ' + e.message);
  }
});


btnShareCamera.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: true
    });
    onOwnerGotStream(stream);
  } catch (e) {
    alert('カメラ取得に失敗: ' + e.message);
  }
});

function onOwnerGotStream(stream) {
  state.ownerStream = stream;
  preview.srcObject = stream;
  btnStop.disabled = false;

  // If tracks end (e.g., user stops screen share), cleanup
  stream.getTracks().forEach(t => t.addEventListener('ended', () => stopOwner()));

  // For already connected viewers, replace tracks
  for (const [vid, pc] of state.peers) {
    replaceTracks(pc, stream);
  }
}

btnStop.addEventListener('click', stopOwner);

function stopOwner() {
  btnStop.disabled = true;
  if (state.ownerStream) {
    state.ownerStream.getTracks().forEach(t => t.stop());
    state.ownerStream = null;
    preview.srcObject = null;
  }
  for (const [vid, pc] of state.peers) {
    pc.getSenders().forEach(s => { try { pc.removeTrack(s); } catch {} });
  }
}

async function handleViewerOffer(viewerId, sdp) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    // LAN最適化: デフォルトでhost候補も含まれる（HTTPS必須）。
  });
  state.peers.set(viewerId, pc);

  pc.onicecandidate = (e) => {
    if (e.candidate) state.ws.send(JSON.stringify({
      type: 'ice-candidate', roomId: state.roomId, to: viewerId, candidate: e.candidate
    }));
  };

  // Add tracks if available
  if (state.ownerStream) {
    for (const track of state.ownerStream.getTracks()) {
      pc.addTrack(track, state.ownerStream);
    }
  }

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  state.ws.send(JSON.stringify({ type: 'owner-answer', roomId: state.roomId, to: viewerId, sdp: pc.localDescription }));

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      pc.close();
      state.peers.delete(viewerId);
    }
  };
}

function replaceTracks(pc, stream) {
  const senders = pc.getSenders();
  for (const track of stream.getTracks()) {
    const kind = track.kind;
    const sender = senders.find(s => s.track && s.track.kind === kind);
    if (sender) {
      sender.replaceTrack(track);
    } else {
      pc.addTrack(track, stream);
    }
  }
}

// ===== Viewer flow =====
async function startViewer() {
  teardownViewer(); // reset if needed
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
  });
  state.pc = pc;

  pc.onicecandidate = (e) => {
    if (e.candidate) state.ws.send(JSON.stringify({
      type: 'ice-candidate', roomId: state.roomId, candidate: e.candidate
    }));
  };

  pc.ontrack = (ev) => {
    // Expecting one stream with A/V
    remote.srcObject = ev.streams[0];
  };

  // Viewer does not send tracks (recvonly)
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await pc.setLocalDescription(offer);
  state.ws.send(JSON.stringify({ type: 'viewer-offer', roomId: state.roomId, sdp: pc.localDescription }));
}

function teardownViewer() {
  if (state.pc) {
    state.pc.getTransceivers?.().forEach(t => t.stop?.());
    state.pc.close();
    state.pc = null;
  }
  remote.srcObject = null;
}

// QR for invite
function makeQR() {
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(state.roomId)}&role=viewer`;
  const canvas = document.getElementById('qrc');
  if (canvas) {
    window.QRCode.toCanvas(canvas, url, { width: 240 }, (err) => {});
  }
}

// Auto-fill from query
const params = new URLSearchParams(location.search);
if (params.get('room')) roomInput.value = params.get('room');
if (params.get('role') === 'viewer') {
  document.querySelector('input[value="viewer"]').checked = true;
  state.role = 'viewer';
  updateRoleUI();
}

