const WebSocket = require('ws');
const { Pool } = require('pg');
const Redis = require('ioredis');
const { jwtVerify } = require("jose");
const JWT_SECRET = process.env.JWT_SECRET;


const WS_PORT = 8080;
const PG_CONFIG = {
connectionString: process.env.PG_URL
};

const pgPool = new Pool(PG_CONFIG);
const redis = new Redis(process.env.REDIS_URL);

const eventHandlers = {};
function on(event, handler) { eventHandlers[event] = handler; }

const users = new Map(); // ws => { uuid }
let contestants = [];
let currentRound = 0;

// Load all contestants (teachers and decoys)
async function loadContestants() {
  const res = await pgPool.query('SELECT id, name FROM contestants');
  contestants = res.rows;
}

async function handleVote(ws, data, user) {
  const { contestantId } = data;
  const uuid = user.uuid;
  if (!uuid) return;

  const voteKey = `votes:round:${currentRound}:user:${uuid}`;
  const prevContestantId = await redis.get(voteKey);

  // If the user already voted for this contestant, do nothing
  if (prevContestantId === contestantId) {
    ws.send(JSON.stringify({ event: 'vote_success', data: { contestantId } }));
    return;
  }

  // If the user voted for someone else, decrement their vote
  if (prevContestantId) {
    await redis.decr(`votes:round:${currentRound}:contestant:${prevContestantId}`);
  }

  // Set the new vote and increment the new contestant's count
  await redis.set(voteKey, contestantId, 'EX', 60 * 60);
  await redis.incr(`votes:round:${currentRound}:contestant:${contestantId}`);

  ws.send(JSON.stringify({ event: 'vote_success', data: { contestantId } }));
  broadcastVoteCounts();
}


async function broadcastVoteCounts() {
  const voteCounts = {};
  for (const c of contestants) {
    const count = await redis.get(`votes:round:${currentRound}:contestant:${c.id}`);
    voteCounts[c.id] = parseInt(count || '0', 10);
  }
  broadcast(wss, 'vote_update', { voteCounts });
}

function send(ws, event, data) {
  ws.send(JSON.stringify({ event, data }));
}
function broadcast(wss, event, data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      send(client, event, data);
    }
  });
}

const wss = new WebSocket.Server({ port: WS_PORT }, async () => {
  await loadContestants();
  console.log(`WebSocket server running on ws://localhost:${WS_PORT}`);
});

wss.on('connection', (ws) => {
  ws.isAdmin = false; // default

  ws.on('message', async (msg) => {
    let parsed;
    try { parsed = JSON.parse(msg); } catch (e) { return; }
    const { event, data } = parsed;

    // Handle identify event first
    if (event === "identify") {
      users.set(ws, { uuid: data.uuid });

      // Check for admin JWT
      if (data.token) {
        try {
          const secret = new TextEncoder().encode(JWT_SECRET);
          const { payload } = await jwtVerify(data.token, secret);
          if (payload && payload.admin) {
            ws.isAdmin = true;
          }
        } catch (e) {
          // Invalid token, ignore
        }
      }

      send(ws, "welcome", {
        uuid: data.uuid,
        contestants,
        currentRound,
        isAdmin: ws.isAdmin,
      });
      return;
    }

    // For all other events, make sure user is identified
    if (!users.has(ws)) return;

    // Only allow admin actions if ws.isAdmin is true
    if ((event === "next_round" || event === "reset_votes") && !ws.isAdmin) {
      send(ws, "error", { message: "Unauthorized" });
      return;
    }

    if (eventHandlers[event]) await eventHandlers[event](ws, data, users.get(ws));
  });

  ws.on('close', () => { users.delete(ws); });
});


on('vote', handleVote);

on('get_vote_counts', async (ws) => {
  const voteCounts = {};
  for (const c of contestants) {
    const count = await redis.get(`votes:round:${currentRound}:contestant:${c.id}`);
    voteCounts[c.id] = parseInt(count || '0', 10);
  }
  send(ws, 'vote_update', { voteCounts });
});

on('get_my_vote', async (ws, data, user) => {
  const uuid = user.uuid;
  const voteKey = `votes:round:${currentRound}:user:${uuid}`;
  const contestantId = await redis.get(voteKey);
  send(ws, "my_vote", { contestantId });
});


on('next_round', async (ws) => {
  currentRound += 1;
  broadcast(wss, 'round_update', { currentRound });
  broadcastVoteCounts();
});

on('reset_votes', async (ws) => {
  for (let round = 0; round <= currentRound; round++) {
    for (const c of contestants) {
      await redis.del(`votes:round:${round}:contestant:${c.id}`);
    }
  }
  broadcastVoteCounts();
});

process.on('SIGINT', async () => {
  await pgPool.end();
  await redis.quit();
  process.exit();
});
