Here’s a tiny WebRTC meeting POC you can deploy as a static site. It uses Supabase as a super-simple signaling backend (stores SDP offers/answers and ICE candidates). It’s vanilla JS, uses a mesh topology (each participant connects to each other), supports 3–5 participants, and avoids React/TypeScript.

What you get
- Join via a Room ID (shareable URL)
- Mesh WebRTC (3–5 participants)
- Audio/Video + basic controls (mute/cam toggle, screenshare)
- Supabase-backed signaling with polling
- Vanilla JS + a dash of JSDoc

How to set up
1) Create a Supabase project (free tier is fine)
2) Run this SQL in Supabase (SQL Editor) to create tables + open RLS for the POC
3) Copy your SUPABASE_URL and SUPABASE_ANON_KEY
4) Paste them into the index.html placeholders below
5) Deploy index.html to any static host (Vercel, Netlify, GitHub Pages, S3, …)
6) Open the site, pick a Room ID, share the link, and have up to 5 people join

SQL: schema and policies (paste into Supabase SQL Editor)
Note: This is intentionally wide-open for a POC. Lock it down for real use.

```sql
-- Needed for gen_random_uuid()
create extension if not exists pgcrypto;

-- Participants presence table
create table if not exists public.participants (
  room_id text not null,
  id text not null,
  display_name text,
  last_seen timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  primary key (room_id, id)
);

create index if not exists participants_room_idx on public.participants (room_id);
create index if not exists participants_last_seen_idx on public.participants (last_seen);

-- Signaling messages
create table if not exists public.signals (
  id uuid primary key default gen_random_uuid(),
  room_id text not null,
  sender_id text not null,
  receiver_id text not null,
  type text not null check (type in ('offer','answer','candidate','bye')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  consumed boolean not null default false
);

create index if not exists signals_room_recv_idx on public.signals (room_id, receiver_id, consumed, created_at);

-- Enable RLS
alter table public.participants enable row level security;
alter table public.signals enable row level security;

-- POC Policies: open read/write
create policy "participants_select" on public.participants
  for select using (true);

create policy "participants_insert" on public.participants
  for insert with check (true);

create policy "participants_update" on public.participants
  for update using (true);

create policy "participants_delete" on public.participants
  for delete using (true);

create policy "signals_select" on public.signals
  for select using (true);

create policy "signals_insert" on public.signals
  for insert with check (true);

create policy "signals_update" on public.signals
  for update using (true);

create policy "signals_delete" on public.signals
  for delete using (true);
```

