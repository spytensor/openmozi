# Unsupported channels (deferred)

These channels were evaluated but not shipped in this release. Each one
needs infrastructure MOZI cannot provide with just an API key — a
separate daemon, Apple hardware, or a backend service to keep OAuth
tokens fresh. The rule is: **if we can't make it reliable, we don't
ship it**.

Tracked for a future release. If you need one urgently, open an issue;
the registry/plugin model means adding one is largely self-contained.

## Interactive-mode for Google Chat and MS Teams

Outgoing-only webhook notifications **are supported today** — see
[googlechat.md](./googlechat.md) and [msteams.md](./msteams.md).

What is deferred is the bi-directional "user chats with MOZI inside
Teams/Google Chat" mode.

- **Google Chat**: bot apps require a Google Cloud project, OAuth
  service-account credentials, a published Google Workspace Marketplace
  app (or domain-wide allowlist), and JWT verification of every incoming
  request. This is too much to ask of a personal-agent setup. We will
  revisit when/if Google adds a socket-mode equivalent.
- **MS Teams**: interactive bots require Azure AD app registration,
  Azure Bot Services, and either a public URL for the Bot Framework
  adapter or Azure Service Bus relay. The onboarding surface is large
  and Azure-specific.

## WhatsApp

Personal WhatsApp has no first-party bot API. Every working bridge
relies on either:

- **WhatsApp Web scraping** (Baileys, wwebjs) — fragile against client
  updates and violates WhatsApp TOS.
- **WhatsApp Business Cloud API** — Meta-hosted, needs a business
  verification, a public webhook URL, and costs per conversation.

Neither is the right default for a personal agent OS. If you already
run a business account, plug the Cloud API into MOZI via a custom
plugin using the same webhook pattern as LINE.

## Signal

Signal has no hosted API. Bridging requires running `signal-cli` (or
`signald`) as a separate daemon, pairing it to a dedicated phone
number, and keeping its sqlite profile in sync. We would need to manage
that daemon's lifecycle as part of MOZI, which is a large undertaking.

## iMessage / BlueBubbles

iMessage is Apple-only and not legally routable off an Apple device.
Existing bridges (AirMessage, BlueBubbles) require you to leave an
always-on Mac running their server app, and MOZI would then call that
server over HTTP. For most users who don't already run such a Mac, this
is infeasible.

## Zalo Official Account

Zalo OA webhooks work, but every API call needs a short-lived OAuth
access token that expires in ~1 hour, which forces MOZI to implement
the OAuth authorization-code flow + refresh-token rotation + web
callback route. That backend is disproportionate to the rest of the
plugin surface. Deferred until the registry gains a shared OAuth
refresh helper that other channels (Google Chat interactive, Zalo,
Microsoft Graph for Teams interactive) can all use.

## Tlon / Urbit

Tlon chat runs on Urbit, which requires you to run a ship (either
self-hosted or paid hosting). The integration works, but the prereq
audience is small; we will revisit after getting more signal on actual
user demand.

## Roadmap

In no particular order:

- [ ] Shared OAuth refresh helper (unblocks Zalo OA, Google Chat bot,
      Teams bot).
- [ ] WhatsApp Business Cloud plugin (user supplies their own phone
      number ID + permanent token).
- [ ] Signal plugin that launches and supervises a local `signal-cli`
      daemon — opt-in only.
- [ ] BlueBubbles plugin — given user supplies server URL + API key.
- [ ] Matrix-native bridge improvements for end-to-end encryption.

None of these block the first-party set. They are listed here for
transparency.
