// This is the Edge Chat Demo Worker, built using Durable Objects!
//
// This version adds a minimal direct-message (1:1) feature on top of the original room chat,
// implemented as a new Durable Object class, UserMailbox. See the comment above UserMailbox
// for details on how it works and what's deliberately left out for now.

import HTML from "./chat.html";
import DMHTML from "./dm.html";

// `handleErrors()` is a little utility function that can wrap an HTTP request handler in a
// try/catch and return errors to the client. You probably wouldn't want to use this in production
// code but it is convenient when debugging and iterating.
async function handleErrors(request, func) {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {
      // Annoyingly, if we return an HTTP error in response to a WebSocket request, Chrome devtools
      // won't show us the response body! So... let's send a WebSocket response with an error
      // frame instead.
      let pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({error: err.stack}));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err.stack, {status: 500});
    }
  }
}

export default {
  async fetch(request, env) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);
      let path = url.pathname.slice(1).split('/');

      if (!path[0]) {
        // Serve the original room-chat demo at the root path.
        return new Response(HTML, {headers: {"Content-Type": "text/html;charset=UTF-8"}});
      }

      switch (path[0]) {
        case "dm":
          // Serve the minimal direct-message test page.
          return new Response(DMHTML, {headers: {"Content-Type": "text/html;charset=UTF-8"}});

        case "api":
          return handleApiRequest(path.slice(1), request, env);

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }
}

async function handleApiRequest(path, request, env) {
  switch (path[0]) {
    case "room": {
      // Request for `/api/room/...`. (Unchanged from the original demo.)

      if (!path[1]) {
        if (request.method == "POST") {
          let id = env.rooms.newUniqueId();
          return new Response(id.toString(), {headers: {"Access-Control-Allow-Origin": "*"}});
        } else {
          return new Response("Method not allowed", {status: 405});
        }
      }

      let name = path[1];
      let id;
      if (name.match(/^[0-9a-f]{64}$/)) {
        id = env.rooms.idFromString(name);
      } else if (name.length <= 32) {
        id = env.rooms.idFromName(name);
      } else {
        return new Response("Name too long", {status: 404});
      }

      let roomObject = env.rooms.get(id);
      let newUrl = new URL(request.url);
      newUrl.pathname = "/" + path.slice(2).join("/");
      return roomObject.fetch(newUrl, request);
    }

    case "user": {
      // Request for `/api/user/<id>/...`. This is the new direct-message routing.
      //
      // NOTE ON IDENTITY: just like the room demo's chat "name", <id> here is claimed by the
      // client and is NOT authenticated. Anyone who connects as "alice" is trusted to be alice.
      // That's fine for this minimal version, but before using this for real, you'd want to
      // replace this with a verified user id (e.g. from a signed session token) before it ever
      // reaches this routing step.

      if (!path[1]) {
        return new Response("Missing user id", {status: 404});
      }

      let name = path[1];
      if (name.length == 0 || name.length > 32) {
        return new Response("Invalid user id", {status: 404});
      }

      // Every distinct name maps deterministically to the same Durable Object instance, which
      // acts as that user's personal "mailbox" -- holding their live connections and their
      // message history.
      let id = env.users.idFromName(name);
      let userObject = env.users.get(id);

      // Forward the request to the mailbox object, passing the claimed identity along via a
      // query parameter so the object knows which mailbox it's acting as.
      let newUrl = new URL(request.url);
      newUrl.pathname = "/" + path.slice(2).join("/");
      newUrl.searchParams.set("self", name);
      return userObject.fetch(newUrl, request);
    }

    default:
      return new Response("Not found", {status: 404});
  }
}

// =======================================================================================
// The ChatRoom Durable Object Class (unchanged from the original demo).