index.html (Vanilla JS + JSDoc)
Replace SUPABASE_URL and SUPABASE_ANON_KEY placeholders and deploy this single file.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>WebRTC POC (Vanilla JS + Supabase)</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 0; background: #111; color: #eee; }
    header { padding: 12px 16px; background: #1b1b1b; border-bottom: 1px solid #222; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    header h1 { margin: 0; font-size: 18px; }
    .controls { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    input, button { padding: 8px 10px; border-radius: 6px; border: 1px solid #333; background: #181818; color: #eee; }
    button { cursor: pointer; }
    button.primary { background: #2563eb; border-color: #2563eb; }
    button.warn { background: #b91c1c; border-color: #991b1b; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .status { margin-left: auto; opacity: 0.8; font-size: 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; padding: 12px; }
    .tile { position: relative; background: #000; border: 1px solid #222; border-radius: 8px; overflow: hidden; }
    video { width: 100%; height: 100%; display: block; background: #000; }
    .label { position: absolute; left: 8px; bottom: 8px; background: rgba(0,0,0,.55); padding: 4px 8px; border-radius: 999px; font-size: 12px; }
    .self { outline: 2px solid #2563eb; }
    .link { margin: 8px 16px; font-size: 12px; opacity: 0.8; }
    .link input { width: 100%; max-width: 520px; }
  </style>
</head>
<body>
  <header>
    <h1>WebRTC POC</h1>
    <div class="controls">
      <input id="room" placeholder="Room ID (e.g. team-sync)" />
      <input id="name" placeholder="Your name" />
      <button id="joinBtn" class="primary">Join</button>
      <button id="leaveBtn" class="warn" disabled>Leave</button>
      <button id="micBtn" disabled>Mute</button>
      <button id="camBtn" disabled>Cam Off</button>
      <button id="screenBtn" disabled>Share Screen</button>
    </div>
    <div class="status" id="status">Idle</div>
  </header>

  <div class="link">
    Share link (appears after you join):
    <div><input id="shareLink" readonly /></div>
  </div>

  <div class="grid" id="grid"></div>

  <!-- Supabase client -->
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <script>
    // ========== CONFIG (replace with your values) ==========
    const SUPABASE_URL = "https://YOUR_PROJECT_ID.supabase.co";
    const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";

    // ========== CONSTANTS ==========
    const MAX_PARTICIPANTS = 5; // room capacity
    const ACTIVE_WINDOW_MS = 10000; // active if seen within last 10s
    const HEARTBEAT_MS = 4000;
    const SIGNAL_POLL_MS = 1000;
    const PARTICIPANTS_POLL_MS = 2500;

    const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }]; // Add TURN for production

    // ========== GLOBALS ==========
    const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const $ = (id) => document.getElementById(id);

    const peers = new Map(); // Map<string, Peer>
    let myId = null;
    let myName = null;
    let roomId = null;
    let joined = false;

    let localStream = null;
    let localVideoEl = null;
    let audioEnabled = true;
    let videoEnabled = true;
    let screenSharing = false;

    let heartbeatTimer = null;
    let signalsPollTimer = null;
    let participantsPollTimer = null;

    // ========== JSDoc Types ==========
    /**
     * @typedef {Object} Peer
     * @property {string} id
     * @property {string} name
     * @property {RTCPeerConnection} pc
     * @property {MediaStream} remoteStream
     * @property {HTMLVideoElement} videoEl
     * @property {RTCIceCandidateInit[]} pendingCandidates
     * @property {boolean} isCaller
     */

    /**
     * @typedef {"offer"|"answer"|"candidate"|"bye"} SignalType
     */

    // ========== UI ==========
    const grid = $("grid");
    const setStatus = (text) => $("status").textContent = text;
    const log = (...args) => console.log("[POC]", ...args);

    function setControlsState(inRoom) {
      $("joinBtn").disabled = inRoom;
      $("leaveBtn").disabled = !inRoom;
      $("micBtn").disabled = !inRoom;
      $("camBtn").disabled = !inRoom;
      $("screenBtn").disabled = !inRoom;
      $("room").disabled = inRoom;
      $("name").disabled = inRoom;
    }

    function urlRoom() {
      const u = new URL(location.href);
      return u.searchParams.get("room");
    }

    function urlName() {
      const u = new URL(location.href);
      return u.searchParams.get("name");
    }

    function updateShareLink() {
      const u = new URL(location.href);
      u.searchParams.set("room", roomId);
      if (myName) u.searchParams.set("name", myName);
      $("shareLink").value = u.toString();
    }

    // ========== Helpers ==========
    function genId(len = 8) {
      const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
      let out = "";
      for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
      return out;
    }

    function nowIso() {
      return new Date().toISOString();
    }

    function msAgo(ms) {
      return new Date(Date.now() - ms).toISOString();
    }

    /**
     * Create or get an existing Peer by remoteId.
     * @param {string} remoteId
     * @param {string} remoteName
     * @param {boolean} isCaller
     * @returns {Peer}
     */
    function ensurePeer(remoteId, remoteName, isCaller) {
      let peer = peers.get(remoteId);
      if (peer) return peer;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const remoteStream = new MediaStream();
      const videoEl = createVideoTile(remoteId, remoteName, remoteStream);

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          sendSignal(remoteId, "candidate", ev.candidate.toJSON());
        }
      };

      pc.ontrack = (ev) => {
        ev.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
        videoEl.srcObject = remoteStream;
      };

      pc.onconnectionstatechange = () => {
        log(`pc(${remoteId}) state:`, pc.connectionState);
        if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
          // allow brief recoveries for disconnected; you can tune this
          if (pc.connectionState === "failed") removePeer(remoteId);
        }
      };

      /** @type {Peer} */
      peer = {
        id: remoteId,
        name: remoteName,
        pc,
        remoteStream,
        videoEl,
        pendingCandidates: [],
        isCaller: !!isCaller,
      };
      peers.set(remoteId, peer);

      // Add local tracks
      if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
      }

      return peer;
    }

    function createVideoTile(id, name, stream) {
      const tile = document.createElement("div");
      tile.className = "tile";
      const v = document.createElement("video");
      v.autoplay = true;
      v.playsInline = true;
      v.srcObject = stream || null;

      const label = document.createElement("div");
      label.className = "label";
      label.textContent = name ? `${name} (${id})` : id;

      tile.appendChild(v);
      tile.appendChild(label);
      grid.appendChild(tile);
      return v;
    }

    function removePeer(remoteId) {
      const peer = peers.get(remoteId);
      if (!peer) return;
      try { peer.pc.onicecandidate = null; } catch {}
      try { peer.pc.ontrack = null; } catch {}
      try { peer.pc.close(); } catch {}
      // Remove tile
      if (peer.videoEl && peer.videoEl.parentElement) {
        peer.videoEl.pause();
        peer.videoEl.srcObject = null;
        peer.videoEl.parentElement.remove();
      }
      peers.delete(remoteId);
    }

    async function checkRoomCapacityOrThrow(room) {
      const since = msAgo(ACTIVE_WINDOW_MS);
      const { data, error } = await supabase
        .from("participants")
        .select("id")
        .eq("room_id", room)
        .gte("last_seen", since);
      if (error) throw error;
      const active = data?.length || 0;
      if (active >= MAX_PARTICIPANTS) {
        const msg = `Room is full (max ${MAX_PARTICIPANTS}).`;
        setStatus(msg);
        throw new Error(msg);
      }
    }

    // ========== Signaling ==========
    /**
     * Send a signaling message to a peer.
     * @param {string} toId
     * @param {SignalType} type
     * @param {any} payload
     */
    async function sendSignal(toId, type, payload) {
      if (!joined) return;
      const { error } = await supabase.from("signals").insert([{
        room_id: roomId,
        sender_id: myId,
        receiver_id: toId,
        type,
        payload
      }]);
      if (error) log("sendSignal error:", error);
    }

    async function pollSignals() {
      if (!joined) return;
      const { data, error } = await supabase
        .from("signals")
        .select("*")
        .eq("room_id", roomId)
        .eq("receiver_id", myId)
        .eq("consumed", false)
        .order("created_at", { ascending: true });
      if (error) { log("pollSignals error:", error); return; }

      for (const row of data) {
        try {
          await handleSignal(row);
        } catch (err) {
          log("handleSignal failed:", err);
        } finally {
          // mark consumed
          await supabase.from("signals").update({ consumed: true }).eq("id", row.id);
        }
      }
    }

    async function handleSignal(row) {
      const { sender_id: from, type, payload } = row;
      if (from === myId) return;

      // Ensure we know the sender's display name if possible
      let remoteName = from;
      try {
        const { data: p } = await supabase.from("participants").select("display_name").eq("room_id", roomId).eq("id", from).limit(1).single();
        if (p?.display_name) remoteName = p.display_name;
      } catch {}

      if (type === "offer") {
        const peer = ensurePeer(from, remoteName, false);
        await peer.pc.setRemoteDescription(new RTCSessionDescription(payload));
        // Add local tracks (if not already)
        if (localStream) {
          const senders = peer.pc.getSenders();
          localStream.getTracks().forEach(t => {
            if (!senders.find(s => s.track && s.track.kind === t.kind)) {
              peer.pc.addTrack(t, localStream);
            }
          });
        }
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        await sendSignal(from, "answer", peer.pc.localDescription);

        // Flush any queued ICE candidates
        await flushPendingCandidates(peer);

      } else if (type === "answer") {
        const peer = ensurePeer(from, remoteName, true);
        await peer.pc.setRemoteDescription(new RTCSessionDescription(payload));
        await flushPendingCandidates(peer);

      } else if (type === "candidate") {
        const peer = ensurePeer(from, remoteName, false);
        const cand = new RTCIceCandidate(payload);
        if (!peer.pc.remoteDescription) {
          peer.pendingCandidates.push(cand.toJSON());
        } else {
          try { await peer.pc.addIceCandidate(cand); } catch (e) { log("addIceCandidate error:", e); }
        }

      } else if (type === "bye") {
        removePeer(from);
      }
    }

    /**
     * Flush queued candidates after remoteDescription is set.
     * @param {Peer} peer
     */
    async function flushPendingCandidates(peer) {
      if (!peer.pc.remoteDescription) return;
      while (peer.pendingCandidates.length > 0) {
        const c = peer.pendingCandidates.shift();
        try { await peer.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { log("flush addIceCandidate error:", e); }
      }
    }

    // ========== Mesh connect logic ==========
    async function connectToMissingPeers() {
      if (!joined) return;
      const since = msAgo(ACTIVE_WINDOW_MS);
      const { data, error } = await supabase
        .from("participants")
        .select("id, display_name")
        .eq("room_id", roomId)
        .gte("last_seen", since)
        .order("joined_at", { ascending: true });
      if (error) { log("participants poll error:", error); return; }

      // Gate room capacity
      const active = (data || []).filter(p => p.id !== myId);
      if (active.length + 1 > MAX_PARTICIPANTS) {
        setStatus(`Room reached capacity: ${active.length + 1}/${MAX_PARTICIPANTS}`);
      }

      // Remove peers that disappeared
      for (const [pid] of peers) {
        if (!active.find(p => p.id === pid)) {
          removePeer(pid);
        }
      }

      // For each active participant, if not connected, connect deterministically:
      // Peer with lexicographically smaller ID becomes "caller" and creates the offer.
      for (const p of active) {
        if (peers.has(p.id)) continue; // already connected
        const amCaller = myId < p.id;
        if (amCaller) {
          // Don't exceed capacity: we only initiate if we have slots
          if ((peers.size + 1) >= MAX_PARTICIPANTS) continue;

          const peer = ensurePeer(p.id, p.display_name || p.id, true);
          const offer = await peer.pc.createOffer();
          await peer.pc.setLocalDescription(offer);
          await sendSignal(p.id, "offer", peer.pc.localDescription);
        } else {
          // We'll wait for their offer; do nothing here.
        }
      }
    }

    // ========== Join / Leave ==========
    async function joinRoom() {
      try {
        myName = $("name").value.trim() || urlName() || `user-${genId(4)}`;
        roomId = $("room").value.trim() || urlRoom() || "poc-room";
        myId = genId(8);

        // Check capacity before claiming a seat
        await checkRoomCapacityOrThrow(roomId);

        setStatus("Requesting camera/mic...");
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

        // Add local video tile
        const localTile = document.createElement("div");
        localTile.className = "tile self";
        localVideoEl = document.createElement("video");
        localVideoEl.autoplay = true;
        localVideoEl.muted = true; // required for autoplay
        localVideoEl.playsInline = true;
        localVideoEl.srcObject = localStream;
        const label = document.createElement("div");
        label.className = "label";
        label.textContent = `${myName} (you)`;
        localTile.appendChild(localVideoEl);
        localTile.appendChild(label);
        grid.appendChild(localTile);

        // Presence: claim seat
        await supabase.from("participants").upsert([{
          room_id: roomId,
          id: myId,
          display_name: myName,
          last_seen: nowIso()
        }], { onConflict: "room_id,id" });

        joined = true;
        setControlsState(true);
        setStatus("Joined");
        updateShareLink();

        // Heartbeat
        heartbeatTimer = setInterval(async () => {
          await supabase.from("participants").update({ last_seen: nowIso() }).eq("room_id", roomId).eq("id", myId);
        }, HEARTBEAT_MS);

        // Poll signals and participants
        signalsPollTimer = setInterval(pollSignals, SIGNAL_POLL_MS);
        participantsPollTimer = setInterval(connectToMissingPeers, PARTICIPANTS_POLL_MS);

        // Immediately attempt to connect to current peers
        await connectToMissingPeers();

      } catch (err) {
        console.error(err);
        setStatus(err?.message || "Join failed");
        await leaveRoom(); // ensure cleanup
      }
    }

    async function leaveRoom() {
      if (!joined) return;
      setStatus("Leaving...");

      // Signal departures
      for (const [pid] of peers) {
        await sendSignal(pid, "bye", {});
      }

      // Clear timers
      if (heartbeatTimer) clearInterval(heartbeatTimer), heartbeatTimer = null;
      if (signalsPollTimer) clearInterval(signalsPollTimer), signalsPollTimer = null;
      if (participantsPollTimer) clearInterval(participantsPollTimer), participantsPollTimer = null;

      // Remove peers
      for (const [pid] of peers) removePeer(pid);

      // Remove presence
      try {
        await supabase.from("participants").delete().eq("room_id", roomId).eq("id", myId);
      } catch {}

      // Stop local media
      if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
      }

      // Remove local tile
      if (localVideoEl && localVideoEl.parentElement) {
        localVideoEl.pause();
        localVideoEl.srcObject = null;
        localVideoEl.parentElement.remove();
      }
      localVideoEl = null;

      joined = false;
      setControlsState(false);
      setStatus("Left");
    }

    // ========== Media Controls ==========
    function toggleMic() {
      if (!localStream) return;
      audioEnabled = !audioEnabled;
      localStream.getAudioTracks().forEach(t => t.enabled = audioEnabled);
      $("micBtn").textContent = audioEnabled ? "Mute" : "Unmute";
    }

    function toggleCam() {
      if (!localStream) return;
      videoEnabled = !videoEnabled;
      localStream.getVideoTracks().forEach(t => t.enabled = videoEnabled);
      $("camBtn").textContent = videoEnabled ? "Cam Off" : "Cam On";
    }

    async function toggleScreenShare() {
      if (!joined) return;
      if (!screenSharing) {
        try {
          const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
          const screenTrack = screenStream.getVideoTracks()[0];
          // Replace the outgoing video track in all connections
          replaceOutgoingTrack("video", screenTrack);
          screenSharing = true;
          $("screenBtn").textContent = "Stop Share";

          screenTrack.onended = () => {
            // Revert to camera on stop
            revertToCamera();
          };
        } catch (e) {
          log("screen share error", e);
        }
      } else {
        revertToCamera();
      }
    }

    function revertToCamera() {
      if (!localStream) return;
      const camTrack = localStream.getVideoTracks()[0];
      if (camTrack) {
        replaceOutgoingTrack("video", camTrack);
      }
      screenSharing = false;
      $("screenBtn").textContent = "Share Screen";
    }

    /**
     * Replace outgoing track of a given kind across all peer connections.
     * @param {"audio"|"video"} kind
     * @param {MediaStreamTrack} newTrack
     */
    function replaceOutgoingTrack(kind, newTrack) {
      for (const [, peer] of peers) {
        const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === kind);
        if (sender) {
          sender.replaceTrack(newTrack);
        }
      }
      // Also update local tile if it's a video track
      if (kind === "video" && localVideoEl && newTrack) {
        const newStream = new MediaStream([newTrack, ...localStream.getAudioTracks()]);
        localVideoEl.srcObject = newStream;
      }
    }

    // ========== Wire up UI ==========
    $("joinBtn").addEventListener("click", async () => {
      if (!SUPABASE_URL || SUPABASE_URL.includes("YOUR_PROJECT_ID")) {
        alert("Please set SUPABASE_URL and SUPABASE_ANON_KEY in index.html first.");
        return;
      }
      if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes("YOUR_SUPABASE_ANON_KEY")) {
        alert("Please set SUPABASE_ANON_KEY in index.html first.");
        return;
      }
      await joinRoom();
    });

    $("leaveBtn").addEventListener("click", leaveRoom);
    $("micBtn").addEventListener("click", toggleMic);
    $("camBtn").addEventListener("click", toggleCam);
    $("screenBtn").addEventListener("click", toggleScreenShare);

    // Prefill from URL params and hint a room
    window.addEventListener("load", () => {
      const r = urlRoom();
      const n = urlName();
      if (r) $("room").value = r;
      else $("room").value = "poc-room";
      if (n) $("name").value = n;
    });

    window.addEventListener("beforeunload", async () => {
      await leaveRoom();
    });
  </script>
</body>
</html>
```

Notes and tips
- Capacity: This uses a full-mesh topology. 5 participants is OK for a POC. For more people, you’d typically move to an SFU (e.g., LiveKit, Mediasoup).
- NAT traversal: Using STUN only. For reliability behind symmetric NATs, add TURN servers to ICE_SERVERS.
- Signaling: This uses simple polling. It’s fine for a POC. You can switch to Supabase Realtime (Postgres Changes) for push-style updates if you want.
- Room fullness: The app checks a sliding window of last_seen timestamps to gate the room. There is a race condition window; you can tighten this with a server function if needed.
- Security: RLS is wide open for demo convenience. Lock it down (auth, per-room policies, cleanup jobs) before any real use.

If you prefer Turso or CouchDB instead of Supabase, the same pattern works:
- Create participants and signals tables (or docs)
- Implement polling for receiver_id + room_id
- Keep the ID-order offerer rule to avoid glare

Want me to adapt this to Turso (SQLite) with a tiny serverless endpoint for polling/insert?