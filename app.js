/**
 * @typedef {import('@supabase/supabase-js').SupabaseClient} SupabaseClient
 * @typedef {import('@supabase/supabase-js').RealtimeChannel} RealtimeChannel
 */

const SUPABASE_URL = 'https://jlmuiojycdqsihmvcuoj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpsbXVpb2p5Y2Rxc2lobXZjdW9qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg4NjcyNDIsImV4cCI6MjA3NDQ0MzI0Mn0.qg05nWX1NINNJ5Af62fyMlfoyqQv8Eah5LuLWFVCzYw';

const joinArea = document.getElementById('join-area');
const roomIdInput = document.getElementById('room-id');
const joinButton = document.getElementById('join-button');
const videoContainer = document.getElementById('video-container');
const localVideo = document.getElementById('local-video');

/** @type {import('@supabase/supabase-js').SupabaseClient} */
let supabaseClient;
/** @type {import('@supabase/supabase-js').RealtimeChannel} */
let realtimeChannel;
/** @type {string | null} */
let myId = null;
/** @type {string | null} */
let currentRoom = null;
/** @type {MediaStream | null} */
let localStream = null;

/** @type {Object<string, RTCPeerConnection>} */
const peerConnections = {};

const iceServers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ],
};

joinButton.addEventListener('click', async () => {
    const room = roomIdInput.value.trim();
    if (room) {
        currentRoom = room;
        joinArea.classList.add('hidden');
        videoContainer.classList.remove('hidden');
        await init();
    }
});

async function init() {
    myId = `user-${Math.random().toString(36).substring(2, 9)}`;
    console.log('My ID:', myId);

    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;

    setupSignaling();
}

function setupSignaling() {
    realtimeChannel = supabase.channel(`room:${currentRoom}`, {
        config: {
            broadcast: {
                self: false,
            },
        },
    });

    realtimeChannel
        .on('broadcast', { event: 'join' }, ({ payload }) => {
            console.log(`${payload.sender_id} joined the room`);
            createPeerConnection(payload.sender_id, true);
        })
        .on('broadcast', { event: 'signal' }, ({ payload }) => {
            const { sender_id, recipient_id, data } = payload;
            if (recipient_id === myId) {
                handleSignal(sender_id, data);
            }
        })
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('Subscribed to room:', currentRoom);
                realtimeChannel.send({
                    type: 'broadcast',
                    event: 'join',
                    payload: { sender_id: myId },
                });
            }
        });
}

/**
 * @param {string} peerId
 * @param {boolean} isInitiator
 */
function createPeerConnection(peerId, isInitiator) {
    if (peerConnections[peerId]) {
        console.log('Connection with', peerId, 'already exists.');
        return;
    }
    console.log('Creating peer connection with', peerId);

    const pc = new RTCPeerConnection(iceServers);
    peerConnections[peerId] = pc;

    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignal(peerId, { candidate: event.candidate });
        }
    };

    pc.ontrack = (event) => {
        addRemoteStream(peerId, event.streams[0]);
    };

    pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed' || pc.iceConnectionState === 'failed') {
            console.log('Peer', peerId, 'disconnected.');
            removePeer(peerId);
        }
    };

    if (isInitiator) {
        pc.createOffer()
            .then(offer => pc.setLocalDescription(offer))
            .then(() => {
                sendSignal(peerId, { sdp: pc.localDescription });
            })
            .catch(e => console.error('Error creating offer:', e));
    }
}

/**
 * @param {string} peerId
 * @param {any} data
 */
async function handleSignal(peerId, data) {
    const pc = peerConnections[peerId] || createPeerConnection(peerId, false);

    if (data.sdp) {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            if (data.sdp.type === 'offer') {
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                sendSignal(peerId, { sdp: pc.localDescription });
            }
        } catch (e) {
            console.error('Error handling SDP:', e);
        }
    } else if (data.candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
            console.error('Error adding ICE candidate:', e);
        }
    }
}

/**
 * @param {string} recipientId
 * @param {any} data
 */
function sendSignal(recipientId, data) {
    realtimeChannel.send({
        type: 'broadcast',
        event: 'signal',
        payload: {
            sender_id: myId,
            recipient_id: recipientId,
            data: data,
        },
    });
}

/**
 * @param {string} peerId
 * @param {MediaStream} stream
 */
function addRemoteStream(peerId, stream) {
    if (document.getElementById(`video-${peerId}`)) return; // Already exists

    const videoWrapper = document.createElement('div');
    videoWrapper.id = `wrapper-${peerId}`;
    videoWrapper.className = 'video-wrapper';

    const nameTag = document.createElement('h3');
    nameTag.innerText = `User: ${peerId.substring(5, 9)}`;

    const remoteVideo = document.createElement('video');
    remoteVideo.id = `video-${peerId}`;
    remoteVideo.srcObject = stream;
    remoteVideo.autoplay = true;
    remoteVideo.playsInline = true;

    videoWrapper.appendChild(nameTag);
    videoWrapper.appendChild(remoteVideo);
    videoContainer.appendChild(videoWrapper);
}

/**
 * @param {string} peerId
 */
function removePeer(peerId) {
    if (peerConnections[peerId]) {
        peerConnections[peerId].close();
        delete peerConnections[peerId];
    }
    const videoWrapper = document.getElementById(`wrapper-${peerId}`);
    if (videoWrapper) {
        videoWrapper.remove();
    }
}

window.addEventListener('beforeunload', () => {
    if (realtimeChannel) {
        realtimeChannel.unsubscribe();
    }
    Object.values(peerConnections).forEach(pc => pc.close());
});