export class ChatRoom {
  constructor(state, env) {
    this.state = state
    this.storage = state.storage;
    this.env = env;
    this.sessions = new Map();
    this.state.getWebSockets().forEach((webSocket) => {
      let meta = webSocket.deserializeAttachment();
      let limiterId = this.env.limiters.idFromString(meta.limiterId);
      let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack));
      let blockedMessages = [];
      this.sessions.set(webSocket, { ...meta, limiter, blockedMessages });
    });
    this.lastTimestamp = 0;
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/websocket": {
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("expected websocket", {status: 400});
          }
          let ip = request.headers.get("CF-Connecting-IP");
          let pair = new WebSocketPair();
          await this.handleSession(pair[1], ip);
          return new Response(null, { status: 101, webSocket: pair[0] });
        }

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }

  async handleSession(webSocket, ip) {
    this.state.acceptWebSocket(webSocket);

    let limiterId = this.env.limiters.idFromName(ip);
    let limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack));

    let session = { limiterId, limiter, blockedMessages: [] };
    webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), limiterId: limiterId.toString() });
    this.sessions.set(webSocket, session);

    for (let otherSession of this.sessions.values()) {
      if (otherSession.name) {
        session.blockedMessages.push(JSON.stringify({joined: otherSession.name}));
      }
    }

    let storage = await this.storage.list({reverse: true, limit: 100});
    let backlog = [...storage.values()];
    backlog.reverse();
    backlog.forEach(value => {
      session.blockedMessages.push(value);
    });
  }

  async webSocketMessage(webSocket, msg) {
    try {
      let session = this.sessions.get(webSocket);
      if (session.quit) {
        webSocket.close(1011, "WebSocket broken.");
        return;
      }

      if (!session.limiter.checkLimit()) {
        webSocket.send(JSON.stringify({
          error: "Your IP is being rate-limited, please try again later."
        }));
        return;
      }

      let data = JSON.parse(msg);

      if (!session.name) {
        session.name = "" + (data.name || "anonymous");
        webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), name: session.name });

        if (session.name.length > 32) {
          webSocket.send(JSON.stringify({error: "Name too long."}));
          webSocket.close(1009, "Name too long.");
          return;
        }

        session.blockedMessages.forEach(queued => {
          webSocket.send(queued);
        });
        delete session.blockedMessages;

        this.broadcast({joined: session.name});
        webSocket.send(JSON.stringify({ready: true}));
        return;
      }

      data = { name: session.name, message: "" + data.message };

      if (data.message.length > 256) {
        webSocket.send(JSON.stringify({error: "Message too long."}));
        return;
      }

      data.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
      this.lastTimestamp = data.timestamp;

      let dataStr = JSON.stringify(data);
      this.broadcast(dataStr);

      let key = new Date(data.timestamp).toISOString();
      await this.storage.put(key, dataStr);
    } catch (err) {
      webSocket.send(JSON.stringify({error: err.stack}));
    }
  }

  async closeOrErrorHandler(webSocket) {
    let session = this.sessions.get(webSocket) || {};
    session.quit = true;
    this.sessions.delete(webSocket);
    if (session.name) {
      this.broadcast({quit: session.name});
    }
  }

  async webSocketClose(webSocket, code, reason, wasClean) {
    this.closeOrErrorHandler(webSocket)
  }

  async webSocketError(webSocket, error) {
    this.closeOrErrorHandler(webSocket)
  }

  broadcast(message) {
    if (typeof message !== "string") {
      message = JSON.stringify(message);
    }

    let quitters = [];
    this.sessions.forEach((session, webSocket) => {
      if (session.name) {
        try {
          webSocket.send(message);
        } catch (err) {
          session.quit = true;
          quitters.push(session);
          this.sessions.delete(webSocket);
        }
      } else {
        session.blockedMessages.push(message);
      }
    });

    quitters.forEach(quitter => {
      if (quitter.name) {
        this.broadcast({quit: quitter.name});
      }
    });
  }
}

// ---------------------------------------------------------------------------------------
// Small helpers for password hashing (PBKDF2) and storing binary data in Durable Object
// storage (which is happiest with strings/JSON, so we base64-encode raw bytes).

