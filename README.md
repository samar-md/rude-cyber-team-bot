# SAMAR-MD REMASTERED

SAMAR-MD Remastered keeps the original SAMAR-MD website/branding and rebuilds the bot backend around a cleaner multi-session lifecycle.

## What was remastered

- Stable multi-file WhatsApp session storage with atomic user-state writes.
- Automatic reconnect after normal network/server disconnects.
- Pairing-code retry flow and stale-code cleanup so old codes are not reused by the website.
- No-cache API responses and cache-busting pairing polling.
- Persistent per-number settings and custom commands.
- Status view/reaction with configurable delay and a conservative reaction rate limit.
- Auto read, auto typing, recording presence, always-online presence.
- Auto reply + custom reply text.
- Auto status reply + custom status reply text.
- Mention reply.
- Group tagall/hidetag/admins/ginfo.
- Welcome/goodbye.
- Anti-link + optional link deletion.
- Anti-delete text recovery from a recent message cache.
- Anti-view-once blocking.
- Anti-call rejection.
- Optional bad-word filtering.
- Optional PM blocker.
- Optional owner reactions.
- Optional admin-action hook setting.
- Sticker command for replied images/videos.
- YouTube/video/audio downloads with size and timeout limits.
- Custom command add/delete/list.
- Original SAMAR website retained.

## Important WhatsApp stability note

No third-party WhatsApp library can honestly guarantee "zero bans". This build reduces avoidable automation/rate-limit pressure by defaulting normal-message auto-reactions **OFF** and applying a reaction-per-minute limit. Keep automation reasonable and use an account that you are allowed to automate.

## Session persistence (MongoDB)

This build uses MongoDB for **WhatsApp authentication state and bot data**. Both Baileys credentials and Signal keys are persisted in MongoDB, so the bot does not depend on a local `sessions/` folder for WhatsApp authentication. Baileys requires both parts of the auth state to be saved together; the custom Mongo store persists `creds` and every signal-key update.

Required environment variables:

```env
MONGODB_URI=mongodb+srv://USERNAME:PASSWORD@CLUSTER.mongodb.net/?appName=APP
MONGODB_DB=samar_md
MONGODB_AUTH_COLLECTION=baileys_auth
MONGODB_USER_COLLECTION=samar_users
```

The app intentionally fails startup when `MONGODB_URI` is missing instead of silently falling back to local session storage.

## Run / deployment

- Node.js 20+.
- Install: `npm install`
- Start: `npm start`
- MongoDB Atlas Network Access must allow the hosting service to connect.
- No persistent disk is required for WhatsApp auth state because it is stored in MongoDB.
- Local `data/downloads` is only temporary media output and can be ephemeral.

## Environment

Copy `.env.example` to `.env` and set MongoDB plus at least:

```env
OWNER_NUMBERS=923XXXXXXXXX
```

Optional:

```env
PORT=3000
PREFIX=.
CHANNEL_LINK=
SITE_URL=https://your-real-domain.example
MAX_REACTIONS_PER_MINUTE=18
MAX_MEDIA_MB=45
BAD_WORDS=
```

## Run

```bash
npm install
npm start
```

Open the website, enter the WhatsApp number in international digits, then use the pairing code shown by the site.

## Deployment

- Node.js 20+.
- Build/install command: `npm install`
- Start command: `npm start`
- Set `MONGODB_URI` in the hosting platform secrets/environment settings.
- Do not commit `.env` or WhatsApp credentials.

## Website

The existing SAMAR-MD public page and logo are intentionally retained. Only its pairing/health JavaScript was hardened so it does not reuse cached pairing responses.

## Source comparison

The supplied KAMRAN-MD package contains an obfuscated `index.js`, so encrypted/unknown code was not copied blindly. Its readable configuration and feature list were used as the reference for the remaster. This keeps the resulting SAMAR-MD code auditable and maintainable.
