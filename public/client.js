class WatchTogether {
  constructor() {
    this.ws = null;
    this.pc = null;
    this.localStream = null;
    this.roomId = null;
    this.role = null;
    this.myId = null;
    this.isConnected = false;
    this.pendingCandidates = [];
    
    this.init();
  }

  init() {
    this.setupEventListeners();
    this.detectBrowser();
  }

  detectBrowser() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    
    if (isIOS) {
      document.body.classList.add('ios-device');
      this.showIOSInstructions();
    } else if (isSafari) {
      document.body.classList.add('safari-browser');
    }
    
    if (isMobile) {
      document.body.classList.add('mobile-device');
    }
  }

  showIOSInstructions() {
    const instructionsDiv = document.createElement('div');
    instructionsDiv.className = 'card ios-instructions';
    instructionsDiv.innerHTML = `
      <div class="small" style="color: #e67e22;">
        <strong>📱 iOS Safari での画面共有について</strong><br>
        iOS Safariでは技術的制限により真の画面共有はできませんが、以下の代替方法があります：
        <ul style="margin: 8px 0; padding-left: 20px;">
          <li><strong>カメラ共有</strong>: 背面カメラで画面を撮影して共有</li>
          <li><strong>AirPlay</strong>: Apple TVやMacにAirPlayで画面を映してから共有</li>
          <li><strong>画面録画アプリ</strong>: サードパーティアプリを使用</li>
        </ul>
        最も簡単なのは「カメラを共有」ボタンを使って背面カメラで画面を撮影することです。
      </div>
    `;
    
    const firstCard = document.querySelector('.card');
    firstCard.parentNode.insertBefore(instructionsDiv, firstCard.nextSibling);
  }

  setupEventListeners() {
    document.getElementById('btnJoin').onclick = () => this.joinRoom();
    document.getElementById('btnShareScreen').onclick = () => this.shareScreen();
    document.getElementById('btnShareCamera').onclick = () => this.shareCamera();
    document.getElementById('btnStop').onclick = () => this.stopSharing();
    
    // 手動再生ボタン
    const playBtn = document.createElement('button');
    playBtn.id = 'btnPlay';
    playBtn.textContent = '再生開始';
    playBtn.style.display = 'none';
    playBtn.onclick = () => this.playRemoteVideo();
    document.querySelector('.viewer-only').appendChild(playBtn);
  }

  async joinRoom() {
    const roomId = document.getElementById('roomId').value.trim();
    const role = document.querySelector('input[name="role"]:checked').value;
    
    if (!roomId) {
      alert('ルームIDを入力してください');
      return;
    }

    this.roomId = roomId;
    this.role = role;
    
    try {
      await this.connectWebSocket();
      this.updateUI();
      if (role === 'owner') {
        this.generateQR();
      }
    } catch (error) {
      console.error('接続エラー:', error);
      alert('接続に失敗しました');
    }
  }

  async connectWebSocket() {
    return new Promise((resolve, reject) => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.ws = new WebSocket(`${protocol}//${location.host}`);
      
      this.ws.onopen = () => {
        console.log('WebSocket接続成功');
        resolve();
      };
      
      this.ws.onerror = (error) => {
        console.error('WebSocket接続エラー:', error);
        reject(error);
      };
      
      this.ws.onmessage = (event) => this.handleWebSocketMessage(event);
      this.ws.onclose = () => this.handleWebSocketClose();
    });
  }

  async handleWebSocketMessage(event) {
    const msg = JSON.parse(event.data);
    console.log('受信メッセージ:', msg);
    
    switch (msg.type) {
      case 'hello':
        this.myId = msg.id;
        this.ws.send(JSON.stringify({
          type: 'join-room',
          roomId: this.roomId,
          role: this.role
        }));
        break;
        
      case 'owner-ready':
        if (this.role === 'viewer') {
          await this.createViewerConnection();
        }
        break;
        
      case 'viewer-offer':
        if (this.role === 'owner') {
          await this.handleViewerOffer(msg);
        }
        break;
        
      case 'owner-answer':
        if (this.role === 'viewer') {
          await this.handleOwnerAnswer(msg);
        }
        break;
        
      case 'ice-candidate':
        await this.handleIceCandidate(msg);
        break;
        
      case 'owner-left':
        this.handleOwnerLeft();
        break;
    }
  }

  handleWebSocketClose() {
    console.log('WebSocket接続が切断されました');
    this.isConnected = false;
    // 再接続ロジックをここに追加可能
  }

  async shareScreen() {
    try {
      // iOS Safari の場合は画面共有をカメラ共有に切り替え
      if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
        alert('iOS Safariでは画面共有ができないため、カメラ共有に切り替えます。背面カメラで画面を撮影してください。');
        return this.shareCamera();
      }

      const safariMode = document.getElementById('chkSafari').checked;
      const constraints = safariMode ? {
        video: { width: 640, height: 480, frameRate: 15 },
        audio: false
      } : {
        video: { width: 1280, height: 720, frameRate: 30 },
        audio: true
      };
      
      this.localStream = await navigator.mediaDevices.getDisplayMedia(constraints);
      await this.startStreaming();
      
    } catch (error) {
      console.error('画面共有エラー:', error);
      if (error.name === 'NotSupportedError' || error.name === 'TypeError') {
        alert('このブラウザでは画面共有がサポートされていません。カメラ共有をお試しください。');
      } else {
        alert('画面共有に失敗しました: ' + error.message);
      }
    }
  }

  async shareCamera() {
    try {
      // モバイルデバイスの場合は背面カメラを優先
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      
      const constraints = {
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
          facingMode: isMobile ? 'environment' : 'user' // モバイルでは背面カメラ
        },
        audio: true
      };
      
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      await this.startStreaming();
      
    } catch (error) {
      console.error('カメラ共有エラー:', error);
      alert('カメラ共有に失敗しました: ' + error.message);
    }
  }

  async startStreaming() {
    const preview = document.getElementById('preview');
    preview.srcObject = this.localStream;
    
    document.getElementById('btnShareScreen').disabled = true;
    document.getElementById('btnShareCamera').disabled = true;
    document.getElementById('btnStop').disabled = false;
    
    // ストリーム終了時の処理
    this.localStream.getVideoTracks()[0].onended = () => {
      this.stopSharing();
    };
  }

  stopSharing() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    
    const preview = document.getElementById('preview');
    preview.srcObject = null;
    
    document.getElementById('btnShareScreen').disabled = false;
    document.getElementById('btnShareCamera').disabled = false;
    document.getElementById('btnStop').disabled = true;
    
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }

  async createViewerConnection() {
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ],
      iceCandidatePoolSize: 10
    });
    
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.ws.send(JSON.stringify({
          type: 'ice-candidate',
          roomId: this.roomId,
          candidate: event.candidate
        }));
      }
    };
    
    this.pc.ontrack = (event) => {
      console.log('リモートストリーム受信');
      const remoteVideo = document.getElementById('remote');
      remoteVideo.srcObject = event.streams[0];
      
      // 自動再生が失敗した場合の処理
      remoteVideo.play().catch(() => {
        document.getElementById('btnPlay').style.display = 'block';
      });
    };
    
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    
    this.ws.send(JSON.stringify({
      type: 'viewer-offer',
      roomId: this.roomId,
      sdp: offer
    }));
  }

  async handleViewerOffer(msg) {
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ],
      iceCandidatePoolSize: 10
    });
    
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.ws.send(JSON.stringify({
          type: 'ice-candidate',
          roomId: this.roomId,
          to: msg.from,
          candidate: event.candidate
        }));
      }
    };
    
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        this.pc.addTrack(track, this.localStream);
      });
    }
    
    await this.pc.setRemoteDescription(msg.sdp);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    
    this.ws.send(JSON.stringify({
      type: 'owner-answer',
      roomId: this.roomId,
      to: msg.from,
      sdp: answer
    }));
  }

  async handleOwnerAnswer(msg) {
    await this.pc.setRemoteDescription(msg.sdp);
    this.isConnected = true;
    
    // 保留中のICE候補を処理
    for (const candidate of this.pendingCandidates) {
      await this.pc.addIceCandidate(candidate);
    }
    this.pendingCandidates = [];
  }

  async handleIceCandidate(msg) {
    if (this.pc && this.pc.remoteDescription) {
      await this.pc.addIceCandidate(msg.candidate);
    } else {
      this.pendingCandidates.push(msg.candidate);
    }
  }

  handleOwnerLeft() {
    alert('オーナーが退室しました');
    const remoteVideo = document.getElementById('remote');
    remoteVideo.srcObject = null;
  }

  async playRemoteVideo() {
    const remoteVideo = document.getElementById('remote');
    try {
      await remoteVideo.play();
      document.getElementById('btnPlay').style.display = 'none';
    } catch (error) {
      console.error('再生エラー:', error);
    }
  }

  updateUI() {
    document.querySelectorAll('.owner-only').forEach(el => {
      el.style.display = this.role === 'owner' ? 'block' : 'none';
    });
    
    document.querySelectorAll('.viewer-only').forEach(el => {
      el.classList.toggle('hidden', this.role !== 'viewer');
    });
  }

  generateQR() {
    const url = `${location.origin}/?room=${this.roomId}`;
    const canvas = document.getElementById('qrc');
    QRCode.toCanvas(canvas, url, { width: 200 }, (error) => {
      if (error) console.error('QR生成エラー:', error);
    });
  }
}

// アプリケーション開始
const app = new WatchTogether();

// URL パラメータからルームIDを取得
const urlParams = new URLSearchParams(location.search);
const roomFromUrl = urlParams.get('room');
if (roomFromUrl) {
  document.getElementById('roomId').value = roomFromUrl;
  document.querySelector('input[name="role"][value="viewer"]').checked = true;
}