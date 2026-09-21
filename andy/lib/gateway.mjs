// The Gateway connection: what lets staff just @Andy instead of typing a command.
//
// Slash commands arrive over HTTP and need no socket. Messages do not — a bot
// only sees a channel message if it is connected to the Gateway, so this is the
// difference between "run /andy" and asking Andy a question the way you would
// ask a colleague. In practice that is the difference between a tool people use
// and a tool people forget exists.
//
// Node has had a global WebSocket since 22, so there is no library here either.
//
// Two intents: GUILD_MESSAGES to see that a message happened, MESSAGE_CONTENT
// to read it. MESSAGE_CONTENT is privileged and must be switched on in the
// Discord developer portal — without it every message arrives with an empty
// body and Andy looks broken rather than unconfigured, so that case is called
// out explicitly below.
const INTENTS = (1 << 9) | (1 << 15);   // GUILD_MESSAGES | MESSAGE_CONTENT

const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 };

// Codes Discord will never accept a reconnect for. Retrying these forever hides
// a misconfiguration behind what looks like a network problem.
const FATAL = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const FATAL_REASON = {
  4004: 'the bot token is wrong',
  4013: 'invalid intents',
  4014: 'MESSAGE_CONTENT is not enabled — turn on the Message Content Intent in the Discord developer portal, under Bot → Privileged Gateway Intents',
};

export class Gateway {
  /**
   * @param {object} options
   * @param {string} options.token     bot token
   * @param {(message) => Promise<void>} options.onMention called for each message that mentions the bot
   * @param {(line) => void} options.log
   */
  constructor({ token, onMention, log = () => {}, allowedChannels = [] }) {
    this.token = token;
    this.onMention = onMention;
    this.log = log;
    this.allowed = new Set(allowedChannels ?? []);
    this.socket = null;
    this.sessionId = null;
    this.resumeUrl = null;
    this.sequence = null;
    this.heartbeat = null;
    this.acked = true;
    this.backoff = 1000;
    this.stopped = false;
    this.userId = null;
    this.ready = false;
  }

  start() { this.stopped = false; this.connect(); return this; }

  stop() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    try { this.socket?.close(1000); } catch { /* already gone */ }
    this.socket = null;
  }

  connect(resume = false) {
    if (this.stopped) return;
    if (typeof WebSocket === 'undefined') {
      this.log('gateway: this Node has no WebSocket — Andy needs Node 22 or newer for @mentions');
      return;
    }
    const url = resume && this.resumeUrl ? this.resumeUrl : 'wss://gateway.discord.gg';
    const socket = this.socket = new WebSocket(`${url}/?v=10&encoding=json`);

    socket.addEventListener('open', () => this.log(`gateway: ${resume ? 'resuming' : 'connecting'}`));
    socket.addEventListener('message', (event) => this.receive(event.data, resume));
    socket.addEventListener('error', () => { /* close always follows; handled there */ });
    socket.addEventListener('close', (event) => {
      clearInterval(this.heartbeat);
      this.ready = false;
      if (this.stopped) return;
      if (FATAL.has(event.code)) {
        this.log(`gateway: refusing to reconnect (${event.code}) — ${FATAL_REASON[event.code] ?? 'see Discord\'s gateway close codes'}`);
        this.stopped = true;
        return;
      }
      // 4000-4009 mean the session is void; anything else can be resumed, which
      // avoids replaying the whole guild list on a blip.
      const canResume = Boolean(this.sessionId) && event.code !== 4007 && event.code !== 4009;
      this.log(`gateway: closed (${event.code}), reconnecting in ${Math.round(this.backoff / 1000)}s`);
      setTimeout(() => this.connect(canResume), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60000);
    });
  }

  send(op, d) {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ op, d }));
  }

  receive(raw, resuming) {
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    if (payload.s != null) this.sequence = payload.s;

    switch (payload.op) {
      case OP.HELLO: {
        clearInterval(this.heartbeat);
        this.acked = true;
        this.heartbeat = setInterval(() => {
          // A missed ack means the connection is a zombie: it looks open and
          // delivers nothing. Dropping it is the only way back.
          if (!this.acked) { this.log('gateway: no heartbeat ack, dropping the connection'); try { this.socket.close(4000); } catch { /* closing anyway */ } return; }
          this.acked = false;
          this.send(OP.HEARTBEAT, this.sequence);
        }, payload.d.heartbeat_interval);
        this.heartbeat.unref?.();

        if (resuming && this.sessionId) {
          this.send(OP.RESUME, { token: this.token, session_id: this.sessionId, seq: this.sequence });
        } else {
          this.send(OP.IDENTIFY, {
            token: this.token,
            intents: INTENTS,
            properties: { os: 'linux', browser: 'leap-andy', device: 'leap-andy' },
            presence: { status: 'online', activities: [{ name: 'the creator library', type: 3 }] },
          });
        }
        return;
      }
      case OP.HEARTBEAT: this.send(OP.HEARTBEAT, this.sequence); return;
      case OP.HEARTBEAT_ACK: this.acked = true; return;
      case OP.RECONNECT: try { this.socket.close(4000); } catch { /* closing anyway */ } return;
      case OP.INVALID_SESSION:
        this.sessionId = null;
        setTimeout(() => this.connect(false), 2000);
        return;
      case OP.DISPATCH: break;
      default: return;
    }

    if (payload.t === 'READY') {
      this.sessionId = payload.d.session_id;
      this.resumeUrl = payload.d.resume_gateway_url;
      this.userId = payload.d.user?.id ?? null;
      this.backoff = 1000;
      this.ready = true;
      this.log(`gateway: ready as ${payload.d.user?.username} (${this.userId})`);
      return;
    }
    if (payload.t === 'RESUMED') { this.backoff = 1000; this.ready = true; this.log('gateway: resumed'); return; }
    if (payload.t === 'MESSAGE_CREATE') this.handleMessage(payload.d);
  }

  handleMessage(message) {
    if (!this.userId) return;
    if (message.author?.bot) return;                       // never answer another bot, or itself
    if (this.allowed.size && !this.allowed.has(message.channel_id) && !this.allowed.has(message.parent_id ?? '')) return;

    const mentioned = (message.mentions ?? []).some((u) => u.id === this.userId);
    // A reply to one of Andy's own messages counts as talking to Andy, which is
    // how a follow-up in a thread reads to a human.
    const repliedTo = message.referenced_message?.author?.id === this.userId;
    if (!mentioned && !repliedTo) return;

    const text = String(message.content ?? '')
      .replace(new RegExp(`<@!?${this.userId}>`, 'g'), '')
      .trim();

    if (!text) {
      // Almost always the privileged intent being off rather than an empty ping.
      this.log('gateway: a mention arrived with no readable content — check the Message Content Intent');
      return;
    }

    Promise.resolve(this.onMention({ ...message, question: text }))
      .catch((err) => this.log(`gateway: handling a mention failed — ${err.message}`));
  }
}