function toBase64(bytes) {
  let binary = "";
  for (let b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(str) {
  let binary = atob(str);
  let bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// PBKDF2 with a random salt and a healthy iteration count. Much better than storing a raw
// SHA-256 of the password, though for a production system you'd still want to consider a
// dedicated password-hashing function (scrypt/argon2) via a library, since Workers' built-in
// crypto.subtle only gives us PBKDF2/HMAC-based KDFs.
async function hashPassword(password, saltBytes) {
  let enc = new TextEncoder();
  let keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password), {name: "PBKDF2"}, false, ["deriveBits"]);
  let bits = await crypto.subtle.deriveBits(
    {name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256"},
    keyMaterial, 256);
  return new Uint8Array(bits);
}

// Constant-time comparison, so responses don't leak hash-matching info via timing.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}

// Constants for login-attempt lockout: after LOGIN_LOCKOUT_THRESHOLD consecutive failed
// attempts, the account is locked out for a period that doubles each additional failure,
// up to LOGIN_LOCKOUT_MAX_MS. This makes password guessing impractical without needing any
// separate rate-limiting infrastructure.
const LOGIN_LOCKOUT_THRESHOLD = 5;
const LOGIN_LOCKOUT_BASE_MS = 30 * 1000;       // 30 seconds
const LOGIN_LOCKOUT_MAX_MS = 15 * 60 * 1000;   // 15 minutes

// =======================================================================================
// The UserMailbox Durable Object Class (new).
//
// One instance of this class exists per user, addressed via env.users.idFromName(userId).
// It plays the same role for a single user that ChatRoom plays for a whole room: it holds
// the live WebSocket sessions for that user (they might have several devices connected) and
// the durable history of messages sent to them. It now also stores that user's account
// (password hash) and issues session tokens, since it's already the natural place to keep
// anything keyed by username.
//
// Account flow:
//   1. POST /api/user/alice/signup {password} creates the account, storing a PBKDF2 hash +
//      random salt (never the plaintext password). Fails with 409 if alice already exists.
//   2. POST /api/user/alice/login {password} checks the password and, if correct, issues a
//      bearer token (a random UUID) good for 24 hours, stored in this object's own storage.
//   3. The client opens /api/user/alice/websocket?token=<token>. The object checks the token
//      is valid and unexpired before accepting the WebSocket upgrade.
//
// Direct-message delivery works like this:
//   1. Alice's client opens an authenticated WebSocket to her own UserMailbox instance.
//   2. Alice's client sends {to: "bob", message: "hi"} over that socket.
//   3. Alice's UserMailbox instance (a) stores + echoes the message back to Alice's own
//      connected sessions (so her other devices/tabs see the sent message), tagging it with
//      her verified username, and (b) makes an HTTP fetch() call to Bob's UserMailbox
//      instance's internal /deliver endpoint.
//   4. Bob's UserMailbox instance stores the message and pushes it to Bob's connected
//      sessions. If Bob isn't connected right now, it's just sitting in his storage, ready
//      to be sent as backlog next time he connects -- same pattern as ChatRoom's history
//      replay.
//
// Deliberately NOT included yet (see the parent conversation's plan for follow-ups):
//   - Password reset / account recovery
//   - Contact lists / discovery of valid user ids
//   - Blocking, read receipts, typing indicators, group DMs
//   - Session revocation / logout endpoint (tokens just expire after 24h)
//   - Rate limiting on signup (an attacker could still hammer /signup to enumerate which
//     usernames are taken, or spam-create accounts; login is the endpoint that matters most
//     since it's the one that lets someone brute-force a password, so that's covered below)
export class UserMailbox {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.sessions = new Map();
    this.state.getWebSockets().forEach((webSocket) => {
      let meta = webSocket.deserializeAttachment();
      this.sessions.set(webSocket, { ...meta });
    });
    this.lastTimestamp = 0;
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/signup": {
          if (request.method != "POST") {
            return new Response("Method not allowed", {status: 405});
          }
          let selfId = url.searchParams.get("self");
          if (!selfId) {
            return new Response("Missing self id", {status: 400});
          }

          let body = await request.json();
          let password = "" + (body.password || "");
          if (password.length < 6 || password.length > 256) {
            return new Response("Password must be 6-256 characters.", {status: 400});
          }

          let existing = await this.storage.get("_account");
          if (existing) {
            return new Response("That username is already taken.", {status: 409});
          }

          let salt = crypto.getRandomValues(new Uint8Array(16));
          let hash = await hashPassword(password, salt);
          await this.storage.put("_account", {
            username: selfId,
            salt: toBase64(salt),
            hash: toBase64(hash),
          });
          return new Response("ok");
        }

        case "/login": {
          if (request.method != "POST") {
            return new Response("Method not allowed", {status: 405});
          }

          let account = await this.storage.get("_account");
          if (!account) {
            return new Response("No account with that username.", {status: 404});
          }

          // Check whether this account is currently locked out from too many recent failed
          // attempts, before even looking at the submitted password.
          let lockout = await this.storage.get("_login_lockout") || {failedCount: 0, lockedUntil: 0};
          if (Date.now() < lockout.lockedUntil) {
            let retryAfterSeconds = Math.ceil((lockout.lockedUntil - Date.now()) / 1000);
            return new Response(
              "Too many failed login attempts. Try again in " + retryAfterSeconds + " seconds.",
              {status: 429, headers: {"Retry-After": "" + retryAfterSeconds}});
          }

          let body = await request.json();
          let password = "" + (body.password || "");

          let salt = fromBase64(account.salt);
          let expectedHash = fromBase64(account.hash);
          let actualHash = await hashPassword(password, salt);

          if (!timingSafeEqual(actualHash, expectedHash)) {
            // Wrong password: record the failure, and once we cross the threshold, lock the
            // account out for a period that grows the longer this keeps happening.
            lockout.failedCount += 1;
            if (lockout.failedCount >= LOGIN_LOCKOUT_THRESHOLD) {
              let extra = lockout.failedCount - LOGIN_LOCKOUT_THRESHOLD;
              let lockoutMs = Math.min(
                LOGIN_LOCKOUT_BASE_MS * Math.pow(2, extra), LOGIN_LOCKOUT_MAX_MS);
              lockout.lockedUntil = Date.now() + lockoutMs;
            }
            await this.storage.put("_login_lockout", lockout);
            return new Response("Incorrect password.", {status: 401});
          }

          // Correct password: clear any lockout history and issue a fresh session token.
          await this.storage.delete("_login_lockout");

          let token = crypto.randomUUID();
          let expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
          await this.storage.put("_session:" + token, {expiresAt});

          return new Response(JSON.stringify({token}), {
            headers: {"Content-Type": "application/json"},
          });
        }

        case "/websocket": {
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("expected websocket", {status: 400});
          }

          // The routing worker tells us which mailbox we're acting as via ?self=<name>.
          let selfId = url.searchParams.get("self");
          if (!selfId) {
            return new Response("Missing self id", {status: 400});
          }

          let account = await this.storage.get("_account");
          if (!account) {
            return new Response("No account exists for this user id. Sign up first.", {status: 401});
          }

          let token = url.searchParams.get("token");
          if (!token) {
            return new Response("Missing token. Log in first.", {status: 401});
          }
          let session = await this.storage.get("_session:" + token);
          if (!session || session.expiresAt < Date.now()) {
            return new Response("Invalid or expired token. Log in again.", {status: 401});
          }

          let pair = new WebSocketPair();
          await this.handleSession(pair[1], selfId);
          return new Response(null, { status: 101, webSocket: pair[0] });
        }

        case "/deliver": {
          // Internal endpoint: another UserMailbox instance calls this to hand us a message
          // addressed to our user. Not intended to be reachable directly from outside the
          // Worker (there's no public route to it), but it also does nothing dangerous if it
          // were -- it just appends a message to this mailbox.
          if (request.method != "POST") {
            return new Response("Method not allowed", {status: 405});
          }
          let data = await request.json();
          await this.deliver(data);
          return new Response("ok");
        }

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }

  async handleSession(webSocket, selfId) {
    this.state.acceptWebSocket(webSocket);

    let session = { selfId, blockedMessages: [] };
    webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), selfId });
    this.sessions.set(webSocket, session);

    // Send this user's recent message history (sent and received) so a freshly connected
    // client is caught up, same as ChatRoom's backlog replay.
    let storage = await this.storage.list({reverse: true, limit: 100});
    let backlog = [...storage.values()];
    backlog.reverse();
    backlog.forEach(value => session.blockedMessages.push(value));

    session.blockedMessages.forEach(queued => webSocket.send(queued));
    delete session.blockedMessages;

    webSocket.send(JSON.stringify({ready: true}));
  }

  async webSocketMessage(webSocket, msg) {
    try {
      let session = this.sessions.get(webSocket);
      if (session.quit) {
        webSocket.close(1011, "WebSocket broken.");
        return;
      }

      let data = JSON.parse(msg);
      let to = "" + (data.to || "");
      let message = "" + (data.message || "");

      if (!to) {
        webSocket.send(JSON.stringify({error: "Missing 'to' field."}));
        return;
      }
      if (to.length > 32) {
        webSocket.send(JSON.stringify({error: "Recipient id too long."}));
        return;
      }
      if (message.length == 0 || message.length > 1000) {
        webSocket.send(JSON.stringify({error: "Message must be 1-1000 characters."}));
        return;
      }

      this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
      let outgoing = {
        from: session.selfId,
        to,
        message,
        timestamp: this.lastTimestamp,
      };
      let dataStr = JSON.stringify(outgoing);

      // Store + echo to the sender's own connected sessions (so other tabs/devices of theirs
      // see the sent message too), keyed so it sorts correctly alongside received messages.
      let key = new Date(outgoing.timestamp).toISOString() + "-out";
      await this.storage.put(key, dataStr);
      this.pushToSessions(dataStr);

      // Hand the message off to the recipient's mailbox instance. This is a plain Worker-to-
      // Durable-Object fetch() call; it isn't visible to any other client.
      let recipientId = this.env.users.idFromName(to);
      let recipient = this.env.users.get(recipientId);
      let response = await recipient.fetch("https://dummy-url/deliver", {
        method: "POST",
        body: dataStr,
      });

      if (!response.ok) {
        webSocket.send(JSON.stringify({error: "Delivery failed: " + (await response.text())}));
      }
    } catch (err) {
      webSocket.send(JSON.stringify({error: err.stack}));
    }
  }

  // Called (via /deliver) by the sender's mailbox instance to hand us an incoming message.
  async deliver(data) {
    let dataStr = JSON.stringify(data);
    let key = new Date(data.timestamp).toISOString() + "-in";
    await this.storage.put(key, dataStr);
    this.pushToSessions(dataStr);
  }

  // Send a message to all of this user's currently-connected sessions (their own devices/tabs).
  pushToSessions(dataStr) {
    let quitters = [];
    this.sessions.forEach((session, webSocket) => {
      try {
        webSocket.send(dataStr);
      } catch (err) {
        session.quit = true;
        quitters.push(webSocket);
      }
    });
    quitters.forEach(ws => this.sessions.delete(ws));
  }

  async webSocketClose(webSocket) {
    let session = this.sessions.get(webSocket) || {};
    session.quit = true;
    this.sessions.delete(webSocket);
  }

  async webSocketError(webSocket) {
    let session = this.sessions.get(webSocket) || {};
    session.quit = true;
    this.sessions.delete(webSocket);
  }
}

