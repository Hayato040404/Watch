
import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files
app.use(express.static('public'));

const rooms = new Map(); // roomId -> { owner: ws|null, viewers: Map<id, ws> }
const clientMeta = new Map(); // ws -> { id, roomId, role }

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { owner: null, viewers: new Map() });
  }
  return rooms.get(roomId);
}

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  } catch {}
}

wss.on('connection', (ws) => {
  const id = uuidv4();
  clientMeta.set(ws, { id, roomId: null, role: null });
  safeSend(ws, { type: 'hello', id });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const meta = clientMeta.get(ws);
    if (!meta) return;

    switch (msg.type) {
      case 'join-room': {
        // { type, roomId, role: 'owner'|'viewer' }
        const { roomId, role } = msg;
        if (!roomId || !role) return;
        meta.roomId = roomId;
        meta.role = role;
        const room = getOrCreateRoom(roomId);
        if (role === 'owner') {
          room.owner = ws;
          // Notify waiting viewers that owner is ready
          for (const [vid, vws] of room.viewers) {
            safeSend(vws, { type: 'owner-ready' });
          }
        } else {
          // viewer
          room.viewers.set(id, ws);
          // If owner exists, tell viewer that owner is ready
          if (room.owner) safeSend(ws, { type: 'owner-ready' });
        }
        break;
      }
      case 'viewer-offer': {
        // { type, roomId, sdp }
        const { roomId, sdp } = msg;
        const room = rooms.get(roomId);
        if (!room || !room.owner) return;
        safeSend(room.owner, { type: 'viewer-offer', from: meta.id, sdp });
        break;
      }
      case 'owner-answer': {
        // { type, roomId, to, sdp }
        const { roomId, to, sdp } = msg;
        const room = rooms.get(roomId);
        if (!room) return;
        const vws = room.viewers.get(to);
        if (!vws) return;
        safeSend(vws, { type: 'owner-answer', sdp });
        break;
      }
      case 'ice-candidate': {
        // { type, roomId, to, candidate }
        const { roomId, to, candidate } = msg;
        const room = rooms.get(roomId);
        if (!room) return;
        if (meta.role === 'viewer' && room.owner) {
          safeSend(room.owner, { type: 'ice-candidate', from: meta.id, candidate });
        } else if (meta.role === 'owner') {
          const vws = room.viewers.get(to);
          if (vws) safeSend(vws, { type: 'ice-candidate', candidate });
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const meta = clientMeta.get(ws);
    if (!meta) return;
    const { roomId, role, id } = meta;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      if (role === 'owner') {
        // notify viewers owner left
        for (const [vid, vws] of room.viewers) {
          safeSend(vws, { type: 'owner-left' });
        }
        room.owner = null;
      } else if (role === 'viewer') {
        if (room.viewers.has(id)) room.viewers.delete(id);
      }
      // cleanup empty room
      if (!room.owner && room.viewers.size === 0) rooms.delete(roomId);
    }
    clientMeta.delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
