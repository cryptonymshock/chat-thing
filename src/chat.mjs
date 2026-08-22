// This is the Edge Chat Demo Worker, built using Durable Objects!
//
// This version adds:
//   - a direct-message (1:1) feature, implemented as the UserMailbox Durable Object class
//   - a group-chat feature, implemented as the GroupChat Durable Object class
//   - delivery-status tracking ("Sent" / "Delivered") for both DMs and group messages
//
// See the comments above UserMailbox and GroupChat for details on how each works.

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
          // Serve the direct-message / group-chat page.
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
      // Request for `/api/user/<id>/...`. Direct-message routing.
      //
      // NOTE ON IDENTITY: just like the room demo's chat "name", <id> here is claimed by the
      // client and is NOT authenticated at the routing layer -- each mailbox sub-endpoint does
      // its own password/token checks (see UserMailbox below). Before using this for real,
      // you'd also want to put a verified session (e.g. a signed cookie) in front of this
      // routing step itself.

      if (!path[1]) {
        return new Response("Missing user id", {status: 404});
      }

      let name = path[1];
      if (name.length == 0 || name.length > 32) {
        return new Response("Invalid user id", {status: 404});
      }

      // Every distinct name maps deterministically to the same Durable Object instance, which
      // acts as that user's personal "mailbox" -- holding their live connections, their message
      // history, their account, and their conversation list (DMs and groups).
      let id = env.users.idFromName(name);
      let userObject = env.users.get(id);

      // Forward the request to the mailbox object, passing the claimed identity along via a
      // query parameter so the object knows which mailbox it's acting as.
      let newUrl = new URL(request.url);
      newUrl.pathname = "/" + path.slice(2).join("/");
      newUrl.searchParams.set("self", name);
      return userObject.fetch(newUrl, request);
    }

    case "group": {
      // Request for `/api/group`. Currently only group creation is exposed publicly; sending
      // messages to a group happens over a member's own /api/user/<id>/websocket connection
      // (see UserMailbox.handleGroupSend), not via a direct route to the group here.

      if (!path[1]) {
        if (request.method != "POST") {
          return new Response("Method not allowed", {status: 405});
        }

        let body = await request.json();
        let creator = ("" + (body.creator || "")).trim();
        let token = "" + (body.token || "");
        if (!creator || !token) {
          return new Response("Missing creator or token.", {status: 400});
        }

        // Verify the creator's session token against their own mailbox before letting them
        // spin up a group "as" that identity.
        let creatorObject = env.users.get(env.users.idFromName(creator));
        let verifyResponse = await creatorObject.fetch("https://dummy-url/verify", {
          method: "POST",
          body: JSON.stringify({token}),
        });
        let verifyBody = await verifyResponse.json().catch(() => ({valid: false}));
        if (!verifyResponse.ok || !verifyBody.valid) {
          return new Response("Invalid session. Please log in again.", {status: 401});
        }

        let name = "" + (body.name || "New Group");
        if (name.length > 64) {
          return new Response("Group name must be 64 characters or fewer.", {status: 400});
        }

        let members = Array.isArray(body.members)
          ? body.members.map(m => ("" + m).trim()).filter(m => m.length > 0 && m.length <= 32)
          : [];
        if (members.length === 0) {
          return new Response("Add at least one other member.", {status: 400});
        }

        // A fresh Durable Object instance for this group. Its own generated id becomes the
        // group's id (analogous to how private rooms work in the original room-chat demo).
        let groupObject = env.groups.get(env.groups.newUniqueId());
        let createResponse = await groupObject.fetch("https://dummy-url/create", {
          method: "POST",
          body: JSON.stringify({name, members, creator}),
        });

        if (!createResponse.ok) {
          return new Response(await createResponse.text(), {status: createResponse.status});
        }

        let result = await createResponse.json();
        return new Response(JSON.stringify(result), {
          headers: {"Content-Type": "application/json"},
        });
      }

      return new Response("Not found", {status: 404});
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
// The UserMailbox Durable Object Class.
//
// One instance of this class exists per user, addressed via env.users.idFromName(userId).
// It holds the live WebSocket sessions for that user (they might have several devices
// connected), the durable history of messages sent to and from them, their account (password
// hash), their session tokens, and a summary of each of their conversations (DMs and groups)
// so the client can populate a sidebar without replaying the full message history.
//
// Account flow:
//   1. POST /api/user/alice/signup {password} creates the account, storing a PBKDF2 hash +
//      random salt (never the plaintext password). Fails with 409 if alice already exists.
//   2. POST /api/user/alice/login {password} checks the password and, if correct, issues a
//      bearer token (a random UUID) good for 24 hours, stored in this object's own storage.
//   3. The client opens /api/user/alice/websocket?token=<token>. The object checks the token
//      is valid and unexpired before accepting the WebSocket upgrade.
//   4. GET /api/user/alice/conversations?token=<token> returns the saved conversation summaries
//      (one per DM peer or group) so the client can render a sidebar immediately on load.
//
// Internal endpoints (called Durable-Object-to-Durable-Object, never routed to directly from
// outside the Worker):
//   - POST /verify {token}: used by the group-creation flow to check a caller's session before
//     letting them create a group "as" that identity.
//   - POST /deliver: another UserMailbox instance (for a DM) or a GroupChat instance (for a
//     group message) hands us a message addressed to our user. Stores it, pushes it to any of
//     our connected sessions, and reports back whether we were actually online to receive it
//     right now (this is what powers the "Delivered" vs "Sent" status on the sender's side).
//   - POST /join-group: a GroupChat instance notifies us that our user was just added to a new
//     group, so we can save a conversation summary for it and push a live update to our
//     connected sessions.
//
// Direct-message delivery works like this:
//   1. Alice's client opens an authenticated WebSocket to her own UserMailbox instance.
//   2. Alice's client sends {to: "bob", message: "hi"} over that socket.
//   3. Alice's UserMailbox instance calls Bob's UserMailbox instance's /deliver endpoint
//      *first*, so it learns synchronously whether Bob was online to receive it.
//   4. Alice's instance then stores + echoes the message back to her own connected sessions
//      (so her other devices/tabs see the sent message too), tagging it with a `delivered`
//      flag reflecting step 3.
//   5. Bob's UserMailbox instance stores the message and pushes it to Bob's connected sessions.
//      If Bob isn't connected right now, it's just sitting in his storage, ready to be sent as
//      backlog next time he connects -- same pattern as ChatRoom's history replay.
//
// Group-message delivery works the same way but is orchestrated by the GroupChat instance
// (see the GroupChat class below) rather than directly between two mailboxes, since there can
// be more than one recipient.
//
// Deliberately NOT included yet (see the parent conversation's plan for follow-ups):
//   - Password reset / account recovery
//   - Contact lists / discovery of valid user ids
//   - Blocking, read receipts, typing indicators
//   - "Delivered later" updates: if a recipient is offline when a message is sent, the sender
//     sees "Sent" and that status never flips to "Delivered" once the recipient later comes
//     online and receives the backlog. Doing that properly would need a receipt sent back to
//     the *original* sender's mailbox after backlog replay, which is a nice follow-up.
//   - Removing/leaving a group, or adding members after creation
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

        case "/verify": {
          // Internal: lets another part of the Worker (currently, the group-creation flow)
          // confirm that a bearer token is currently valid for this mailbox.
          if (request.method != "POST") {
            return new Response("Method not allowed", {status: 405});
          }
          let body = await request.json();
          let token = "" + (body.token || "");
          let valid = false;
          if (token) {
            let session = await this.storage.get("_session:" + token);
            valid = !!session && session.expiresAt > Date.now();
          }
          return new Response(JSON.stringify({valid}), {
            headers: {"Content-Type": "application/json"},
          });
        }

        case "/conversations": {
          if (request.method != "GET") {
            return new Response("Method not allowed", {status: 405});
          }
          let token = url.searchParams.get("token");
          if (!token) {
            return new Response("Missing token. Log in first.", {status: 401});
          }
          let session = await this.storage.get("_session:" + token);
          if (!session || session.expiresAt < Date.now()) {
            return new Response("Invalid or expired token. Log in again.", {status: 401});
          }

          let list = await this.storage.list({prefix: "_conv:"});
          let conversations = [...list.values()];
          conversations.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

          return new Response(JSON.stringify({conversations}), {
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
          // Internal endpoint: another UserMailbox instance (DM) or a GroupChat instance
          // (group message) calls this to hand us a message addressed to our user. Not
          // intended to be reachable directly from outside the Worker (there's no public
          // route to it), but it also does nothing dangerous if it were -- it just appends a
          // message to this mailbox and reports whether we were online to receive it.
          if (request.method != "POST") {
            return new Response("Method not allowed", {status: 405});
          }
          let data = await request.json();
          let delivered = await this.deliver(data);
          return new Response(JSON.stringify({ok: true, delivered}), {
            headers: {"Content-Type": "application/json"},
          });
        }

        case "/join-group": {
          // Internal endpoint: a GroupChat instance calls this right after creation to let
          // each member's mailbox know it now belongs to that group, so a conversation summary
          // shows up in their sidebar even before any messages have been sent.
          if (request.method != "POST") {
            return new Response("Method not allowed", {status: 405});
          }
          let meta = await request.json(); // {id, name, members, creator}
          await this.touchConversation("group", meta.id, meta.name, null, null, Date.now(), meta.members);
          this.pushToSessions(JSON.stringify({
            groupJoined: {id: meta.id, name: meta.name, members: meta.members},
          }));
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
    // client is caught up, same as ChatRoom's backlog replay. (Conversation _summaries_ are
    // fetched separately via GET /conversations before the socket even opens.) Message keys
    // all share the "msg:" prefix (see touchConversation's siblings below) precisely so this
    // listing can't accidentally pick up _account/_session/_conv metadata instead of actual
    // messages once a user has enough conversations for those keys to crowd the tail of a
    // plain reverse-sorted listing.
    let storage = await this.storage.list({prefix: "msg:", reverse: true, limit: 100});
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

      if (data.groupId) {
        await this.handleGroupSend(webSocket, session, data);
      } else {
        await this.handleDirectSend(webSocket, session, data);
      }
    } catch (err) {
      webSocket.send(JSON.stringify({error: err.stack}));
    }
  }

  // Handles {to, message} sent over our own socket -- a direct message from us to `to`.
  async handleDirectSend(webSocket, session, data) {
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
    let core = {
      id: crypto.randomUUID(),
      from: session.selfId,
      to,
      message,
      timestamp: this.lastTimestamp,
    };

    // Hand the message off to the recipient's mailbox instance *first*, so we can learn
    // synchronously whether they were online to receive it right now, and reflect that in the
    // "Sent"/"Delivered" status we echo back to ourselves below.
    let delivered = false;
    try {
      let recipientId = this.env.users.idFromName(to);
      let recipient = this.env.users.get(recipientId);
      let response = await recipient.fetch("https://dummy-url/deliver", {
        method: "POST",
        body: JSON.stringify(core),
      });
      if (response.ok) {
        let body = await response.json();
        delivered = !!body.delivered;
      } else {
        webSocket.send(JSON.stringify({error: "Delivery failed: " + (await response.text())}));
      }
    } catch (err) {
      webSocket.send(JSON.stringify({error: "Delivery failed: " + err}));
    }

    let outgoing = { ...core, delivered };
    let dataStr = JSON.stringify(outgoing);

    // Store + echo to the sender's own connected sessions (so other tabs/devices of theirs
    // see the sent message, with its delivery status, too), keyed so it sorts correctly
    // alongside received messages.
    let key = "msg:" + new Date(core.timestamp).toISOString() + "-out";
    await this.storage.put(key, dataStr);
    await this.touchConversation("dm", to, to, message, session.selfId, core.timestamp);
    this.pushToSessions(dataStr);
  }

  // Handles {groupId, message} sent over our own socket -- a group message from us.
  async handleGroupSend(webSocket, session, data) {
    let groupId = "" + (data.groupId || "");
    let message = "" + (data.message || "");

    if (message.length == 0 || message.length > 1000) {
      webSocket.send(JSON.stringify({error: "Message must be 1-1000 characters."}));
      return;
    }

    let groupObject;
    try {
      groupObject = this.env.groups.get(this.env.groups.idFromString(groupId));
    } catch (err) {
      webSocket.send(JSON.stringify({error: "Invalid group id."}));
      return;
    }

    // The GroupChat instance owns message ordering and fan-out to every other member; it
    // hands back the fully-formed message (with a server-assigned id/timestamp) plus how many
    // of the other members were online to receive it just now.
    let response = await groupObject.fetch("https://dummy-url/send", {
      method: "POST",
      body: JSON.stringify({from: session.selfId, message}),
    });

    if (!response.ok) {
      webSocket.send(JSON.stringify({error: "Failed to send to group: " + (await response.text())}));
      return;
    }

    let result = await response.json();
    let dataStr = JSON.stringify(result);

    let key = "msg:" + new Date(result.timestamp).toISOString() + "-out";
    await this.storage.put(key, dataStr);
    await this.touchConversation(
      "group", result.groupId, result.groupName, result.message, result.from, result.timestamp);
    this.pushToSessions(dataStr);
  }

  // Called (via /deliver) by another mailbox (DM) or a GroupChat instance (group message) to
  // hand us an incoming message. Returns whether we were online to receive it right now.
  async deliver(data) {
    let dataStr = JSON.stringify(data);
    let key = "msg:" + new Date(data.timestamp).toISOString() + "-in";
    await this.storage.put(key, dataStr);

    if (data.groupId) {
      await this.touchConversation("group", data.groupId, data.groupName, data.message, data.from, data.timestamp);
    } else {
      await this.touchConversation("dm", data.from, data.from, data.message, data.from, data.timestamp);
    }

    let deliveredCount = this.pushToSessions(dataStr);
    return deliveredCount > 0;
  }

  // Saves/updates the sidebar summary for one conversation (a DM peer or a group). Preserves
  // an existing `members` list (for groups) if this particular update doesn't supply one, since
  // most calls here are just "a message happened", not "membership changed".
  async touchConversation(type, id, name, lastMessage, lastFrom, timestamp, members) {
    let key = "_conv:" + type + ":" + id;
    let value = {type, id, name, lastMessage, lastFrom, timestamp};

    let mem = members;
    if (!mem) {
      let existing = await this.storage.get(key);
      if (existing && existing.members) mem = existing.members;
    }
    if (mem) value.members = mem;

    await this.storage.put(key, value);
  }

  // Send a message to all of this user's currently-connected sessions (their own devices/tabs).
  // Returns how many sessions it was successfully sent to, which the caller uses to decide
  // whether this user counts as "online" for delivery-status purposes.
  pushToSessions(dataStr) {
    let quitters = [];
    let delivered = 0;
    this.sessions.forEach((session, webSocket) => {
      try {
        webSocket.send(dataStr);
        delivered++;
      } catch (err) {
        session.quit = true;
        quitters.push(webSocket);
      }
    });
    quitters.forEach(ws => this.sessions.delete(ws));
    return delivered;
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
// The GroupChat Durable Object Class.
//
// One instance exists per group, addressed by its own Durable-Object-generated id (there's no
// human-chosen name for a group the way there is for a user or a named public room). A group
// is created via POST /api/group (see handleApiRequest above), which spins up a fresh instance
// and calls its /create endpoint.
//
// A GroupChat instance is the source of truth for:
//   - the group's metadata: name, creator, and member list (stored once, at creation time --
//     there's deliberately no way yet to add/remove members after the fact, see the
//     UserMailbox class comment's follow-up list)
//   - message ordering: it assigns each message's timestamp and id, the same role ChatRoom's
//     `lastTimestamp` plays for a public room
//   - fan-out: on /send, it calls every *other* member's UserMailbox /deliver endpoint (the
//     sender's own mailbox already stores + echoes the message to their own sessions once this
//     call returns, so we don't deliver back to the sender here) and counts how many of them
//     were online to receive it, which becomes the "Delivered to N/M" status shown to the
//     sender.
//
// A GroupChat instance does NOT hold any live WebSocket connections itself -- group messages
// are always sent and received over each member's own personal mailbox connection, the same
// connection they use for DMs. This keeps the client's networking code (and reconnect logic)
// entirely uniform between DMs and groups; GroupChat is purely a coordination + fan-out object,
// the same role RateLimiter plays elsewhere in this file, just with durable storage of its own.
export class GroupChat {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.lastTimestamp = 0;
  }

  async fetch(request) {
    return await handleErrors(request, async () => {
      let url = new URL(request.url);

      switch (url.pathname) {
        case "/create": {
          if (request.method != "POST") {
            return new Response("Method not allowed", {status: 405});
          }

          let body = await request.json();
          let creator = "" + (body.creator || "");
          let name = ("" + (body.name || "New Group")).slice(0, 64);

          let requested = Array.isArray(body.members) ? body.members : [];
          let members = Array.from(new Set(
            [creator, ...requested.map(m => ("" + m).trim())].filter(Boolean)));

          if (members.length < 2) {
            return new Response("A group needs at least one other member.", {status: 400});
          }
          if (members.length > 50) {
            return new Response("Groups are limited to 50 members.", {status: 400});
          }

          let meta = {id: this.state.id.toString(), name, creator, members};
          await this.storage.put("_meta", meta);

          // Let every member's mailbox know about the new group so it shows up in their
          // sidebar right away, even before any message has been sent. Best-effort: if one
          // member's mailbox can't be reached, the group still exists and they'll pick it up
          // the first time a message is delivered to them.
          await Promise.all(members.map(async member => {
            try {
              let stub = this.env.users.get(this.env.users.idFromName(member));
              await stub.fetch("https://dummy-url/join-group", {
                method: "POST",
                body: JSON.stringify(meta),
              });
            } catch (err) {
              // Best-effort, see comment above.
            }
          }));

          return new Response(JSON.stringify(meta), {
            headers: {"Content-Type": "application/json"},
          });
        }

        case "/send": {
          if (request.method != "POST") {
            return new Response("Method not allowed", {status: 405});
          }

          let meta = await this.storage.get("_meta");
          if (!meta) {
            return new Response("Group not found.", {status: 404});
          }

          let body = await request.json();
          let from = "" + (body.from || "");
          let message = "" + (body.message || "");

          if (!meta.members.includes(from)) {
            return new Response("Not a member of this group.", {status: 403});
          }
          if (message.length == 0 || message.length > 1000) {
            return new Response("Message must be 1-1000 characters.", {status: 400});
          }

          this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
          let outgoing = {
            id: crypto.randomUUID(),
            groupId: meta.id,
            groupName: meta.name,
            from,
            message,
            timestamp: this.lastTimestamp,
          };
          let dataStr = JSON.stringify(outgoing);

          let key = "msg:" + new Date(outgoing.timestamp).toISOString();
          await this.storage.put(key, dataStr);

          // Fan out to every member except the sender (their own mailbox handles storing +
          // echoing to their own sessions once we return, using the deliveredCount/
          // totalRecipients we compute here).
          let recipients = meta.members.filter(m => m !== from);
          let deliveredCount = 0;
          await Promise.all(recipients.map(async member => {
            try {
              let stub = this.env.users.get(this.env.users.idFromName(member));
              let response = await stub.fetch("https://dummy-url/deliver", {
                method: "POST",
                body: dataStr,
              });
              if (response.ok) {
                let result = await response.json();
                if (result.delivered) deliveredCount++;
              }
            } catch (err) {
              // Best-effort: one unreachable member's mailbox shouldn't fail the whole send.
            }
          }));

          return new Response(JSON.stringify({
            ...outgoing,
            deliveredCount,
            totalRecipients: recipients.length,
          }), {headers: {"Content-Type": "application/json"}});
        }

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }
}

// =======================================================================================
// The RateLimiter Durable Object class (unchanged from the original demo).
// Note: UserMailbox and GroupChat do not use this yet -- see the UserMailbox class comment.

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