// =======================================================================================
// The RateLimiter Durable Object class (unchanged from the original demo).
// Note: UserMailbox does not use this yet -- see the class comment above.

export class RateLimiter {
  constructor(state, env) {
    this.nextAllowedTime = 0;
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let now = Date.now() / 1000;
      this.nextAllowedTime = Math.max(now, this.nextAllowedTime);

      if (request.method == "POST") {
        this.nextAllowedTime += 5;
      }

      let cooldown = Math.max(0, this.nextAllowedTime - now - 20);
      return new Response(cooldown);
    })
  }
}

class RateLimiterClient {
  constructor(getLimiterStub, reportError) {
    this.getLimiterStub = getLimiterStub;
    this.reportError = reportError;
    this.limiter = getLimiterStub();
    this.inCooldown = false;
  }

  checkLimit() {
    if (this.inCooldown) {
      return false;
    }
    this.inCooldown = true;
    this.callLimiter();
    return true;
  }

  async callLimiter() {
    try {
      let response;
      try {
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      } catch (err) {
        this.limiter = this.getLimiterStub();
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      }

      let cooldown = +(await response.text());
      await new Promise(resolve => setTimeout(resolve, cooldown * 1000));
      this.inCooldown = false;
    } catch (err) {
      this.reportError(err);
    }
  }
}
